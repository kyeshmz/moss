import test from "node:test";
import assert from "node:assert/strict";
import { DRAFT_KEY, DRAFT_LIMITS, DraftStore } from "../src/drafts";

function storage(raw: string | null = null) {
  let value = raw;
  return { store: new DraftStore(() => ({ getItem: () => value, setItem: (_key, next) => { value = next; } })), raw: () => value };
}

test("draft storage is versioned and only stores edited values and their bases", () => {
  const data = new Map<string, string>();
  const store = new DraftStore(() => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } }));
  const draft = { notes: "New", expected: { notes: "Old" }, conflicted: true };
  store.save({ one: draft });
  assert.deepEqual(JSON.parse(data.get(DRAFT_KEY)!), { version: 1, drafts: { one: draft } });
  assert.deepEqual(store.load(), { drafts: { one: draft }, error: null });
});

test("malformed, unsupported, and oversized storage does not crash or alter the original", () => {
  for (const raw of ["{broken", "null", '{"version":2,"drafts":{}}', "x".repeat(DRAFT_LIMITS.characters + 1)]) {
    const { store, raw: read } = storage(raw);
    assert.deepEqual(store.load().drafts, {});
    assert.match(store.load().error!, /could not be read/);
    assert.equal(read(), raw);
  }
});

test("invalid records are skipped while valid drafts remain recoverable", () => {
  const record = JSON.stringify({ version: 1, drafts: {
    good: { title: "New", expected: { title: "Old" } },
    missingBase: { notes: "New", expected: {} },
    wrongType: { notes: 42, expected: { notes: "" } },
    tooLong: { title: "x".repeat(DRAFT_LIMITS.title + 1), expected: { title: "" } },
    extraData: { notes: "New", expected: { notes: "" }, segments: [] },
    constructor: { notes: "New", expected: { notes: "" } },
  } });
  const { store, raw } = storage(record);
  assert.deepEqual(store.load().drafts, { good: { title: "New", expected: { title: "Old" } } });
  assert.match(store.load().error!, /Some saved drafts were invalid/);
  assert.equal(raw(), record);
});

test("draft count and total size are bounded without evicting previously saved edits", () => {
  const { store, raw } = storage();
  const draft = { notes: "New", expected: { notes: "Old" } };
  store.save({ one: draft });
  const saved = raw();
  const tooMany = Object.fromEntries(Array.from({ length: DRAFT_LIMITS.count + 1 }, (_, i) => [`meeting-${i}`, draft]));
  assert.throws(() => store.save(tooMany), /limits exceeded/);
  const large = { notes: "n".repeat(DRAFT_LIMITS.notes), expected: { notes: "b".repeat(DRAFT_LIMITS.notes) } };
  assert.throws(() => store.save(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`meeting-${i}`, large]))), /storage is full/);
  assert.equal(raw(), saved);
});

test("denied browser storage access is reported during load and save", () => {
  const store = new DraftStore(() => { throw new Error("SecurityError"); });
  assert.match(store.load().error!, /could not be read/);
  assert.throws(() => store.save({}), /unavailable or full/);
});
