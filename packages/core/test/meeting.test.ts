import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newMeeting, parsePatch, quickSummary, exportMarkdown, exportContent, sourceContent, isMeeting } from "../src/index.js";

test("empty meetings and validated edits", () => {
  const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
  assert.equal(meeting.segments.length, 0);
  assert.deepEqual(parsePatch({ title: "  Design review  ", notes: "hello", expected: { title: "Untitled meeting", notes: "" } }),
    { title: "Design review", notes: "hello", expected: { title: "Untitled meeting", notes: "" } });
  assert.throws(() => parsePatch({ notes: "No precondition" }), /expected.notes/);
  assert.throws(() => parsePatch({ segments: [] }));
  assert.throws(() => parsePatch({ notes: 42 }));
  assert.throws(() => parsePatch({ title: "a".repeat(241) }));
});

test("contract fixture decodes and exports with truthful summary labels", () => {
  const fixture: unknown = JSON.parse(readFileSync(new URL("../../contracts/fixtures/meeting.json", import.meta.url), "utf8"));
  assert.ok(isMeeting(fixture));
  assert.match(exportMarkdown(fixture), /Extracted highlights/);
  assert.match(exportMarkdown(fixture), /\*\*0:00\*\*/);
  fixture.revision += 1;
  assert.match(exportMarkdown(fixture), /out of date/);
});

test("extractive highlights never invent facts or claim to be AI", () => {
  const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
  meeting.notes = "The prototype is ready. We will test it on Friday. The prototype is ready.";
  const summary = quickSummary(meeting);
  assert.equal(summary.kind, "extractive");
  assert.match(summary.markdown, /Possible next steps\n- We will test it on Friday\./);
  assert.equal(summary.markdown.match(/The prototype is ready/g)?.length, 1);
});

test("OpenCode attribution survives validation and Markdown export without changing AI summary kind", () => {
  const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
  meeting.summary = { kind: "ai", sourceRevision: 0, markdown: "No decisions recorded.", opencode: {
    agentID: "moss-summary", model: { providerID: "fixture", id: "fixture-chat", variant: "high" },
  } };
  assert.ok(isMeeting(meeting));
  assert.match(exportMarkdown(meeting), /AI summary\n\nGenerated with OpenCode agent moss-summary, model fixture\/fixture-chat \(high\)/);
  assert.equal(isMeeting({ ...meeting, summary: { ...meeting.summary, opencode: { agentID: "moss-summary", model: null } } }), false);
  assert.equal(isMeeting({ ...meeting, summary: { ...meeting.summary, opencode: { agentID: 123, model: { id: "model", providerID: "provider" } } } }), false);
});

test("selected sources and Markdown, text and JSON exports retain original content and agent results", () => {
  const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
  meeting.notes = "Original notes";
  meeting.summary = { kind: "ai", markdown: "Original summary", sourceRevision: 0 };
  meeting.agentWork = [{ id: "work", source: "summary", instruction: "Review", markdown: "Review result", sourceRevision: 0, agentID: "reviewer", model: { id: "model", providerID: "provider" }, createdAt: meeting.createdAt }];
  assert.equal(sourceContent(meeting, "notes"), "Original notes");
  assert.equal(sourceContent(meeting, "summary"), "Original summary");
  assert.match(sourceContent(meeting, "meeting"), /Review result/);
  assert.deepEqual(JSON.parse(exportContent(meeting, "json")), meeting);
  assert.match(exportContent(meeting, "text"), /Original notes/);
  assert.match(exportContent(meeting, "markdown"), /Agent results/);
  assert.equal(isMeeting({ ...meeting, agentWork: [null] }), false);
});
