export function validateWav(wav: Buffer): void {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected a PCM WAV file, not compressed WebM or M4A audio.");
  }
  let byteRate = 0;
  let blockAlign = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("The WAV file is truncated.");
    if (name === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format.");
      const format = wav.readUInt16LE(start);
      const channels = wav.readUInt16LE(start + 2);
      const sampleRate = wav.readUInt32LE(start + 4);
      const bits = wav.readUInt16LE(start + 14);
      byteRate = wav.readUInt32LE(start + 8);
      blockAlign = wav.readUInt16LE(start + 12);
      if (format !== 1 || bits !== 16 || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000
        || byteRate !== sampleRate * channels * 2 || blockAlign !== channels * 2) {
        throw new Error("Use 16-bit PCM WAV, 8–192 kHz, with 1–8 channels.");
      }
    }
    if (name === "data") dataSize += size;
    offset = start + size + (size % 2);
  }
  if (!byteRate || !dataSize || dataSize % blockAlign !== 0) throw new Error("The WAV file has no valid audio frames.");
  if (dataSize / byteRate > 120) throw new Error("Use audio chunks of at most 120 seconds.");
}
