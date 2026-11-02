import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingStore } from "../src/store.js";

test("invalid persisted data is surfaced without replacement", () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-store-"));
  try {
    const store = new MeetingStore(directory);
    const meeting = store.create();
    const path = join(directory, `${meeting.id}.json`);
    const corrupt = '{"id":"unexpected-data"}';
    writeFileSync(path, corrupt);
    assert.throws(() => store.get(meeting.id), /left untouched/);
    assert.equal(readFileSync(path, "utf8"), corrupt);
    assert.throws(() => store.get("../../elsewhere"), /Invalid meeting ID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("meeting files are private and summary updates do not overwrite later edits", () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-store-"));
  try {
    const store = new MeetingStore(directory);
    const meeting = store.create();
    store.patch(meeting.id, { notes: "Saved while the summary was generating." });
    const updated = store.summarize(meeting.id, { kind: "extractive", sourceRevision: 0, markdown: "Older excerpts" });
    assert.equal(updated.notes, "Saved while the summary was generating.");
    assert.notEqual(updated.revision, updated.summary?.sourceRevision);
    if (process.platform !== "win32") assert.equal(statSync(join(directory, `${meeting.id}.json`)).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("audio batches append atomically at the latest offset and content retries do not duplicate results", () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-store-"));
  try {
    const store = new MeetingStore(directory);
    const meeting = store.create();
    store.append(meeting.id, { id: "recording", startMs: 0, durationMs: 3000, text: "Earlier recording" });
    const hash = "a".repeat(64);
    const batch = [{ id: "file-a", startMs: 0, durationMs: 1000, text: "Imported" }, { id: "file-b", startMs: 1000, durationMs: 1000, text: "More" }];
    const result = store.appendImportedAudio(meeting.id, batch, hash);
    assert.deepEqual(result.segments.map(segment => segment.startMs), [0, 3000, 4000]);
    assert.deepEqual(result.audioImportHashes, [hash]);
    assert.deepEqual(store.appendImportedAudio(meeting.id, batch, hash), result);
    assert.equal(store.list()[0].segments.length, 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
