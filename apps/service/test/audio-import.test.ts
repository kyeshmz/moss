import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { audioImportStatus, importAudioFile } from "../src/audio-import.js";
import { validateWav } from "../src/audio.js";

const realFFmpeg = [process.env.FFMPEG_BIN,
  ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, "ffmpeg")),
  "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg",
].find((path): path is string => {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
});

async function isolated<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const saved = { TMPDIR: process.env.TMPDIR, FFMPEG_BIN: process.env.FFMPEG_BIN, PATH: process.env.PATH };
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "moss-audio-test-"));
  process.env.TMPDIR = directory;
  if (realFFmpeg) process.env.FFMPEG_BIN = realFFmpeg;
  try { return await run(directory); }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function wav(seconds: number): Buffer {
  const buffer = Buffer.alloc(44 + Math.round(seconds * 16000) * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

function encode(directory: string, format: string, codec: string, seconds = 0.25): Buffer {
  const output = join(directory, "fixture");
  execFileSync(realFFmpeg!, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", String(seconds),
    "-ac", "2", "-c:a", codec, "-f", format, output], { stdio: "ignore", timeout: 30_000 });
  return readFileSync(output);
}

function assertMonoWav(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes);
  validateWav(buffer);
  assert.equal(buffer.readUInt16LE(20), 1);
  assert.equal(buffer.readUInt16LE(22), 1);
  assert.equal(buffer.readUInt32LE(24), 16000);
  assert.equal(buffer.readUInt16LE(34), 16);
  const durationMs = (buffer.length - 44) / 32000 * 1000;
  assert.ok(durationMs > 0 && durationMs <= 90_000);
  return Math.ceil(durationMs);
}

test("status discovers ffmpeg without inference and reports honest limits", async () => isolated(async directory => {
  process.env.FFMPEG_BIN = join(directory, "not-installed");
  const missing = audioImportStatus();
  assert.equal(missing.available, false);
  assert.match(missing.message, /FFMPEG_BIN/);
  assert.equal(missing.maxBytes, 100 * 1024 * 1024);
  assert.equal(missing.maxDurationMs, 7_200_000);
  assert.deepEqual(missing.formats, ["mp3", "m4a", "wav", "flac", "ogg", "aiff", "aac", "webm"]);
  missing.formats.length = 0;
  assert.equal(audioImportStatus().formats.length, 8);
  await assert.rejects(importAudioFile(wav(1), { signal: new AbortController().signal,
    transcribe: async () => { assert.fail("Missing ffmpeg must not start inference."); } }), /local ffmpeg/);
  if (realFFmpeg) {
    process.env.FFMPEG_BIN = realFFmpeg;
    assert.equal(audioImportStatus().available, true);
    assert.match(audioImportStatus().message, /unsupported codecs/);
  }
  if (existsSync("/opt/homebrew/bin/ffmpeg") || existsSync("/usr/local/bin/ffmpeg")) {
    delete process.env.FFMPEG_BIN;
    process.env.PATH = "";
    assert.equal(audioImportStatus().available, true);
  }
  assert.deepEqual(readdirSync(directory), []);
}));

test("actual ffmpeg detects common formats from bytes and produces mono PCM", { skip: !realFFmpeg }, async () => isolated(async directory => {
  const formats = [
    ["mp3", "libmp3lame"], ["ipod", "aac"], ["wav", "pcm_s24le"], ["flac", "flac"],
    ["ogg", "libopus"], ["aiff", "pcm_s16be"], ["adts", "aac"], ["webm", "libopus"],
  ];
  for (const [format, codec] of formats) {
    const input = encode(directory, format, codec);
    const signal = new AbortController().signal;
    const durations: number[] = [];
    const segments = await importAudioFile(input, { signal, transcribe: async (bytes, passedSignal) => {
      assert.equal(passedSignal, signal);
      durations.push(assertMonoWav(bytes));
      const imports = readdirSync(directory).filter(name => name.startsWith("moss-audio-import-"));
      assert.equal(imports.length, 1);
      assert.deepEqual(readdirSync(join(directory, imports[0])), ["converted.wav"]);
      return { transcript: `Synthetic ${format}`, durationMs: -999 };
    } });
    assert.equal(segments.length, 1, format);
    assert.equal(segments[0].startMs, 0);
    assert.equal(segments[0].durationMs, durations[0]);
    assert.ok(segments[0].durationMs >= 250 && segments[0].durationMs < 600, format);
    assert.equal(segments[0].text, `Synthetic ${format}`);
    assert.deepEqual(readdirSync(directory), ["fixture"]);
  }
}));

test("exact 90-second segments have relative offsets, source-derived UUIDs, and truthful durations", { skip: !realFFmpeg }, async () => isolated(async directory => {
  const input = wav(180.123);
  const original = Buffer.from(input);
  const calls: number[] = [];
  const options = { signal: new AbortController().signal, transcribe: async (bytes: Uint8Array) => {
    calls.push(assertMonoWav(bytes));
    return { transcript: "Synthetic transcript", durationMs: Number.NaN };
  } };
  const firstImport = importAudioFile(input, options);
  input.fill(0);
  const first = await firstImport;
  assert.deepEqual(calls, [90_000, 90_000, 123]);
  assert.deepEqual(first.map(segment => segment.startMs), [0, 90_000, 180_000]);
  assert.deepEqual(first.map(segment => segment.durationMs), [90_000, 90_000, 123]);
  assert.equal(new Set(first.map(segment => segment.id)).size, 3);
  for (const segment of first) assert.match(segment.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const retry = await importAudioFile(original, options);
  assert.deepEqual(retry, first);
  original[44] = 1;
  const changed = await importAudioFile(original, options);
  assert.ok(changed.every((segment, index) => segment.id !== first[index].id));
  assert.deepEqual(readdirSync(directory), []);
}));

test("empty, oversize, malformed, truncated, and playlist files never start inference", { skip: !realFFmpeg }, async () => isolated(async directory => {
  let calls = 0;
  const options = { signal: new AbortController().signal, transcribe: async () => {
    calls++; return { transcript: "Must not happen", durationMs: 1 };
  } };
  await assert.rejects(importAudioFile(Buffer.alloc(0), options), /contains audio/);
  await assert.rejects(importAudioFile(Buffer.alloc(100 * 1024 * 1024 + 1), options), /100 MiB/);
  for (const invalid of [Buffer.from("not audio"), wav(1).subarray(0, 100),
    Buffer.from("#EXTM3U\n#EXTINF:10,Audio\nhttps://127.0.0.1:1/private.mp3\n"),
    Buffer.from("ffconcat version 1.0\nfile 'file:/etc/passwd'\n"),
    Buffer.from("[playlist]\nFile1=http://127.0.0.1:1/private.mp3\nNumberOfEntries=1\n"),
  ]) await assert.rejects(importAudioFile(invalid, options), /invalid|unsupported codec/);
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(directory), []);
}));

test("two-hour bound is checked after complete conversion and never silently truncated", { skip: !realFFmpeg }, async () => isolated(async directory => {
  const input = encode(directory, "flac", "flac", 7201.25);
  assert.ok(input.byteLength < 100 * 1024 * 1024);
  let calls = 0;
  await assert.rejects(importAudioFile(input, { signal: new AbortController().signal, transcribe: async () => {
    calls++; return { transcript: "Must not happen", durationMs: 1 };
  } }), /no longer than 2 hours/);
  assert.equal(calls, 0);
  const segments = await importAudioFile(encode(directory, "flac", "flac", 7200), {
    signal: new AbortController().signal, transcribe: async bytes => {
      assert.equal(assertMonoWav(bytes), 90_000);
      calls++;
      return { transcript: "Synthetic two-hour fixture", durationMs: 1 };
    },
  });
  assert.equal(calls, 80);
  assert.equal(segments.length, 80);
  assert.equal(segments.at(-1)!.startMs + segments.at(-1)!.durationMs, 7_200_000);
  assert.deepEqual(readdirSync(directory), ["fixture"]);
}));

test("all segments remain staged when a later inference fails", { skip: !realFFmpeg }, async () => isolated(async directory => {
  writeFileSync(join(directory, "unrelated"), "keep");
  let calls = 0;
  await assert.rejects(importAudioFile(wav(91), { signal: new AbortController().signal, transcribe: async bytes => {
    assertMonoWav(bytes);
    if (++calls === 2) throw new Error("private provider details");
    return { transcript: "Not committed", durationMs: 90_000 };
  } }), /Speech recognition failed\. No audio segments were imported/);
  assert.equal(calls, 2);
  assert.deepEqual(readdirSync(directory), ["unrelated"]);
  assert.equal(readFileSync(join(directory, "unrelated"), "utf8"), "keep");
}));

test("an already cancelled import creates no files and starts no inference", async () => isolated(async directory => {
  const controller = new AbortController();
  controller.abort(new Error("Private cancellation reason"));
  await assert.rejects(importAudioFile(wav(1), { signal: controller.signal,
    transcribe: async () => { assert.fail("Cancelled import started inference."); } }), { name: "AbortError", message: "Audio import cancelled." });
  assert.deepEqual(readdirSync(directory), []);
}));

function waitForFile(directory: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_, filename) => {
      if (filename === name && existsSync(join(directory, name))) { cleanup(); resolve(); }
    });
    const timer = setTimeout(() => { cleanup(); reject(new Error("Conversion fixture did not start.")); }, 5000);
    const cleanup = () => { watcher.close(); clearTimeout(timer); };
  });
}

function stalledFFmpeg(directory: string): string {
  const marker = join(directory, "started.json");
  const executable = join(directory, "fake-ffmpeg");
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(marker + ".pending")}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\nfs.renameSync(${JSON.stringify(marker + ".pending")}, ${JSON.stringify(marker)});\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  process.env.FFMPEG_BIN = executable;
  return marker;
}

test("conversion cancellation kills its process, enforces allowlists and private files, and cleans only owned paths", async () => isolated(async directory => {
  const marker = stalledFFmpeg(directory);
  writeFileSync(join(directory, "unrelated"), "keep");
  const started = waitForFile(directory, "started.json");
  const controller = new AbortController();
  const importing = importAudioFile(wav(1), { signal: controller.signal,
    transcribe: async () => { assert.fail("Cancelled conversion started inference."); } });
  const rejected = assert.rejects(importing, { name: "AbortError" });
  try {
    await started;
    const { pid, args } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; args: string[] };
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
    assert.equal(args[args.indexOf("-format_whitelist") + 1], "mp3,mov,wav,flac,ogg,aiff,aac,matroska,webm");
    assert.equal(args[args.indexOf("-t") + 1], "7201");
    assert.equal(args[args.indexOf("-ac") + 1], "1");
    assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s16le");
    const source = args[args.indexOf("-i") + 1];
    assert.equal(dirname(dirname(source)), directory);
    assert.equal(statSync(dirname(source)).mode & 0o777, 0o700);
    assert.equal(statSync(source).mode & 0o777, 0o600);
    assert.equal(statSync(args.at(-1)!).mode & 0o777, 0o600);
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(readdirSync(directory).sort(), ["fake-ffmpeg", "started.json", "unrelated"]);
  } finally { controller.abort(); await rejected; }
}));

test("the finite conversion deadline kills a stalled process and cleans temporary audio", async t => isolated(async directory => {
  const marker = stalledFFmpeg(directory);
  const started = waitForFile(directory, "started.json");
  const realSetTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 120_000) expire = () => callback(...args);
    return realSetTimeout(callback, delay, ...args);
  });
  const controller = new AbortController();
  const rejected = assert.rejects(importAudioFile(wav(1), { signal: controller.signal,
    transcribe: async () => { assert.fail("Timed out conversion started inference."); } }), /conversion timed out/);
  try {
    await started;
    assert.ok(expire, "Conversion must install its two-minute deadline.");
    expire();
    await rejected;
    const { pid } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(readdirSync(directory).sort(), ["fake-ffmpeg", "started.json"]);
  } finally { controller.abort(); await rejected; }
}));

test("cancellation during inference is prompt even if the transcriber ignores its signal", { skip: !realFFmpeg }, async () => isolated(async directory => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(importAudioFile(wav(91), { signal: controller.signal, transcribe: async (_, signal) => {
    assert.equal(signal, controller.signal);
    calls++;
    setImmediate(() => controller.abort());
    return new Promise<never>(() => {});
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.deepEqual(readdirSync(directory), []);
}));

test("synchronous transcriber cancellation cannot return a partial result", { skip: !realFFmpeg }, async () => isolated(async directory => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(importAudioFile(wav(91), { signal: controller.signal, transcribe: () => {
    calls++;
    controller.abort();
    throw new Error("Synchronous provider failure");
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.deepEqual(readdirSync(directory), []);
}));
