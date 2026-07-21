(() => {
  const BANK_NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const AUDIO_EXT = /\.(wav|wave|aif|aiff|mp3|ogg|oga|flac|m4a|aac|opus|webm|caf)$/i;
  const SWIPE_MIN = 48;

  const player = new PadPlayer();
  const drums = new DrumKit();
  const sampler = new SamplerKit();
  let api = null;
  let busy = false;
  let globalDragDepth = 0;
  let sessionReady = false;

  const engineVer = document.getElementById("engine-ver");
  const workspace = document.getElementById("workspace");
  const btnExport = document.getElementById("btn-export");
  const exportDropdown = document.getElementById("export-dropdown");
  const btnExportDrums = document.getElementById("btn-export-drums");
  const btnExportChops = document.getElementById("btn-export-chops");
  const btnSessionClear = document.getElementById("btn-session-clear");

  /** @type {{schedule:Function,flush:Function,suspend:Function}|null} */
  let sessionSaver = null;

  function noteKitChanged() {
    if (sessionSaver && sessionReady) sessionSaver.schedule();
    updateSessionClearBtn();
  }

  function updateSessionClearBtn() {
    if (!btnSessionClear) return;
    const hasKits =
      drums.activePads().length > 0 || sampler.activePads().length > 0;
    const hasLoop =
      sessionLooper && sessionLooper.getState().cycleFrames > 0;
    btnSessionClear.disabled = !hasKits && !hasLoop;
  }

  /** Set after looper is created — used by session clear enablement */
  let sessionLooper = null;

  /**
   * @param {object} cfg
   */
  function makeColumn(cfg) {
    const {
      kit,
      prefix,
      pageLabel,
      dropzone,
      fileInput,
      progress,
      progressFill,
      progressLabel,
      dropInner,
      deckBar,
      legend,
      padGrid,
      bankLabel,
      padStats,
      btnLoad,
      btnAdd,
      btnReset,
      btnBankPrev,
      btnBankNext,
      colEl,
      mode, // 'drums' | 'sampler'
    } = cfg;

    let bank = 0;
    let dragPadId = null;
    let suppressPlayUntil = 0;
    /** @type {'replace'|'append'} */
    let loadMode = "replace";
    let swipe = null;

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

    function syncChrome() {
      const has = kit.activePads().length > 0;
      const show = has || (busy && cfg.activeBusy);
      colEl.classList.toggle("has-kit", has);
      deckBar.classList.toggle("hidden", !show);
      legend.classList.toggle("hidden", !show);
      padGrid.classList.toggle("hidden", !show);
      btnAdd.disabled = busy || !has;
      btnLoad.disabled = busy;
      if (btnReset) btnReset.disabled = busy || !has;
      updateExportButtons();
      noteKitChanged();
    }

    function resetColumn() {
      if (busy) return;
      player.clear(kit.idPrefix);
      kit.reset(kit.exportName);
      bank = 0;
      dragPadId = null;
      if (mode === "sampler" && api) api.clearChops();
      if (mode === "drums" && api) api.clearHits();
      hideProgress();
      renderPads();
      noteKitChanged();
    }

    function setBank(next) {
      const banks = kit.bankCount();
      bank = Math.max(0, Math.min(banks - 1, next));
      renderPads();
    }

    function shiftBank(delta) {
      setBank(bank + delta);
    }

    function keyLabel(slot) {
      if (mode === "sampler") return SAMPLER_KEY_LABELS[slot] || String(slot + 1);
      return String(slot + 1);
    }

    function renderPads() {
      const active = kit.activePads();
      const banks = kit.bankCount();
      if (bank >= banks) bank = Math.max(0, banks - 1);

      if (mode === "sampler") {
        bankLabel.textContent = `PAGE ${bank + 1}`;
        padStats.textContent = `${active.length} chops · ${banks} page${banks > 1 ? "s" : ""}`;
      } else {
        bankLabel.textContent = `BANK ${BANK_NAMES[bank] || bank}`;
        padStats.textContent = `${active.length} pads · ${banks} bank${banks > 1 ? "s" : ""}`;
      }

      btnBankPrev.disabled = bank <= 0;
      btnBankNext.disabled = bank >= banks - 1;
      syncChrome();

      const slots = kit.pageSize;
      padGrid.innerHTML = "";
      for (let slot = 0; slot < slots; slot++) {
        const pad = kit.padAtBankSlot(bank, slot);
        const el = document.createElement("div");
        el.className = "pad" + (pad ? ` ${pad.kind}` : " empty");
        el.dataset.slot = String(slot);
        if (pad) {
          el.dataset.padId = pad.id;
          el.draggable = true;
        }

        const key = document.createElement("span");
        key.className = "pad-key";
        key.textContent = keyLabel(slot);
        el.appendChild(key);

        if (!pad) {
          el.addEventListener("dragover", (e) => {
            if (!dragPadId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            el.classList.add("drag-over");
          });
          el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
          el.addEventListener("drop", (e) => {
            e.preventDefault();
            el.classList.remove("drag-over");
            const fromId = e.dataTransfer.getData("text/plain") || dragPadId;
            if (!fromId) return;
            if (kit.moveToActiveIndex(fromId, bank * kit.pageSize + slot)) renderPads();
            suppressPlayUntil = Date.now() + 400;
          });
          padGrid.appendChild(el);
          continue;
        }

        const kind = document.createElement("span");
        kind.className = "pad-kind";
        kind.textContent = pad.recreated ? `${pad.kind} · rebuilt` : pad.kind;
        el.appendChild(kind);

        const name = document.createElement("input");
        name.className = "pad-name";
        name.type = "text";
        name.value = pad.name;
        name.spellcheck = false;
        name.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          el.draggable = false;
        });
        name.addEventListener("click", (e) => e.stopPropagation());
        name.addEventListener("blur", () => {
          el.draggable = true;
          if (name.value.trim()) kit.rename(pad.id, name.value);
          else name.value = pad.name;
        });
        name.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            name.blur();
          }
          if (e.key === "Escape") {
            name.value = pad.name;
            name.blur();
          }
        });
        name.addEventListener("change", () => {
          kit.rename(pad.id, name.value);
          name.value = kit.activePads().find((p) => p.id === pad.id)?.name || name.value;
        });
        el.appendChild(name);

        const actions = document.createElement("div");
        actions.className = "pad-actions";

        const leftBtn = document.createElement("button");
        leftBtn.type = "button";
        leftBtn.className = "btn tiny";
        leftBtn.textContent = "◀";
        leftBtn.title = "Move earlier";
        leftBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (kit.nudge(pad.id, -1)) renderPads();
        });

        const rightBtn = document.createElement("button");
        rightBtn.type = "button";
        rightBtn.className = "btn tiny";
        rightBtn.textContent = "▶";
        rightBtn.title = "Move later";
        rightBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (kit.nudge(pad.id, 1)) renderPads();
        });

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "btn tiny";
        playBtn.textContent = "▶";
        playBtn.title = "Play";
        playBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          triggerPad(pad, el);
        });

        const fxBtn = document.createElement("button");
        fxBtn.type = "button";
        fxBtn.className = "btn tiny";
        fxBtn.textContent = "FX";
        fxBtn.title = "Pitch / EQ / clone";
        fxBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = el.classList.contains("fx-open");
          padGrid.querySelectorAll(".pad.fx-open").forEach((n) => n.classList.remove("fx-open"));
          if (!open) el.classList.add("fx-open");
        });

        const discardBtn = document.createElement("button");
        discardBtn.type = "button";
        discardBtn.className = "btn tiny danger";
        discardBtn.textContent = "×";
        discardBtn.title = "Discard";
        discardBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          kit.discard(pad.id);
          player.remove(pad.id);
          renderPads();
        });

        actions.append(leftBtn, rightBtn, playBtn, fxBtn, discardBtn);
        el.appendChild(actions);

        const fx = document.createElement("div");
        fx.className = "pad-fx";
        fx.addEventListener("click", (e) => e.stopPropagation());
        fx.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          el.draggable = false;
        });

        const sliders = [];
        const mkSlider = (label, key, min, max, step, unit) => {
          const row = document.createElement("label");
          row.className = "fx-row";
          const lab = document.createElement("span");
          lab.textContent = label;
          const input = document.createElement("input");
          input.type = "range";
          input.min = String(min);
          input.max = String(max);
          input.step = String(step);
          input.value = String(pad[key] ?? 0);
          const val = document.createElement("span");
          val.className = "fx-val";
          const syncVal = () => {
            const n = Number(input.value);
            val.textContent = `${n > 0 ? "+" : ""}${n}${unit}`;
          };
          syncVal();
          input.addEventListener("input", () => {
            const n = Number(input.value);
            kit.setFx(pad.id, { [key]: n });
            pad[key] = n;
            syncVal();
          });
          input.addEventListener("change", () => triggerPad(pad, el));
          row.append(lab, input, val);
          sliders.push({ input, syncVal });
          return row;
        };

        fx.appendChild(mkSlider("Pitch", "pitchSemitones", -12, 12, 1, "st"));
        fx.appendChild(mkSlider("Low", "eqLowDb", -12, 12, 1, "dB"));
        fx.appendChild(mkSlider("High", "eqHighDb", -12, 12, 1, "dB"));

        const fxBtns = document.createElement("div");
        fxBtns.className = "fx-btns";

        const resetFx = document.createElement("button");
        resetFx.type = "button";
        resetFx.className = "btn tiny";
        resetFx.textContent = "Flat";
        resetFx.addEventListener("click", (e) => {
          e.stopPropagation();
          kit.setFx(pad.id, { pitchSemitones: 0, eqLowDb: 0, eqHighDb: 0 });
          pad.pitchSemitones = 0;
          pad.eqLowDb = 0;
          pad.eqHighDb = 0;
          for (const s of sliders) {
            s.input.value = "0";
            s.syncVal();
          }
          triggerPad(pad, el);
        });

        const cloneNext = document.createElement("button");
        cloneNext.type = "button";
        cloneNext.className = "btn tiny";
        cloneNext.textContent = "Clone next";
        cloneNext.title = "Duplicate after this pad";
        cloneNext.addEventListener("click", (e) => {
          e.stopPropagation();
          const copy = kit.clonePad(pad.id, "next");
          if (copy) {
            player.setSample(copy.id, copy.pcm, copy.sampleRate);
            renderPads();
          }
        });

        const cloneEnd = document.createElement("button");
        cloneEnd.type = "button";
        cloneEnd.className = "btn tiny";
        cloneEnd.textContent = "Clone end";
        cloneEnd.title = "Duplicate at end of kit";
        cloneEnd.addEventListener("click", (e) => {
          e.stopPropagation();
          const copy = kit.clonePad(pad.id, "end");
          if (copy) {
            player.setSample(copy.id, copy.pcm, copy.sampleRate);
            renderPads();
          }
        });

        const closeFx = document.createElement("button");
        closeFx.type = "button";
        closeFx.className = "btn tiny";
        closeFx.textContent = "Done";
        closeFx.addEventListener("click", (e) => {
          e.stopPropagation();
          el.classList.remove("fx-open");
          el.draggable = true;
        });

        fxBtns.append(resetFx, cloneNext, cloneEnd, closeFx);
        fx.appendChild(fxBtns);
        el.appendChild(fx);

        el.addEventListener("click", (e) => {
          if (e.target.closest("input, button, .pad-actions, .pad-fx")) return;
          if (Date.now() < suppressPlayUntil) return;
          triggerPad(pad, el);
        });

        el.addEventListener("dragstart", (e) => {
          dragPadId = pad.id;
          el.classList.add("drag-src");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", pad.id);
          suppressPlayUntil = Date.now() + 400;
        });
        el.addEventListener("dragend", () => {
          dragPadId = null;
          el.classList.remove("drag-src");
          padGrid.querySelectorAll(".drag-over").forEach((n) => n.classList.remove("drag-over"));
        });
        el.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          el.classList.add("drag-over");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
        el.addEventListener("drop", (e) => {
          e.preventDefault();
          el.classList.remove("drag-over");
          const fromId = e.dataTransfer.getData("text/plain") || dragPadId;
          if (!fromId || fromId === pad.id) return;
          if (kit.moveBefore(fromId, pad.id)) renderPads();
          suppressPlayUntil = Date.now() + 400;
        });

        padGrid.appendChild(el);
      }
    }

    function triggerPad(pad, el, gain) {
      player.ensureCtx();
      // Session restore can leave kit PCM without a player buffer — hydrate on demand
      if (!player.hasSample(pad.id) && pad.pcm && pad.pcm.length) {
        player.setSample(pad.id, pad.pcm, pad.sampleRate);
      }
      player.play(pad.id, {
        pitchSemitones: pad.pitchSemitones ?? 0,
        eqLowDb: pad.eqLowDb ?? 0,
        eqHighDb: pad.eqHighDb ?? 0,
        gain: gain == null ? 1 : gain,
      });
      if (el) {
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 120);
      }
    }

    async function ingestSource(file, progressBase, progressSpan, labelPrefix, crop) {
      setProgress(progressBase + progressSpan * 0.05, `${labelPrefix} decoding…`);
      await yieldToUi();
      const decoded = await decodeFile(file);
      let { mono, sampleRate } = decoded;
      if (crop) {
        mono = sliceMono(mono, sampleRate, crop);
      }
      setProgress(
        progressBase + progressSpan * 0.25,
        `${labelPrefix} ${mode === "sampler" ? "chopping" : "splitting"}…`
      );
      await yieldToUi();

      let hits;
      if (mode === "sampler") {
        api.clearChops();
        ({ hits } = api.chop(mono, sampleRate, { threshold: 1.0, minGap: 0.048 }));
      } else {
        api.clearHits();
        ({ hits } = api.split(mono, sampleRate, { threshold: 1.0, minGap: 0.048 }));
      }

      if (!hits.length) {
        const pad = kit.addPad(
          { kind: mode === "sampler" ? "chop" : "unknown", confidence: 0, index: 0 },
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

      if (mode === "drums") {
        const toRebuild = added.filter(
          (p) => p.kind === "kick" || p.kind === "snare" || p.kind === "hat"
        );
        for (let i = 0; i < toRebuild.length; i++) {
          const p = toRebuild[i];
          const t = (i + 1) / Math.max(1, toRebuild.length);
          setProgress(
            progressBase + progressSpan * (0.4 + 0.6 * t),
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
      }
      return added;
    }

    async function processFiles(files, opts = {}) {
      const list = collectAudioFiles(files);
      if (!list.length) {
        alert("No audio files found. Try WAV, MP3, OGG, FLAC, M4A, AIFF, or AAC.");
        return;
      }
      if (busy) return;
      if (!api) await initEngine();
      if (!api) return;

      const append = !!opts.append && kit.pads.length > 0;

      // Crop UI first (not busy yet) so Cancel doesn't leave a half-processed kit
      /** @type {Array<{file:File,crop:{startSec:number,endSec:number}}>} */
      const queue = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const crop = await cropAudioInDropzone(dropzone, file, {
          accent:
            mode === "sampler"
              ? "rgba(180, 154, 212, 0.35)"
              : "rgba(232, 160, 74, 0.35)",
          confirmLabel: mode === "sampler" ? "Chop this" : "Split this",
        });
        if (!crop) {
          // cancelled — skip this file
          continue;
        }
        queue.push({ file, crop });
      }
      if (!queue.length) return;

      busy = true;
      cfg.activeBusy = true;
      setBusyGlobal(true);
      syncChrome();

      try {
        if (!append) {
          player.clear(kit.idPrefix);
          kit.reset(queue.length === 1 ? queue[0].file.name : kit.exportName);
          bank = 0;
        } else if (queue.length > 1) {
          kit.sourceName = kit.exportName;
        }

        for (let i = 0; i < queue.length; i++) {
          const { file, crop } = queue[i];
          const base = i / queue.length;
          const span = 1 / queue.length;
          const prefix =
            queue.length > 1 ? `[${i + 1}/${queue.length}] ${file.name}` : file.name;
          await ingestSource(file, base, span, prefix, crop);
          renderPads();
        }

        setProgress(1, `Done — ${kit.activePads().length}`);
        renderPads();
        setTimeout(hideProgress, 700);
      } catch (err) {
        console.error(err);
        hideProgress();
        alert(err?.message || String(err));
      } finally {
        busy = false;
        cfg.activeBusy = false;
        setBusyGlobal(false);
        renderPads();
      }
    }

    function openFilePicker(modeName) {
      loadMode = modeName;
      fileInput.value = "";
      fileInput.click();
    }

    dropzone.addEventListener("click", (e) => {
      if (busy) return;
      if (e.target.closest("button")) return;
      openFilePicker(kit.pads.length ? "append" : "replace");
    });
    btnLoad.addEventListener("click", () => openFilePicker("replace"));
    btnAdd.addEventListener("click", () => openFilePicker("append"));
    btnReset?.addEventListener("click", () => resetColumn());
    fileInput.addEventListener("change", () => {
      const files = collectAudioFiles(fileInput.files);
      const append = loadMode === "append";
      fileInput.value = "";
      if (files.length) processFiles(files, { append });
    });

    // Column-scoped file drops
    dropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    dropzone.addEventListener("dragleave", (e) => {
      if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("drag");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag");
      if (busy) return;
      if (!e.dataTransfer?.files?.length) return;
      processFiles(collectAudioFiles(e.dataTransfer.files), {
        append: kit.pads.length > 0,
      });
    });

    btnBankPrev.addEventListener("click", () => shiftBank(-1));
    btnBankNext.addEventListener("click", () => shiftBank(1));

    padGrid.addEventListener(
      "touchstart",
      (e) => {
        if (busy || kit.activePads().length === 0) return;
        const t = e.changedTouches[0];
        swipe = { x: t.clientX, y: t.clientY, bank: false };
      },
      { passive: true }
    );
    padGrid.addEventListener(
      "touchmove",
      (e) => {
        if (!swipe) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipe.x;
        const dy = t.clientY - swipe.y;
        if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.15) {
          if (!swipe.bank) {
            swipe.bank = true;
            shiftBank(dx < 0 ? 1 : -1);
            suppressPlayUntil = Date.now() + 500;
          }
        }
      },
      { passive: true }
    );
    padGrid.addEventListener("touchend", () => {
      swipe = null;
    }, { passive: true });
    padGrid.addEventListener("touchcancel", () => {
      swipe = null;
    }, { passive: true });

    return {
      kit,
      mode,
      prefix,
      renderPads,
      shiftBank,
      setBank,
      processFiles,
      triggerPad,
      get bank() {
        return bank;
      },
      padAtSlot(slot) {
        return kit.padAtBankSlot(bank, slot);
      },
      padGrid,
    };
  }

  function collectAudioFiles(fileList) {
    return Array.from(fileList || []).filter((file) => {
      if (!file) return false;
      if (file.type && file.type.startsWith("audio/")) return true;
      return AUDIO_EXT.test(file.name || "");
    });
  }

  async function decodeFile(file) {
    player.ensureCtx();
    const ab = await file.arrayBuffer();
    return decodeAudioBuffer(ab, file.name || "audio");
  }

  function yieldToUi() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function updateExportButtons() {
    const hasD = drums.activePads().length > 0;
    const hasS = sampler.activePads().length > 0;
    btnExport.disabled = busy || (!hasD && !hasS);
    btnExportDrums.disabled = !hasD;
    btnExportChops.disabled = !hasS;
  }

  function setBusyGlobal(on) {
    busy = on;
    updateExportButtons();
  }

  async function initEngine() {
    try {
      api = await loadNodruma();
      engineVer.textContent = `engine ${api.version()}`;
    } catch (err) {
      engineVer.textContent = "engine unavailable";
      console.error(err);
      alert(err.message || String(err));
    }
  }

  const samplerCol = makeColumn({
    kit: sampler,
    prefix: "s",
    pageLabel: "PAGE",
    mode: "sampler",
    dropzone: document.getElementById("s-dropzone"),
    fileInput: document.getElementById("s-file-input"),
    progress: document.getElementById("s-progress"),
    progressFill: document.getElementById("s-progress-fill"),
    progressLabel: document.getElementById("s-progress-label"),
    dropInner: document.querySelector("#s-dropzone .drop-inner"),
    deckBar: document.getElementById("s-deck-bar"),
    legend: document.getElementById("s-legend"),
    padGrid: document.getElementById("s-pad-grid"),
    bankLabel: document.getElementById("s-bank-label"),
    padStats: document.getElementById("s-pad-stats"),
    btnLoad: document.getElementById("btn-s-load"),
    btnAdd: document.getElementById("btn-s-add"),
    btnReset: document.getElementById("btn-s-reset"),
    btnBankPrev: document.getElementById("s-bank-prev"),
    btnBankNext: document.getElementById("s-bank-next"),
    colEl: document.getElementById("col-sampler"),
    activeBusy: false,
  });

  const drumsCol = makeColumn({
    kit: drums,
    prefix: "d",
    pageLabel: "BANK",
    mode: "drums",
    dropzone: document.getElementById("d-dropzone"),
    fileInput: document.getElementById("d-file-input"),
    progress: document.getElementById("d-progress"),
    progressFill: document.getElementById("d-progress-fill"),
    progressLabel: document.getElementById("d-progress-label"),
    dropInner: document.querySelector("#d-dropzone .drop-inner"),
    deckBar: document.getElementById("d-deck-bar"),
    legend: document.getElementById("d-legend"),
    padGrid: document.getElementById("d-pad-grid"),
    bankLabel: document.getElementById("d-bank-label"),
    padStats: document.getElementById("d-pad-stats"),
    btnLoad: document.getElementById("btn-d-load"),
    btnAdd: document.getElementById("btn-d-add"),
    btnReset: document.getElementById("btn-d-reset"),
    btnBankPrev: document.getElementById("d-bank-prev"),
    btnBankNext: document.getElementById("d-bank-next"),
    colEl: document.getElementById("col-drums"),
    activeBusy: false,
  });

  // Prevent browser navigation on stray file drops
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    globalDragDepth = 0;
  });

  // Mobile tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      workspace.dataset.tab = tab;
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
    });
  });
  workspace.dataset.tab = "drums";

  // Export menu
  btnExport.addEventListener("click", (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle("hidden");
  });
  document.addEventListener("click", () => exportDropdown.classList.add("hidden"));

  async function downloadZip(kit, suffix) {
    try {
      const blob = await kit.exportZip();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${kit.sourceName || suffix}_${suffix}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert(err.message || String(err));
    }
  }

  btnExportDrums.addEventListener("click", () => {
    exportDropdown.classList.add("hidden");
    downloadZip(drums, "kit");
  });
  btnExportChops.addEventListener("click", () => {
    exportDropdown.classList.add("hidden");
    downloadZip(sampler, "chops");
  });

  // —— Looper screen (independent of kits) ——
  const btnLooper = document.getElementById("btn-looper");
  const looperTracksEl = document.getElementById("looper-tracks");
  const loopPlayhead = document.getElementById("loop-playhead");
  const loopStatus = document.getElementById("loop-status");
  const btnLoopPlay = document.getElementById("loop-play");
  const btnLoopStop = document.getElementById("loop-stop");
  const btnLoopRec = document.getElementById("loop-rec");
  const inputLoopBpm = document.getElementById("loop-bpm");
  const selectLoopQuantize = document.getElementById("loop-quantize");
  const selectLoopBars = document.getElementById("loop-bars");
  const btnLoopClearAll = document.getElementById("loop-clear-all");
  const loopCrop = document.getElementById("loop-crop");
  const loopCropWave = document.getElementById("loop-crop-wave");
  const loopCropSel = document.getElementById("loop-crop-sel");
  const loopCropPh = document.getElementById("loop-crop-ph");
  const loopCropMeta = document.getElementById("loop-crop-meta");
  const loopCropWrap = document.getElementById("loop-crop-wave-wrap");
  const btnCropHalve = document.getElementById("loop-crop-halve");
  const btnCropDouble = document.getElementById("loop-crop-double");
  const btnCropStartHere = document.getElementById("loop-crop-start-here");
  const btnCropEndHere = document.getElementById("loop-crop-end-here");

  /** Pending crop region as 0..1 of current cycle (applied on handle release). */
  let cropStart01 = 0;
  let cropEnd01 = 1;
  let cropDrag = null; // 'start' | 'end' | null
  let cropPcmSig = -1;

  document.body.dataset.screen = "pads";

  /** @type {HTMLCanvasElement[]} */
  const waveCanvases = [];
  /** @type {(boolean|null)[]} */
  const waveDrawn = [];
  let looperRaf = 0;

  function tickLooperPlayhead() {
    const st = looper.getState();
    const x = st.phase01 * 100;
    loopPlayhead.style.left = `${x}%`;
    loopPlayhead.style.transform = "translateX(-50%)";
    if (loopCropPh && !loopCrop.classList.contains("hidden")) {
      loopCropPh.style.left = `${x}%`;
    }
  }

  function updateCropSelUi() {
    const left = cropStart01 * 100;
    const right = (1 - cropEnd01) * 100;
    loopCropSel.style.left = `${left}%`;
    loopCropSel.style.right = `${right}%`;
  }

  function applyCropRegion() {
    const st = looper.getState();
    if (st.cycleFrames <= 0) return;
    const a = Math.round(cropStart01 * st.cycleFrames);
    const b = Math.round(cropEnd01 * st.cycleFrames);
    if (a <= 0 && b >= st.cycleFrames) return;
    if (looper.cropCycle(a, b)) {
      cropStart01 = 0;
      cropEnd01 = 1;
      cropPcmSig = -1;
    }
  }

  function syncCropPanel(st) {
    const has = st.cycleFrames > 0 && st.masterPcm;
    loopCrop.classList.toggle("hidden", !has);
    if (!has) return;

    const sig = st.masterPcm.length;
    if (sig !== cropPcmSig) {
      drawLooperWaveform(loopCropWave, st.masterPcm, null);
      cropPcmSig = sig;
      cropStart01 = 0;
      cropEnd01 = 1;
    }
    updateCropSelUi();
    const sec = st.cycleSec.toFixed(2);
    const bars =
      st.bpm > 0 ? (st.cycleSec / ((60 / st.bpm) * 4)).toFixed(2) : "?";
    loopCropMeta.textContent = `${sec}s · ~${bars} bars @ ${st.bpm}`;
  }

  function ensureLooperAnim() {
    if (!looperRaf) looperRaf = requestAnimationFrame(looperAnimLoop);
  }

  function looperAnimLoop() {
    looperRaf = 0;
    const st = looper.getState();
    const onLooper = document.body.dataset.screen === "looper";
    if (!st.playing && !st.recording) {
      tickLooperPlayhead();
      return;
    }
    tickLooperPlayhead();
    if (st.recording) {
      looperTracksEl.querySelectorAll("[data-meter]").forEach((meter) => {
        const i = Number(meter.dataset.meter);
        const t = st.tracks[i];
        if (t && t.recording) {
          meter.style.width = `${Math.min(100, Math.round(t.peak * 140))}%`;
        }
      });
    }
    // Keep RAF alive while playing even if Pads screen is showing
    void onLooper;
    looperRaf = requestAnimationFrame(looperAnimLoop);
  }

  function syncLooperUi() {
    const st = looper.getState();
    btnLoopRec.classList.toggle("recording", st.recording);
    btnLoopRec.classList.toggle("waiting", st.waitingStart || st.waitingStop);
    btnLoopPlay.textContent = st.playing ? "Playing" : "Play";

    if (st.waitingStart) {
      loopStatus.textContent = "waiting for grid…";
    } else if (st.waitingStop) {
      loopStatus.textContent = "closing on grid…";
    } else if (st.recording && st.cycleFrames <= 0) {
      loopStatus.textContent = "recording first take…";
    } else if (st.recording) {
      loopStatus.textContent = `overdub T${st.recTrack + 1}…`;
    } else if (st.cycleFrames <= 0) {
      loopStatus.textContent = "empty — arm + Rec";
    } else {
      const sec = st.cycleSec.toFixed(2);
      const bars =
        st.bpm > 0
          ? (st.cycleSec / ((60 / st.bpm) * 4)).toFixed(2)
          : "?";
      loopStatus.textContent = `${sec}s ≈ ${bars} bars · ${
        st.playing ? "run" : "stop"
      }`;
    }

    looperTracksEl.querySelectorAll(".loop-track").forEach((row) => {
      const i = Number(row.dataset.track);
      const t = st.tracks[i];
      if (!t) return;
      row.classList.toggle("armed", t.armed);
      row.classList.toggle("recording", t.recording);
      const armBtn = row.querySelector("[data-arm]");
      const muteBtn = row.querySelector("[data-mute]");
      if (armBtn) {
        armBtn.classList.toggle("arm-on", t.armed);
        armBtn.textContent = t.armed ? "Armed" : "Arm";
      }
      if (muteBtn) {
        muteBtn.classList.toggle("on", !t.muted);
        muteBtn.textContent = t.muted ? "Off" : "On";
      }
      const meter = row.querySelector("[data-meter]");
      if (meter) {
        meter.style.width = t.recording
          ? `${Math.min(100, Math.round(t.peak * 140))}%`
          : "0%";
      }
      // onChange only — redraw so overdubs show up even when length is unchanged
      drawLooperWaveform(waveCanvases[i], t.pcm, null);
      waveDrawn[i] = t.pcm ? t.pcm.length : 0;
    });

    tickLooperPlayhead();
    syncCropPanel(st);
  }

  const looper = createLooper({
    getCtx: () => player.getCtx(),
    getPadBus: () => player.getPadBus(),
    onChange: () => {
      syncLooperUi();
      ensureLooperAnim();
      noteKitChanged();
    },
  });
  sessionLooper = looper;

  function syncLooperFormFromState() {
    const st = looper.getState();
    inputLoopBpm.value = String(st.bpm);
    selectLoopQuantize.value = st.quantize;
    selectLoopBars.value = String(st.barsPreset);
  }

  sessionSaver = createSessionSaver(() => ({
    drums: drums.toSnapshot(),
    sampler: sampler.toSnapshot(),
    looper: looper.exportSnapshot(),
    ui: {
      drumsBank: drumsCol.bank,
      samplerBank: samplerCol.bank,
      screen: document.body.dataset.screen || "pads",
    },
  }));

  function applyKitToPlayer(kit) {
    player.clear(kit.idPrefix);
    let n = 0;
    for (const p of kit.pads) {
      if (p.discarded || !p.pcm || !p.pcm.length) continue;
      if (player.setSample(p.id, p.pcm, p.sampleRate)) n += 1;
    }
    return n;
  }

  async function restoreSession() {
    sessionSaver.suspend(true);
    try {
      const data = await loadSession();
      if (!data) return false;
      // Accept v1 (legacy TypedArray) and v2 (ArrayBuffer PCM)
      if (data.v != null && data.v > NODRUMA_SESSION_VERSION) return false;
      if (data.drums) drums.loadSnapshot(data.drums);
      if (data.sampler) sampler.loadSnapshot(data.sampler);
      const loaded =
        applyKitToPlayer(drums) + applyKitToPlayer(sampler);
      if (data.looper) looper.importSnapshot(data.looper);
      syncLooperFormFromState();
      if (data.ui) {
        if (typeof data.ui.drumsBank === "number") drumsCol.setBank(data.ui.drumsBank);
        if (typeof data.ui.samplerBank === "number") {
          samplerCol.setBank(data.ui.samplerBank);
        }
      }
      if (loaded === 0 && (drums.pads.length || sampler.pads.length)) {
        console.warn(
          "session restore: pads present but no audio buffers loaded — re-save after this fix"
        );
      }
      return true;
    } catch (err) {
      console.warn("restoreSession", err);
      return false;
    } finally {
      sessionSaver.suspend(false);
      sessionReady = true;
      updateSessionClearBtn();
    }
  }

  async function wipeSessionAndKits() {
    if (
      !confirm(
        "Clear saved session?\nThis removes drums, sampler chops, and looper tracks from this browser."
      )
    ) {
      return;
    }
    sessionSaver.suspend(true);
    await clearSession();
    looper.clearAll();
    player.clear("d");
    player.clear("s");
    drums.reset(drums.exportName);
    sampler.reset(sampler.exportName);
    if (api) {
      api.clearHits?.();
      api.clearChops?.();
    }
    drumsCol.setBank(0);
    samplerCol.setBank(0);
    drumsCol.renderPads();
    samplerCol.renderPads();
    syncLooperFormFromState();
    syncLooperUi();
    sessionSaver.suspend(false);
    sessionReady = true;
    updateSessionClearBtn();
    updateExportButtons();
  }

  btnSessionClear.addEventListener("click", () => {
    void wipeSessionAndKits();
  });

  function buildLooperTracks() {
    looperTracksEl.innerHTML = "";
    waveCanvases.length = 0;
    waveDrawn.length = 0;
    for (let i = 0; i < LOOPER_TRACKS; i++) {
      const row = document.createElement("div");
      row.className = "loop-track";
      row.dataset.track = String(i);

      const num = document.createElement("div");
      num.className = "loop-track-num";
      num.textContent = String(i + 1);

      const waveWrap = document.createElement("div");
      waveWrap.className = "loop-wave-wrap";
      const canvas = document.createElement("canvas");
      canvas.className = "loop-wave";
      canvas.width = 640;
      canvas.height = 48;
      canvas.setAttribute("aria-hidden", "true");
      const meter = document.createElement("div");
      meter.className = "loop-meter";
      meter.dataset.meter = String(i);
      waveWrap.appendChild(canvas);
      waveWrap.appendChild(meter);
      waveCanvases.push(canvas);
      waveDrawn.push(null);

      const actions = document.createElement("div");
      actions.className = "loop-track-actions";

      const btnArm = document.createElement("button");
      btnArm.type = "button";
      btnArm.className = "btn ghost tiny";
      btnArm.textContent = "Arm";
      btnArm.dataset.arm = String(i);

      const btnMute = document.createElement("button");
      btnMute.type = "button";
      btnMute.className = "btn ghost tiny";
      btnMute.textContent = "On";
      btnMute.dataset.mute = String(i);

      const btnClear = document.createElement("button");
      btnClear.type = "button";
      btnClear.className = "btn ghost tiny danger";
      btnClear.textContent = "Clear";
      btnClear.dataset.clear = String(i);

      actions.appendChild(btnArm);
      actions.appendChild(btnMute);
      actions.appendChild(btnClear);

      row.appendChild(num);
      row.appendChild(waveWrap);
      row.appendChild(actions);
      looperTracksEl.appendChild(row);

      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        player.ensureCtx();
        looper.arm(i);
      });

      btnArm.addEventListener("click", () => {
        player.ensureCtx();
        looper.arm(i);
      });
      btnMute.addEventListener("click", () => {
        player.ensureCtx();
        looper.toggleMute(i);
      });
      btnClear.addEventListener("click", () => {
        looper.clear(i);
      });
    }
  }

  buildLooperTracks();
  syncLooperUi();

  btnLooper.addEventListener("click", () => {
    const next = document.body.dataset.screen === "looper" ? "pads" : "looper";
    document.body.dataset.screen = next;
    btnLooper.textContent = next === "looper" ? "Pads" : "Looper";
    looper.setUiVisible(next === "looper");
    if (next === "looper") {
      player.ensureCtx();
      syncLooperUi();
      ensureLooperAnim();
    }
    noteKitChanged();
  });

  btnLoopPlay.addEventListener("click", () => {
    player.ensureCtx();
    looper.play();
  });
  btnLoopStop.addEventListener("click", () => looper.stop());
  btnLoopRec.addEventListener("click", () => {
    if (busy) return;
    player.ensureCtx();
    looper.toggleRec();
  });
  btnLoopClearAll.addEventListener("click", () => looper.clearAll());
  inputLoopBpm.addEventListener("change", () => {
    looper.setBpm(inputLoopBpm.value);
    noteKitChanged();
  });
  selectLoopQuantize.addEventListener("change", () => {
    looper.setQuantize(selectLoopQuantize.value);
    noteKitChanged();
  });
  selectLoopBars.addEventListener("change", () => {
    looper.setBarsPreset(selectLoopBars.value);
    noteKitChanged();
  });

  btnCropHalve.addEventListener("click", () => {
    looper.halveCycle();
  });
  btnCropDouble.addEventListener("click", () => {
    looper.doubleCycle();
  });
  btnCropEndHere.addEventListener("click", () => {
    player.ensureCtx();
    if (!looper.getState().playing) looper.play();
    looper.setCycleEndAtPlayhead();
  });
  btnCropStartHere.addEventListener("click", () => {
    player.ensureCtx();
    if (!looper.getState().playing) looper.play();
    looper.setCycleStartAtPlayhead();
  });

  function cropClientTo01(clientX) {
    const rect = loopCropWrap.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  loopCropWrap.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-handle]");
    if (!handle) return;
    e.preventDefault();
    cropDrag = handle.dataset.handle;
    loopCropWrap.setPointerCapture(e.pointerId);
  });
  loopCropWrap.addEventListener("pointermove", (e) => {
    if (!cropDrag) return;
    const x = cropClientTo01(e.clientX);
    const minGap = 0.02;
    if (cropDrag === "start") {
      cropStart01 = Math.min(x, cropEnd01 - minGap);
    } else {
      cropEnd01 = Math.max(x, cropStart01 + minGap);
    }
    updateCropSelUi();
  });
  loopCropWrap.addEventListener("pointerup", (e) => {
    if (!cropDrag) return;
    cropDrag = null;
    try {
      loopCropWrap.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
    applyCropRegion();
  });
  loopCropWrap.addEventListener("pointercancel", () => {
    cropDrag = null;
  });

  // Keyboard: digits → drums, QWERTY → sampler, PgUp/Dn → banks;
  // Space → looper play/stop; R → rec only on looper screen (R is a sampler pad)
  window.addEventListener("keydown", (e) => {
    if (
      e.target &&
      (e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT")
    ) {
      return;
    }

    if (e.code === "Space") {
      e.preventDefault();
      player.ensureCtx();
      const st = looper.getState();
      if (st.playing && st.cycleFrames > 0 && !st.recording) looper.stop();
      else looper.play();
      return;
    }
    if (
      (e.key === "r" || e.key === "R") &&
      document.body.dataset.screen === "looper"
    ) {
      if (busy) return;
      e.preventDefault();
      player.ensureCtx();
      looper.toggleRec();
      return;
    }

    if (e.key === "PageUp" || e.key === "PageDown") {
      const tab = workspace.dataset.tab || "sampler";
      const narrow = window.matchMedia("(max-width: 1099px)").matches;
      const target = narrow
        ? tab === "drums"
          ? drumsCol
          : samplerCol
        : drums.activePads().length
          ? drumsCol
          : samplerCol;
      if (target.kit.activePads().length === 0) return;
      e.preventDefault();
      target.shiftBank(e.key === "PageUp" ? -1 : 1);
      return;
    }

    // Digits → drums
    let num = null;
    if (e.code.startsWith("Digit")) num = Number(e.code.slice(5));
    if (e.code.startsWith("Numpad")) num = Number(e.code.slice(6));
    if (num && num >= 1 && num <= 9) {
      const pad = drumsCol.padAtSlot(num - 1);
      if (!pad) return;
      e.preventDefault();
      const el = drumsCol.padGrid.querySelector(`[data-slot="${num - 1}"]`);
      drumsCol.triggerPad(pad, el);
      return;
    }

    // QWERTY → sampler
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const slot = SAMPLER_KEYS.indexOf(key);
    if (slot < 0) return;
    const pad = samplerCol.padAtSlot(slot);
    if (!pad) return;
    e.preventDefault();
    const el = samplerCol.padGrid.querySelector(`[data-slot="${slot}"]`);
    samplerCol.triggerPad(pad, el);
  });

  // WebMIDI: C2–G♯2 → drums, C3+ → sampler pages
  // Permission prompt only appears from a user gesture (do not request on load).
  const btnMidi = document.getElementById("btn-midi");
  const midi = createMidiController({
    onStatus(msg, ok) {
      btnMidi.textContent = msg;
      btnMidi.title =
        "Click to enable WebMIDI\nC2–G♯2 = drums 1–9 · C3+ = sampler (16/page)\n" + msg;
      btnMidi.classList.toggle("midi-on", ok === true);
      btnMidi.classList.toggle("midi-off", ok === false);
      btnMidi.classList.toggle("midi-wait", ok === undefined && msg.includes("allow"));
    },
    onNote(mapped, velocity) {
      if (busy) return;
      player.ensureCtx();
      const gain = midiVelocityGain(velocity);
      if (mapped.kind === "drums") {
        const pad = drumsCol.padAtSlot(mapped.slot);
        if (!pad) return;
        const el = drumsCol.padGrid.querySelector(`[data-slot="${mapped.slot}"]`);
        drumsCol.triggerPad(pad, el, gain);
        return;
      }
      if (mapped.page != null && mapped.page !== samplerCol.bank) {
        samplerCol.setBank(mapped.page);
      }
      const pad = samplerCol.padAtSlot(mapped.slot);
      if (!pad) return;
      const el = samplerCol.padGrid.querySelector(`[data-slot="${mapped.slot}"]`);
      samplerCol.triggerPad(pad, el, gain);
    },
  });

  btnMidi.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Keep this sync path tied to the click so Chrome shows the MIDI prompt
    void midi.enable();
  });

  if (!midi.midiSupported()) {
    btnMidi.textContent = "MIDI n/a";
    btnMidi.classList.add("midi-off");
    btnMidi.title = "WebMIDI is not supported in this browser (try Chrome or Edge)";
  } else {
    // Only auto-connect when permission was already granted earlier
    midi.enableIfGranted().catch(() => {});
  }

  samplerCol.renderPads();
  drumsCol.renderPads();
  updateExportButtons();
  initEngine();

  // Restore last session (kits + looper) then enable autosave
  restoreSession()
    .then((ok) => {
      drumsCol.renderPads();
      samplerCol.renderPads();
      syncLooperUi();
      syncLooperFormFromState();
      updateExportButtons();
      if (ok) {
        const n =
          drums.activePads().length + sampler.activePads().length;
        if (n > 0 || looper.getState().cycleFrames > 0) {
          engineVer.title = "Session restored from this browser";
        }
      }
    })
    .catch(() => {
      sessionReady = true;
    });

  window.addEventListener("pagehide", () => {
    if (sessionSaver && sessionReady) void sessionSaver.flush();
  });
})();
