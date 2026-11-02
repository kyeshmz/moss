import { test } from "node:test";
import assert from "node:assert/strict";
import { aiSummary } from "../src/summary.js";
import { newMeeting } from "@moss/core";

test("remote AI summaries require explicit consent before any request", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected external request"); };
  try {
    process.env.SUMMARY_BASE_URL = "https://provider.example/v1";
    process.env.SUMMARY_MODEL = "test-model";
    delete process.env.SUMMARY_ALLOW_REMOTE;
    const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
    meeting.notes = "Private meeting notes";
    await assert.rejects(aiSummary(meeting), /explicit consent/);
    assert.equal(calls, 0);
    process.env.SUMMARY_ALLOW_REMOTE = "true";
    process.env.SUMMARY_BASE_URL = "http://provider.example/v1";
    await assert.rejects(aiSummary(meeting), /HTTPS/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = previous;
  }
});

test("AI summaries refuse oversized text instead of sending silently truncated input", async () => {
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected external request"); };
  try {
    process.env.SUMMARY_MODEL = "test-model";
    process.env.SUMMARY_BASE_URL = "http://127.0.0.1:11434/v1";
    const meeting = newMeeting("be197276-e0d0-42f7-9b58-c4d3ed567b8e");
    meeting.notes = "private".repeat(20_000);
    await assert.rejects(aiSummary(meeting), /no partial summary was sent/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = previous;
  }
});
