import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AudioImportHealth, Segment } from "@moss/contracts";
import { validateWav } from "./audio.js";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const SAMPLE_RATE = 16000;
const BYTE_RATE = SAMPLE_RATE * 2;
const CHUNK_BYTES = 90 * BYTE_RATE;
const CONVERSION_TIMEOUT_MS = 120_000;
const FORMATS = ["mp3", "m4a", "wav", "flac", "ogg", "aiff", "aac", "webm"];
const DEMUXERS = "mp3,mov,wav,flac,ogg,aiff,aac,matroska,webm";

interface ImportOptions {
  signal: AbortSignal;
  transcribe: (wav: Uint8Array, signal: AbortSignal) => Promise<{ transcript: string; durationMs: number }>;
}

class AudioImportError extends Error {}

function findFFmpeg(): string | undefined {
  const candidates = process.env.FFMPEG_BIN ? [process.env.FFMPEG_BIN] : [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, "ffmpeg")),
    "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg",
  ];
  return candidates.find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
}

export function audioImportStatus(): AudioImportHealth {
  const available = Boolean(findFFmpeg());
  return {
    available,
    message: available
      ? "Local ffmpeg supports common audio files. Corrupt, encrypted, or unsupported codecs cannot be imported."
      : "Audio import needs a local ffmpeg executable. Install it or set FFMPEG_BIN, then retry.",
    formats: [...FORMATS], maxBytes: MAX_BYTES, maxDurationMs: MAX_DURATION_MS,
  };
}

function cancelled(): DOMException { return new DOMException("Audio import cancelled.", "AbortError"); }
function checkCancellation(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

async function convert(executable: string, source: string, output: string, signal: AbortSignal): Promise<void> {
  checkCancellation(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-xerror",
      "-err_detect", "explode", "-protocol_whitelist", "file", "-format_whitelist", DEMUXERS,
      "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-af", "asetpts=N/SR/TB", "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le",
      "-t", String(MAX_DURATION_MS / 1000 + 1), "-f", "wav", output,
    ], { shell: false, stdio: "ignore" });
    let timedOut = false;
    let spawnFailed = false;
    const abort = () => { child.kill("SIGKILL"); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, CONVERSION_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", () => { spawnFailed = true; });
    child.once("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(cancelled());
      else if (timedOut) reject(new AudioImportError("Audio conversion timed out. Try a shorter file."));
      else if (spawnFailed) reject(new AudioImportError("ffmpeg could not start. Check the local ffmpeg installation."));
      else if (code !== 0) reject(new AudioImportError("This audio file is invalid, encrypted, or uses an unsupported codec. Try another audio file."));
      else resolve();
    });
  });
}

async function pcmData(file: FileHandle): Promise<{ offset: number; size: number }> {
  const { size } = await file.stat();
  const header = Buffer.alloc(Math.min(size, 64 * 1024));
  await file.read(header, 0, header.length, 0);
  const invalid = () => new AudioImportError("Audio conversion produced an invalid WAV file. Try another audio file.");
  if (header.length < 44 || header.toString("ascii", 0, 4) !== "RIFF"
    || header.toString("ascii", 8, 12) !== "WAVE" || header.readUInt32LE(4) + 8 !== size) throw invalid();
  let formatValid = false;
  for (let offset = 12; offset + 8 <= header.length;) {
    const name = header.toString("ascii", offset, offset + 4);
    const length = header.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > size) throw invalid();
    if (name === "fmt ") {
      if (length < 16 || start + length > header.length) throw invalid();
      formatValid = header.readUInt16LE(start) === 1 && header.readUInt16LE(start + 2) === 1
        && header.readUInt32LE(start + 4) === SAMPLE_RATE && header.readUInt32LE(start + 8) === BYTE_RATE
        && header.readUInt16LE(start + 12) === 2 && header.readUInt16LE(start + 14) === 16;
    }
    if (name === "data") {
      if (!formatValid || !length || length % 2 || start + length !== size) throw invalid();
      if (length / BYTE_RATE * 1000 > MAX_DURATION_MS) {
        throw new AudioImportError("Audio files must be no longer than 2 hours. Split the file and try again.");
      }
      return { offset: start, size: length };
    }
    offset = start + length + (length % 2);
  }
  throw invalid();
}

function chunkWav(pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(BYTE_RATE, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  validateWav(wav);
  return wav;
}

function segmentID(sourceHash: Buffer, index: number): string {
  const digest = createHash("sha256").update("moss-audio-import-v1\0").update(sourceHash).update(`\0${index}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function transcribe(wav: Buffer, options: ImportOptions): Promise<string> {
  checkCancellation(options.signal);
  let abort!: () => void;
  try {
    const result = await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => reject(cancelled());
        options.signal.addEventListener("abort", abort, { once: true });
      }),
      Promise.resolve().then(() => {
        checkCancellation(options.signal);
        return options.transcribe(wav, options.signal);
      }),
    ]);
    checkCancellation(options.signal);
    if (typeof result.transcript !== "string") throw new Error("Invalid transcription result.");
    return result.transcript;
  } catch {
    checkCancellation(options.signal);
    throw new AudioImportError("Speech recognition failed. No audio segments were imported. Try again.");
  } finally { options.signal.removeEventListener("abort", abort); }
}

export async function importAudioFile(bytes: Uint8Array, options: ImportOptions): Promise<Segment[]> {
  checkCancellation(options.signal);
  if (!bytes.byteLength) throw new AudioImportError("Choose an audio file that contains audio.");
  if (bytes.byteLength > MAX_BYTES) throw new AudioImportError("Audio files must be 100 MiB or smaller. Split the file and try again.");
  const executable = findFFmpeg();
  if (!executable) throw new AudioImportError(audioImportStatus().message);
  const source = Buffer.from(bytes);
  const sourceHash = createHash("sha256").update(source).digest();
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "moss-audio-import-"));
    await chmod(directory, 0o700);
    const input = join(directory, "source");
    const output = join(directory, "converted.wav");
    await writeFile(input, source, { mode: 0o600, flag: "wx", signal: options.signal });
    await writeFile(output, new Uint8Array(), { mode: 0o600, flag: "wx" });
    await convert(executable, input, output, options.signal);
    await rm(input);
    checkCancellation(options.signal);
    const file = await open(output, "r");
    try {
      const data = await pcmData(file);
      const segments: Segment[] = [];
      for (let offset = 0; offset < data.size; offset += CHUNK_BYTES) {
        checkCancellation(options.signal);
        const pcm = Buffer.alloc(Math.min(CHUNK_BYTES, data.size - offset));
        const { bytesRead } = await file.read(pcm, 0, pcm.length, data.offset + offset);
        if (bytesRead !== pcm.length) throw new AudioImportError("The converted audio is incomplete. Try again.");
        const wav = chunkWav(pcm);
        const text = await transcribe(wav, options);
        segments.push({ id: segmentID(sourceHash, segments.length), startMs: offset / BYTE_RATE * 1000,
          durationMs: Math.ceil(pcm.length / BYTE_RATE * 1000), text });
      }
      checkCancellation(options.signal);
      return segments;
    } finally { await file.close(); }
  } catch (error) {
    checkCancellation(options.signal);
    if (error instanceof AudioImportError) throw error;
    throw new AudioImportError("Audio import failed. Check available temporary disk space and try another file.");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
