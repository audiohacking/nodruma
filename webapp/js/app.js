(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const dropInner = dropzone.querySelector(".drop-inner");
  const deck = document.getElementById("deck");
  const padGrid = document.getElementById("pad-grid");
  const bankLabel = document.getElementById("bank-label");
  const padStats = document.getElementById("pad-stats");
  const btnExport = document.getElementById("btn-export");
  const btnLoad = document.getElementById("btn-load");
  const btnAdd = document.getElementById("btn-add");
  const engineVer = document.getElementById("engine-ver");

  const player = new PadPlayer();
  const kit = new Kit();
  let api = null;
  let bank = 0;
  let busy = false;
  let dragDepth = 0;

  /** @type {'replace'|'append'} */
  let loadMode = "replace";

  const BANK_NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const AUDIO_EXT = /\.(wav|wave|aif|aiff|mp3|ogg|flac|m4a|aac|webm)$/i;

  function setProgress(frac, label) {
    progress.classList.remove("hidden");
    dropInner?.classList.add("hidden");
    progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    progressLabel.textContent = label || "";
  }

  function hideProgress() {
    progress.classList.add("hidden");
    dropInner?.classList.remove("hidden");
  }

  function setBusy(on) {
    busy = on;
    btnLoad.disabled = on;
    btnAdd.disabled = on || kit.activePads().length === 0;
    btnExport.disabled = on || kit.activePads().length === 0;
  }

  async function init() {
    try {
      api = await loadNodruma();
      engineVer.textContent = `engine ${api.version()}`;
    } catch (err) {
      engineVer.textContent = "engine unavailable";
      console.error(err);
      alert(err.message || String(err));
    }
  }

  function renderPads() {
    const active = kit.activePads();
    const banks = kit.bankCount();
    if (bank >= banks) bank = Math.max(0, banks - 1);
    bankLabel.textContent = `BANK ${BANK_NAMES[bank] || bank} · keys 1–9`;
    padStats.textContent = `${active.length} pads · ${banks} bank${banks > 1 ? "s" : ""}`;
    if (!busy) {
      btnExport.disabled = active.length === 0;
      btnAdd.disabled = active.length === 0;
    }

    padGrid.innerHTML = "";
    for (let slot = 0; slot < 9; slot++) {
      const pad = kit.padAtBankSlot(bank, slot);
      const el = document.createElement("div");
      el.className = "pad" + (pad ? ` ${pad.kind}` : " empty");
      el.dataset.slot = String(slot);

      const key = document.createElement("span");
      key.className = "pad-key";
      key.textContent = String(slot + 1);
      el.appendChild(key);

      if (!pad) {
        padGrid.appendChild(el);
        continue;
      }

      const kind = document.createElement("span");
      kind.className = "pad-kind";
      kind.textContent = pad.recreated ? `${pad.kind} · rebuilt` : pad.kind;
      el.appendChild(kind);

      const name = document.createElement("input");
      name.className = "pad-name";
      name.value = pad.name;
      name.spellcheck = false;
      name.addEventListener("change", () => kit.rename(pad.id, name.value));
      name.addEventListener("click", (e) => e.stopPropagation());
      el.appendChild(name);

      const actions = document.createElement("div");
      actions.className = "pad-actions";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "btn tiny";
      playBtn.textContent = "Play";
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerPad(pad, el);
      });

      const discardBtn = document.createElement("button");
      discardBtn.type = "button";
      discardBtn.className = "btn tiny danger";
      discardBtn.textContent = "Discard";
      discardBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        kit.discard(pad.id);
        renderPads();
      });

      actions.append(playBtn, discardBtn);
      el.appendChild(actions);

      el.addEventListener("pointerdown", () => triggerPad(pad, el));
      padGrid.appendChild(el);
    }
  }

  function triggerPad(pad, el) {
    player.ensureCtx();
    player.play(pad.id);
    if (el) {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 120);
    }
  }

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith("audio/")) return true;
    return AUDIO_EXT.test(file.name || "");
  }

  function collectAudioFiles(fileList) {
    return Array.from(fileList || []).filter(isAudioFile);
  }

  async function decodeFile(file) {
    const ctx = player.ensureCtx();
    const ab = await file.arrayBuffer();
    let audio;
    try {
      audio = await ctx.decodeAudioData(ab.slice(0));
    } catch (err) {
      throw new Error(`Could not decode “${file.name}” (${err.message || "unsupported format"})`);
    }
    const ch0 = audio.getChannelData(0);
    let mono;
    if (audio.numberOfChannels === 1) {
      mono = new Float32Array(ch0);
    } else {
      mono = new Float32Array(ch0.length);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < ch0.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
      }
    }
    return { mono, sampleRate: audio.sampleRate };
  }

  /**
   * Split + recreate one source file; returns new pad objects added.
   */
  async function ingestSource(file, progressBase, progressSpan, labelPrefix) {
    const { mono, sampleRate } = await decodeFile(file);
    setProgress(progressBase + progressSpan * 0.15, `${labelPrefix} splitting…`);
    await yieldToUi();

    api.clearHits();
    const { hits } = api.split(mono, sampleRate, { threshold: 1.0, minGap: 0.048 });
    if (!hits.length) {
      // Treat whole file as a single unknown chop so one-shots still land on a pad
      const pad = kit.addPad(
        { kind: "unknown", confidence: 0, index: 0 },
        mono,
        sampleRate
      );
      player.setSample(pad.id, pad.pcm, pad.sampleRate);
      return [pad];
    }

    const added = [];
    for (const h of hits) {
      const stem = file.name.replace(/\.[^.]+$/, "");
      const pad = kit.addPad(h.meta, h.pcm, h.sampleRate);
      if (hits.length === 1) pad.name = stem;
      else pad.name = `${stem}_${pad.name}`;
      player.setSample(pad.id, pad.pcm, pad.sampleRate);
      added.push(pad);
    }

    const toRebuild = added.filter(
      (p) => p.kind === "kick" || p.kind === "snare" || p.kind === "hat"
    );
    for (let i = 0; i < toRebuild.length; i++) {
      const p = toRebuild[i];
      const t = (i + 1) / Math.max(1, toRebuild.length);
      setProgress(
        progressBase + progressSpan * (0.3 + 0.7 * t),
        `${labelPrefix} recreating ${p.kind}…`
      );
      await yieldToUi();
      try {
        const out = api.recreate(p.pcm, p.sampleRate, p.kind);
        if (out && out.length) {
          kit.updatePcm(p.id, out, p.sampleRate);
          player.setSample(p.id, out, p.sampleRate);
        }
      } catch (err) {
        console.warn("recreate failed", p.name, err);
      }
    }
    return added;
  }

  /**
   * @param {File[]} files
   * @param {{append?: boolean}} opts
   */
  async function processFiles(files, opts = {}) {
    const list = collectAudioFiles(files);
    if (!list.length) {
      alert("No audio files found. Try WAV, AIFF, MP3, OGG, or FLAC.");
      return;
    }
    if (busy) return;

    if (!api) await init();
    if (!api) return;

    const append = !!opts.append && kit.pads.length > 0;
    setBusy(true);
    deck.classList.remove("hidden");

    try {
      if (!append) {
        player.clear();
        kit.reset(list.length === 1 ? list[0].name : "kit");
        bank = 0;
      } else if (kit.sourceName === "kit" || list.length > 1) {
        kit.sourceName = "kit";
      }

      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const base = i / list.length;
        const span = 1 / list.length;
        const prefix = list.length > 1 ? `[${i + 1}/${list.length}] ${file.name}` : file.name;
        setProgress(base, `${prefix} — decoding…`);
        await yieldToUi();
        await ingestSource(file, base, span, prefix);
        renderPads();
      }

      setProgress(1, `Done — ${kit.activePads().length} pads`);
      renderPads();
      setTimeout(hideProgress, 700);
    } catch (err) {
      console.error(err);
      hideProgress();
      alert(err.message || String(err));
    } finally {
      setBusy(false);
      renderPads();
    }
  }

  function yieldToUi() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function openFilePicker(mode) {
    loadMode = mode;
    fileInput.value = "";
    fileInput.click();
  }

  // --- Click / button load ---
  dropzone.addEventListener("click", (e) => {
    if (busy) return;
    if (e.target.closest("button")) return;
    openFilePicker(kit.pads.length ? "append" : "replace");
  });
  btnLoad.addEventListener("click", () => openFilePicker("replace"));
  btnAdd.addEventListener("click", () => openFilePicker("append"));

  fileInput.addEventListener("change", () => {
    const files = collectAudioFiles(fileInput.files);
    const append = loadMode === "append";
    fileInput.value = "";
    if (files.length) processFiles(files, { append });
  });

  // --- Drag & drop (window-level so the browser never navigates away) ---
  function onDragEnter(e) {
    e.preventDefault();
    dragDepth += 1;
    dropzone.classList.add("drag");
  }
  function onDragOver(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e) {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove("drag");
  }
  function onDrop(e) {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("drag");
    if (busy) return;
    const files = collectAudioFiles(e.dataTransfer?.files);
    processFiles(files, { append: kit.pads.length > 0 });
  }

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  document.getElementById("bank-prev").addEventListener("click", () => {
    bank = Math.max(0, bank - 1);
    renderPads();
  });
  document.getElementById("bank-next").addEventListener("click", () => {
    bank = Math.min(kit.bankCount() - 1, bank + 1);
    renderPads();
  });

  btnExport.addEventListener("click", async () => {
    try {
      const blob = await kit.exportZip();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${kit.sourceName || "nodruma"}_kit.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    let num = null;
    if (e.code.startsWith("Digit")) num = Number(e.code.slice(5));
    if (e.code.startsWith("Numpad")) num = Number(e.code.slice(6));
    if (!num || num < 1 || num > 9) return;
    const pad = kit.padAtBankSlot(bank, num - 1);
    if (!pad) return;
    e.preventDefault();
    const el = padGrid.querySelector(`[data-slot="${num - 1}"]`);
    triggerPad(pad, el);
  });

  init();
})();
