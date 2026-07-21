/**
 * Parallel loopstation — records padBus mix into independent tracks.
 * Survives kit Reset; never touches Sampler/Drums state.
 *
 * Musical model (Boss RC / Ableton Looper style):
 *   - First take defines cycle length (optional bars preset / grid snap)
 *   - Later takes fill or overdub the armed track for one cycle
 *   - Quantize snaps Rec in/out to beat or bar
 *   - Mute is gain-only (phase stays locked)
 *   - Tiny seam crossfade avoids loop clicks
 *
 * Capture: ScriptProcessor (4096) into Float32Array.
 * Playback: BufferSource.loop = true per track with audio.
 */

const LOOPER_TRACKS = 4;
const LOOPER_MAX_SEC = 30;
const LOOPER_PROC_SIZE = 4096;
const LOOPER_BEATS_PER_BAR = 4;
/** Samples of equal-power crossfade at loop seam */
const LOOPER_SEAM_FADE = 128;

/**
 * @param {{
 *   getCtx: () => AudioContext,
 *   getPadBus: () => GainNode,
 *   onChange?: () => void,
 * }} deps
 */
function createLooper(deps) {
  const tracks = [];
  for (let i = 0; i < LOOPER_TRACKS; i++) {
    tracks.push({
      pcm: null, // Float32Array | null
      muted: false,
      armed: i === 0,
      recording: false,
      peak: 0,
      /** @type {AudioBufferSourceNode|null} */
      source: null,
      /** @type {GainNode|null} */
      gainNode: null,
    });
  }

  let bpm = 120;
  /** @type {'off'|'beat'|'bar'} */
  let quantize = "bar";
  /** @type {0|1|2|4|8} 0 = free first take */
  let barsPreset = 4;
  let playing = false;
  let cycleFrames = 0;
  let sampleRate = 44100;
  /** AudioContext time of cycle phase 0 */
  let cycleOrigin = 0;

  /** @type {ScriptProcessorNode|null} */
  let recorder = null;
  /** @type {GainNode|null} */
  let recorderSink = null;
  /** @type {GainNode|null} */
  let loopBus = null;

  let recTrack = -1;
  let recWrite = 0;
  /** @type {Float32Array|null} first-take scratch only */
  let recScratch = null;
  let recIsFirst = false;
  let recStopAt = 0;
  let recPendingStop = false;
  let recPendingStart = false;
  let recStartAtCtx = 0;
  /** Latency compensation into the cycle (frames) */
  let recLatencyFrames = 0;

  let uiVisible = false;

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

  function ensureLoopBus() {
    const ctx = deps.getCtx();
    sampleRate = ctx.sampleRate || 44100;
    if (!loopBus) {
      loopBus = ctx.createGain();
      loopBus.gain.value = 1;
      loopBus.connect(ctx.destination);
    }
    return loopBus;
  }

  function maxFrames() {
    return Math.floor(LOOPER_MAX_SEC * sampleRate);
  }

  function quantizeStepSec() {
    if (quantize === "beat") return beatSec();
    if (quantize === "bar") return barSec();
    return 0;
  }

  function estimateLatencyFrames(ctx) {
    // ScriptProcessor buffers input; pad monitor path is near-direct.
    // Compensate so overdubs land on the felt downbeat.
    const base = typeof ctx.baseLatency === "number" ? ctx.baseLatency : 0;
    const out = typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0;
    return Math.round((base + out) * sampleRate) + LOOPER_PROC_SIZE;
  }

  /** Next grid boundary at or after ctxTime. */
  function nextGridTime(ctxTime) {
    const step = quantizeStepSec();
    if (step <= 0) return ctxTime;
    if (cycleOrigin == null || cycleFrames <= 0) {
      // No established cycle — first hit defines the downbeat (start now)
      return ctxTime;
    }
    const elapsed = Math.max(0, ctxTime - cycleOrigin);
    const next = Math.ceil(elapsed / step - 1e-9) * step;
    return cycleOrigin + next;
  }

  function phaseFrames(ctxTime) {
    if (cycleFrames <= 0) return 0;
    const elapsed = (ctxTime - cycleOrigin) * sampleRate;
    let f = Math.floor(elapsed) % cycleFrames;
    if (f < 0) f += cycleFrames;
    return f;
  }

  function stopTrackSources() {
    for (const t of tracks) {
      if (t.source) {
        try {
          t.source.stop();
        } catch {
          /* already stopped */
        }
        try {
          t.source.disconnect();
        } catch {
          /* */
        }
        t.source = null;
      }
    }
  }

  function pcmToBuffer(pcm) {
    const ctx = deps.getCtx();
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.getChannelData(0).set(pcm);
    return buf;
  }

  /** Soften the wrap point so loops don't click. */
  function applySeamCrossfade(pcm) {
    const n = Math.min(LOOPER_SEAM_FADE, Math.floor(pcm.length / 4));
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // equal-ish power: fade end into start
      const fadeIn = Math.sin((t * Math.PI) / 2);
      const fadeOut = Math.cos((t * Math.PI) / 2);
      const start = pcm[i];
      const end = pcm[pcm.length - n + i];
      pcm[i] = start * fadeIn + end * fadeOut;
    }
  }

  /** Snap a frame count to the active quantize grid (musical loop length). */
  function snapLengthFrames(len) {
    const step = quantizeStepSec();
    if (step <= 0) return len;
    const stepFrames = Math.max(1, Math.round(step * sampleRate));
    let snapped = Math.round(len / stepFrames) * stepFrames;
    if (snapped < stepFrames) snapped = stepFrames;
    return Math.min(maxFrames(), snapped);
  }

  function ensureTrackPcm(idx) {
    const t = tracks[idx];
    if (!t.pcm || t.pcm.length !== cycleFrames) {
      const next = new Float32Array(cycleFrames);
      if (t.pcm && t.pcm.length) {
        next.set(t.pcm.subarray(0, Math.min(t.pcm.length, cycleFrames)));
      }
      t.pcm = next;
    }
    return t.pcm;
  }

  function startTrackSource(idx, when) {
    const t = tracks[idx];
    if (!t.pcm || t.pcm.length === 0) return;
    const ctx = deps.getCtx();
    ensureLoopBus();
    if (!t.gainNode) {
      t.gainNode = ctx.createGain();
      t.gainNode.connect(loopBus);
    }
    // Keep source running while muted — gain only (phase-locked like hardware)
    t.gainNode.gain.value = t.muted ? 0 : 1;

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
    src.connect(t.gainNode);

    const dur = t.pcm.length / sampleRate;
    let offset = 0;
    if (cycleFrames > 0 && dur > 0) {
      const elapsed = Math.max(0, when - cycleOrigin);
      offset = elapsed % dur;
    }
    try {
      src.start(when, offset);
    } catch {
      src.start();
    }
    t.source = src;
  }

  function restartAllSources(when) {
    stopTrackSources();
    if (!playing || cycleFrames <= 0) return;
    for (let i = 0; i < tracks.length; i++) {
      startTrackSource(i, when);
    }
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
      const out = ev.outputBuffer.getChannelData(0);
      out.fill(0);

      if (recTrack < 0) return;
      if (recIsFirst && !recScratch) return;

      const ctxNow = ctx.currentTime;

      if (recPendingStart) {
        if (ctxNow < recStartAtCtx) return;
        recPendingStart = false;
        if (recIsFirst) {
          cycleOrigin = recStartAtCtx;
          recWrite = 0;
        } else if (cycleFrames > 0) {
          recWrite = phaseFrames(recStartAtCtx);
          recStopAt = recWrite + cycleFrames;
          ensureTrackPcm(recTrack);
        }
        emit();
      }

      let peak = 0;
      const t = tracks[recTrack];
      const n = input.length;
      const lat = recLatencyFrames;

      for (let i = 0; i < n; i++) {
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
          if (cycleFrames <= 0) break;
          const pcm = ensureTrackPcm(recTrack);
          // Latency-compensated write so pad hits land on the grid you heard
          let idx = recWrite - lat;
          while (idx < 0) idx += cycleFrames;
          idx %= cycleFrames;
          pcm[idx] = clampSample(pcm[idx] + v);
          recWrite++;
          if (recStopAt > 0 && recWrite >= recStopAt) {
            finishRecording();
            break;
          }
        }
      }

      if (t) t.peak = peak;
    };
  }

  function clampSample(v) {
    if (v > 1) return 1;
    if (v < -1) return -1;
    return v;
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
        // < 50ms — discard accidental tap
        recScratch = null;
        recTrack = -1;
        recIsFirst = false;
        recPendingStop = false;
        recPendingStart = false;
        playing = false;
        cycleOrigin = 0;
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
        // Free length but grid-snapped — musical loop boundaries
        len = snapLengthFrames(len);
        if (len > recScratch.length) len = recScratch.length;
        if (recWrite < len) {
          // pad silence to the snapped boundary
          // (recScratch already zero-filled beyond recWrite)
        }
      }

      cycleFrames = len;
      const pcm = new Float32Array(recScratch.subarray(0, len));
      applySeamCrossfade(pcm);
      t.pcm = pcm;
      recScratch = null;

      playing = true;
      // Align playback so "now" is the moment we closed the loop (phase ~ 0
      // if we stopped on a grid). Keeps the drop seamless.
      const ctx = deps.getCtx();
      if (quantize !== "off" || barsPreset > 0) {
        cycleOrigin = ctx.currentTime;
      }
      restartAllSources(ctx.currentTime);
    } else if (!recIsFirst) {
      if (t.pcm) applySeamCrossfade(t.pcm);
      if (playing && t.pcm) {
        startTrackSource(idx, deps.getCtx().currentTime);
      }
    }

    recTrack = -1;
    recIsFirst = false;
    recPendingStop = false;
    recPendingStart = false;
    recStopAt = 0;
    emit();
  }

  function armedIndex() {
    return tracks.findIndex((tr) => tr.armed);
  }

  function arm(i) {
    for (let j = 0; j < tracks.length; j++) {
      tracks[j].armed = j === i;
    }
    emit();
  }

  function toggleMute(i) {
    const t = tracks[i];
    if (!t) return;
    t.muted = !t.muted;
    if (t.gainNode) {
      t.gainNode.gain.value = t.muted ? 0 : 1;
    } else if (playing && t.pcm && !t.muted) {
      startTrackSource(i, deps.getCtx().currentTime);
    }
    emit();
  }

  function clear(i) {
    const t = tracks[i];
    if (!t) return;
    if (t.recording && recTrack === i) {
      cancelRecording();
    }
    if (t.source) {
      try {
        t.source.stop();
      } catch {
        /* */
      }
      t.source = null;
    }
    t.pcm = null;
    t.peak = 0;

    if (tracks.every((x) => !x.pcm)) {
      cycleFrames = 0;
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
      t.pcm = null;
      t.peak = 0;
      t.recording = false;
    }
    cycleFrames = 0;
    playing = false;
    cycleOrigin = 0;
    emit();
  }

  function cancelRecording() {
    if (recTrack < 0) return;
    const t = tracks[recTrack];
    t.recording = false;
    t.peak = 0;
    recScratch = null;
    recTrack = -1;
    recIsFirst = false;
    recPendingStop = false;
    recPendingStart = false;
    recStopAt = 0;
  }

  function play() {
    deps.getCtx();
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
    cancelRecording();
    playing = false;
    stopTrackSources();
    emit();
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
    recLatencyFrames = estimateLatencyFrames(ctx);

    const now = ctx.currentTime;
    const isFirst = cycleFrames <= 0;

    recTrack = idx;
    recIsFirst = isFirst;
    recWrite = 0;
    tracks[idx].recording = true;
    tracks[idx].armed = true;
    for (let j = 0; j < tracks.length; j++) {
      if (j !== idx) tracks[j].armed = false;
    }

    if (isFirst) {
      const cap = maxFrames();
      recScratch = new Float32Array(cap);
      if (barsPreset > 0) {
        recStopAt = Math.min(
          cap,
          Math.round(barsPreset * barSec() * sampleRate)
        );
      } else {
        recStopAt = 0;
      }
      // First press = downbeat (hardware loopers don't wait for a phantom grid)
      cycleOrigin = now;
      recStartAtCtx = now;
      recPendingStart = false;
      playing = true;
    } else {
      // Fill / overdub armed track for exactly one cycle, starting on grid
      ensureTrackPcm(idx);
      const startAt = nextGridTime(now);
      recStartAtCtx = startAt;
      recPendingStart = quantize !== "off" && startAt > now + 0.002;
      if (!recPendingStart) {
        recWrite = phaseFrames(now);
        recStopAt = recWrite + cycleFrames;
      } else {
        recStopAt = cycleFrames; // adjusted when start fires
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
        // Already auto-stops at bars length — treat as "close now" → finish at target
        // If still early, jump stop to current write (user wants out) only if quantize off…
        // With bars preset, second press finishes early and pads to bars in finishRecording
        finishRecording();
        return;
      }
      // Quantized free length: keep rolling to next grid, then close
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

  function getState() {
    return {
      bpm,
      quantize,
      barsPreset,
      playing,
      cycleFrames,
      cycleSec: cycleSec(),
      sampleRate,
      recording: recTrack >= 0,
      waitingStart: recPendingStart,
      waitingStop: recPendingStop,
      recTrack,
      tracks: tracks.map((t, i) => ({
        index: i,
        hasAudio: !!(t.pcm && t.pcm.length),
        muted: t.muted,
        armed: t.armed,
        recording: t.recording,
        peak: t.peak,
        pcm: t.pcm,
      })),
      phase01: (() => {
        if (cycleFrames <= 0 || !playing) return 0;
        return phaseFrames(deps.getCtx().currentTime) / cycleFrames;
      })(),
    };
  }

  function setUiVisible(v) {
    uiVisible = !!v;
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
    toggleMute,
    clear,
    clearAll,
    setUiVisible,
    dispose,
    phaseFrames: () =>
      cycleFrames > 0 ? phaseFrames(deps.getCtx().currentTime) : 0,
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Float32Array|null} pcm
 * @param {number} [phase01] playhead 0..1
 */
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
    ctx.fillStyle = "rgba(232, 160, 74, 0.9)";
    ctx.fillRect(x, 0, 2, h);
  }
}

window.createLooper = createLooper;
window.drawLooperWaveform = drawLooperWaveform;
window.LOOPER_TRACKS = LOOPER_TRACKS;
