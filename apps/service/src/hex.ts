import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { create, MODEL_IDS, type ModelId, type Transcriber } from "@kitlangton/hex";
import type { Health } from "@moss/contracts";

function findExecutable(): string | undefined {
  const candidates = process.env.HEX_BIN ? [process.env.HEX_BIN] : [
    "/Applications/Hex.app/Contents/MacOS/hex",
    ...(process.env.PATH ?? "").split(delimiter).map(path => join(path, process.platform === "win32" ? "hex.exe" : "hex")),
  ];
  return candidates.find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

export class HexEngine {
  private readonly executable = findExecutable();
  private readonly model = process.env.HEX_MODEL ?? "parakeet_unified_en";
  private transcriber?: Promise<Transcriber>;
  private busy = false;
  private readonly lifetime = new AbortController();
  private state: Health["hex"] = { state: this.executable ? "idle" : "unavailable", model: this.model,
    message: this.executable ? "Ready to load the local speech model." : "Install Hex, then restart the Moss service." };

  status() { return { ...this.state }; }

  async prepare() {
    if (!this.executable) throw new Error("Hex is not installed. Install it from anoma.ly/hex, then restart the service.");
    if (!MODEL_IDS.includes(this.model as typeof MODEL_IDS[number]) && !this.model.startsWith("custom-")) throw new Error("Unknown HEX_MODEL.");
    if (!this.transcriber) {
      this.state = { ...this.state, state: "preparing", message: "Preparing local model. The first run may download model files." };
      this.transcriber = create({ command: [this.executable, "service", "--embedded"], model: this.model as ModelId,
        language: process.env.HEX_LANGUAGE ?? "en", signal: this.lifetime.signal,
        onProgress: progress => {
          const message = progress.type === "downloading"
            ? `Downloading speech model${progress.totalBytes ? ` · ${Math.round(progress.downloadedBytes / progress.totalBytes * 100)}%` : ""}`
            : progress.type === "verifying" ? "Verifying speech model…" : "Loading speech model…";
          this.state = { ...this.state, state: "preparing", message };
        },
      }).then(transcriber => {
        this.state = { ...this.state, state: "ready", message: "Speech recognition is running on this device." };
        return transcriber;
      }).catch(error => {
        this.transcriber = undefined;
        this.state = { ...this.state, state: "error", message: error instanceof Error ? error.message : "Hex failed to start." };
        throw error;
      });
    }
    await this.transcriber;
  }

  async transcribe(wav: Uint8Array, signal?: AbortSignal) {
    if (this.busy) throw new Error("Hex is processing another audio chunk. Try again shortly.");
    this.busy = true;
    try {
      await this.prepare();
      return await (await this.transcriber!).transcribe(wav, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
      });
    } catch (error) {
      const previous = this.transcriber;
      this.transcriber = undefined;
      if (previous) await previous.then(transcriber => transcriber.close(), () => {});
      this.state = { ...this.state, state: this.executable ? "error" : "unavailable",
        message: error instanceof Error ? error.message : "Transcription failed." };
      throw error;
    } finally { this.busy = false; }
  }

  async close() {
    this.lifetime.abort();
    if (this.transcriber) await this.transcriber.then(transcriber => transcriber.close(), () => {});
  }
}
