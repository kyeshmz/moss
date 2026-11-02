import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Meeting } from "@moss/contracts";
import { createMossServer } from "../src/server.js";
import { validateWav } from "../src/audio.js";

function wav(seconds = 1) {
  const data = Buffer.alloc(44 + 16000 * 2 * seconds);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test("WAV boundary rejects mislabeled, corrupt, and oversized-duration audio", () => {
  assert.doesNotThrow(() => validateWav(wav()));
  assert.throws(() => validateWav(Buffer.from("webm")), /PCM WAV/);
  assert.throws(() => validateWav(wav().subarray(0, 100)), /truncated/);
  assert.throws(() => validateWav(wav(121)), /120 seconds/);
});

test("public API persists notes, deduplicates chunks, exports, and rejects hostile origins", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-api-"));
  let transcriptions = 0;
  const engine = {
    status: () => ({ state: "ready" as const, model: "test-boundary", message: "Injected test engine" }),
    prepare: async () => {}, close: async () => {},
    transcribe: async () => { transcriptions++; return { transcript: "We will test the prototype on Friday.", durationMs: 1000 }; },
  };
  let app = createMossServer({ dataDirectory: directory, engine });
  const listen = async () => {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  };
  let origin = await listen();
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, {
    ...init, headers: { "X-Moss-Client": "1", "Content-Type": "application/json", ...init.headers },
  });
  try {
    assert.equal((await fetch(`${origin}/api/meetings`)).status, 403);
    assert.equal((await request("/meetings", { headers: { Origin: "https://evil.example" } })).status, 403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${origin}/api/meetings`, { headers: { Host: "evil.example", "X-Moss-Client": "1" } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostileHostStatus, 403);
    const created = await request("/meetings", { method: "POST", body: "{}" });
    assert.equal(created.status, 201);
    const meeting = await created.json() as Meeting;
    const patched = await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ title: "Design review", notes: "Launch remains unconfirmed.", expected: { title: meeting.title, notes: meeting.notes } }) });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as Meeting).notes, "Launch remains unconfirmed.");
    const stale = await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ notes: "Stale overwrite", expected: { notes: "" } }) });
    assert.equal(stale.status, 409);
    const titleOnly = await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ title: "Review renamed", expected: { title: "Design review" } }) });
    assert.equal(titleOnly.status, 200);
    assert.equal((await titleOnly.json() as Meeting).notes, "Launch remains unconfirmed.");
    assert.equal((await request(`/meetings/${meeting.id}`, { method: "PATCH", body: '{"segments":[]}' })).status, 400);
    const chunkId = randomUUID();
    const upload = () => request(`/meetings/${meeting.id}/audio`, { method: "POST", headers: {
      "Content-Type": "audio/wav", "X-Chunk-Id": chunkId, "X-Start-Ms": "0" }, body: wav() });
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 200);
    assert.equal(transcriptions, 1);
    const summarized = await request(`/meetings/${meeting.id}/summary`, { method: "POST", body: '{"kind":"extractive"}' });
    const summary = await summarized.json() as Meeting;
    assert.equal(summary.summary?.kind, "extractive");
    assert.match(summary.summary!.markdown, /test the prototype/);
    const exported = await request(`/meetings/${meeting.id}/export`);
    assert.match(await exported.text(), /Review renamed/);
    assert.equal(JSON.parse(readFileSync(join(directory, `${meeting.id}.json`), "utf8")).segments.length, 1);
    await app.close();
    app = createMossServer({ dataDirectory: directory, engine });
    origin = await listen();
    const restored = await (await request("/meetings")).json() as Meeting[];
    assert.equal(restored[0].notes, "Launch remains unconfirmed.");
    assert.equal(restored[0].segments.length, 1);
    assert.equal((await request(`/meetings/${meeting.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(await (await request("/meetings")).json(), []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
