/**
 * Real-time loopstation
 * --------------------
 * Shared clock:   cycleOrigin + cycleFrames (all tracks lock to this)
 * Per track:      tape[takeFrames]  full recording
 *                 shiftFrames       circular sync offset into the cycle
 *                 pitchSemitones    playbackRate
 * Cycle trim:     [trimStart, trimEnd) into takeFrames — non-destructive;
 *                 expand/shrink freely within the original take.
 *
 * Overdubs write into each track's tape at the absolute trim window so
 * expanding the selection never loses what was recorded.
 */

const LOOPER_TRACKS = 4;
const LOOPER_MAX_SEC = 30;
const LOOPER_PROC_SIZE = 4096;
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
   *   shiftFrames: number,
   *   pitchSemitones: number,
   *   muted: boolean,
   *   armed: boolean,
   *   recording: boolean,
   *   peak: number,
   *   source: AudioBufferSourceNode|null,
   *   gainNode: GainNode|null,
   * }>} */
  const tracks = [];
  for (let i = 0; i < LOOPER_TRACKS; i++) {
    tracks.push({
      tape: null,
      pcm: null,
      shiftFrames: 0,
      pitchSemitones: 0,
      muted: false,
      armed: i === 0,
      recording: false,
      peak: 0,
      source: null,
      gainNode: null,
    });
  }

  let bpm = 120;
  /** @type {'off'|'beat'|'bar'} */
  let quantize = "off";
  /** @type {0|1|2|4|8} */
  let barsPreset = 0;
  let playing = false;
  let sampleRate = 44100;

  /** Original take length (all tapes share this). */
  let takeFrames = 0;
  /** Inclusive window into the take → playing cycle. */
  let trimStart = 0;
  let trimEnd = 0;
  /** Derived: trimEnd - trimStart */
  let cycleFrames = 0;
  /** AudioContext time of cycle phase 0 */
  let cycleOrigin = 0;

  /** Track shown in the cycle editor (click a row to select). */
  let selectedTrack = 0;

  /** @type {ScriptProcessorNode|null} */
  let recorder = null;
  /** @type {GainNode|null} */
  let recorderSink = null;
  /** @type {GainNode|null} */
  let loopBus = null;

  let recTrack = -1;
  let recWrite = 0;
  /** @type {Float32Array|null} */
  let recScratch = null;
  let recIsFirst = false;
  let recStopAt = 0;
  let recPendingStop = false;
  let recPendingStart = false;
  let recStartAtCtx = 0;
  let recLatencyFrames = 0;

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
    return loopBus;
  }

  function quantizeStepSec() {
    if (quantize === "beat") return beatSec();
    if (quantize === "bar") return barSec();
    return 0;
  }

  function estimateLatencyFrames(ctx) {
    const base = typeof ctx.baseLatency === "number" ? ctx.baseLatency : 0;
    const out = typeof ctx.outputLatency === "number" ? ctx.outputLatency : 0;
    return Math.round((base + out) * sampleRate) + LOOPER_PROC_SIZE;
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
   * Build playing buffer for one track from tape[trim] + shift.
   * Always length === cycleFrames when tape exists.
   */
  function rebuildTrackPcm(idx) {
    const t = tracks[idx];
    if (cycleFrames <= 0 || !t.tape || takeFrames <= 0) {
      t.pcm = null;
      return;
    }
    const slice = new Float32Array(cycleFrames);
    const a = Math.min(trimStart, t.tape.length);
    const n = Math.max(0, Math.min(cycleFrames, t.tape.length - a));
    if (n > 0) slice.set(t.tape.subarray(a, a + n));
    const out = new Float32Array(cycleFrames);
    circularShiftInto(out, slice, t.shiftFrames);
    applySeamCrossfade(out);
    t.pcm = out;
  }

  function rebuildAllPcm() {
    cycleFrames = Math.max(0, trimEnd - trimStart);
    for (let i = 0; i < tracks.length; i++) rebuildTrackPcm(i);
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
   * offset is always derived from cycleOrigin so every track stays in phase.
   */
  function startTrackSource(idx, when) {
    const t = tracks[idx];
    if (!t.pcm || t.pcm.length !== cycleFrames || cycleFrames <= 0) return;
    const ctx = deps.getCtx();
    ensureLoopBus();
    if (!t.gainNode) {
      t.gainNode = ctx.createGain();
      t.gainNode.connect(loopBus);
    }
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
    src.playbackRate.value = Math.pow(2, (t.pitchSemitones || 0) / 12);
    src.connect(t.gainNode);

    const offsetSec = phaseFrames(when) / sampleRate;
    try {
      src.start(when, offsetSec);
    } catch {
      src.start();
    }
    t.source = src;
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
          ensureTrackTape(recTrack);
          rebuildTrackPcm(recTrack);
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
          if (cycleFrames <= 0 || takeFrames <= 0) break;
          let idx = recWrite - lat;
          while (idx < 0) idx += cycleFrames;
          idx %= cycleFrames;
          // Undo track shift so material lands on the timeline the user hears
          const unshifted = (idx + t.shiftFrames) % cycleFrames;
          const abs = trimStart + unshifted;
          const tape = ensureTrackTape(recTrack);
          if (tape && abs >= 0 && abs < tape.length) {
            tape[abs] = clampSample(tape[abs] + v);
          }
          // Mirror into playing buffer for live monitoring of the overdub
          if (t.pcm && t.pcm.length === cycleFrames) {
            t.pcm[idx] = clampSample(t.pcm[idx] + v);
          }
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
      trimStart = 0;
      trimEnd = len;
      cycleFrames = len;
      t.tape = new Float32Array(recScratch.subarray(0, len));
      t.shiftFrames = 0;
      recScratch = null;
      selectedTrack = idx;

      rebuildAllPcm();
      playing = true;
      const ctx = deps.getCtx();
      cycleOrigin = ctx.currentTime;
      restartAllSources(ctx.currentTime);
    } else if (!recIsFirst) {
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
    if (t.gainNode) t.gainNode.gain.value = t.muted ? 0 : 1;
    else if (playing && t.pcm && !t.muted) {
      startTrackSource(i, deps.getCtx().currentTime);
    }
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
    t.shiftFrames = 0;
    t.pitchSemitones = 0;
    t.peak = 0;
    if (tracks.every((x) => !x.tape)) {
      takeFrames = 0;
      trimStart = 0;
      trimEnd = 0;
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
      t.tape = null;
      t.pcm = null;
      t.shiftFrames = 0;
      t.pitchSemitones = 0;
      t.peak = 0;
      t.recording = false;
    }
    takeFrames = 0;
    trimStart = 0;
    trimEnd = 0;
    cycleFrames = 0;
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
   * Set cycle window inside the take. Expand or shrink freely.
   * Preserves musical phase across the change.
   */
  function setTrim(startFrame, endFrame) {
    if (takeFrames <= 0) return false;
    let a = Math.max(0, Math.floor(Number(startFrame) || 0));
    let b = Math.min(takeFrames, Math.floor(Number(endFrame) || 0));
    if (b <= a) return false;
    const minN = minCycleFrames();
    if (b - a < minN) {
      b = Math.min(takeFrames, a + minN);
      if (b - a < minN) a = Math.max(0, b - minN);
    }
    if (b - a < 64) return false;
    trimStart = a;
    trimEnd = b;
    resyncPlayback();
    return true;
  }

  function setTrim01(start01, end01) {
    if (takeFrames <= 0) return false;
    return setTrim(start01 * takeFrames, end01 * takeFrames);
  }

  function resetTrim() {
    if (takeFrames <= 0) return false;
    return setTrim(0, takeFrames);
  }

  function setCycleEndAtPlayhead() {
    if (takeFrames <= 0 || !playing) return false;
    const abs = trimStart + phaseFrames(deps.getCtx().currentTime);
    if (abs - trimStart < minCycleFrames()) return false;
    return setTrim(trimStart, abs);
  }

  function setCycleStartAtPlayhead() {
    if (takeFrames <= 0 || !playing) return false;
    const abs = trimStart + phaseFrames(deps.getCtx().currentTime);
    if (trimEnd - abs < minCycleFrames()) return false;
    return setTrim(abs, trimEnd);
  }

  function halveCycle() {
    if (cycleFrames < minCycleFrames() * 2) return false;
    return setTrim(trimStart, trimStart + Math.floor(cycleFrames / 2));
  }

  function doubleCycle() {
    if (cycleFrames <= 0 || cycleFrames * 2 > maxFrames()) return false;
    const len = cycleFrames;
    // Extend take: duplicate current cycle content for every track
    for (const t of tracks) {
      if (!t.pcm || t.pcm.length !== len) continue;
      const chunk = new Float32Array(t.pcm);
      // Unshift so tape stores timeline order
      const unshifted = new Float32Array(len);
      circularShiftInto(unshifted, chunk, -t.shiftFrames);
      const tape = new Float32Array(len * 2);
      tape.set(unshifted, 0);
      tape.set(unshifted, len);
      t.tape = tape;
    }
    takeFrames = len * 2;
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
    if (t.source) {
      t.source.playbackRate.value = Math.pow(2, t.pitchSemitones / 12);
    } else if (playing && t.pcm) {
      startTrackSource(idx, deps.getCtx().currentTime);
    }
    emit();
    return true;
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
    const isFirst = takeFrames <= 0 || cycleFrames <= 0;

    recTrack = idx;
    recIsFirst = isFirst;
    recWrite = 0;
    tracks[idx].recording = true;
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
      rebuildTrackPcm(idx);
      const startAt = nextGridTime(now);
      recStartAtCtx = startAt;
      recPendingStart = quantize !== "off" && startAt > now + 0.002;
      if (!recPendingStart) {
        recWrite = phaseFrames(now);
        recStopAt = recWrite + cycleFrames;
      } else {
        recStopAt = cycleFrames;
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
      trimStart,
      trimEnd,
      trimStart01: takeFrames > 0 ? trimStart / takeFrames : 0,
      trimEnd01: takeFrames > 0 ? trimEnd / takeFrames : 1,
      sampleRate,
      recording: recTrack >= 0,
      waitingStart: recPendingStart,
      waitingStop: recPendingStop,
      recTrack,
      selectedTrack,
      phase01: ph,
      cropPhase01:
        takeFrames > 0
          ? (trimStart + ph * cycleFrames) / takeFrames
          : 0,
      masterPcm: selectedTape(),
      tracks: tracks.map((t, i) => ({
        index: i,
        hasAudio: !!(t.tape && t.tape.length),
        muted: t.muted,
        armed: t.armed,
        selected: i === selectedTrack,
        recording: t.recording,
        peak: t.peak,
        pcm: t.pcm,
        tape: t.tape,
        shiftFrames: t.shiftFrames || 0,
        shift01: cycleFrames > 0 ? (t.shiftFrames || 0) / cycleFrames : 0,
        pitchSemitones: t.pitchSemitones || 0,
      })),
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
      trimStart,
      trimEnd,
      sampleRate,
      selectedTrack,
      tracks: tracks.map((t) => ({
        muted: !!t.muted,
        armed: !!t.armed,
        shiftFrames: t.shiftFrames || 0,
        pitchSemitones: t.pitchSemitones || 0,
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
    for (const t of tracks) {
      t.tape = null;
      t.pcm = null;
      t.shiftFrames = 0;
      t.pitchSemitones = 0;
      t.peak = 0;
      t.recording = false;
      t.muted = false;
      t.armed = false;
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

    const list = snap.tracks || [];
    let maxTake = 0;
    for (let i = 0; i < tracks.length; i++) {
      const src = list[i];
      if (!src) continue;
      tracks[i].muted = !!src.muted;
      tracks[i].armed = !!src.armed;
      tracks[i].shiftFrames = src.shiftFrames | 0;
      tracks[i].pitchSemitones = src.pitchSemitones || 0;
      const tape =
        typeof pcmFromStored === "function"
          ? pcmFromStored(src.tape || src.archivePcm || src.pcm)
          : null;
      if (tape && tape.length) {
        tracks[i].tape = tape;
        maxTake = Math.max(maxTake, tape.length);
      }
    }

    takeFrames =
      (snap.takeFrames | 0) > 0
        ? snap.takeFrames | 0
        : (snap.archiveFrames | 0) > 0
          ? snap.archiveFrames | 0
          : maxTake;

    if (takeFrames > 0) {
      // Normalize tapes to takeFrames
      for (const t of tracks) {
        if (!t.tape) continue;
        if (t.tape.length !== takeFrames) {
          const n = new Float32Array(takeFrames);
          n.set(t.tape.subarray(0, Math.min(t.tape.length, takeFrames)));
          t.tape = n;
        }
      }
      trimStart = Math.max(0, snap.trimStart | 0);
      trimEnd =
        snap.trimEnd > trimStart
          ? Math.min(takeFrames, snap.trimEnd | 0)
          : takeFrames;
      trimEnd = Math.min(takeFrames, Math.max(trimStart + 64, trimEnd));
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
    setCycleEndAtPlayhead,
    setCycleStartAtPlayhead,
    halveCycle,
    doubleCycle,
    setTrackShift,
    setTrackShift01,
    nudgeTrackShift,
    setTrackPitch,
    setUiVisible() {},
    exportSnapshot,
    importSnapshot,
    dispose,
    // compat aliases
    cropCycle: (a, b) => setTrim(trimStart + a, trimStart + b),
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
