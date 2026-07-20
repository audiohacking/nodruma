(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const deck = document.getElementById("deck");
  const padGrid = document.getElementById("pad-grid");
  const bankLabel = document.getElementById("bank-label");
  const padStats = document.getElementById("pad-stats");
  const btnExport = document.getElementById("btn-export");
  const engineVer = document.getElementById("engine-ver");

  const player = new PadPlayer();
  const kit = new Kit();
  let api = null;
  let bank = 0;

  const BANK_NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  function setProgress(frac, label) {
    progress.classList.remove("hidden");
    progressFill.style.width = `${Math.round(frac * 100)}%`;
    progressLabel.textContent = label || "";
  }

  function hideProgress() {
    progress.classList.add("hidden");
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
    btnExport.disabled = active.length === 0;

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

  async function decodeFile(file) {
    const ctx = player.ensureCtx();
    const ab = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(ab.slice(0));
    const ch0 = audio.getChannelData(0);
    let mono;
    if (audio.numberOfChannels === 1) {
      mono = new Float32Array(ch0);
    } else {
      const ch1 = audio.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    }
    return { mono, sampleRate: audio.sampleRate };
  }

  async function processFile(file) {
    if (!api) await init();
    if (!api) return;

    dropzone.querySelector(".drop-inner")?.classList.add("hidden");
    deck.classList.remove("hidden");
    player.clear();
    kit.reset(file.name);
    api.clearHits();
    bank = 0;

    setProgress(0.05, "Decoding audio…");
    const { mono, sampleRate } = await decodeFile(file);

    setProgress(0.2, "Splitting groove…");
    await yieldToUi();
    const { hits } = api.split(mono, sampleRate, { threshold: 1.0, minGap: 0.048 });

    setProgress(0.4, `Found ${hits.length} hits — loading pads…`);
    for (const h of hits) {
      const pad = kit.addPad(h.meta, h.pcm, h.sampleRate);
      player.setSample(pad.id, pad.pcm, pad.sampleRate);
    }
    renderPads();

    // Background recreate for classified hits
    const toRebuild = kit.pads.filter((p) => p.kind === "kick" || p.kind === "snare" || p.kind === "hat");
    for (let i = 0; i < toRebuild.length; i++) {
      const p = toRebuild[i];
      setProgress(0.45 + (0.5 * (i + 1)) / Math.max(1, toRebuild.length), `Recreating ${p.name}…`);
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
      if (i % 3 === 2) renderPads();
    }

    setProgress(1, "Done");
    renderPads();
    setTimeout(hideProgress, 600);
    dropzone.querySelector(".drop-inner")?.classList.remove("hidden");
  }

  function yieldToUi() {
    return new Promise((r) => setTimeout(r, 0));
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) processFile(f);
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) processFile(f);
    fileInput.value = "";
  });

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
