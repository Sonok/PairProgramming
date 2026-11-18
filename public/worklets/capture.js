// Mic capture: downsamples the mic to 16 kHz and posts 16-bit PCM in 40 ms chunks.
const TARGET_RATE = 16000;
const CHUNK = 640; // 40 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(CHUNK);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      // Average the input samples that fall into each output sample.
      this.sum += input[i];
      this.count++;
      this.pos++;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const s = Math.max(-1, Math.min(1, this.sum / this.count));
      this.out[this.len++] = s * 0x7fff;
      this.sum = 0;
      this.count = 0;
      if (this.len === CHUNK) {
        this.port.postMessage(this.out.slice().buffer);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
