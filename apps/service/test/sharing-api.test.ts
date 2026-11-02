import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meeting } from "@moss/contracts";
import { createMossServer } from "../src/server.js";

test("audio-file API requires consent, commits batches once, keeps failures atomic, and exports three formats", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-sharing-api-"));
  let conversions = 0;
  const app = createMossServer({ dataDirectory: directory, engine: {
    status: () => ({ state: "ready", model: "fixture", message: "Injected engine" }),
    prepare: async () => {}, transcribe: async () => ({ transcript: "Imported sound", durationMs: 1000 }), close: async () => {},
  }, audioImporter: async (bytes, options) => {
    conversions++;
    if (Buffer.from(bytes).toString() === "failed") throw new Error("Injected conversion failure");
    const result = await options.transcribe(new Uint8Array(), options.signal);
    return [{ id: "00000000-0000-8000-8000-000000000001", startMs: 0, durationMs: result.durationMs, text: result.transcript }];
  } });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, { ...init,
    headers: { "X-Moss-Client": "1", "Content-Type": "application/json", ...init.headers } });
  try {
    const meeting = await (await request("/meetings", { method: "POST", body: "{}" })).json() as Meeting;
    await request(`/meetings/${meeting.id}`, { method: "PATCH", body: JSON.stringify({ notes: "Saved notes", expected: { notes: "" } }) });
    const upload = (data: string, consent = "1") => request(`/meetings/${meeting.id}/audio-file`, { method: "POST", body: data,
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("会議.mp3"), "X-Audio-Consent": consent } });
    assert.equal((await upload("file", "0")).status, 400);
    assert.equal(conversions, 0);
    const imported = await (await upload("file")).json() as Meeting;
    assert.equal(imported.notes, "Saved notes");
    assert.equal(imported.segments.length, 1);
    assert.equal(imported.segments[0].text, "Imported sound");
    assert.deepEqual(await (await upload("file")).json(), imported);
    assert.equal(conversions, 1);
    assert.equal((await upload("failed")).status, 400);
    const stored = await (await request("/meetings")).json() as Meeting[];
    assert.deepEqual(stored[0], imported);
    for (const format of ["markdown", "text", "json"]) {
      const response = await request(`/meetings/${meeting.id}/export?format=${format}`);
      assert.equal(response.status, 200);
      if (format === "json") assert.deepEqual(await response.json(), imported);
      else assert.match(await response.text(), /Imported sound/);
    }
    assert.equal((await request(`/meetings/${meeting.id}/export?format=unsupported`)).status, 400);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("agent-work API persists separate idempotent results and Drive API reports only submitted handoffs", async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-agent-api-"));
  let generations = 0;
  const catalog = { available: true, message: "Fixture", servers: [{ name: "drive", status: "connected" as const }] };
  const app = createMossServer({ dataDirectory: directory, work: {
    catalog: async () => catalog, connectDrive: async () => catalog, close: async () => {},
    work: async (meeting, options) => { generations++; return { id: options.requestID, source: options.source, instruction: options.instruction,
      markdown: "Separate review output.", sourceRevision: meeting.revision, agentID: options.agentID, model: options.model, createdAt: meeting.createdAt }; },
    exportDrive: async () => ({ status: "submitted", sessionID: "ses_fixture_drive", message: "Approve in OpenCode, not a confirmed file." }),
  } });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, value?: unknown) => fetch(`${origin}/api${path}`, {
    method: value ? "POST" : "GET", headers: { "X-Moss-Client": "1", "Content-Type": "application/json" }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  try {
    const created = await (await request("/meetings", {})).json() as Meeting;
    const options = { agentID: "reviewer", model: { id: "model", providerID: "fixture" }, consent: true,
      source: "meeting", instruction: "Review this meeting", requestID: "10000000-0000-4000-8000-000000000001" };
    const route = `/meetings/${created.id}/agent-work`;
    const denied = await request(route, { ...options, consent: false });
    assert.equal(denied.status, 400);
    assert.equal(generations, 0);
    const result = await (await request(route, options)).json() as Meeting;
    assert.equal(result.notes, created.notes);
    assert.equal(result.summary, null);
    assert.equal(result.agentWork?.[0].markdown, "Separate review output.");
    assert.deepEqual(await (await request(route, options)).json(), result);
    assert.equal(generations, 1);
    assert.equal((await request(route, { ...options, instruction: "Different task" })).status, 409);
    assert.deepEqual(await (await request("/drive")).json(), catalog);
    assert.equal((await request("/drive/connect", { server: "drive", consent: false })).status, 400);
    const handoff = await (await request(`/meetings/${created.id}/drive-export`, { agentID: "drive-agent", model: options.model, server: "drive", source: "meeting", consent: true })).json();
    assert.equal(handoff.status, "submitted");
    assert.match(handoff.message, /not a confirmed file/);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
