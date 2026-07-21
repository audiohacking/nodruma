/**
 * In-dropzone waveform crop using wavesurfer.js + Regions.
 * Returns { startSec, endSec } or null if cancelled.
 */

/**
 * @param {HTMLElement} dropzone
 * @param {File} file
 * @param {{accent?: string, confirmLabel?: string}} [opts]
 * @returns {Promise<{startSec:number,endSec:number}|null>}
 */
function cropAudioInDropzone(dropzone, file, opts = {}) {
  if (typeof WaveSurfer === "undefined") {
    return Promise.reject(new Error("WaveSurfer failed to load"));
  }

  const accent = opts.accent || "rgba(232, 160, 74, 0.35)";
  const confirmLabel = opts.confirmLabel || "Use this";
  // UMD: WaveSurfer.Regions ; ESM: RegionsPlugin
  const RegionsPlugin =
    WaveSurfer.Regions ||
    WaveSurfer.RegionsPlugin ||
    (typeof Regions !== "undefined" ? Regions : null);
  if (!RegionsPlugin || typeof RegionsPlugin.create !== "function") {
    return Promise.reject(new Error("WaveSurfer Regions plugin missing"));
  }

  return new Promise((resolve) => {
    const dropInner = dropzone.querySelector(".drop-inner");
    const progress = dropzone.querySelector(".progress");
    dropInner?.classList.add("hidden");
    progress?.classList.add("hidden");
    dropzone.classList.add("cropping");

    const panel = document.createElement("div");
    panel.className = "crop-panel";
    panel.innerHTML = `
      <p class="crop-title">Select slice · <span class="crop-file"></span></p>
      <div class="crop-wave"></div>
      <div class="crop-meta"><span class="crop-range">—</span></div>
      <div class="crop-actions">
        <button type="button" class="btn ghost crop-play">Play</button>
        <button type="button" class="btn ghost danger crop-cancel">Cancel</button>
        <button type="button" class="btn primary crop-confirm"></button>
      </div>
    `;
    panel.querySelector(".crop-file").textContent = file.name;
    panel.querySelector(".crop-confirm").textContent = confirmLabel;
    dropzone.appendChild(panel);

    const waveEl = panel.querySelector(".crop-wave");
    const rangeEl = panel.querySelector(".crop-range");
    const btnPlay = panel.querySelector(".crop-play");
    const btnCancel = panel.querySelector(".crop-cancel");
    const btnConfirm = panel.querySelector(".crop-confirm");

    let wavesurfer = null;
    let region = null;
    let objectUrl = null;
    let settled = false;

    function fmt(sec) {
      if (!Number.isFinite(sec)) return "0:00";
      const m = Math.floor(sec / 60);
      const s = sec - m * 60;
      return `${m}:${s.toFixed(2).padStart(5, "0")}`;
    }

    function updateRange() {
      if (!region) return;
      const a = Math.min(region.start, region.end);
      const b = Math.max(region.start, region.end);
      rangeEl.textContent = `${fmt(a)} → ${fmt(b)}  (${fmt(b - a)})`;
    }

    function cleanup(result) {
      if (settled) return;
      settled = true;
      try {
        wavesurfer?.destroy();
      } catch (_) {
        /* ignore */
      }
      wavesurfer = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      panel.remove();
      dropzone.classList.remove("cropping");
      dropInner?.classList.remove("hidden");
      resolve(result);
    }

    btnCancel.addEventListener("click", (e) => {
      e.stopPropagation();
      cleanup(null);
    });

    btnConfirm.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!region || !wavesurfer) {
        cleanup(null);
        return;
      }
      const startSec = Math.min(region.start, region.end);
      const endSec = Math.max(region.start, region.end);
      const dur = wavesurfer.getDuration() || endSec;
      if (endSec - startSec < 0.05) {
        alert("Selection is too short — drag the handles to pick a longer slice.");
        return;
      }
      cleanup({
        startSec: Math.max(0, startSec),
        endSec: Math.min(dur, endSec),
      });
    });

    btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!wavesurfer || !region) return;
      const a = Math.min(region.start, region.end);
      const b = Math.max(region.start, region.end);
      if (wavesurfer.isPlaying()) {
        wavesurfer.pause();
        btnPlay.textContent = "Play";
        return;
      }
      wavesurfer.play(a, b);
      btnPlay.textContent = "Stop";
    });

    // Don't open file picker while cropping
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    objectUrl = URL.createObjectURL(file);
    const regions = RegionsPlugin.create();

    wavesurfer = WaveSurfer.create({
      container: waveEl,
      url: objectUrl,
      height: 88,
      waveColor: "rgba(138, 135, 144, 0.85)",
      progressColor: "rgba(232, 160, 74, 0.9)",
      cursorColor: "rgba(232, 160, 74, 0.8)",
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      interact: true,
    });

    wavesurfer.registerPlugin(regions);

    wavesurfer.on("ready", () => {
      const dur = wavesurfer.getDuration();
      // Default: full file selected; user crops left/right handles
      region = regions.addRegion({
        start: 0,
        end: dur,
        color: accent,
        drag: true,
        resize: true,
      });
      updateRange();
      region.on("update", updateRange);
      region.on("update-end", updateRange);
    });

    wavesurfer.on("finish", () => {
      btnPlay.textContent = "Play";
    });

    wavesurfer.on("error", (err) => {
      console.error(err);
      alert(`Could not load waveform for “${file.name}”`);
      cleanup(null);
    });
  });
}

/**
 * Slice mono PCM by time range.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{startSec:number,endSec:number}} crop
 */
function sliceMono(mono, sampleRate, crop) {
  const start = Math.max(0, Math.floor(crop.startSec * sampleRate));
  const end = Math.min(mono.length, Math.ceil(crop.endSec * sampleRate));
  if (end - start < 64) return new Float32Array(mono);
  return new Float32Array(mono.subarray(start, end));
}

window.cropAudioInDropzone = cropAudioInDropzone;
window.sliceMono = sliceMono;
