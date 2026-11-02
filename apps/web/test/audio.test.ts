import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AudioQueue, type AudioChunk } from "../src/audio-queue";
import { pcmWav } from "../src/wav";

const chunk = (id: string): AudioChunk => ({ id, startMs: 0, wav: new Blob([id]) });

test("PCM WAV uses a mono signed 16-bit header and clips samples", async () => {
  const blob = pcmWav(new Float32Array([-2, -1, 0, 1, 2]), 16000);
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(blob.type, "audio/wav");
  assert.equal(bytes.byteLength, 54);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767]);
});

test("failed audio is retained and retried with the same chunk identity", async () => {
  const sent: AudioChunk[] = [];
  let fail = true;
  let notify!: () => void;
  const failed = new Promise<void>(resolve => { notify = resolve; });
  const queue = new AudioQueue(async chunk => {
    sent.push(chunk);
    if (fail) throw new Error("Hex unavailable");
  }, state => { if (state.error && !state.uploading) notify(); });
  const first = chunk("first");
  queue.add(first);
  queue.add(chunk("second"));
  await failed;
  assert.equal(queue.getSnapshot().pending.length, 2);
  assert.equal(queue.getSnapshot().error, "Hex unavailable");
  fail = false;
  await queue.retry();
  assert.deepEqual(sent.map(chunk => chunk.id), ["first", "first", "second"]);
  assert.equal(sent[0], sent[1]);
  assert.equal(queue.getSnapshot().pending.length, 0);
});

test("queue capacity bounds memory and uploads remain sequential", async () => {
  const releases: (() => void)[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const queue = new AudioQueue(async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise<void>(resolve => { releases.push(resolve); });
    concurrent--;
  }, () => undefined, 2);
  queue.add(chunk("one"));
  queue.add(chunk("two"));
  assert.throws(() => queue.add(chunk("overflow")), /queue is full/);
  assert.equal(queue.getSnapshot().pending.length, 2);
  releases.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  releases.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(queue.getSnapshot().pending.length, 0);
  assert.equal(maxConcurrent, 1);
});

interface Processor {
  port: { onmessage: (event: { data: string }) => void };
  process(inputs: Float32Array[][]): boolean;
}

function worklet() {
  const messages: { type: string; samples?: Float32Array; sampleRate?: number }[] = [];
  let ProcessorClass!: new () => Processor;
  runInNewContext(readFileSync(new URL("../public/pcm-worklet.js", import.meta.url), "utf8"), {
    sampleRate: 10,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: typeof messages[number]) => messages.push(message) }; },
    registerProcessor: (_name: string, value: typeof ProcessorClass) => { ProcessorClass = value; },
  });
  return { processor: new ProcessorClass(), messages };
}

test("AudioWorklet emits 15-second mono chunks and flushes on stop", () => {
  const { processor, messages } = worklet();
  processor.process([[new Float32Array(160).fill(.5), new Float32Array(160).fill(-.5)]]);
  assert.equal(messages[0].type, "chunk");
  assert.equal(messages[0].samples?.length, 150);
  assert.ok(messages[0].samples?.every(sample => sample === 0));
  processor.port.onmessage({ data: "ack" });
  processor.port.onmessage({ data: "stop" });
  assert.equal(messages[1].samples?.length, 10);
  assert.equal(messages[2].type, "stopped");
  assert.equal(processor.process([[new Float32Array(10)]]), false);
});

test("AudioWorklet stops at a chunk boundary if the main thread stops acknowledging", () => {
  const { processor, messages } = worklet();
  assert.equal(processor.process([[new Float32Array(150)]]), true);
  assert.equal(processor.process([[new Float32Array(150)]]), false);
  assert.deepEqual(messages.map(message => message.type), ["chunk", "chunk", "overflow"]);
});
