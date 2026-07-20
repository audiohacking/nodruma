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

function wrapModule(Module) {
  const utf8 = (ptr) => Module.UTF8ToString(ptr);

  function copyHeapF32(ptr, frames) {
    if (!ptr || frames <= 0) return new Float32Array(0);
    const start = ptr >> 2;
    return Float32Array.from(Module.HEAPF32.subarray(start, start + frames));
  }

  return {
    version() {
      return utf8(Module._nd_version());
    },

    clearHits() {
      Module._nd_clear_hits();
    },

    /**
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {{threshold?:number,minGap?:number}} opts
     */
    split(mono, sampleRate, opts = {}) {
      const n = mono.length;
      const bytes = n * 4;
      const ptr = Module._nd_malloc(bytes);
      if (!ptr) throw new Error("malloc failed");
      Module.HEAPF32.set(mono, ptr >> 2);
      const thr = opts.threshold ?? 1.0;
      const gap = opts.minGap ?? 0.048;
      const jsonPtr = Module._nd_split(ptr, n, sampleRate, thr, gap);
      Module._nd_free(ptr);
      if (!jsonPtr) throw new Error("split failed");
      const json = JSON.parse(utf8(jsonPtr));
      Module._nd_free(jsonPtr);

      const hits = [];
      const count = Module._nd_hit_count();
      for (let i = 0; i < count; i++) {
        const framesPtr = Module._nd_malloc(4);
        const srPtr = Module._nd_malloc(8);
        const pcmPtr = Module._nd_hit_pcm(i, framesPtr, srPtr);
        const frames = Module.getValue(framesPtr, "i32");
        const sr = Module.getValue(srPtr, "double");
        Module._nd_free(framesPtr);
        Module._nd_free(srPtr);
        const pcm = copyHeapF32(pcmPtr, frames);
        const meta = json.hits[i] || { index: i, kind: "unknown" };
        hits.push({ meta, pcm, sampleRate: sr || sampleRate });
      }
      return { json, hits };
    },

    /**
     * @param {Float32Array} mono
     * @param {number} sampleRate
     * @param {string} modelId
     */
    recreate(mono, sampleRate, modelId) {
      const n = mono.length;
      const ptr = Module._nd_malloc(n * 4);
      Module.HEAPF32.set(mono, ptr >> 2);
      const modelPtr = Module._nd_malloc(modelId.length + 1);
      for (let i = 0; i < modelId.length; i++) {
        Module.HEAPU8[modelPtr + i] = modelId.charCodeAt(i);
      }
      Module.HEAPU8[modelPtr + modelId.length] = 0;

      const framesPtr = Module._nd_malloc(4);
      const outPtr = Module._nd_recreate(ptr, n, sampleRate, modelPtr, framesPtr);
      const frames = Module.getValue(framesPtr, "i32");
      Module._nd_free(framesPtr);
      Module._nd_free(ptr);
      Module._nd_free(modelPtr);

      if (!outPtr || frames <= 0) return null;
      const pcm = copyHeapF32(outPtr, frames);
      Module._nd_free(outPtr);
      return pcm;
    },
  };
}

window.loadNodruma = loadNodruma;
