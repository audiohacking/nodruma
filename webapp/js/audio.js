/** Shared decode + AudioContext playback. */

/** Engine analysis rate — OfflineAudioContext forces decode here so MP3/WAV/etc.
 *  don't inherit the device rate (often 48 kHz) and diverge from CLI/tests. */
const NODRUMA_DECODE_SR = 44100;
const NODRUMA_MAX_DURATION_SEC = 6 * 60;
const NODRUMA_MIN_FRAMES = 64;

/**
 * Decode any browser-supported audio (WAV, MP3, OGG, FLAC, M4A, …) to mono float.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} [label]
 * @returns {Promise<{mono: Float32Array, sampleRate: number, durationSec: number}>}
 */
async function decodeAudioBuffer(arrayBuffer, label = "audio") {
  if (!arrayBuffer || arrayBuffer.byteLength < 16) {
    throw new Error(`“${label}” is empty or too small to be audio`);
  }

  let audio;
  try {
    // Prefer offline @ 44.1k so format/device doesn't change DSP sample rate.
    const offline = new OfflineAudioContext(2, 128, NODRUMA_DECODE_SR);
    audio = await offline.decodeAudioData(arrayBuffer.slice(0));
  } catch (errOffline) {
    // Fallback: live context (may be 48k — engine still accepts any rate).
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const tmp = new AC();
      try {
        audio = await tmp.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        tmp.close?.();
      }
    } catch (errLive) {
      const detail = errLive?.message || errOffline?.message || "unsupported format";
      throw new Error(
        `Could not decode “${label}” (${detail}). Try WAV, MP3, OGG, FLAC, or M4A.`
      );
    }
  }

  const sampleRate = audio.sampleRate || NODRUMA_DECODE_SR;
  if (!(sampleRate >= 8000 && sampleRate <= 192000)) {
    throw new Error(`“${label}” has an unsupported sample rate (${sampleRate} Hz)`);
  }

  const frames = audio.length;
  if (frames < NODRUMA_MIN_FRAMES) {
    throw new Error(`“${label}” is too short to split`);
  }
  const durationSec = frames / sampleRate;
  if (durationSec > NODRUMA_MAX_DURATION_SEC) {
    throw new Error(
      `“${label}” is ${(durationSec / 60).toFixed(1)} min — keep loops under ${NODRUMA_MAX_DURATION_SEC / 60} min`
    );
  }

  const ch0 = audio.getChannelData(0);
  let mono;
  if (audio.numberOfChannels === 1) {
    mono = new Float32Array(ch0);
  } else {
    mono = new Float32Array(frames);
    const nCh = audio.numberOfChannels;
    for (let c = 0; c < nCh; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < frames; i++) mono[i] += ch[i] / nCh;
    }
  }

  // Strip NaN/Inf that some decoders emit on corrupt frames
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i];
    if (!Number.isFinite(v)) mono[i] = 0;
    else {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  if (peak < 1e-8) {
    throw new Error(`“${label}” decoded as silence`);
  }

  return { mono, sampleRate, durationSec };
}

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
    // Web Audio requires ~3000–768000 Hz depending on browser
    const sr = Math.min(768000, Math.max(3000, Math.round(sampleRate || NODRUMA_DECODE_SR)));
    const buf = ctx.createBuffer(1, Math.max(1, n), sr);
    const ch = buf.getChannelData(0);
    if (n > 0) ch.set(float32Mono.subarray(0, n));
    this.buffers.set(padId, buf);
  }

  clear(prefix) {
    if (!prefix) {
      this.buffers.clear();
      return;
    }
    for (const k of [...this.buffers.keys()]) {
      if (k.startsWith(prefix)) this.buffers.delete(k);
    }
  }

  remove(padId) {
    this.buffers.delete(padId);
  }

  /**
   * @param {string} padId
   * @param {{pitchSemitones?:number,eqLowDb?:number,eqHighDb?:number,gain?:number}} [fx]
   */
  play(padId, fx = {}) {
    const ctx = this.ensureCtx();
    const buf = this.buffers.get(padId);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const semis = fx.pitchSemitones ?? 0;
    src.playbackRate.value = Math.pow(2, semis / 12);

    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 250;
    low.gain.value = fx.eqLowDb ?? 0;

    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 4000;
    high.gain.value = fx.eqHighDb ?? 0;

    const gain = ctx.createGain();
    const g = fx.gain;
    gain.gain.value = g == null ? 1 : Math.max(0, Math.min(1.5, g));

    src.connect(low);
    low.connect(high);
    high.connect(gain);
    gain.connect(ctx.destination);
    src.start();
    return true;
  }
}

window.PadPlayer = PadPlayer;
window.decodeAudioBuffer = decodeAudioBuffer;
window.NODRUMA_DECODE_SR = NODRUMA_DECODE_SR;
