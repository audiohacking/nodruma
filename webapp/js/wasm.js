/** Load createNodruma() and wrap C exports. */

async function loadNodruma() {
  if (typeof createNodruma !== "function") {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "nodruma.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load nodruma.js — build WASM first"));
      document.head.appendChild(s);
    });
  }
  const Module = await createNodruma({
    locateFile: (file) => {
      try {
        return new URL(file, window.location.href).href;
      } catch {
        return file;
      }
    },
  });
  return wrapModule(Module);
}

function engineError(err, fallback) {
  if (err instanceof Error) {
    const m = err.message || "";
    // Strip Emscripten's "Aborted(...)" wrapper when present
    const aborted = m.match(/^Aborted\((.*)\)\.?\s*(?:Build with.*)?$/s);
    if (aborted && aborted[1] && aborted[1] !== "undefined") {
      return new Error(`${fallback}: ${aborted[1]}`);
    }
    if (m.includes("Aborted")) {
      return new Error(`${fallback}: engine aborted (see console)`);
    }
    return err;
  }
  if (typeof err === "number") {
    return new Error(`${fallback} (engine abort ${err})`);
  }
  return new Error(fallback + ": " + String(err));
}

function wrapModule(Module) {
  const utf8 = (ptr) => Module.UTF8ToString(ptr);

  function copyHeapF32(ptr, frames) {
    if (!ptr || frames <= 0) return new Float32Array(0);
    const start = ptr >> 2;
    return Float32Array.from(Module.HEAPF32.subarray(start, start + frames));
  }

  function allocF32(mono) {
    const n = mono.length;
    const ptr = Module._nd_malloc(n * 4);
    if (!ptr) throw new Error("Out of memory allocating audio buffer");
    try {
      Module.HEAPF32.set(mono, ptr >> 2);
    } catch (err) {
      Module._nd_free(ptr);
      throw engineError(err, "Failed to copy audio into engine memory");
    }
    return ptr;
  }

  return {
    version() {
      return utf8(Module._nd_version());
    },

    clearHits() {
      Module._nd_clear_hits();
    },

    clearChops() {
      Module._nd_clear_chops();
    },

    /**
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {{threshold?:number,minGap?:number}} opts
     * @param {{fn:string,countFn:string,pcmFn:string,label:string}} bridge
     */
    _collectHits(mono, sampleRate, opts, bridge) {
      const n = mono.length;
      if (n <= 0) return { json: { num_hits: 0, hits: [] }, hits: [] };

      let ptr = 0;
      let jsonPtr = 0;
      try {
        ptr = allocF32(mono);
        const thr = opts.threshold ?? 1.0;
        const gap = opts.minGap ?? 0.048;
        jsonPtr = Module[bridge.fn](ptr, n, sampleRate, thr, gap);
        Module._nd_free(ptr);
        ptr = 0;
        if (!jsonPtr) throw new Error(`${bridge.label} failed`);
        const json = JSON.parse(utf8(jsonPtr));
        Module._nd_free(jsonPtr);
        jsonPtr = 0;
        if (json.error) throw new Error(json.error);

        const hits = [];
        const count = Module[bridge.countFn]();
        for (let i = 0; i < count; i++) {
          const framesPtr = Module._nd_malloc(4);
          const srPtr = Module._nd_malloc(8);
          if (!framesPtr || !srPtr) {
            if (framesPtr) Module._nd_free(framesPtr);
            if (srPtr) Module._nd_free(srPtr);
            throw new Error("Out of memory reading hit PCM");
          }
          const pcmPtr = Module[bridge.pcmFn](i, framesPtr, srPtr);
          const frames = Module.getValue(framesPtr, "i32");
          const sr = Module.getValue(srPtr, "double");
          Module._nd_free(framesPtr);
          Module._nd_free(srPtr);
          const pcm = copyHeapF32(pcmPtr, frames);
          const meta = json.hits[i] || { index: i, kind: "unknown" };
          hits.push({ meta, pcm, sampleRate: sr || sampleRate });
        }
        return { json, hits };
      } catch (err) {
        if (ptr) Module._nd_free(ptr);
        if (jsonPtr) Module._nd_free(jsonPtr);
        throw engineError(err, `${bridge.label} failed`);
      }
    },

    /**
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {{threshold?:number,minGap?:number}} opts
     */
    split(mono, sampleRate, opts = {}) {
      return this._collectHits(mono, sampleRate, opts, {
        fn: "_nd_split",
        countFn: "_nd_hit_count",
        pcmFn: "_nd_hit_pcm",
        label: "Split",
      });
    },

    /**
     * Generic sample chops (no classify / recreate).
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {{threshold?:number,minGap?:number}} opts
     */
    chop(mono, sampleRate, opts = {}) {
      return this._collectHits(mono, sampleRate, opts, {
        fn: "_nd_chop",
        countFn: "_nd_chop_count",
        pcmFn: "_nd_chop_pcm",
        label: "Chop",
      });
    },

    /**
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {string} modelId
     */
    recreate(mono, sampleRate, modelId) {
      let ptr = 0;
      let modelPtr = 0;
      let framesPtr = 0;
      let outPtr = 0;
      try {
        ptr = allocF32(mono);
        modelPtr = Module._nd_malloc(modelId.length + 1);
        if (!modelPtr) throw new Error("Out of memory");
        for (let i = 0; i < modelId.length; i++) {
          Module.HEAPU8[modelPtr + i] = modelId.charCodeAt(i);
        }
        Module.HEAPU8[modelPtr + modelId.length] = 0;

        framesPtr = Module._nd_malloc(4);
        outPtr = Module._nd_recreate(ptr, mono.length, sampleRate, modelPtr, framesPtr);
        const frames = Module.getValue(framesPtr, "i32");
        Module._nd_free(framesPtr);
        framesPtr = 0;
        Module._nd_free(ptr);
        ptr = 0;
        Module._nd_free(modelPtr);
        modelPtr = 0;

        if (!outPtr || frames <= 0) return null;
        const pcm = copyHeapF32(outPtr, frames);
        Module._nd_free(outPtr);
        outPtr = 0;
        return pcm;
      } catch (err) {
        if (ptr) Module._nd_free(ptr);
        if (modelPtr) Module._nd_free(modelPtr);
        if (framesPtr) Module._nd_free(framesPtr);
        if (outPtr) Module._nd_free(outPtr);
        throw engineError(err, "Recreate failed");
      }
    },
  };
}

window.loadNodruma = loadNodruma;
