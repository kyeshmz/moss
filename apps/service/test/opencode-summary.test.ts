import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { newMeeting } from "@moss/core";
import type { Meeting } from "@moss/contracts";
import { OpenCodeSummaries, parseOpenCodeOptions } from "../src/opencode-summary.js";
import { createMossServer } from "../src/server.js";

const selection = { agentID: "moss-summary", model: { id: "fixture-chat", providerID: "fixture", variant: "high" }, consent: true as const };
const source = { ...newMeeting("00000000-0000-0000-0000-000000000001"), notes: "Launch remains unconfirmed.", revision: 3 };
const summaryText = "## Overview\nLaunch remains unconfirmed.\n\n## Decisions\nNone recorded.\n\n## Next steps\nNone recorded.";

async function fixture(settings: { hold?: boolean; failure?: boolean; outcome?: string; finish?: string; empty?: boolean; wrongModel?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let release: (() => void) | undefined;
  let sawWait!: () => void;
  const waiting = new Promise<void>(resolve => { sawWait = resolve; });
  let interrupted!: () => void;
  const interruption = new Promise<void>(resolve => { interrupted = resolve; });
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-secret");
    const url = new URL(request.url!, "http://fixture");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/agent") {
      assert.equal(url.searchParams.get("location[directory]"), process.cwd());
      return json(response, { data: [
        { id: "moss-summary", name: "Meeting summary", mode: "primary", hidden: false, system: "private system instructions" },
        { id: "summary", name: "Internal", mode: "primary", hidden: true },
        { id: "general", name: "General", mode: "subagent", hidden: false },
      ] });
    }
    if (url.pathname === "/api/model") return json(response, { data: [
      { id: "fixture-chat", providerID: "fixture", name: "Fixture Chat", type: "chat", enabled: true, variants: [{ id: "high", headers: { authorization: "private-variant-key" } }], headers: { authorization: "private-model-key" }, body: { secret: true } },
      { id: "disabled", providerID: "fixture", name: "Disabled", type: "chat", enabled: false, variants: [] },
      { id: "image", providerID: "fixture", name: "Image", type: "image", enabled: true, variants: [] },
    ] });
    if (url.pathname === "/api/session") return json(response, { data: { id: "ses_fixture" } });
    if (url.pathname.endsWith("/prompt")) return json(response, settings.failure ? { error: "fixture-secret private provider failure" } : { data: { id: "msg_fixture", type: "user" } }, settings.failure ? 400 : 200);
    if (url.pathname.endsWith("/wait")) {
      release = () => { response.writeHead(204); response.end(); };
      sawWait();
      if (!settings.hold) release();
      return;
    }
    if (url.pathname.endsWith("/interrupt")) { assert.equal(url.searchParams.get("resume"), "false"); interrupted(); return json(response, { interrupted: true }); }
    if (url.pathname === "/api/session/ses_fixture") return json(response, { data: { id: "ses_fixture", outcome: settings.outcome ?? "succeeded" } });
    if (url.pathname.endsWith("/message")) {
      assert.equal(url.searchParams.get("type"), "assistant");
      assert.equal(url.searchParams.get("order"), "desc");
      return json(response, { data: [{ type: "assistant", agent: selection.agentID,
        model: { ...selection.model, ...(settings.wrongModel ? { id: "different-model" } : {}) },
        time: { completed: 10 }, finish: settings.finish ?? "stop", content: [
        { type: "reasoning", text: "Do not expose reasoning." }, { type: "text", text: settings.empty ? "" : summaryText },
      ] }], cursor: {} });
    }
    json(response, { error: "unexpected fixture route" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, headers: { authorization: "Bearer fixture-secret" } });
  return { client, calls, waiting, interruption, release: () => release?.(), close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("OpenCode options require per-request consent and reject malformed or extra model fields", () => {
  assert.deepEqual(parseOpenCodeOptions({ kind: "opencode", ...selection }), selection);
  assert.throws(() => parseOpenCodeOptions({ ...selection, consent: false }), /Confirm sharing/);
  assert.throws(() => parseOpenCodeOptions({ ...selection, model: { ...selection.model, baseUrl: "https://evil.example" } }), /Invalid/);
  assert.throws(() => parseOpenCodeOptions({ ...selection, agentID: "" }), /Choose/);
  assert.throws(() => parseOpenCodeOptions({ ...selection, password: "not-allowed" }), /Unknown/);
});

test("OpenCode catalog filters private agents and non-chat models without exposing provider configuration", async () => {
  const fake = await fixture();
  const summaries = new OpenCodeSummaries({ connect: async () => fake.client });
  try {
    assert.deepEqual(await summaries.catalog(), { available: true, message: "OpenCode is connected. Model inference may use a remote provider.",
      agents: [{ id: "moss-summary", name: "Meeting summary" }],
      models: [{ id: "fixture-chat", providerID: "fixture", name: "Fixture Chat", variants: ["high"] }] });
    assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
  } finally { await summaries.close(); await fake.close(); }
});

test("missing or failing OpenCode discovery returns an actionable safe catalog", async () => {
  for (const connect of [async () => undefined, async (): Promise<never> => { throw new Error("authorization private-key"); }]) {
    const summaries = new OpenCodeSummaries({ connect });
    const catalog = await summaries.catalog();
    assert.equal(catalog.available, false);
    assert.deepEqual(catalog.models, []);
    assert.match(catalog.message, /Open OpenCode/);
    assert.doesNotMatch(JSON.stringify(catalog), /private-key|authorization/);
    await summaries.close();
  }
});

test("OpenCode summary uses an isolated tool-denied session, waits, and reads only completed assistant text", async () => {
  const fake = await fixture();
  const summaries = new OpenCodeSummaries({ connect: async () => fake.client });
  try {
    const result = await summaries.summarize(source, selection);
    assert.deepEqual(result, { kind: "ai", markdown: summaryText, sourceRevision: 3, opencode: { agentID: selection.agentID, model: selection.model } });
    const create = fake.calls.find(call => call.path === "/api/session")!;
    assert.deepEqual(create.body.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
    assert.deepEqual(create.body.model, selection.model);
    assert.equal(create.body.agent, selection.agentID);
    const prompt = fake.calls.find(call => call.path.endsWith("/prompt"))!;
    assert.match(prompt.body.text as string, /untrusted source data/);
    assert.match(prompt.body.text as string, /Launch remains unconfirmed/);
    assert.deepEqual(fake.calls.slice(-3).map(call => call.path), ["/api/experimental/session/ses_fixture/wait", "/api/session/ses_fixture", "/api/session/ses_fixture/message"]);
  } finally { await summaries.close(); await fake.close(); }
});

test("stale catalog selections and oversized content cause no OpenCode session or prompt", async () => {
  const fake = await fixture();
  const summaries = new OpenCodeSummaries({ connect: async () => fake.client });
  try {
    await assert.rejects(summaries.summarize(source, { ...selection, agentID: "summary" }), /no longer available/);
    await assert.rejects(summaries.summarize(source, { ...selection, model: { ...selection.model, variant: "invented" } }), /no longer available/);
    await assert.rejects(summaries.summarize(source, { ...selection, model: { ...selection.model, providerID: "other" } }), /no longer available/);
    await assert.rejects(summaries.summarize({ ...source, notes: "x".repeat(120_001) }, selection), /no partial summary was sent/);
    assert.equal(fake.calls.some(call => call.path === "/api/session" || call.path.endsWith("/prompt")), false);
  } finally { await summaries.close(); await fake.close(); }
});

test("provider failure, failed runs, partial and empty replies keep previous summaries and interrupt the owned session", async () => {
  for (const setting of [{ failure: true }, { outcome: "failed" }, { finish: "length" }, { empty: true }, { wrongModel: true }]) {
    const fake = await fixture(setting);
    const summaries = new OpenCodeSummaries({ connect: async () => fake.client });
    try {
      await assert.rejects(summaries.summarize(source, selection), error => {
        assert.doesNotMatch(String(error), /fixture-secret|private provider/);
        return true;
      });
      assert.ok(fake.calls.some(call => call.path.endsWith("/interrupt")));
    } finally { await summaries.close(); await fake.close(); }
  }
});

test("OpenCode deadlines, caller cancellation, and service close interrupt only the created session", async () => {
  for (const mode of ["timeout", "caller", "close"]) {
    const fake = await fixture({ hold: true });
    const summaries = new OpenCodeSummaries({ connect: async () => fake.client, timeoutMs: mode === "timeout" ? 100 : 10_000 });
    const caller = new AbortController();
    try {
      const task = summaries.summarize(source, selection, caller.signal);
      const rejected = assert.rejects(task, mode === "timeout" ? /timed out/ : /cancelled/);
      await fake.waiting;
      await assert.rejects(summaries.summarize(source, selection), /already running/);
      if (mode === "caller") caller.abort();
      if (mode === "close") await summaries.close();
      await rejected;
      await fake.interruption;
      assert.deepEqual(fake.calls.filter(call => call.path.endsWith("/interrupt")), [{ path: "/api/session/ses_fixture/interrupt", body: {} }]);
    } finally { await summaries.close(); await fake.close(); }
  }
});

test("public OpenCode summary route enforces consent and preserves concurrent notes with a stale revision", async () => {
  const fake = await fixture({ hold: true });
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-opencode-"));
  const summaries = new OpenCodeSummaries({ connect: async () => fake.client });
  const app = createMossServer({ dataDirectory: directory, opencode: summaries, engine: {
    status: () => ({ state: "unavailable", model: "fixture", message: "No audio in this test" }),
    prepare: async () => {}, transcribe: async () => ({ transcript: "", durationMs: 0 }), close: async () => {},
  } });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, body?: unknown, method = body ? "POST" : "GET") => fetch(`${origin}/api${path}`, {
    method, headers: { "X-Moss-Client": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await (await request("/summary/opencode")).json()).available, true);
    let meeting = await (await request("/meetings", {})).json() as Meeting;
    meeting = await (await request(`/meetings/${meeting.id}`, { notes: source.notes, expected: { notes: "" } }, "PATCH")).json() as Meeting;
    const route = `/meetings/${meeting.id}/summary`;
    const denied = await request(route, { kind: "opencode", ...selection, consent: false });
    assert.equal(denied.status, 400);
    assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
    const pending = request(route, { kind: "opencode", ...selection });
    await fake.waiting;
    await request(`/meetings/${meeting.id}`, { notes: "A later edit.", expected: { notes: source.notes } }, "PATCH");
    fake.release();
    const response = await pending;
    assert.equal(response.status, 200);
    const result = await response.json() as Meeting;
    assert.equal(result.notes, "A later edit.");
    assert.equal(result.summary?.sourceRevision, meeting.revision);
    assert.notEqual(result.summary?.sourceRevision, result.revision);
    assert.deepEqual(result.summary?.opencode, { agentID: selection.agentID, model: selection.model });
    assert.equal(JSON.parse(readFileSync(join(directory, `${meeting.id}.json`), "utf8")).summary.markdown, summaryText);
  } finally { await app.close(); await fake.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a disconnected summary HTTP caller interrupts generation without replacing the previous summary", async () => {
  const fake = await fixture({ hold: true });
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-opencode-cancel-"));
  const app = createMossServer({ dataDirectory: directory, opencode: new OpenCodeSummaries({ connect: async () => fake.client }) });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const request = (path: string, body?: unknown, method = body ? "POST" : "GET", signal?: AbortSignal) => fetch(`${origin}/api${path}`, {
    method, headers: { "X-Moss-Client": "1", "Content-Type": "application/json" }, signal, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const created = await (await request("/meetings", {})).json() as Meeting;
    await request(`/meetings/${created.id}`, { notes: source.notes, expected: { notes: "" } }, "PATCH");
    const route = `/meetings/${created.id}/summary`;
    const previous = await (await request(route, { kind: "extractive" })).json() as Meeting;
    const caller = new AbortController();
    const pending = request(route, { kind: "opencode", ...selection }, "POST", caller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await fake.waiting;
    caller.abort();
    await rejected;
    await fake.interruption;
    const meetings = await (await request("/meetings")).json() as Meeting[];
    assert.deepEqual(meetings[0].summary, previous.summary);
  } finally { await app.close(); await fake.close(); rmSync(directory, { recursive: true, force: true }); }
});
