import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, REQUEST_DEADLINES, RequestTimeoutError } from "../src/api";
import { AudioQueue } from "../src/audio-queue";
import type { OpenCodeSummaryCatalog, OpenCodeSummaryOptions } from "@moss/contracts";

const openCodeOptions: OpenCodeSummaryOptions = { agentID: "moss-summary", model: { providerID: "configured-provider", id: "server-model", variant: "high" }, consent: true };

test("audio imports, agent work, Drive handoffs and export formats use explicit public contracts", async t => {
  const original = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init = {}) => { requests.push({ url: String(input), init }); return Response.json({}); };
  t.after(() => { globalThis.fetch = original; });
  const file = new File(["audio"], "会議.mp3", { type: "audio/mpeg" });
  await api.audioFile("meeting", file);
  const work = { ...openCodeOptions, source: "summary" as const, instruction: "Review this summary.", requestID: "request-id" };
  await api.agentWork("meeting", work);
  await api.driveCatalog();
  await api.connectDrive({ server: "drive", consent: true });
  await api.driveExport("meeting", { ...openCodeOptions, source: "meeting", server: "drive" });
  await api.export("meeting", "json");
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("X-Audio-Consent"), "1");
  assert.equal(headers.get("X-File-Name"), encodeURIComponent(file.name));
  assert.equal(headers.get("Content-Type"), "application/octet-stream");
  assert.equal(requests[0].init.body, file);
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), work);
  assert.deepEqual(JSON.parse(String(requests[3].init.body)), { server: "drive", consent: true });
  assert.equal(requests[5].url, "/api/meetings/meeting/export?format=json");
});

test("explicit audio import cancellation reaches fetch without discarding the selected file", async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  t.after(() => { globalThis.fetch = original; });
  const file = new File(["retained"], "meeting.wav");
  const controller = new AbortController();
  const task = api.audioFile("meeting", file, controller.signal);
  const rejected = assert.rejects(task, /cancelled/);
  controller.abort();
  await rejected;
  assert.equal(await file.text(), "retained");
});

test("all API requests stay relative and include the Moss client header", async t => {
  const original = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  await api.health();
  await api.opencodeSummaryCatalog();
  await api.prepare();
  await api.meetings();
  await api.create();
  await api.patch("meeting", { notes: "Notes", expected: { notes: "" } });
  await api.remove("meeting");
  await api.import("meeting", "Transcript");
  await api.summarize("meeting", "extractive");
  await api.summarize("meeting", "opencode", openCodeOptions);
  const wav = new Blob(["audio"]);
  await api.audio("meeting", { id: "same-id", startMs: 15000, wav });
  await api.export("meeting");
  for (const request of requests) {
    assert.ok(request.url.startsWith("/api/"));
    assert.equal(new Headers(request.init.headers).get("X-Moss-Client"), "1");
    assert.ok(request.init.signal instanceof AbortSignal);
  }
  const audio = requests.find(request => request.url.endsWith("/audio"))!;
  const headers = new Headers(audio.init.headers);
  assert.equal(audio.init.body, wav);
  assert.equal(headers.get("Content-Type"), "audio/wav");
  assert.equal(headers.get("X-Chunk-Id"), "same-id");
  assert.equal(headers.get("X-Start-Ms"), "15000");
});

test("OpenCode catalog needs only the public catalog and no connection or credential configuration", async t => {
  const original = globalThis.fetch;
  const catalog: OpenCodeSummaryCatalog = {
    available: true, message: "Ready", agents: [{ id: "moss-summary", name: "Meeting summary" }],
    models: [{ providerID: "configured-provider", id: "server-model", name: "Server model", variants: ["high"] }],
  };
  let request!: { url: string; init: RequestInit };
  globalThis.fetch = async (input, init = {}) => { request = { url: String(input), init }; return Response.json(catalog); };
  t.after(() => { globalThis.fetch = original; });
  assert.deepEqual(await api.opencodeSummaryCatalog(), catalog);
  assert.equal(request.url, "/api/summary/opencode");
  assert.equal(request.init.method ?? "GET", "GET");
  assert.equal(request.init.body, undefined);
  assert.deepEqual([...new Headers(request.init.headers)], [["x-moss-client", "1"]]);
});

test("OpenCode summary encodes a flat selection and explicit consent while legacy bodies stay unchanged", async t => {
  const original = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init = {}) => { requests.push({ url: String(input), init }); return Response.json({}); };
  t.after(() => { globalThis.fetch = original; });
  await api.summarize("meeting/id", "opencode", openCodeOptions);
  await api.summarize("meeting/id", "opencode", { ...openCodeOptions, model: { id: "server-model", providerID: "configured-provider" } });
  await api.summarize("meeting/id", "extractive", openCodeOptions);
  await api.summarize("meeting/id", "ai");
  await api.summarize("meeting/id", "opencode");
  assert.deepEqual(requests.map(request => JSON.parse(String(request.init.body))), [
    { kind: "opencode", agentID: "moss-summary", model: { providerID: "configured-provider", id: "server-model", variant: "high" }, consent: true },
    { kind: "opencode", agentID: "moss-summary", model: { providerID: "configured-provider", id: "server-model" }, consent: true },
    { kind: "extractive" }, { kind: "ai" }, { kind: "opencode" },
  ]);
  for (const { url, init } of requests) {
    assert.equal(url, "/api/meetings/meeting%2Fid/summary");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  }
});

test("catalog unavailability and discovery errors remain actionable", async t => {
  const original = globalThis.fetch;
  const unavailable: OpenCodeSummaryCatalog = { available: false, message: "Start OpenCode, then refresh models.", agents: [], models: [] };
  globalThis.fetch = async () => Response.json(unavailable);
  t.after(() => { globalThis.fetch = original; });
  assert.deepEqual(await api.opencodeSummaryCatalog(), unavailable);
  globalThis.fetch = async () => Response.json({ error: "Discovery failed; refresh models." }, { status: 503 });
  await assert.rejects(api.opencodeSummaryCatalog(), /Discovery failed; refresh models/);
});

test("server errors remain visible instead of becoming success data", async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Hex failed" }), { status: 503 });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(api.prepare(), /Hex failed/);
});

test("preparation sends the JSON object required by the service", async t => {
  const original = globalThis.fetch;
  let sent: RequestInit = {};
  globalThis.fetch = async (_input, init = {}) => {
    sent = init;
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = original; });
  await api.prepare();
  assert.equal(new Headers(sent.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(sent.body)), {});
});

test("HTTP status survives the API boundary for conflict handling", async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "Notes changed elsewhere" }, { status: 409 });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(api.patch("one", { notes: "Mine", expected: { notes: "Old" } }), error => error instanceof ApiError && error.status === 409);
});

test("ordinary requests time out, abort fetch, and release the caller", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init = {}) => {
    signals.push(init.signal!);
    return new Promise<Response>(() => undefined);
  };
  t.after(() => { globalThis.fetch = original; });
  const calls = [api.health(), api.opencodeSummaryCatalog(), api.meetings(), api.create(), api.patch("one", {}), api.remove("one"), api.import("one", "Text"), api.export("one")];
  const checks = calls.map(call => assert.rejects(call, RequestTimeoutError));
  t.mock.timers.tick(REQUEST_DEADLINES.standard);
  await Promise.all(checks);
  assert.equal(signals.length, 8);
  assert.ok(signals.every(signal => signal.aborted));
});

test("deadlines also cover stalled JSON, error bodies, and Markdown bodies", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  let ok = true;
  globalThis.fetch = async () => ({ ok, status: 503, json: () => new Promise(() => undefined), text: () => new Promise(() => undefined) }) as unknown as Response;
  t.after(() => { globalThis.fetch = original; });
  const json = api.meetings();
  const markdown = api.export("one");
  ok = false;
  const errorBody = api.health();
  await new Promise<void>(resolve => setImmediate(resolve));
  const checks = [json, markdown, errorBody].map(call => assert.rejects(call, RequestTimeoutError));
  t.mock.timers.tick(REQUEST_DEADLINES.standard);
  await Promise.all(checks);
});

test("preparation, audio, and summaries have explicit longer but finite deadlines", async t => {
  assert.equal(REQUEST_DEADLINES.summary, 150_000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init = {}) => {
    signals.push(init.signal!);
    return new Promise<Response>(() => undefined);
  };
  t.after(() => { globalThis.fetch = original; });
  for (const [call, deadline] of [
    [() => api.prepare(), REQUEST_DEADLINES.prepare],
    [() => api.audio("one", { id: "uuid", startMs: 0, wav: new Blob() }), REQUEST_DEADLINES.audio],
    [() => api.summarize("one", "ai"), REQUEST_DEADLINES.summary],
    [() => api.summarize("one", "opencode", openCodeOptions), REQUEST_DEADLINES.summary],
  ] as const) {
    assert.ok(Number.isFinite(deadline) && deadline > REQUEST_DEADLINES.standard);
    const pending = call();
    const check = assert.rejects(pending, RequestTimeoutError);
    t.mock.timers.tick(REQUEST_DEADLINES.standard);
    assert.equal(signals.at(-1)?.aborted, false);
    t.mock.timers.tick(deadline - REQUEST_DEADLINES.standard);
    await check;
    assert.equal(signals.at(-1)?.aborted, true);
  }
});

test("an audio timeout retains the WAV and retries the same UUID", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init = {}) => {
    requests.push(init);
    if (requests.length === 1) return new Promise<Response>(() => undefined);
    return Response.json({});
  };
  t.after(() => { globalThis.fetch = original; });
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const queue = new AudioQueue(async chunk => { await api.audio("one", chunk); }, state => { if (state.error && !state.uploading) failed(); });
  const chunk = { id: "retained-uuid", startMs: 15000, wav: new Blob(["WAV"]) };
  queue.add(chunk);
  t.mock.timers.tick(REQUEST_DEADLINES.audio);
  await failure;
  assert.equal(queue.getSnapshot().pending[0], chunk);
  assert.match(queue.getSnapshot().error!, /timed out/);
  assert.equal(requests[0].signal?.aborted, true);
  await queue.retry();
  assert.equal(queue.getSnapshot().pending.length, 0);
  assert.deepEqual(requests.map(init => new Headers(init.headers).get("X-Chunk-Id")), [chunk.id, chunk.id]);
  assert.equal(requests[0].body, requests[1].body);
});
