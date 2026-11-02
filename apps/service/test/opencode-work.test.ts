import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { OpenCode } from "@opencode/client";
import { newMeeting, sourceContent } from "@moss/core";
import type { AgentWorkOptions, ContentSource, DriveExportOptions, Meeting } from "@moss/contracts";
import { OpenCodeWork, parseAgentWorkOptions, parseDriveConnectionOptions, parseDriveExportOptions } from "../src/opencode-work.js";

const selection = { agentID: "moss-editor", model: { id: "fixture-chat", providerID: "fixture", variant: "high" }, consent: true as const };
const workOptions: AgentWorkOptions = { ...selection, source: "notes", instruction: "Review the uncertainty without adding facts.", requestID: "10000000-0000-4000-8000-000000000001" };
const exportOptions: DriveExportOptions = { ...selection, agentID: "primary", source: "meeting", server: "team.drive" };
const original: Meeting = { ...newMeeting("00000000-0000-0000-0000-000000000001", "2026-01-01T00:00:00Z"),
  title: "Planning", notes: "Launch is unconfirmed.\nKeep this exact line. ", revision: 7,
  segments: [{ id: "segment", startMs: 0, durationMs: 1500, text: "Transcript-only detail." }],
  summary: { kind: "extractive", markdown: "Existing summary-only detail.", sourceRevision: 4 } };
const resultText = "## Review\nLaunch remains unconfirmed.";
const privateValue = "fixture-secret-not-public";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("Drive export rejects Moss text-only profiles before any discovery or model request", async () => {
  const service = new OpenCodeWork({ connect: async () => { assert.fail("Text-only Drive export must not connect."); } });
  for (const agentID of ["moss-summary", "moss-editor", "moss-reviewer"]) {
    await assert.rejects(service.exportDrive(original, { ...exportOptions, agentID }), /text-only/);
  }
  await service.close();
});

interface FixtureOptions {
  servers?: { name: string; title?: string; status: { status: string; error?: string }; config?: unknown }[];
  holdWait?: boolean;
  holdPrompt?: boolean;
  holdMcp?: boolean;
  promptFailure?: boolean;
  mcpFailure?: boolean;
  outcome?: string;
  finish?: string;
  completed?: number | null;
  text?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  messageError?: boolean;
  interruptFailure?: boolean;
}

async function fixture(settings: FixtureOptions = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const waitStarted = deferred();
  const promptStarted = deferred();
  const mcpStarted = deferred();
  const interrupted = deferred();
  const releases: (() => void)[] = [];
  const servers = settings.servers ?? [
    { name: "team.drive", title: "Team files", status: { status: "connected" }, config: { headers: { authorization: privateValue } } },
    { name: "unrelated", status: { status: "needs_auth", error: privateValue } },
  ];
  const json = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
  };
  const empty = (response: ServerResponse) => { response.writeHead(204); response.end(); };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${privateValue}`);
    const url = new URL(request.url!, "http://fixture");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ path: url.pathname, method: request.method!, body });
    if (["/api/agent", "/api/model", "/api/mcp"].includes(url.pathname) || url.pathname.startsWith("/api/experimental/mcp")) {
      assert.equal(url.searchParams.get("location[directory]"), process.cwd());
    }
    if (url.pathname === "/api/agent") return json(response, { data: [
      { id: "moss-editor", name: "Editor", mode: "all", hidden: false, system: privateValue },
      { id: "primary", name: "Primary", mode: "primary", hidden: false },
      { id: "hidden", name: "Hidden", mode: "all", hidden: true },
      { id: "child-only", name: "Child", mode: "subagent", hidden: false },
    ] });
    if (url.pathname === "/api/model") {
      assert.equal(url.searchParams.get("types"), "chat");
      return json(response, { data: [
        { id: "fixture-chat", providerID: "fixture", name: "Fixture", type: "chat", enabled: true,
          variants: [{ id: "high", headers: { authorization: privateValue } }], headers: { authorization: privateValue } },
        { id: "disabled", providerID: "fixture", name: "Disabled", type: "chat", enabled: false, variants: [] },
        { id: "picture", providerID: "fixture", name: "Picture", type: "image", enabled: true, variants: [] },
      ] });
    }
    if (url.pathname === "/api/mcp") {
      mcpStarted.resolve();
      if (settings.mcpFailure) return json(response, { error: privateValue }, 500);
      if (settings.holdMcp) { releases.push(() => json(response, { data: servers })); return; }
      return json(response, { data: servers });
    }
    if (url.pathname.startsWith("/api/experimental/mcp/")) {
      const name = decodeURIComponent(url.pathname.split("/")[4]!);
      if (url.pathname.endsWith("/connect")) {
        servers.find(server => server.name === name)!.status = { status: "needs_auth", error: privateValue };
      } else {
        assert.equal(request.method, "PUT");
        servers.push({ name, status: { status: "needs_auth", error: privateValue } });
      }
      return empty(response);
    }
    if (url.pathname === "/api/session") return json(response, { data: { id: "ses_owned_fixture" } });
    if (url.pathname.endsWith("/prompt")) {
      promptStarted.resolve();
      if (settings.promptFailure) return json(response, { error: privateValue }, 400);
      const send = () => json(response, { data: { id: "msg_fixture", type: "user" } });
      if (settings.holdPrompt) { releases.push(send); return; }
      return send();
    }
    if (url.pathname.endsWith("/wait")) {
      waitStarted.resolve();
      if (settings.holdWait) { releases.push(() => empty(response)); return; }
      return empty(response);
    }
    if (url.pathname.endsWith("/interrupt")) {
      assert.equal(url.pathname, "/api/session/ses_owned_fixture/interrupt");
      assert.equal(url.searchParams.get("resume"), "false");
      interrupted.resolve();
      return json(response, settings.interruptFailure ? { error: privateValue } : { interrupted: true }, settings.interruptFailure ? 500 : 200);
    }
    if (url.pathname === "/api/session/ses_owned_fixture") return json(response, { data: { id: "ses_owned_fixture", outcome: settings.outcome ?? "succeeded" } });
    if (url.pathname.endsWith("/message")) {
      assert.equal(url.searchParams.get("type"), "assistant");
      assert.equal(url.searchParams.get("order"), "desc");
      assert.equal(url.searchParams.get("limit"), "1");
      return json(response, { data: [{ type: "assistant", agent: settings.agent ?? selection.agentID,
        model: settings.model ?? selection.model, time: { completed: settings.completed === undefined ? 10 : settings.completed },
        finish: settings.finish ?? "stop", ...(settings.messageError ? { error: { message: privateValue } } : {}),
        content: [{ type: "reasoning", text: privateValue }, { type: "text", text: settings.text ?? resultText }] }] });
    }
    return json(response, { error: "Unexpected fixture request" }, 404);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers: { authorization: `Bearer ${privateValue}` } });
  return { client, calls, waitStarted: waitStarted.promise, promptStarted: promptStarted.promise, mcpStarted: mcpStarted.promise,
    interrupted: interrupted.promise, release: () => releases.splice(0).forEach(release => release()), close: async () => {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    } };
}

test("work and Drive parsers require consent and reject malformed payloads without leaking supplied values", () => {
  assert.deepEqual(parseAgentWorkOptions(workOptions), workOptions);
  assert.deepEqual(parseDriveExportOptions({ ...exportOptions, folderID: "drive_folder-1" }), { ...exportOptions, folderID: "drive_folder-1" });
  for (const input of [null, [], { ...workOptions, consent: false }, { ...workOptions, source: "all" },
    { ...workOptions, instruction: " " }, { ...workOptions, instruction: "x".repeat(10_001) }, { ...workOptions, requestID: "bad" },
    { ...workOptions, extra: privateValue }, { ...workOptions, model: { ...selection.model, headers: privateValue } }]) {
    assert.throws(() => parseAgentWorkOptions(input), error => { assert.doesNotMatch(String(error), /fixture-secret/); return true; });
  }
  for (const input of [{ ...exportOptions, consent: false }, { ...exportOptions, source: "unknown" },
    { ...exportOptions, folderID: "https://drive.example/folder" }, { ...exportOptions, folderID: "" }, { ...exportOptions, autoApprove: true }]) {
    assert.throws(() => parseDriveExportOptions(input));
  }
  assert.throws(() => parseDriveConnectionOptions({ server: "drive", consent: false }), /Confirm/);
  assert.throws(() => parseDriveConnectionOptions({ server: "drive", consent: true, headers: privateValue }), /Unknown/);
  assert.throws(() => parseDriveConnectionOptions({ server: "bad\nserver", consent: true }), /server/);
  for (const url of ["http://mcp.example/mcp", "https://name:password@mcp.example/mcp", "https://mcp.example/mcp?key=secret",
    "https://mcp.example/mcp?", "https://mcp.example/mcp#token", "https://mcp.example/mcp#", "file:///config", "not a url", "https:\\evil.example"]) {
    assert.throws(() => parseDriveConnectionOptions({ server: "drive", url, consent: true }));
  }
  assert.deepEqual(parseDriveConnectionOptions({ server: "drive", url: "https://mcp.example/mcp", consent: true }),
    { server: "drive", url: "https://mcp.example/mcp", consent: true });
});

test("Drive catalog lists every configured server but only public names, titles, and safe statuses", async () => {
  const fake = await fixture({ servers: [
    { name: "first", title: "Files", status: { status: "connected" }, config: privateValue },
    ...["pending", "disabled", "failed", "needs_auth"].map(status => ({ name: status, status: { status, error: privateValue }, config: privateValue })),
  ] });
  const service = new OpenCodeWork({ connect: async () => fake.client });
  try {
    const catalog = await service.catalog();
    assert.equal(catalog.available, true);
    assert.deepEqual(catalog.servers, [{ name: "first", title: "Files", status: "connected" },
      ...["pending", "disabled", "failed", "needs_auth"].map(status => ({ name: status, status }))]);
    assert.match(catalog.message, /\/mcps/);
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret|authorization|"config"|"error"/);
    assert.deepEqual(fake.calls.map(call => call.path), ["/api/mcp"]);
  } finally { await service.close(); await fake.close(); }
});

test("Drive catalog discovery and provider errors become safe actionable messages", async () => {
  for (const connect of [async () => undefined, async (): Promise<never> => { throw new Error(privateValue); }]) {
    const service = new OpenCodeWork({ connect });
    const catalog = await service.catalog();
    assert.equal(catalog.available, false);
    assert.deepEqual(catalog.servers, []);
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret/);
    await service.close();
  }
  const fake = await fixture({ mcpFailure: true });
  const service = new OpenCodeWork({ connect: async () => fake.client });
  try {
    assert.equal((await service.catalog()).available, false);
    await assert.rejects(service.connectDrive({ server: "new", url: "https://mcp.example/mcp", consent: true }), error => {
      assert.doesNotMatch(String(error), /fixture-secret/); return true;
    });
  } finally { await service.close(); await fake.close(); }
});

test("Drive connection requires consent before discovery and safely adds OAuth remote servers without overriding existing ones", async () => {
  const fake = await fixture();
  let discoveries = 0;
  const service = new OpenCodeWork({ connect: async () => { discoveries++; return fake.client; } });
  try {
    await assert.rejects(service.connectDrive({ server: "new", consent: false } as never), /Confirm/);
    assert.equal(discoveries, 0);
    await assert.rejects(service.connectDrive({ server: "team.drive", url: "https://replacement.example/mcp", consent: true }), /already exists/);
    assert.equal(fake.calls.some(call => call.method === "PUT"), false);
    await service.connectDrive({ server: "team.drive", consent: true });
    assert.ok(fake.calls.some(call => call.path === "/api/experimental/mcp/team.drive/connect"));
    const catalog = await service.connectDrive({ server: "new-drive", url: "https://mcp.example/mcp", consent: true });
    assert.deepEqual(fake.calls.find(call => call.method === "PUT")?.body,
      { config: { type: "remote", url: "https://mcp.example/mcp", oauth: {}, codemode: false } });
    assert.deepEqual(catalog.servers.find(server => server.name === "new-drive"), { name: "new-drive", status: "needs_auth" });
    assert.match(catalog.message, /\/mcps/);
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret|https:/);
    await assert.rejects(service.connectDrive({ server: "team_drive", url: "https://mcp.example/mcp", consent: true }), /conflicts/);
    await assert.rejects(service.connectDrive({ server: "another", consent: true }), /HTTPS endpoint/);
    assert.equal(fake.calls.filter(call => call.method === "PUT").length, 1);
  } finally { await service.close(); await fake.close(); }
});

test("agent work selects exactly the confirmed source and instruction, returns completed text and never mutates originals", async () => {
  for (const source of ["notes", "transcript", "summary", "meeting"] as ContentSource[]) {
    const fake = await fixture();
    const service = new OpenCodeWork({ connect: async () => fake.client });
    const meeting = structuredClone(original);
    try {
      const result = await service.work(meeting, { ...workOptions, source });
      assert.equal(result.id, workOptions.requestID);
      assert.equal(result.source, source);
      assert.equal(result.sourceRevision, 7);
      assert.equal(result.markdown, resultText);
      assert.equal(result.instruction, workOptions.instruction);
      assert.equal(result.agentID, selection.agentID);
      assert.deepEqual(result.model, selection.model);
      assert.ok(Number.isFinite(Date.parse(result.createdAt)));
      assert.deepEqual(meeting, original);
      const create = fake.calls.find(call => call.path === "/api/session")!.body;
      assert.equal(create.agent, selection.agentID);
      assert.deepEqual(create.model, selection.model);
      assert.deepEqual(create.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
      const prompt = fake.calls.find(call => call.path.endsWith("/prompt"))!.body.text as string;
      assert.match(prompt, /Use no tools/);
      assert.ok(prompt.includes(workOptions.instruction));
      assert.deepEqual(JSON.parse(prompt.split("Selected source JSON:\n")[1]!), { source, content: sourceContent(meeting, source) });
      if (source === "notes" || source === "transcript") assert.doesNotMatch(prompt, /summary-only/);
      assert.deepEqual(fake.calls.slice(-3).map(call => call.path), ["/api/experimental/session/ses_owned_fixture/wait", "/api/session/ses_owned_fixture", "/api/session/ses_owned_fixture/message"]);
      assert.equal(fake.calls.some(call => call.path.endsWith("/interrupt")), false);
    } finally { await service.close(); await fake.close(); }
  }
});

test("work validates live primary/all agents, enabled chat models and variants before creating sessions", async () => {
  const fake = await fixture();
  const service = new OpenCodeWork({ connect: async () => fake.client });
  try {
    for (const options of [{ ...workOptions, agentID: "hidden" }, { ...workOptions, agentID: "child-only" },
      { ...workOptions, agentID: "missing" }, { ...workOptions, model: { ...selection.model, id: "disabled" } },
      { ...workOptions, model: { ...selection.model, id: "picture" } }, { ...workOptions, model: { ...selection.model, providerID: "other" } },
      { ...workOptions, model: { ...selection.model, variant: "invented" } }]) {
      await assert.rejects(service.work(original, options), /no longer available/);
    }
    assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
  } finally { await service.close(); await fake.close(); }
});

test("selected content caps and empty sources fail before any OpenCode discovery", async () => {
  let discoveries = 0;
  const service = new OpenCodeWork({ connect: async () => { discoveries++; return undefined; } });
  try {
    const oversized = { ...original, notes: "x".repeat(120_001) };
    await assert.rejects(service.work(oversized, workOptions), /No partial/);
    await assert.rejects(service.exportDrive(oversized, { ...exportOptions, source: "notes" }), /No partial/);
    await assert.rejects(service.work({ ...original, summary: null }, { ...workOptions, source: "summary" }), /empty/);
    await assert.rejects(service.exportDrive({ ...original, segments: [] }, { ...exportOptions, source: "transcript" }), /empty/);
    await assert.rejects(service.work(original, { ...workOptions, consent: false } as never), /Confirm/);
    assert.equal(discoveries, 0);
  } finally { await service.close(); }
});

test("agent work snapshots confirmed content, revision and selection and ignores oversized unselected sources", async () => {
  const fake = await fixture({ holdWait: true });
  const service = new OpenCodeWork({ connect: async () => fake.client });
  const meeting = { ...structuredClone(original), notes: "x".repeat(120_001) };
  const options = { ...structuredClone(workOptions), source: "summary" as const };
  try {
    const task = service.work(meeting, options);
    await fake.waitStarted;
    meeting.revision = 99;
    meeting.summary!.markdown = "An edit while work was running.";
    options.instruction = "A later instruction.";
    options.model.id = "a-later-selection";
    fake.release();
    const result = await task;
    assert.equal(result.sourceRevision, 7);
    assert.equal(result.instruction, workOptions.instruction);
    assert.deepEqual(result.model, selection.model);
    const prompt = fake.calls.find(call => call.path.endsWith("/prompt"))!.body.text as string;
    assert.deepEqual(JSON.parse(prompt.split("Selected source JSON:\n")[1]!), { source: "summary", content: original.summary!.markdown });
    assert.doesNotMatch(prompt, /An edit while work/);
  } finally { await service.close(); await fake.close(); }
});

test("failed, partial, empty, oversized, and wrong-identity work interrupts its session without exposing provider details", async () => {
  for (const options of [{ promptFailure: true }, { outcome: "failed" }, { finish: "length" }, { completed: null }, { text: "" },
    { text: "x".repeat(200_001) }, { agent: "other-agent" }, { model: { ...selection.model, id: "other-model" } },
    { model: { ...selection.model, providerID: "other-provider" } }, { model: { ...selection.model, variant: "low" } },
    { messageError: true }, { promptFailure: true, interruptFailure: true }]) {
    const fake = await fixture(options);
    const service = new OpenCodeWork({ connect: async () => fake.client });
    try {
      await assert.rejects(service.work(original, workOptions), error => {
        assert.doesNotMatch(String(error), /fixture-secret/);
        if (options.interruptFailure) assert.match(String(error), /Could not confirm interruption/);
        return true;
      });
      assert.equal(fake.calls.filter(call => call.path.endsWith("/interrupt")).length, 1);
    } finally { await service.close(); await fake.close(); }
  }
});

test("work cancellation, deadline and service close interrupt only owned in-flight sessions", async () => {
  for (const mode of ["caller", "timeout", "close"]) {
    const fake = await fixture({ holdWait: true });
    const service = new OpenCodeWork({ connect: async () => fake.client, timeoutMs: mode === "timeout" ? 100 : 10_000 });
    const caller = new AbortController();
    try {
      const task = service.work(original, workOptions, caller.signal);
      const rejected = assert.rejects(task, mode === "timeout" ? /timed out/ : /cancelled/);
      await fake.waitStarted;
      await assert.rejects(service.work(original, workOptions), /already running/);
      if (mode === "caller") caller.abort();
      if (mode === "close") await service.close();
      await rejected;
      assert.equal(fake.calls.filter(call => call.path.endsWith("/interrupt")).length, 1);
    } finally { await service.close(); await fake.close(); }
  }
});

test("bounded discovery and pre-cancelled work never create a session", async () => {
  const service = new OpenCodeWork({ connect: () => new Promise(() => {}), timeoutMs: 30, requestTimeoutMs: 30 });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(service.work(original, workOptions), /timed out/);
    assert.equal((await service.catalog()).available, false);
    await assert.rejects(service.connectDrive({ server: "new", url: "https://mcp.example/mcp", consent: true }), /Could not connect/);
  } finally { clearInterval(keepAlive); await service.close(); }
  let discoveries = 0;
  const closed = new OpenCodeWork({ connect: async () => { discoveries++; return undefined; } });
  const caller = new AbortController(); caller.abort();
  await assert.rejects(closed.work(original, workOptions, caller.signal), /cancelled/);
  await closed.close();
  await assert.rejects(closed.work(original, workOptions), /cancelled/);
  assert.equal(discoveries, 0);
});

test("Drive export hands off exact selected Markdown with ask-only server tools, never waits or claims file creation", async () => {
  for (const source of ["notes", "transcript", "summary", "meeting"] as ContentSource[]) {
    const fake = await fixture();
    const service = new OpenCodeWork({ connect: async () => fake.client });
    try {
      const handoff = await service.exportDrive(original, { ...exportOptions, source, folderID: "target-folder_1" });
      assert.equal(handoff.status, "submitted");
      assert.equal(handoff.sessionID, "ses_owned_fixture");
      assert.match(handoff.message, /not yet confirmed/);
      assert.match(handoff.message, /approve/);
       const create = fake.calls.find(call => call.path === "/api/session")!.body;
       assert.deepEqual(create.model, selection.model);
       assert.equal(create.agent, exportOptions.agentID);
       assert.deepEqual(create.permissions, [{ action: "*", resource: "*", effect: "deny" },
        { action: "team_drive_*", resource: "*", effect: "ask" }]);
      const prompt = fake.calls.find(call => call.path.endsWith("/prompt"))!.body.text as string;
      assert.deepEqual(JSON.parse(prompt.split("Export request JSON:\n")[1]!), { server: "team.drive", filename: `Moss-${original.id}.md`,
        source, folderID: "target-folder_1", markdown: sourceContent(original, source) });
      assert.match(prompt, /exact Markdown/);
      await service.close();
      assert.equal(fake.calls.some(call => call.path.endsWith("/wait") || call.path.endsWith("/interrupt") || call.method === "DELETE"), false);
      assert.equal(fake.calls.some(call => call.path === "/api/experimental/mcp/team.drive/connect"), false);
    } finally { await service.close(); await fake.close(); }
  }
});

test("Drive export rejects disconnected servers, overlapping normalized tool prefixes and stale selections before creating a session", async () => {
  for (const servers of [
    [{ name: "team.drive", status: { status: "needs_auth", error: privateValue } }],
    [{ name: "another", status: { status: "connected" } }],
    [{ name: "team.drive", status: { status: "connected" } }, { name: "team_drive", status: { status: "connected" } }],
    [{ name: "team.drive", status: { status: "connected" } }, { name: "team_drive_other", status: { status: "connected" } }],
    [{ name: "team.drive", status: { status: "connected" } }, { name: "team", status: { status: "connected" } }],
  ]) {
    const fake = await fixture({ servers });
    const service = new OpenCodeWork({ connect: async () => fake.client });
    try {
      await assert.rejects(service.exportDrive(original, exportOptions));
      assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
    } finally { await service.close(); await fake.close(); }
  }
  const fake = await fixture();
  const service = new OpenCodeWork({ connect: async () => fake.client });
  try {
    for (const options of [{ ...exportOptions, agentID: "child-only" }, { ...exportOptions, model: { ...selection.model, variant: "missing" } },
      { ...exportOptions, consent: false } as never]) await assert.rejects(service.exportDrive(original, options));
    assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
  } finally { await service.close(); await fake.close(); }
});

test("failed or shutdown-interrupted Drive submissions clean up in-flight sessions but never delete history", async () => {
  for (const settings of [{ promptFailure: true }, { holdPrompt: true }]) {
    const fake = await fixture(settings);
    const service = new OpenCodeWork({ connect: async () => fake.client });
    try {
      const task = service.exportDrive(original, exportOptions);
      const rejected = assert.rejects(task, error => { assert.doesNotMatch(String(error), /fixture-secret/); return true; });
      if (settings.holdPrompt) { await fake.promptStarted; await service.close(); }
      await rejected;
      assert.equal(fake.calls.filter(call => call.path.endsWith("/interrupt")).length, 1);
      assert.equal(fake.calls.some(call => call.method === "DELETE"), false);
    } finally { await service.close(); await fake.close(); }
  }
});

test("Drive tool prefixes cannot enable unrelated built-in permission actions", async () => {
  for (const name of ["opencode", "opencode_read_mcp", "external", "experimental_image"]) {
    const fake = await fixture({ servers: [{ name, status: { status: "connected" } }] });
    const service = new OpenCodeWork({ connect: async () => fake.client });
    try {
      await assert.rejects(service.exportDrive(original, { ...exportOptions, server: name }), /permission action/);
      assert.equal(fake.calls.some(call => call.path === "/api/session"), false);
    } finally { await service.close(); await fake.close(); }
  }
});

test("service close cancels MCP catalog and connection requests and parallel connection attempts do not race writes", async () => {
  const fake = await fixture({ holdMcp: true });
  const service = new OpenCodeWork({ connect: async () => fake.client });
  try {
    const task = service.connectDrive({ server: "new", url: "https://mcp.example/mcp", consent: true });
    const rejected = assert.rejects(task, /Could not connect/);
    await fake.mcpStarted;
    await assert.rejects(service.connectDrive({ server: "new", url: "https://mcp.example/mcp", consent: true }), /already in progress/);
    await service.close();
    await rejected;
    assert.equal(fake.calls.some(call => call.method === "PUT"), false);
  } finally { await service.close(); await fake.close(); }
});
