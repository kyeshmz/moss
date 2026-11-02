import { errorMessage } from "./api";

export interface AudioChunk { id: string; startMs: number; wav: Blob }
export interface QueueState { pending: readonly AudioChunk[]; uploading: boolean; error: string | null }

export class AudioQueue {
  private state: QueueState = { pending: [], uploading: false, error: null };

  constructor(
    private readonly upload: (chunk: AudioChunk) => Promise<void>,
    private readonly changed: (state: QueueState) => void,
    readonly capacity = 4,
  ) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new Error("Audio queue capacity must allow a capture chunk and a final partial chunk.");
  }

  getSnapshot = () => this.state;

  private update(patch: Partial<QueueState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  add(chunk: AudioChunk) {
    if (this.state.pending.length >= this.capacity) throw new Error("The audio recovery queue is full. Capture has stopped.");
    this.update({ pending: [...this.state.pending, chunk] });
    void this.drain();
  }

  async retry() {
    this.update({ error: null });
    await this.drain();
  }

  discard() {
    if (this.state.uploading) throw new Error("Wait for the current audio upload before discarding pending audio.");
    this.update({ pending: [], error: null });
  }

  private async drain() {
    if (this.state.uploading || this.state.error || !this.state.pending.length) return;
    this.update({ uploading: true });
    try {
      while (this.state.pending.length && !this.state.error) {
        const chunk = this.state.pending[0];
        await this.upload(chunk);
        this.update({ pending: this.state.pending.slice(1) });
      }
    } catch (error) {
      this.update({ error: errorMessage(error) });
    } finally {
      this.update({ uploading: false });
    }
  }
}
