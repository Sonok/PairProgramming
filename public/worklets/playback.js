// Playback: plays queued 16-bit PCM chunks. The context runs at 24 kHz, Gemini's output rate.
// Posting 'clear' drops everything queued, which is how interruptions cut the voice off.
class PcmPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = [];
        this.offset = 0;
      } else {
        this.queue.push(new Int16Array(e.data));
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0];
      const n = Math.min(out.length - i, chunk.length - this.offset);
      for (let j = 0; j < n; j++) out[i + j] = chunk[this.offset + j] / 0x8000;
      i += n;
      this.offset += n;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-playback', PcmPlayback);
