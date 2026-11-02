import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../src/recorder";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fakeCapture(t: TestContext, options: { denied?: boolean; moduleFails?: boolean; delayed?: boolean; finalChunk?: boolean } = {}) {
  let stops = 0;
  let closes = 0;
  let grant!: () => void;
  const track = { stop: () => { stops++; }, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const worklets: FakeWorklet[] = [];
  class FakeWorklet {
    onprocessorerror: (() => void) | null = null;
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: string) => {
        if (message === "stop") queueMicrotask(() => {
          if (options.finalChunk) this.port.onmessage?.({ data: { type: "chunk", samples: new Float32Array(8000), sampleRate: 16000 } });
          this.port.onmessage?.({ data: { type: "stopped" } });
        });
      },
      close: () => undefined,
    };
    constructor() { worklets.push(this); }
    connect() {}
    disconnect() {}
  }
  class FakeContext {
    state = "running";
    destination = {};
    audioWorklet = { addModule: async () => { if (options.moduleFails) throw new Error("Worklet unavailable"); } };
    async resume() {}
    createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined }; }
    async close() { closes++; this.state = "closed"; }
  }
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: async () => {
      if (options.denied) throw new Error("Microphone permission denied");
      if (options.delayed) await new Promise<void>(resolve => { grant = resolve; });
      return stream;
    } } },
    AudioContext: FakeContext,
    AudioWorkletNode: FakeWorklet,
  };
  for (const [key, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { stops: () => stops, closes: () => closes, grant: () => grant(), worklets };
}

test("stop closes microphone tracks and AudioContext", async t => {
  const capture = fakeCapture(t);
  const recorder = new Recorder(async () => undefined);
  await recorder.start("meeting", 0);
  assert.equal(recorder.getSnapshot().phase, "recording");
  await recorder.stop();
  assert.equal(capture.stops(), 1);
  assert.equal(capture.closes(), 1);
  assert.equal(recorder.getSnapshot().phase, "idle");
});

test("permission rejection closes the allocated AudioContext", async t => {
  const capture = fakeCapture(t, { denied: true });
  const recorder = new Recorder(async () => undefined);
  await recorder.start("meeting", 0);
  assert.equal(capture.closes(), 1);
  assert.match(recorder.getSnapshot().error!, /permission denied/);
  assert.equal(recorder.getSnapshot().phase, "idle");
});

test("worklet setup failure closes both microphone and AudioContext", async t => {
  const capture = fakeCapture(t, { moduleFails: true });
  const recorder = new Recorder(async () => undefined);
  await recorder.start("meeting", 0);
  assert.equal(capture.stops(), 1);
  assert.equal(capture.closes(), 1);
  assert.equal(recorder.getSnapshot().error, "Worklet unavailable");
});

test("a permission request completing after disposal cannot reopen capture", async t => {
  const capture = fakeCapture(t, { delayed: true });
  const recorder = new Recorder(async () => undefined);
  const starting = recorder.start("meeting", 0);
  await tick();
  recorder.dispose();
  capture.grant();
  await starting;
  await tick();
  assert.equal(capture.stops(), 1);
  assert.equal(capture.closes(), 1);
  assert.equal(capture.worklets.length, 0);
  assert.equal(recorder.getSnapshot().phase, "idle");
});

test("transcription failure stops capture and retains the failed WAV for retry", async t => {
  const capture = fakeCapture(t);
  let fail = true;
  const uploaded: string[] = [];
  const recorder = new Recorder(async (_id, chunk) => {
    uploaded.push(chunk.id);
    if (fail) throw new Error("Hex is unavailable");
  });
  await recorder.start("meeting", 42000);
  capture.worklets[0].port.onmessage?.({ data: { type: "chunk", samples: new Float32Array(16000), sampleRate: 16000 } });
  await tick();
  assert.equal(recorder.getSnapshot().phase, "idle");
  assert.equal(capture.stops(), 1);
  assert.equal(capture.closes(), 1);
  assert.equal(recorder.getSnapshot().pending.length, 1);
  assert.equal(recorder.getSnapshot().pending[0].startMs, 42000);
  assert.equal(recorder.getSnapshot().pending[0].wav.type, "audio/wav");
  fail = false;
  await recorder.retry();
  assert.equal(recorder.getSnapshot().pending.length, 0);
  assert.deepEqual(uploaded, [uploaded[0], uploaded[0]]);
});

for (const capacity of [2, 5]) {
  test(`queue capacity ${capacity} reserves its final partial chunk and recovers every UUID`, async t => {
    const capture = fakeCapture(t, { finalChunk: true });
    let fail!: (error: Error) => void;
    const uploaded: string[] = [];
    const recorder = new Recorder(async (_id, chunk) => {
      uploaded.push(chunk.id);
      if (uploaded.length === 1) await new Promise<void>((_resolve, reject) => { fail = reject; });
    }, capacity);
    await recorder.start("meeting", 0);
    for (let i = 0; i < capacity - 1; i++) {
      if (i < capacity - 2) assert.equal(recorder.getSnapshot().phase, "recording");
      capture.worklets[0].port.onmessage?.({ data: { type: "chunk", samples: new Float32Array(240000), sampleRate: 16000 } });
    }
    await recorder.stop();
    assert.equal(recorder.getSnapshot().phase, "idle");
    const retained = [...recorder.getSnapshot().pending];
    assert.equal(retained.length, capacity);
    assert.equal(retained.at(-1)?.startMs, (capacity - 1) * 15000);
    assert.equal(capture.stops(), 1);
    fail(new Error("Timed out"));
    await tick();
    assert.equal(recorder.getSnapshot().pending.length, capacity);
    await recorder.retry();
    assert.deepEqual(uploaded, [retained[0].id, ...retained.map(chunk => chunk.id)]);
    assert.equal(recorder.getSnapshot().pending.length, 0);
  });
}

test("discard requires confirmation, stopped capture, and no in-flight upload", async t => {
  const capture = fakeCapture(t);
  let reject!: (error: Error) => void;
  let fail = true;
  const recorder = new Recorder(async () => { if (fail) await new Promise<void>((_resolve, fail) => { reject = fail; }); });
  await recorder.start("meeting", 0);
  assert.throws(() => recorder.discardPending(true), /Stop capture/);
  capture.worklets[0].port.onmessage?.({ data: { type: "chunk", samples: new Float32Array(16000), sampleRate: 16000 } });
  await recorder.stop();
  assert.throws(() => recorder.discardPending(true), /wait for the current upload/);
  reject(new Error("Hex unavailable"));
  await tick();
  const retained = recorder.getSnapshot().pending[0];
  recorder.discardPending(false);
  assert.equal(recorder.getSnapshot().pending[0], retained);
  recorder.discardPending(true);
  assert.equal(recorder.getSnapshot().pending.length, 0);
  assert.equal(recorder.getSnapshot().meetingId, null);
  assert.equal(recorder.getSnapshot().error, null);
  fail = false;
  await recorder.start("other-meeting", 0);
  assert.equal(recorder.getSnapshot().phase, "recording");
  await recorder.stop();
});
