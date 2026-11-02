import { AudioQueue, type AudioChunk, type QueueState } from "./audio-queue";
import { errorMessage } from "./api";
import { pcmWav } from "./wav";

export interface RecordingState {
  phase: "idle" | "starting" | "recording" | "stopping";
  meetingId: string | null;
  elapsedMs: number;
  pending: readonly AudioChunk[];
  uploading: boolean;
  error: string | null;
}

export class Recorder {
  private state: RecordingState = { phase: "idle", meetingId: null, elapsedMs: 0, pending: [], uploading: false, error: null };
  private listeners = new Set<() => void>();
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private queue?: AudioQueue;
  private startedAt = 0;
  private nextStartMs = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopped?: () => void;
  private stopping?: Promise<void>;
  private generation = 0;

  constructor(private readonly upload: (meetingId: string, chunk: AudioChunk) => Promise<void>, private readonly queueCapacity?: number) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<RecordingState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  private queueChanged = (queue: QueueState) => {
    this.update({ pending: queue.pending, uploading: queue.uploading, error: queue.error ?? this.state.error });
    if (queue.error && this.state.phase === "recording") void this.stop();
    // Reserve one queue slot for the partial chunk emitted during stop.
    if (this.queue && queue.pending.length >= this.queue.capacity - 1 && this.state.phase === "recording") {
      this.update({ error: queue.error ?? "Transcription is falling behind. Recording stopped to keep your audio safe. Pending chunks will finish uploading." });
      void this.stop();
    }
  };

  async start(meetingId: string, startMs: number) {
    if (this.state.phase !== "idle" || this.state.pending.length || this.stopping) return;
    const generation = ++this.generation;
    this.update({ phase: "starting", meetingId, elapsedMs: 0, error: null });
    this.nextStartMs = startMs;
    try {
      this.queue = new AudioQueue(chunk => this.upload(meetingId, chunk), this.queueChanged, this.queueCapacity);
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
        throw new Error("Microphone capture needs a secure browser with AudioWorklet support. You can still import a transcript.");
      }
      const context = new AudioContext({ sampleRate: 16000 });
      this.context = context;
      await context.resume();
      if (generation !== this.generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      await context.audioWorklet.addModule("/pcm-worklet.js");
      if (generation !== this.generation) return;
      const worklet = new AudioWorkletNode(context, "moss-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.worklet = worklet;
      worklet.port.onmessage = (event: MessageEvent) => {
        const message = event.data as { type: string; samples: Float32Array; sampleRate: number };
        if (message.type === "chunk") {
          const chunk = { id: crypto.randomUUID(), startMs: this.nextStartMs, wav: pcmWav(message.samples, message.sampleRate) };
          this.nextStartMs += Math.round(message.samples.length / message.sampleRate * 1000);
          try {
            this.queue!.add(chunk);
            worklet.port.postMessage("ack");
          } catch (error) {
            this.update({ error: `${errorMessage(error)} The last chunk could not be retained. Download the retained audio before leaving.` });
            void this.stop();
          }
        } else if (message.type === "stopped") {
          this.stopped?.();
        } else if (message.type === "overflow") {
          this.update({ error: "The capture thread stopped because this window was unresponsive. Retained chunks can be retried or downloaded." });
          void this.stop();
        }
      };
      worklet.onprocessorerror = () => {
        this.update({ error: "The audio processor stopped. The last partial chunk may be incomplete. Retained chunks are still available below." });
        void this.stop();
      };
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(worklet);
      worklet.connect(context.destination);
      stream.getAudioTracks().forEach(track => {
        track.onended = () => {
          if (this.state.phase === "recording") {
            this.update({ error: "Microphone access ended. Recording has stopped." });
            void this.stop();
          }
        };
      });
      this.startedAt = Date.now();
      this.update({ phase: "recording" });
      this.timer = setInterval(() => this.update({ elapsedMs: Date.now() - this.startedAt }), 500);
    } catch (error) {
      if (generation === this.generation) {
        this.update({ error: errorMessage(error) });
        await this.release();
        this.update({ phase: "idle" });
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state.phase === "idle") return Promise.resolve();
    ++this.generation;
    this.update({ phase: "stopping" });
    clearInterval(this.timer);
    this.stopping = (async () => {
      if (this.worklet) {
        await new Promise<void>(resolve => {
          const timeout = setTimeout(() => {
            this.update({ error: "Capture stopped without confirming the final partial chunk. Earlier retained chunks are still available." });
            resolve();
          }, 2000);
          this.stopped = () => { clearTimeout(timeout); resolve(); };
          this.worklet!.port.postMessage("stop");
        });
      }
      await this.release();
      this.update({ phase: "idle" });
      this.stopping = undefined;
    })();
    return this.stopping;
  }

  private async release() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.worklet?.port.close();
    if (this.context && this.context.state !== "closed") await this.context.close().catch(() => undefined);
    this.stream = undefined;
    this.context = undefined;
    this.source = undefined;
    this.worklet = undefined;
    this.stopped = undefined;
  }

  async retry() {
    if (this.state.phase !== "idle" || this.stopping) return;
    this.update({ error: null });
    await this.queue?.retry();
  }

  discardPending(confirmed: boolean) {
    if (!confirmed) return;
    if (this.state.phase !== "idle" || this.stopping || this.state.uploading) throw new Error("Stop capture and wait for the current upload before discarding pending audio.");
    this.queue?.discard();
    this.update({ meetingId: null, error: null, elapsedMs: 0 });
  }

  dispose() {
    void this.stop();
    this.listeners.clear();
  }
}
