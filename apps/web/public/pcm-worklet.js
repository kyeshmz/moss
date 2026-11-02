class MossCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate * 15));
    this.length = 0;
    this.stopped = false;
    this.outstanding = 0;
    this.port.onmessage = event => {
      if (event.data === "ack") this.outstanding = Math.max(0, this.outstanding - 1);
      if (event.data === "stop") {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ type: "chunk", samples, sampleRate }, [samples.buffer]);
    this.outstanding++;
    this.length = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] ?? 0;
      this.buffer[this.length++] = sample / channels.length;
      if (this.length === this.buffer.length) {
        this.flush();
        if (this.outstanding >= 2) {
          this.stopped = true;
          this.port.postMessage({ type: "overflow" });
          return false;
        }
      }
    }
    return true;
  }
}

registerProcessor("moss-capture", MossCapture);
