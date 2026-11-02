import test from "node:test";
import assert from "node:assert/strict";
import type { Meeting, MeetingPatch, OpenCodeSummaryOptions, SummaryKind } from "@moss/contracts";
import { Workspace } from "../src/workspace";
import { ApiError } from "../src/api";
import { DRAFT_KEY, DraftStore, type EditableFields } from "../src/drafts";

const openCodeOptions: OpenCodeSummaryOptions = { agentID: "moss-summary", model: { id: "server-model", providerID: "configured-provider", variant: "high" }, consent: true };

function meeting(id = "one"): Meeting {
  return { id, title: "Meeting", notes: "Original", revision: 0, segments: [], summary: null,
    createdAt: "2026-11-02T09:00:00.000Z", updatedAt: "2026-11-02T09:00:00.000Z" };
}

function fixture() {
  let saved = meeting();
  let failSave = false;
  let reads = 0;
  const calls: string[] = [];
  const patches: MeetingPatch[] = [];
  const client = {
    meetings: async () => { reads++; return [saved, meeting("two")]; },
    create: async () => meeting("new"),
    patch: async (_id: string, patch: MeetingPatch) => {
      calls.push("save");
      patches.push(patch);
      if (failSave) throw new Error("Service unavailable");
      for (const field of ["title", "notes"] as const) {
        if (patch[field] !== undefined && patch.expected?.[field] !== saved[field]) throw new ApiError("Changed elsewhere", 409);
      }
      const { expected: _expected, ...changes } = patch;
      saved = { ...saved, ...changes, revision: saved.revision + 1 };
      return saved;
    },
    remove: async () => ({ ok: true as const }),
    import: async (_id: string, text: string) => {
      calls.push("import");
      saved = { ...saved, revision: saved.revision + 1, segments: [{ id: "segment", text, startMs: 0, durationMs: 0 }] };
      return saved;
    },
    audio: async () => { calls.push("audio"); saved = { ...saved, revision: saved.revision + 1 }; return saved; },
    summarize: async () => { calls.push("summary"); return saved; },
    export: async () => { calls.push("export"); return saved.notes; },
  };
  return { client, calls, patches, reads: () => reads, saved: () => saved,
    remoteEdit: (changes: EditableFields) => { saved = { ...saved, ...changes, revision: saved.revision + 1 }; },
    setFailSave: (value: boolean) => { failSave = value; } };
}

function draftStorage() {
  const data = new Map<string, string>();
  return { data, store: new DraftStore(() => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } })) };
}

test("agent work and Drive handoff save drafts first and cannot bypass failed saves", async () => {
  const f = fixture();
  const client = { ...f.client,
    agentWork: async () => { f.calls.push("agent-work"); return f.saved(); },
    driveExport: async () => { f.calls.push("drive-export"); return { sessionID: "ses_export", status: "submitted" as const, message: "Approve in OpenCode" }; },
  };
  const workspace = new Workspace(client, draftStorage().store);
  await workspace.load();
  const options = { ...openCodeOptions, source: "summary" as const, instruction: "Review", requestID: "stable-request" };
  workspace.edit("one", { notes: "Save before review" });
  await workspace.agentWork("one", options);
  assert.deepEqual(f.calls, ["save", "agent-work"]);
  workspace.edit("one", { notes: "Save before export" });
  assert.equal((await workspace.driveExport("one", { ...openCodeOptions, source: "meeting", server: "drive" })).status, "submitted");
  assert.deepEqual(f.calls.slice(-2), ["save", "drive-export"]);
  workspace.edit("one", { notes: "Keep failed draft" });
  f.setFailSave(true);
  await assert.rejects(workspace.agentWork("one", options), /unavailable/);
  await assert.rejects(workspace.driveExport("one", { ...openCodeOptions, source: "meeting", server: "drive" }), /unavailable/);
  assert.equal(f.calls.filter(call => call === "agent-work").length, 1);
  assert.equal(f.calls.filter(call => call === "drive-export").length, 1);
  assert.equal(workspace.getSnapshot().drafts.one.notes, "Keep failed draft");
  workspace.pauseAutosave();
});

test("drafts survive audio updates and edits to a different meeting", async () => {
  const { client } = fixture();
  const workspace = new Workspace(client);
  await workspace.load();
  workspace.edit("one", { notes: "Not saved yet" });
  workspace.edit("two", { title: "Another meeting" });
  await workspace.audio("one", { id: "chunk", startMs: 0, wav: new Blob() });
  assert.equal(workspace.getSnapshot().drafts.one.notes, "Not saved yet");
  assert.equal(workspace.getSnapshot().drafts.two.title, "Another meeting");
  workspace.pauseAutosave();
});

test("a failed save retains the draft and exposes a retry", async () => {
  const fixtureState = fixture();
  const workspace = new Workspace(fixtureState.client);
  await workspace.load();
  workspace.edit("one", { notes: "Keep this" });
  fixtureState.setFailSave(true);
  await assert.rejects(workspace.save("one"), /Service unavailable/);
  assert.equal(workspace.getSnapshot().drafts.one.notes, "Keep this");
  assert.equal(workspace.getSnapshot().saves.one.state, "error");
  fixtureState.setFailSave(false);
  await workspace.save("one");
  assert.equal(workspace.getSnapshot().drafts.one, undefined);
  assert.equal(workspace.getSnapshot().meetings.find(item => item.id === "one")?.notes, "Keep this");
  workspace.pauseAutosave();
});

test("typing while a save is in flight is saved after its response", async () => {
  const { client } = fixture();
  let release!: () => void;
  const started = new Promise<void>(resolve => {
    const patch = client.patch;
    client.patch = async (...args) => {
      resolve();
      await new Promise<void>(done => { release = done; });
      client.patch = patch;
      return patch(...args);
    };
  });
  const workspace = new Workspace(client);
  await workspace.load();
  workspace.edit("one", { notes: "First edit" });
  const save = workspace.save("one");
  await started;
  workspace.edit("one", { notes: "Original" });
  release();
  await save;
  assert.equal(workspace.getSnapshot().meetings.find(item => item.id === "one")?.notes, "Original");
  assert.equal(workspace.getSnapshot().drafts.one, undefined);
  workspace.pauseAutosave();
});

test("summary, import, and export wait for current drafts", async () => {
  const { client, calls } = fixture();
  const workspace = new Workspace(client);
  await workspace.load();
  workspace.edit("one", { notes: "For the summary" });
  await workspace.summarize("one", "extractive");
  assert.deepEqual(calls, ["save", "summary"]);
  workspace.edit("one", { notes: "Before import" });
  await workspace.import("one", "A real transcript");
  assert.deepEqual(calls.slice(-2), ["save", "import"]);
  workspace.edit("one", { notes: "Export this" });
  assert.equal(await workspace.export("one"), "Export this");
  assert.deepEqual(calls.slice(-2), ["save", "export"]);
  workspace.pauseAutosave();
});

test("failed saves prevent dependent summary requests", async () => {
  const fixtureState = fixture();
  const workspace = new Workspace(fixtureState.client);
  await workspace.load();
  workspace.edit("one", { notes: "Unsaved" });
  fixtureState.setFailSave(true);
  await assert.rejects(workspace.summarize("one", "extractive"), /Service unavailable/);
  assert.deepEqual(fixtureState.calls, ["save"]);
  workspace.pauseAutosave();
});

test("OpenCode waits for the saved notes, forwards consent and selection, and accepts AI provenance", async t => {
  const server = fixture();
  let releaseSave!: () => void;
  let saving!: () => void;
  const started = new Promise<void>(resolve => { saving = resolve; });
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  const patch = server.client.patch;
  server.client.patch = async (...args) => {
    const saved = await patch(...args);
    saving();
    await gate;
    return saved;
  };
  let received: unknown[] = [];
  const workspace = new Workspace({ ...server.client, summarize: async (id: string, kind: SummaryKind, options?: OpenCodeSummaryOptions) => {
    server.calls.push("opencode-summary");
    received = [id, kind, options, server.saved().notes];
    const saved = server.saved();
    return { ...saved, summary: { kind: "ai", markdown: "# Summary\nSaved notes", sourceRevision: saved.revision, opencode: { agentID: options!.agentID, model: options!.model } } };
  } });
  t.after(() => { releaseSave(); workspace.pauseAutosave(); });
  await workspace.load();
  workspace.edit("one", { notes: "Saved before OpenCode" });
  const pending = workspace.summarize("one", "opencode", openCodeOptions);
  await started;
  assert.deepEqual(received, []);
  assert.deepEqual(server.calls, ["save"]);
  releaseSave();
  await pending;
  assert.deepEqual(server.calls, ["save", "opencode-summary"]);
  assert.deepEqual(received, ["one", "opencode", openCodeOptions, "Saved before OpenCode"]);
  const state = workspace.getSnapshot();
  assert.equal(state.drafts.one, undefined);
  assert.equal(state.meetings.find(item => item.id === "one")?.summary?.kind, "ai");
  assert.deepEqual(state.meetings.find(item => item.id === "one")?.summary?.opencode, { agentID: openCodeOptions.agentID, model: openCodeOptions.model });
});

test("failed saves block OpenCode entirely and retain the recoverable draft", async t => {
  const server = fixture();
  const storage = draftStorage();
  const workspace = new Workspace(server.client, storage.store);
  t.after(() => workspace.pauseAutosave());
  await workspace.load();
  workspace.edit("one", { notes: "Never send an older version" });
  server.setFailSave(true);
  await assert.rejects(workspace.summarize("one", "opencode", openCodeOptions), /Service unavailable/);
  assert.deepEqual(server.calls, ["save"]);
  assert.equal(workspace.getSnapshot().drafts.one.notes, "Never send an older version");
  assert.equal(workspace.getSnapshot().saves.one.state, "error");
  assert.equal(new Workspace(server.client, storage.store).getSnapshot().drafts.one.notes, "Never send an older version");
});

test("OpenCode cannot bypass a same-field conflict or silently rebase it", async t => {
  const server = fixture();
  const workspace = new Workspace(server.client);
  t.after(() => workspace.pauseAutosave());
  await workspace.load();
  workspace.edit("one", { notes: "My local notes" });
  server.remoteEdit({ notes: "Another client's notes" });
  await assert.rejects(workspace.summarize("one", "opencode", openCodeOptions), error => error instanceof ApiError && error.status === 409);
  await assert.rejects(workspace.summarize("one", "opencode", openCodeOptions), /Confirm replacement/);
  assert.deepEqual(server.calls, ["save"]);
  assert.equal(workspace.getSnapshot().drafts.one.expected.notes, "Original");
  assert.equal(workspace.getSnapshot().drafts.one.notes, "My local notes");
});

test("saving notes submits only notes and their original base value", async () => {
  const { client } = fixture();
  let submitted: unknown;
  const patch = client.patch;
  client.patch = async (id, value) => { submitted = value; return patch(id, value); };
  const workspace = new Workspace(client);
  await workspace.load();
  workspace.edit("one", { notes: "My new notes" });
  workspace.pauseAutosave();
  await workspace.save("one");
  assert.deepEqual(submitted, { notes: "My new notes", expected: { notes: "Original" } });
});

test("two clients editing different fields preserve both changes", async () => {
  const server = fixture();
  const first = new Workspace(server.client);
  const second = new Workspace(server.client);
  await Promise.all([first.load(), second.load()]);
  first.edit("one", { title: "Remote title" });
  second.edit("one", { notes: "Local notes" });
  first.pauseAutosave(); second.pauseAutosave();
  await first.save("one");
  await second.save("one");
  assert.equal(server.saved().title, "Remote title");
  assert.equal(server.saved().notes, "Local notes");
  assert.deepEqual(server.patches, [
    { title: "Remote title", expected: { title: "Meeting" } },
    { notes: "Local notes", expected: { notes: "Original" } },
  ]);
});

test("same-field conflicts retain the original base across loads and audio, and block automatic retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fixture();
  const first = new Workspace(server.client);
  const second = new Workspace(server.client);
  await Promise.all([first.load(), second.load()]);
  second.edit("one", { notes: "My draft" });
  first.edit("one", { notes: "Other client's notes", title: "Keep this title" });
  first.pauseAutosave(); second.pauseAutosave();
  await first.save("one");
  await second.load();
  await second.audio("one", { id: "chunk", startMs: 0, wav: new Blob() });
  await assert.rejects(second.save("one"), error => error instanceof ApiError && error.status === 409);
  assert.equal(server.saved().notes, "Other client's notes");
  assert.equal(second.getSnapshot().drafts.one.notes, "My draft");
  assert.equal(second.getSnapshot().drafts.one.expected.notes, "Original");
  assert.equal(second.getSnapshot().saves.one.state, "conflict");
  const attempts = server.patches.length;
  const reads = server.reads();
  second.edit("one", { notes: "My revised draft" });
  t.mock.timers.tick(5000);
  await assert.rejects(second.save("one"), /Confirm replacement/);
  await assert.rejects(second.summarize("one", "extractive"), /Confirm replacement/);
  assert.equal(server.patches.length, attempts);
  assert.equal(server.reads(), reads);
  await second.replaceConflictingFields("one");
  assert.equal(server.reads(), reads + 1);
  assert.deepEqual(server.patches.at(-1), { notes: "My revised draft", expected: { notes: "Other client's notes" } });
  assert.equal(server.saved().notes, "My revised draft");
  assert.equal(server.saved().title, "Keep this title");
  assert.equal(second.getSnapshot().drafts.one, undefined);
});

test("a race during confirmed replacement conflicts again instead of forcing a write", async () => {
  const server = fixture();
  const workspace = new Workspace(server.client);
  await workspace.load();
  workspace.edit("one", { notes: "My draft" });
  workspace.pauseAutosave();
  server.remoteEdit({ notes: "Changed" });
  await assert.rejects(workspace.save("one"), /Changed elsewhere/);
  const read = server.client.meetings;
  server.client.meetings = async () => {
    const result = await read();
    server.remoteEdit({ notes: "Changed again" });
    return result;
  };
  await assert.rejects(workspace.replaceConflictingFields("one"), /Changed elsewhere/);
  assert.equal(server.saved().notes, "Changed again");
  assert.equal(workspace.getSnapshot().drafts.one.notes, "My draft");
  assert.equal(workspace.getSnapshot().saves.one.state, "conflict");
});

test("failed saves are restored with their original bases when the workspace is recreated", async () => {
  const server = fixture();
  const storage = draftStorage();
  const first = new Workspace(server.client, storage.store);
  await first.load();
  first.edit("one", { notes: "Recover after reload" });
  server.setFailSave(true);
  await assert.rejects(first.save("one"), /Service unavailable/);
  first.pauseAutosave();
  const persisted = JSON.parse(storage.data.get(DRAFT_KEY)!);
  assert.deepEqual(persisted.drafts.one, { notes: "Recover after reload", expected: { notes: "Original" } });
  server.remoteEdit({ title: "New remote title" });
  const restored = new Workspace(server.client, storage.store);
  await restored.load();
  assert.equal(restored.getSnapshot().drafts.one.notes, "Recover after reload");
  assert.equal(restored.getSnapshot().drafts.one.expected.notes, "Original");
  server.setFailSave(false);
  await restored.save("one");
  assert.equal(server.saved().notes, "Recover after reload");
  assert.equal(server.saved().title, "New remote title");
  assert.deepEqual(JSON.parse(storage.data.get(DRAFT_KEY)!).drafts, {});
  assert.deepEqual(new Workspace(server.client, storage.store).getSnapshot().drafts, {});
});

test("conflicts remain blocked after reload until explicit replacement", async () => {
  const server = fixture();
  const storage = draftStorage();
  const first = new Workspace(server.client, storage.store);
  await first.load();
  first.edit("one", { notes: "My persistent draft" });
  first.pauseAutosave();
  server.remoteEdit({ notes: "Remote notes" });
  await assert.rejects(first.save("one"));
  const restored = new Workspace(server.client, storage.store);
  await restored.load();
  assert.equal(restored.getSnapshot().saves.one.state, "conflict");
  const attempts = server.patches.length;
  await assert.rejects(restored.save("one"), /Confirm replacement/);
  assert.equal(server.patches.length, attempts);
  await restored.replaceConflictingFields("one");
  assert.equal(server.saved().notes, "My persistent draft");
});

test("storage failures are visible, preserve in-memory edits, and have an explicit retry", async () => {
  const server = fixture();
  const data = new Map<string, string>();
  let broken = true;
  const store = new DraftStore(() => ({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { if (broken) throw new Error("QuotaExceededError"); data.set(key, value); },
  }));
  const workspace = new Workspace(server.client, store);
  await workspace.load();
  workspace.edit("one", { notes: "In memory" });
  workspace.pauseAutosave();
  assert.equal(workspace.getSnapshot().drafts.one.notes, "In memory");
  assert.match(workspace.getSnapshot().storageError!, /only in this window/);
  broken = false;
  workspace.retryDraftStorage();
  assert.equal(workspace.getSnapshot().storageError, null);
  assert.equal(new Workspace(server.client, store).getSnapshot().drafts.one.notes, "In memory");
});
