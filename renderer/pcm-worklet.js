// Recebe PCM s16le estéreo 48kHz do audiocap.exe e toca num MediaStream (vai pro WebRTC).
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000; // 1 s de buffer
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.w = 0; this.r = 0; this.n = 0;
    this.primed = false;
    this.TARGET = 960;   // 20 ms antes de começar a tocar
    this.MAX = 9600;     // acima de 200 ms acumulado, descarta o excesso
    this.port.onmessage = (e) => this.push(new Int16Array(e.data));
  }
  push(s) {
    const frames = s.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.L[this.w] = s[2 * i] / 32768;
      this.R[this.w] = s[2 * i + 1] / 32768;
      this.w = (this.w + 1) % this.cap;
      if (this.n < this.cap) this.n++; else this.r = (this.r + 1) % this.cap;
    }
    if (this.n > this.MAX) { // latência crescendo: pula pra perto do alvo
      const drop = this.n - 2400;
      this.r = (this.r + drop) % this.cap; this.n -= drop;
    }
  }
  process(_in, outputs) {
    const out = outputs[0];
    const l = out[0], r = out[1] || out[0];
    const len = l.length;
    if (!this.primed && this.n >= this.TARGET) this.primed = true;
    if (!this.primed || this.n < len) {
      l.fill(0); r.fill(0);
      if (this.n < len) this.primed = false;
      return true;
    }
    for (let i = 0; i < len; i++) {
      l[i] = this.L[this.r]; r[i] = this.R[this.r];
      this.r = (this.r + 1) % this.cap;
    }
    this.n -= len;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
