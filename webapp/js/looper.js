/**
 * Real-time loopstation
 * --------------------
 * Shared clock:  cycleOrigin + cycleFrames (sacred after first take)
 * Per track:     tape → region → tile → shift → pitch-bake → pcm @ rate 1
 *                volume / EQ / reverb send (insert FX, clock-safe)
 *
 * Overdub writes by per-sample AudioContext time → phaseFrames(t)
 * so layers lock to what was heard on the shared clock.
 *
 * Shorter regions tile to fill the master cycle — never shrink the clock
 * unless the user explicitly ½ / ×2 / set-cycle.
 */

const LOOPER_TRACKS = 8;
const LOOPER_MAX_SEC = 30;
const LOOPER_PROC_SIZE = 2048;
const LOOPER_BEATS_PER_BAR = 4;
const LOOPER_SEAM_FADE = 64;

/**
 * @param {{
 *   getCtx: () => AudioContext,
 *   getPadBus: () => GainNode,
 *   onChange?: () => void,
 * }} deps
 */
function createLooper(deps) {
  /** @type {Array<{
   *   tape: Float32Array|null,
   *   pcm: Float32Array|null,
   *   regionStart: number,
   *   regionEnd: number,
   *   shiftFrames: number,
   *   pitchSemitones: number,
   *   volume: number,
   *   eqLowDb: number,
   *   eqHighDb: number,
   *   reverb: number,
   *   muted: boolean,
   *   armed: boolean,
   *   recording: boolean,
   *   peak: number,
   *   source: AudioBufferSourceNode|null,
   *   gainNode: GainNode|null,
   *   lowEq: BiquadFilterNode|null,
   *   highEq: BiquadFilterNode|null,
   *   dryGain: GainNode|null,
   *   reverbSend: GainNode|null,
   * }>} */
  const tracks = [];
  for (let i = 0; i < LOOPER_TRACKS; i++) {
    tracks.push({
      tape: null,
      pcm: null,
      /** Phrase window into tape — tiled to fill cycleFrames when shorter */
      regionStart: 0,
      regionEnd: 0,
      shiftFrames: 0,
      pitchSemitones: 0,
      volume: 1,
      eqLowDb: 0,
      eqHighDb: 0,
      reverb: 0,
      muted: false,
      armed: i === 0,
      recording: false,
      peak: 0,
      source: null,
      gainNode: null,
      lowEq: null,
      highEq: null,
      dryGain: null,
      reverbSend: null,
    });
  }

  let bpm = 120;
  /** @type {'off'|'beat'|'bar'} */
  let quantize = "off";
  /** @type {0|1|2|4|8} */
  let barsPreset = 0;
  let playing = false;
  let sampleRate = 44100;
  /** Phrase crop snaps to cycle/n when true (default off for fine control). */
  let phraseSnap = false;
  /** User trim for record→playback alignment (ms). Positive = write later. */
  let syncOffsetMs = 0;

  /** Tape length (shared). */
  let takeFrames = 0;
  /** Master loop length — locked after first take unless ½ / ×2. */
  let cycleFrames = 0;
  /** @deprecated kept for session compat; master cycle uses 0..cycleFrames on tape */
  let trimStart = 0;
  let trimEnd = 0;
  let cycleOrigin = 0;
  let selectedTrack = 0;

  /** @type {ScriptProcessorNode|null} */
  let recorder = null;
  /** @type {GainNode|null} */
  let recorderSink = null;
  /** @type {GainNode|null} */
  let loopBus = null;
  /** @type {ConvolverNode|null} */
  let reverbNode = null;
  /** @type {GainNode|null} */
  let reverbReturn = null;

  let recTrack = -1;
  let recWrite = 0;
  let recSamplesWritten = 0;
  /** @type {Float32Array|null} */
  let recScratch = null;
  let recIsFirst = false;
  let recStopAt = 0;
  let recPendingStop = false;
  let recPendingStart = false;
  let recStartAtCtx = 0;

  function emit() {
    deps.onChange?.();
  }

  function beatSec() {
    return 60 / Math.max(40, Math.min(240, bpm));
  }

  function barSec() {
    return beatSec() * LOOPER_BEATS_PER_BAR;
  }

  function cycleSec() {
    return cycleFrames > 0 ? cycleFrames / sampleRate : 0;
  }

  function minCycleFrames() {
    return Math.max(
      Math.floor(sampleRate * 0.2),
      Math.floor(beatSec() * sampleRate * 0.5)
    );
  }

  function maxFrames() {
    return Math.floor(LOOPER_MAX_SEC * sampleRate);
  }

  function ensureLoopBus() {
    const ctx = deps.getCtx();
    sampleRate = ctx.sampleRate || 44100;
    if (!loopBus) {
      loopBus = ctx.createGain();
      loopBus.gain.value = 1;
      loopBus.connect(ctx.destination);
    }
    if (!reverbNode) {
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = makeImpulseResponse(ctx, 1.6);
      reverbReturn = ctx.createGain();
      reverbReturn.gain.value = 0.85;
      reverbNode.connect(reverbReturn);
      reverbReturn.connect(loopBus);
    }
    return loopBus;
  }

  /** Short noise IR for a usable plate-ish reverb. */
  function makeImpulseResponse(ctx, seconds) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
      }
    }
    return buf;
  }

  /** Record alignment trim only — padBus is internal, no outputLatency guess. */
  function syncOffsetFrames() {
    return Math.round((Number(syncOffsetMs) || 0) * 0.001 * sampleRate);
  }

  function setSyncOffsetMs(ms) {
    syncOffsetMs = Math.max(-80, Math.min(80, Number(ms) || 0));
    emit();
  }

  function setPhraseSnap(on) {
    phraseSnap = !!on;
    emit();
  }

  function quantizeStepSec() {
    if (quantize === "beat") return beatSec();
    if (quantize === "bar") return barSec();
    return 0;
  }

  function nextGridTime(ctxTime) {
    const step = quantizeStepSec();
    if (step <= 0 || cycleFrames <= 0) return ctxTime;
    const elapsed = Math.max(0, ctxTime - cycleOrigin);
    return cycleOrigin + Math.ceil(elapsed / step - 1e-9) * step;
  }

  function phaseFrames(ctxTime) {
    if (cycleFrames <= 0) return 0;
    let f = Math.floor((ctxTime - cycleOrigin) * sampleRate) % cycleFrames;
    if (f < 0) f += cycleFrames;
    return f;
  }

  function phase01(ctxTime) {
    return cycleFrames > 0 ? phaseFrames(ctxTime) / cycleFrames : 0;
  }

  function snapLengthFrames(len) {
    const step = quantizeStepSec();
    if (step <= 0) return len;
    const stepFrames = Math.max(1, Math.round(step * sampleRate));
    let snapped = Math.round(len / stepFrames) * stepFrames;
    if (snapped < stepFrames) snapped = stepFrames;
    return Math.min(maxFrames(), snapped);
  }

  function clampSample(v) {
    if (v > 1) return 1;
    if (v < -1) return -1;
    return v;
  }

  function applySeamCrossfade(pcm) {
    const n = Math.min(LOOPER_SEAM_FADE, Math.floor(pcm.length / 4));
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      const start = pcm[i];
      const end = pcm[pcm.length - n + i];
      pcm[i] = start * fadeIn + end * fadeOut;
    }
  }

  /** Circular-shift `src` by `shift` samples into `dst` (same length). */
  function circularShiftInto(dst, src, shift) {
    const n = dst.length;
    if (!n) return;
    let s = ((shift % n) + n) % n;
    if (s === 0) {
      dst.set(src.subarray(0, n));
      return;
    }
    dst.set(src.subarray(s, n), 0);
    dst.set(src.subarray(0, s), n - s);
  }

  /**
   * Build playing buffer: tile track region into master cycleFrames, then shift.
   * Uneven phrases stay on the grid — they repeat instead of shrinking the clock.
   */
  function rebuildTrackPcm(idx) {
    const t = tracks[idx];
    if (cycleFrames <= 0 || !t.tape || !t.tape.length) {
      t.pcm = null;
      return;
    }
    let rs = t.regionStart | 0;
    let re = t.regionEnd | 0;
    if (re <= rs) {
      rs = 0;
      re = t.tape.length;
    }
    rs = Math.max(0, Math.min(t.tape.length - 1, rs));
    re = Math.max(rs + 1, Math.min(t.tape.length, re));
    t.regionStart = rs;
    t.regionEnd = re;

    const regionLen = re - rs;
    const region = t.tape.subarray(rs, re);
    const filled = new Float32Array(cycleFrames);
    // Shorter than master → tile; longer → first cycleFrames (clock stays)
    for (let i = 0; i < cycleFrames; i++) {
      filled[i] = region[i % regionLen];
    }
    const shifted = new Float32Array(cycleFrames);
    circularShiftInto(shifted, filled, t.shiftFrames);
    // Bake pitch into buffer so BufferSource stays at rate 1 (clock lock)
    const pitched = bakePitchSameLength(shifted, t.pitchSemitones || 0);
    applySeamCrossfade(pitched);
    t.pcm = pitched;
  }

  /**
   * Vinyl-style pitch into same-length buffer (rate linked). Keeps wall-clock
   * cycle locked — BufferSource always plays at playbackRate=1.
   */
  function bakePitchSameLength(input, semis) {
    const s = Number(semis) || 0;
    if (!s || !input || !input.length) return input;
    const rate = Math.pow(2, s / 12);
    if (Math.abs(rate - 1) < 1e-6) return input;
    const n = input.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let src = (i * rate) % n;
      if (src < 0) src += n;
      const i0 = Math.floor(src);
      const f = src - i0;
      const a = input[i0];
      const b = input[(i0 + 1) % n];
      out[i] = a + (b - a) * f;
    }
    return out;
  }

  /** Prefer even divisions of the master cycle when phraseSnap is on. */
  function grooveSnapRegionLength(len, maxLen) {
    if (!phraseSnap || cycleFrames <= 0 || len <= 0) return len;
    const cap = Math.max(64, Math.min(maxLen || len, cycleFrames));
    if (len >= cycleFrames) return Math.min(len, cycleFrames);
    let best = len;
    let bestErr = Infinity;
    for (let n = 1; n <= 16; n++) {
      const target = Math.round(cycleFrames / n);
      if (target < 64 || target > cap) continue;
      const err = Math.abs(len - target) / cycleFrames;
      // Tight window — only snap when clearly near a division
      if (err < 0.015 && err < bestErr) {
        bestErr = err;
        best = target;
      }
    }
    return best;
  }

  function rebuildAllPcm() {
    for (let i = 0; i < tracks.length; i++) rebuildTrackPcm(i);
  }

  function tilesForTrack(idx) {
    const t = tracks[idx];
    if (!t || cycleFrames <= 0) return 1;
    const len = Math.max(1, (t.regionEnd | 0) - (t.regionStart | 0));
    return cycleFrames / len;
  }

  function stopTrackSources() {
    for (const t of tracks) {
      if (!t.source) continue;
      try {
        t.source.stop();
      } catch {
        /* */
      }
      try {
        t.source.disconnect();
      } catch {
        /* */
      }
      t.source = null;
    }
  }

  function pcmToBuffer(pcm) {
    const ctx = deps.getCtx();
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.getChannelData(0).set(pcm);
    return buf;
  }

  /**
   * Start one track locked to the shared clock.
   * playbackRate is always 1 — pitch is baked into pcm.
   */
  function startTrackSource(idx, when) {
    const t = tracks[idx];
    if (!t.pcm || t.pcm.length !== cycleFrames || cycleFrames <= 0) return;
    const ctx = deps.getCtx();
    ensureLoopBus();
    ensureTrackGraph(idx);
    applyTrackFx(idx);

    if (t.source) {
      try {
        t.source.stop();
      } catch {
        /* */
      }
      try {
        t.source.disconnect();
      } catch {
        /* */
      }
      t.source = null;
    }

    const src = ctx.createBufferSource();
    src.buffer = pcmToBuffer(t.pcm);
    src.loop = true;
    src.playbackRate.value = 1;
    src.connect(t.lowEq);

    const offsetSec = phaseFrames(when) / sampleRate;
    try {
      src.start(when, offsetSec);
    } catch {
      src.start();
    }
    t.source = src;
  }

  function ensureTrackGraph(idx) {
    const t = tracks[idx];
    const ctx = deps.getCtx();
    ensureLoopBus();
    if (t.lowEq) return;
    t.lowEq = ctx.createBiquadFilter();
    t.lowEq.type = "lowshelf";
    t.lowEq.frequency.value = 250;
    t.highEq = ctx.createBiquadFilter();
    t.highEq.type = "highshelf";
    t.highEq.frequency.value = 4000;
    t.gainNode = ctx.createGain();
    t.dryGain = ctx.createGain();
    t.reverbSend = ctx.createGain();
    t.lowEq.connect(t.highEq);
    t.highEq.connect(t.gainNode);
    t.gainNode.connect(t.dryGain);
    t.gainNode.connect(t.reverbSend);
    t.dryGain.connect(loopBus);
    t.reverbSend.connect(reverbNode);
  }

  function applyTrackFx(idx) {
    const t = tracks[idx];
    if (!t.gainNode) return;
    const silent = t.muted || !t.pcm;
    const vol = silent ? 0 : Math.max(0, Math.min(1.5, t.volume ?? 1));
    t.gainNode.gain.value = vol;
    if (t.lowEq) t.lowEq.gain.value = t.eqLowDb || 0;
    if (t.highEq) t.highEq.gain.value = t.eqHighDb || 0;
    if (t.dryGain) t.dryGain.gain.value = 1;
    if (t.reverbSend) {
      t.reverbSend.gain.value = silent
        ? 0
        : Math.max(0, Math.min(1, t.reverb || 0));
    }
  }

  function applyAllTrackFx() {
    for (let i = 0; i < tracks.length; i++) applyTrackFx(i);
  }

  function restartAllSources(when) {
    stopTrackSources();
    if (!playing || cycleFrames <= 0) return;
    for (let i = 0; i < tracks.length; i++) startTrackSource(i, when);
  }

  /** Rebuild pcm + reschedule all tracks without losing musical phase. */
  function resyncPlayback() {
    const ctx = deps.getCtx();
    const now = ctx.currentTime;
    const ph = playing && cycleFrames > 0 ? phase01(now) : 0;
    rebuildAllPcm();
    if (playing && cycleFrames > 0) {
      // Keep the same fractional position in the (possibly new) cycle
      cycleOrigin = now - ph * (cycleFrames / sampleRate);
      restartAllSources(now);
    }
    emit();
  }

  function ensureTrackTape(idx) {
    const t = tracks[idx];
    if (takeFrames <= 0) return null;
    if (!t.tape || t.tape.length !== takeFrames) {
      const next = new Float32Array(takeFrames);
      if (t.tape && t.tape.length) {
        next.set(t.tape.subarray(0, Math.min(t.tape.length, takeFrames)));
      }
      t.tape = next;
    }
    return t.tape;
  }

  function ensureRecorder() {
    if (recorder) return;
    const ctx = deps.getCtx();
    const padBus = deps.getPadBus();
    ensureLoopBus();

    recorder = ctx.createScriptProcessor(LOOPER_PROC_SIZE, 1, 1);
    recorderSink = ctx.createGain();
    recorderSink.gain.value = 0;
    padBus.connect(recorder);
    recorder.connect(recorderSink);
    recorderSink.connect(ctx.destination);

    recorder.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      ev.outputBuffer.getChannelData(0).fill(0);
      if (recTrack < 0) return;
      if (recIsFirst && !recScratch) return;

      const n = input.length;
      // ScriptProcessor: buffer ends near currentTime; sample i at blockStart+i/sr
      const blockEnd = ctx.currentTime;
      const blockStart = blockEnd - n / sampleRate;
      const syncF = syncOffsetFrames();

      let i0 = 0;
      if (recPendingStart) {
        if (blockEnd < recStartAtCtx) return;
        i0 = Math.max(
          0,
          Math.min(n, Math.round((recStartAtCtx - blockStart) * sampleRate))
        );
        recPendingStart = false;
        if (recIsFirst) {
          cycleOrigin = recStartAtCtx;
          recWrite = 0;
        } else if (cycleFrames > 0) {
          recSamplesWritten = 0;
          ensureTrackTape(recTrack);
        }
        emit();
      }

      let peak = 0;
      const t = tracks[recTrack];

      for (let i = i0; i < n; i++) {
        const v = input[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;

        if (recIsFirst) {
          if (recWrite >= recScratch.length) {
            finishRecording();
            break;
          }
          recScratch[recWrite++] = v;
          if (recStopAt > 0 && recWrite >= recStopAt) {
            finishRecording();
            break;
          }
        } else {
          if (cycleFrames <= 0 || takeFrames <= 0) break;
          // As-played lock: map capture time → shared cycle phase
          const tCap = blockStart + i / sampleRate + syncF / sampleRate;
          let idx = phaseFrames(tCap);
          const unshifted =
            (idx + (t.shiftFrames || 0)) % cycleFrames;
          const rs = t.regionStart | 0;
          const re = t.regionEnd > rs ? t.regionEnd | 0 : takeFrames;
          const regionLen = Math.max(1, re - rs);
          const abs = rs + (unshifted % regionLen);
          const tape = ensureTrackTape(recTrack);
          if (tape && abs >= 0 && abs < tape.length) {
            tape[abs] = clampSample(tape[abs] + v);
          }
          // Do not live-mix into pcm (avoids dry/wet flams); rebuild on finish
          recSamplesWritten++;
          if (recSamplesWritten >= cycleFrames) {
            finishRecording();
            break;
          }
        }
      }
      if (t) t.peak = peak;
    };
  }

  function finishRecording() {
    if (recTrack < 0) return;
    const idx = recTrack;
    const t = tracks[idx];
    t.recording = false;
    t.peak = 0;

    if (recIsFirst && recScratch) {
      let len = recWrite;
      if (len < Math.floor(sampleRate * 0.05)) {
        recScratch = null;
        recTrack = -1;
        recIsFirst = false;
        recPendingStop = false;
        recPendingStart = false;
        playing = false;
        emit();
        return;
      }

      if (barsPreset > 0) {
        const target = Math.min(
          maxFrames(),
          Math.round(barsPreset * barSec() * sampleRate)
        );
        if (len < target) {
          const padded = new Float32Array(target);
          padded.set(recScratch.subarray(0, len));
          recScratch = padded;
          len = target;
        } else {
          len = Math.min(len, target);
        }
      } else if (quantize !== "off") {
        len = Math.min(recScratch.length, snapLengthFrames(len));
      }

      takeFrames = len;
      cycleFrames = len;
      trimStart = 0;
      trimEnd = len;
      t.tape = new Float32Array(recScratch.subarray(0, len));
      t.regionStart = 0;
      t.regionEnd = len;
      t.shiftFrames = 0;
      recScratch = null;
      selectedTrack = idx;

      rebuildAllPcm();
      playing = true;
      const ctx = deps.getCtx();
      cycleOrigin = ctx.currentTime;
      restartAllSources(ctx.currentTime);
    } else if (!recIsFirst) {
      if (t.tape && !(t.regionEnd > t.regionStart)) {
        t.regionStart = 0;
        t.regionEnd = t.tape.length;
      }
      rebuildTrackPcm(idx);
      // Resync ALL tracks so the new layer locks to the clock
      if (playing) {
        const ctx = deps.getCtx();
        const now = ctx.currentTime;
        const ph = phase01(now);
        cycleOrigin = now - ph * (cycleFrames / sampleRate);
        restartAllSources(now);
      }
    }

    recTrack = -1;
    recIsFirst = false;
    recPendingStop = false;
    recPendingStart = false;
    recStopAt = 0;
    emit();
  }

  function cancelRecording() {
    if (recTrack < 0) return;
    tracks[recTrack].recording = false;
    tracks[recTrack].peak = 0;
    recScratch = null;
    recTrack = -1;
    recIsFirst = false;
    recPendingStop = false;
    recPendingStart = false;
    recStopAt = 0;
  }

  function armedIndex() {
    return tracks.findIndex((tr) => tr.armed);
  }

  function selectTrack(i) {
    if (i < 0 || i >= tracks.length) return;
    selectedTrack = i;
    emit();
  }

  function arm(i) {
    for (let j = 0; j < tracks.length; j++) tracks[j].armed = j === i;
    selectedTrack = i;
    emit();
  }

  function toggleMute(i) {
    const t = tracks[i];
    if (!t) return;
    t.muted = !t.muted;
    applyTrackFx(i);
    emit();
  }

  function clear(i) {
    const t = tracks[i];
    if (!t) return;
    if (t.recording && recTrack === i) cancelRecording();
    if (t.source) {
      try {
        t.source.stop();
      } catch {
        /* */
      }
      t.source = null;
    }
    t.tape = null;
    t.pcm = null;
    t.regionStart = 0;
    t.regionEnd = 0;
    t.shiftFrames = 0;
    t.pitchSemitones = 0;
    t.volume = 1;
    t.eqLowDb = 0;
    t.eqHighDb = 0;
    t.reverb = 0;
    t.peak = 0;
    applyTrackFx(i);
    if (tracks.every((x) => !x.tape)) {
      takeFrames = 0;
      cycleFrames = 0;
      trimStart = 0;
      trimEnd = 0;
      playing = false;
      cycleOrigin = 0;
      stopTrackSources();
    }
    emit();
  }

  function clearAll() {
    cancelRecording();
    stopTrackSources();
    for (const t of tracks) {
      t.tape = null;
      t.pcm = null;
      t.regionStart = 0;
      t.regionEnd = 0;
      t.shiftFrames = 0;
      t.pitchSemitones = 0;
      t.volume = 1;
      t.eqLowDb = 0;
      t.eqHighDb = 0;
      t.reverb = 0;
      t.peak = 0;
      t.recording = false;
    }
    takeFrames = 0;
    cycleFrames = 0;
    trimStart = 0;
    trimEnd = 0;
    playing = false;
    cycleOrigin = 0;
    selectedTrack = 0;
    emit();
  }

  function play() {
    ensureLoopBus();
    if (cycleFrames <= 0) {
      emit();
      return;
    }
    const ctx = deps.getCtx();
    if (!playing) {
      playing = true;
      cycleOrigin = ctx.currentTime;
    }
    restartAllSources(ctx.currentTime);
    emit();
  }

  function stop() {
    if (recTrack >= 0) finishRecording();
    playing = false;
    stopTrackSources();
    emit();
  }

  /**
   * Per-track phrase region (does NOT change the master cycle).
   * Shorter phrases tile to fill the cycle and stay on the grid.
   * @param {{ snap?: boolean }} [opts]  snap length to cycle/n on commit (default true)
   */
  function setTrackRegion(idx, startFrame, endFrame, opts) {
    const t = tracks[idx];
    if (!t || !t.tape || takeFrames <= 0 || cycleFrames <= 0) return false;
    let a = Math.max(0, Math.floor(Number(startFrame) || 0));
    let b = Math.min(t.tape.length, Math.floor(Number(endFrame) || 0));
    if (b <= a) return false;
    const minN = Math.min(64, Math.min(minCycleFrames(), cycleFrames));
    if (b - a < minN) {
      b = Math.min(t.tape.length, a + minN);
      if (b <= a) return false;
    }
    const doSnap = phraseSnap && (!opts || opts.snap !== false);
    if (doSnap) {
      let len = b - a;
      len = grooveSnapRegionLength(len, t.tape.length - a);
      b = Math.min(t.tape.length, a + len);
    }
    t.regionStart = a;
    t.regionEnd = b;
    rebuildTrackPcm(idx);
    if (playing) startTrackSource(idx, deps.getCtx().currentTime);
    emit();
    return true;
  }

  function setTrackRegion01(idx, start01, end01, opts) {
    if (takeFrames <= 0) return false;
    return setTrackRegion(idx, start01 * takeFrames, end01 * takeFrames, opts);
  }

  /** Crop UI → edit the selected track's region (clock stays put). */
  function setTrim(startFrame, endFrame, opts) {
    return setTrackRegion(selectedTrack, startFrame, endFrame, opts);
  }

  function setTrim01(start01, end01, opts) {
    return setTrackRegion01(selectedTrack, start01, end01, opts);
  }

  function resetTrim() {
    const t = tracks[selectedTrack];
    if (!t || !t.tape) return false;
    return setTrackRegion(selectedTrack, 0, t.tape.length, { snap: false });
  }

  /** Set region end at playhead mapped into the selected track's phrase. */
  function setCycleEndAtPlayhead() {
    if (!playing || cycleFrames <= 0) return false;
    const t = tracks[selectedTrack];
    if (!t || !t.tape) return false;
    const rs = t.regionStart | 0;
    const re = t.regionEnd | 0;
    const regionLen = Math.max(1, re - rs);
    const abs = Math.min(
      t.tape.length,
      rs + (phaseFrames(deps.getCtx().currentTime) % regionLen)
    );
    return setTrackRegion(selectedTrack, rs, Math.max(rs + 64, abs));
  }

  function setCycleStartAtPlayhead() {
    if (!playing || cycleFrames <= 0) return false;
    const t = tracks[selectedTrack];
    if (!t || !t.tape) return false;
    const rs = t.regionStart | 0;
    const re = t.regionEnd | 0;
    const regionLen = Math.max(1, re - rs);
    const abs = Math.min(
      t.tape.length - 64,
      rs + (phaseFrames(deps.getCtx().currentTime) % regionLen)
    );
    return setTrackRegion(selectedTrack, abs, re);
  }

  /** Explicitly set master cycle length — phase-preserving. */
  function setMasterCycleFrames(frames) {
    if (takeFrames <= 0) return false;
    let n = Math.floor(Number(frames) || 0);
    n = Math.max(minCycleFrames(), Math.min(takeFrames, n));
    if (n === cycleFrames) return true;
    const ctx = deps.getCtx();
    const now = ctx.currentTime;
    const ph = playing ? phase01(now) : 0;
    cycleFrames = n;
    trimStart = 0;
    trimEnd = n;
    rebuildAllPcm();
    if (playing) {
      cycleOrigin = now - ph * (cycleFrames / sampleRate);
      restartAllSources(now);
    }
    emit();
    return true;
  }

  function halveCycle() {
    if (cycleFrames < minCycleFrames() * 2) return false;
    return setMasterCycleFrames(Math.floor(cycleFrames / 2));
  }

  function doubleCycle() {
    if (cycleFrames <= 0 || cycleFrames * 2 > maxFrames()) return false;
    const len = cycleFrames;
    for (const t of tracks) {
      if (!t.pcm || t.pcm.length !== len) continue;
      const chunk = new Float32Array(t.pcm);
      const unshifted = new Float32Array(len);
      circularShiftInto(unshifted, chunk, -(t.shiftFrames || 0));
      const tape = new Float32Array(len * 2);
      tape.set(unshifted, 0);
      tape.set(unshifted, len);
      t.tape = tape;
      t.regionStart = 0;
      t.regionEnd = len * 2;
      t.shiftFrames = 0;
    }
    takeFrames = len * 2;
    cycleFrames = takeFrames;
    trimStart = 0;
    trimEnd = takeFrames;
    resyncPlayback();
    return true;
  }

  /** Circular shift of selected (or given) track, in samples. Live while playing. */
  function setTrackShift(idx, frames) {
    const t = tracks[idx];
    if (!t || cycleFrames <= 0) return false;
    t.shiftFrames = ((Math.round(frames) % cycleFrames) + cycleFrames) % cycleFrames;
    rebuildTrackPcm(idx);
    if (playing) startTrackSource(idx, deps.getCtx().currentTime);
    emit();
    return true;
  }

  function nudgeTrackShift(idx, deltaFrames) {
    const t = tracks[idx];
    if (!t) return false;
    return setTrackShift(idx, (t.shiftFrames || 0) + deltaFrames);
  }

  /** Shift as fraction of cycle (−0.5…0.5 typical). */
  function setTrackShift01(idx, frac) {
    if (cycleFrames <= 0) return false;
    return setTrackShift(idx, Math.round(Number(frac) * cycleFrames));
  }

  function setTrackPitch(idx, semis) {
    const t = tracks[idx];
    if (!t) return false;
    t.pitchSemitones = Math.max(-12, Math.min(12, Number(semis) || 0));
    rebuildTrackPcm(idx);
    if (playing) startTrackSource(idx, deps.getCtx().currentTime);
    emit();
    return true;
  }

  function setTrackFx(idx, fx = {}) {
    const t = tracks[idx];
    if (!t) return false;
    let needRebuild = false;
    if (fx.volume != null) {
      t.volume = Math.max(0, Math.min(1.5, Number(fx.volume) || 0));
    }
    if (fx.eqLowDb != null) {
      t.eqLowDb = Math.max(-12, Math.min(12, Number(fx.eqLowDb) || 0));
    }
    if (fx.eqHighDb != null) {
      t.eqHighDb = Math.max(-12, Math.min(12, Number(fx.eqHighDb) || 0));
    }
    if (fx.reverb != null) {
      t.reverb = Math.max(0, Math.min(1, Number(fx.reverb) || 0));
    }
    if (fx.pitchSemitones != null) {
      t.pitchSemitones = Math.max(
        -12,
        Math.min(12, Number(fx.pitchSemitones) || 0)
      );
      needRebuild = true;
    }
    if (needRebuild) {
      rebuildTrackPcm(idx);
      if (playing) startTrackSource(idx, deps.getCtx().currentTime);
    } else {
      ensureTrackGraph(idx);
      applyTrackFx(idx);
    }
    emit();
    return true;
  }

  /** Shift in milliseconds (± half cycle clamped). */
  function setTrackShiftMs(idx, ms) {
    if (cycleFrames <= 0 || sampleRate <= 0) return false;
    return setTrackShift(idx, Math.round((Number(ms) || 0) * 0.001 * sampleRate));
  }

  function nudgeTrackShiftMs(idx, deltaMs) {
    const t = tracks[idx];
    if (!t || cycleFrames <= 0) return false;
    const curMs = ((t.shiftFrames || 0) / sampleRate) * 1000;
    return setTrackShiftMs(idx, curMs + (Number(deltaMs) || 0));
  }

  function toggleRec() {
    if (recTrack >= 0) {
      requestStopRec();
      return;
    }
    requestStartRec();
  }

  function requestStartRec() {
    const idx = armedIndex();
    if (idx < 0) return;
    const ctx = deps.getCtx();
    ensureRecorder();
    ensureLoopBus();

    const now = ctx.currentTime;
    const isFirst = takeFrames <= 0 || cycleFrames <= 0;

    recTrack = idx;
    recIsFirst = isFirst;
    recWrite = 0;
    recSamplesWritten = 0;
    tracks[idx].recording = true;
    selectedTrack = idx;
    arm(idx);

    if (isFirst) {
      const cap = maxFrames();
      recScratch = new Float32Array(cap);
      recStopAt =
        barsPreset > 0
          ? Math.min(cap, Math.round(barsPreset * barSec() * sampleRate))
          : 0;
      cycleOrigin = now;
      recStartAtCtx = now;
      recPendingStart = false;
      playing = true;
    } else {
      ensureTrackTape(idx);
      if (!(tracks[idx].regionEnd > tracks[idx].regionStart)) {
        tracks[idx].regionStart = 0;
        tracks[idx].regionEnd = takeFrames;
      }
      const startAt = nextGridTime(now);
      recStartAtCtx = startAt;
      recPendingStart = startAt > now + 0.001;
      if (!recPendingStart) {
        recSamplesWritten = 0;
      }
      if (!playing) {
        playing = true;
        restartAllSources(now);
      }
    }
    emit();
  }

  function requestStopRec() {
    if (recTrack < 0) return;
    if (recIsFirst) {
      if (quantize === "off" && barsPreset === 0) {
        finishRecording();
        return;
      }
      if (barsPreset > 0) {
        finishRecording();
        return;
      }
      const ctx = deps.getCtx();
      const endAt = nextGridTime(ctx.currentTime + 0.001);
      const framesToEnd = Math.max(
        1,
        Math.round((endAt - cycleOrigin) * sampleRate)
      );
      recStopAt = Math.min(maxFrames(), Math.max(recWrite + 1, framesToEnd));
      recPendingStop = true;
      emit();
      return;
    }
    finishRecording();
  }

  function setBpm(v) {
    bpm = Math.max(40, Math.min(240, Math.round(Number(v) || 120)));
    emit();
  }

  function setQuantize(q) {
    if (q === "off" || q === "beat" || q === "bar") quantize = q;
    emit();
  }

  function setBarsPreset(b) {
    const n = Number(b);
    barsPreset = n === 1 || n === 2 || n === 4 || n === 8 ? n : 0;
    emit();
  }

  function selectedTape() {
    const t = tracks[selectedTrack];
    if (t && t.tape && t.tape.length) return t.tape;
    for (const x of tracks) {
      if (x.tape && x.tape.length) return x.tape;
    }
    return null;
  }

  function getState() {
    const now = (() => {
      try {
        return deps.getCtx().currentTime;
      } catch {
        return 0;
      }
    })();
    const ph = playing && cycleFrames > 0 ? phase01(now) : 0;
    const sel = tracks[selectedTrack];
    const rs = sel && sel.tape ? sel.regionStart | 0 : 0;
    const re =
      sel && sel.tape
        ? sel.regionEnd > rs
          ? sel.regionEnd | 0
          : sel.tape.length
        : 0;
    const regionLen = Math.max(1, re - rs);
    const tiles = cycleFrames > 0 ? cycleFrames / regionLen : 1;
    // Playhead on crop wave: walk the phrase as it tiles through the cycle
    const shift = (sel && sel.shiftFrames) || 0;
    const local =
      cycleFrames > 0
        ? (Math.floor(ph * cycleFrames) + shift) % regionLen
        : 0;
    const cropPh =
      takeFrames > 0 ? (rs + ((local % regionLen) + regionLen) % regionLen) / takeFrames : 0;

    return {
      bpm,
      quantize,
      barsPreset,
      playing,
      cycleFrames,
      cycleSec: cycleSec(),
      takeFrames,
      takeSec: takeFrames > 0 ? takeFrames / sampleRate : 0,
      archiveFrames: takeFrames,
      archiveSec: takeFrames > 0 ? takeFrames / sampleRate : 0,
      trimStart: rs,
      trimEnd: re,
      trimStart01: takeFrames > 0 ? rs / takeFrames : 0,
      trimEnd01: takeFrames > 0 ? re / takeFrames : 1,
      regionStart: rs,
      regionEnd: re,
      regionStart01: takeFrames > 0 ? rs / takeFrames : 0,
      regionEnd01: takeFrames > 0 ? re / takeFrames : 1,
      regionTiles: tiles,
      sampleRate,
      phraseSnap,
      syncOffsetMs,
      recording: recTrack >= 0,
      waitingStart: recPendingStart,
      waitingStop: recPendingStop,
      recTrack,
      selectedTrack,
      phase01: ph,
      cropPhase01: cropPh,
      masterPcm: selectedTape(),
      tracks: tracks.map((t, i) => {
        const trs = t.regionStart | 0;
        const tre =
          t.tape && t.regionEnd > trs ? t.regionEnd | 0 : t.tape ? t.tape.length : 0;
        const tlen = Math.max(1, tre - trs);
        const shiftF = t.shiftFrames || 0;
        let shiftSigned = cycleFrames > 0 ? shiftF / cycleFrames : 0;
        if (shiftSigned > 0.5) shiftSigned -= 1;
        return {
          index: i,
          hasAudio: !!(t.tape && t.tape.length),
          muted: t.muted,
          armed: t.armed,
          selected: i === selectedTrack,
          recording: t.recording,
          peak: t.peak,
          pcm: t.pcm,
          tape: t.tape,
          regionStart: trs,
          regionEnd: tre,
          regionStart01: takeFrames > 0 ? trs / takeFrames : 0,
          regionEnd01: takeFrames > 0 ? tre / takeFrames : 1,
          tiles: cycleFrames > 0 ? cycleFrames / tlen : 1,
          shiftFrames: shiftF,
          shift01: cycleFrames > 0 ? shiftF / cycleFrames : 0,
          shiftMs: sampleRate > 0 ? (shiftF / sampleRate) * 1000 : 0,
          shiftSigned01: shiftSigned,
          pitchSemitones: t.pitchSemitones || 0,
          volume: t.volume ?? 1,
          eqLowDb: t.eqLowDb || 0,
          eqHighDb: t.eqHighDb || 0,
          reverb: t.reverb || 0,
        };
      }),
    };
  }

  function exportSnapshot() {
    return {
      bpm,
      quantize,
      barsPreset,
      cycleFrames,
      takeFrames,
      archiveFrames: takeFrames,
      trimStart: 0,
      trimEnd: cycleFrames,
      sampleRate,
      selectedTrack,
      phraseSnap,
      syncOffsetMs,
      tracks: tracks.map((t) => ({
        muted: !!t.muted,
        armed: !!t.armed,
        shiftFrames: t.shiftFrames || 0,
        pitchSemitones: t.pitchSemitones || 0,
        volume: t.volume ?? 1,
        eqLowDb: t.eqLowDb || 0,
        eqHighDb: t.eqHighDb || 0,
        reverb: t.reverb || 0,
        regionStart: t.regionStart | 0,
        regionEnd: t.regionEnd | 0,
        tape:
          t.tape && typeof pcmToArrayBuffer === "function"
            ? pcmToArrayBuffer(t.tape)
            : t.tape
              ? t.tape.slice().buffer
              : null,
        archivePcm:
          t.tape && typeof pcmToArrayBuffer === "function"
            ? pcmToArrayBuffer(t.tape)
            : null,
        pcm:
          t.pcm && typeof pcmToArrayBuffer === "function"
            ? pcmToArrayBuffer(t.pcm)
            : null,
      })),
    };
  }

  function importSnapshot(snap) {
    cancelRecording();
    stopTrackSources();
    playing = false;
    cycleOrigin = 0;
    cycleFrames = 0;
    takeFrames = 0;
    trimStart = 0;
    trimEnd = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      t.tape = null;
      t.pcm = null;
      t.regionStart = 0;
      t.regionEnd = 0;
      t.shiftFrames = 0;
      t.pitchSemitones = 0;
      t.volume = 1;
      t.eqLowDb = 0;
      t.eqHighDb = 0;
      t.reverb = 0;
      t.peak = 0;
      t.recording = false;
      t.muted = false;
      t.armed = false;
      applyTrackFx(i);
    }
    tracks[0].armed = true;
    selectedTrack = 0;

    if (!snap) {
      emit();
      return;
    }

    bpm = Math.max(40, Math.min(240, Math.round(Number(snap.bpm) || 120)));
    if (snap.quantize === "off" || snap.quantize === "beat" || snap.quantize === "bar") {
      quantize = snap.quantize;
    }
    const b = Number(snap.barsPreset);
    barsPreset = b === 1 || b === 2 || b === 4 || b === 8 ? b : 0;
    sampleRate = snap.sampleRate || sampleRate;
    selectedTrack = Math.max(0, Math.min(LOOPER_TRACKS - 1, snap.selectedTrack | 0));
    if (typeof snap.phraseSnap === "boolean") phraseSnap = snap.phraseSnap;
    if (snap.syncOffsetMs != null) {
      syncOffsetMs = Math.max(-80, Math.min(80, Number(snap.syncOffsetMs) || 0));
    }

    const list = snap.tracks || [];
    let maxTake = 0;
    for (let i = 0; i < tracks.length; i++) {
      const src = list[i];
      if (!src) continue;
      tracks[i].muted = !!src.muted;
      tracks[i].armed = !!src.armed;
      tracks[i].shiftFrames = src.shiftFrames | 0;
      tracks[i].pitchSemitones = src.pitchSemitones || 0;
      tracks[i].volume =
        src.volume != null ? Math.max(0, Math.min(1.5, Number(src.volume))) : 1;
      tracks[i].eqLowDb = src.eqLowDb || 0;
      tracks[i].eqHighDb = src.eqHighDb || 0;
      tracks[i].reverb =
        src.reverb != null ? Math.max(0, Math.min(1, Number(src.reverb))) : 0;
      const tape =
        typeof pcmFromStored === "function"
          ? pcmFromStored(src.tape || src.archivePcm || src.pcm)
          : null;
      if (tape && tape.length) {
        tracks[i].tape = tape;
        maxTake = Math.max(maxTake, tape.length);
        const rs = src.regionStart | 0;
        const re = src.regionEnd | 0;
        if (re > rs) {
          tracks[i].regionStart = Math.max(0, Math.min(tape.length - 1, rs));
          tracks[i].regionEnd = Math.max(
            tracks[i].regionStart + 1,
            Math.min(tape.length, re)
          );
        } else {
          tracks[i].regionStart = 0;
          tracks[i].regionEnd = tape.length;
        }
      }
    }

    takeFrames =
      (snap.takeFrames | 0) > 0
        ? snap.takeFrames | 0
        : (snap.archiveFrames | 0) > 0
          ? snap.archiveFrames | 0
          : maxTake;

    if (takeFrames > 0) {
      for (const t of tracks) {
        if (!t.tape) continue;
        if (t.tape.length !== takeFrames) {
          const n = new Float32Array(takeFrames);
          n.set(t.tape.subarray(0, Math.min(t.tape.length, takeFrames)));
          t.tape = n;
        }
        if (!(t.regionEnd > t.regionStart)) {
          t.regionStart = 0;
          t.regionEnd = t.tape.length;
        }
      }
      // Master cycle: prefer snap.cycleFrames; legacy trim window as fallback
      let cf = snap.cycleFrames | 0;
      if (cf <= 0) {
        const ts = Math.max(0, snap.trimStart | 0);
        const te =
          snap.trimEnd > ts ? Math.min(takeFrames, snap.trimEnd | 0) : takeFrames;
        cf = Math.max(64, te - ts);
      }
      cycleFrames = Math.max(minCycleFrames(), Math.min(takeFrames, cf));
      trimStart = 0;
      trimEnd = cycleFrames;
      rebuildAllPcm();
    }
    if (!tracks.some((t) => t.armed)) tracks[0].armed = true;
    emit();
  }

  function dispose() {
    cancelRecording();
    stopTrackSources();
    if (recorder) {
      try {
        deps.getPadBus().disconnect(recorder);
      } catch {
        /* */
      }
      try {
        recorder.disconnect();
      } catch {
        /* */
      }
      recorder.onaudioprocess = null;
      recorder = null;
    }
    if (recorderSink) {
      try {
        recorderSink.disconnect();
      } catch {
        /* */
      }
      recorderSink = null;
    }
  }

  return {
    LOOPER_TRACKS,
    getState,
    setBpm,
    setQuantize,
    setBarsPreset,
    play,
    stop,
    toggleRec,
    arm,
    selectTrack,
    toggleMute,
    clear,
    clearAll,
    setTrim,
    setTrim01,
    resetTrim,
    setTrackRegion,
    setTrackRegion01,
    setMasterCycleFrames,
    setCycleEndAtPlayhead,
    setCycleStartAtPlayhead,
    halveCycle,
    doubleCycle,
    setTrackShift,
    setTrackShift01,
    setTrackShiftMs,
    nudgeTrackShift,
    nudgeTrackShiftMs,
    setTrackPitch,
    setTrackFx,
    setSyncOffsetMs,
    setPhraseSnap,
    setUiVisible() {},
    exportSnapshot,
    importSnapshot,
    dispose,
    // compat aliases
    cropCycle: (a, b) => setTrackRegion(selectedTrack, a, b),
    phaseFrames: () =>
      cycleFrames > 0 ? phaseFrames(deps.getCtx().currentTime) : 0,
  };
}

function drawLooperWaveform(canvas, pcm, phase01) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(42, 46, 56, 0.9)";
  ctx.fillRect(0, 0, w, h);
  if (!pcm || pcm.length < 2) {
    ctx.fillStyle = "rgba(138, 135, 144, 0.35)";
    ctx.fillRect(0, h / 2 - 0.5, w, 1);
    return;
  }
  ctx.strokeStyle = "rgba(232, 160, 74, 0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const mid = h / 2;
  const step = Math.max(1, Math.floor(pcm.length / w));
  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const start = x * step;
    const end = Math.min(pcm.length, start + step);
    for (let i = start; i < end; i++) {
      const v = pcm[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x + 0.5, mid + min * mid * 0.9);
    ctx.lineTo(x + 0.5, mid + max * mid * 0.9);
  }
  ctx.stroke();
  if (phase01 != null && phase01 >= 0) {
    const x = Math.floor(phase01 * w);
    ctx.fillStyle = "rgba(126, 200, 163, 0.95)";
    ctx.fillRect(x, 0, 2, h);
  }
}

window.createLooper = createLooper;
window.drawLooperWaveform = drawLooperWaveform;
window.LOOPER_TRACKS = LOOPER_TRACKS;
