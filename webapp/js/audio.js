/** Shared AudioContext + one-shot playback. */
class PadPlayer {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
  }

  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  setSample(padId, float32Mono, sampleRate) {
    const ctx = this.ensureCtx();
    const n = float32Mono.length;
    const buf = ctx.createBuffer(1, n, sampleRate);
    // copy — float32Mono may be a view into WASM heap
    const ch = buf.getChannelData(0);
    ch.set(float32Mono.subarray(0, n));
    this.buffers.set(padId, buf);
  }

  clear() {
    this.buffers.clear();
  }

  play(padId) {
    const ctx = this.ensureCtx();
    const buf = this.buffers.get(padId);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    return true;
  }
}

window.PadPlayer = PadPlayer;
