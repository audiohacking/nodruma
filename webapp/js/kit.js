/** Kit state: keep / rename / discard + ZIP export. */

class Kit {
  /**
   * @param {{pageSize?:number,idPrefix?:string,exportName?:string}} [opts]
   */
  constructor(opts = {}) {
    /** @type {Array<{id:string,name:string,kind:string,confidence:number,pcm:Float32Array,sampleRate:number,discarded:boolean,recreated:boolean}>} */
    this.pads = [];
    this.sourceName = "kit";
    this.pageSize = opts.pageSize || 9;
    this.idPrefix = opts.idPrefix || "p";
    this.exportName = opts.exportName || "kit";
    this._seq = 0;
  }

  reset(sourceName) {
    this.pads = [];
    this._seq = 0;
    this.sourceName = (sourceName || this.exportName).replace(/\.[^.]+$/, "");
  }

  addPad(meta, pcm, sampleRate) {
    const id = `${this.idPrefix}${this._seq++}`;
    const kind = meta.kind || "unknown";
    const name = `${String(this.activePads().length).padStart(3, "0")}_${kind}`;
    this.pads.push({
      id,
      name,
      kind,
      confidence: meta.confidence ?? 0,
      pcm,
      sampleRate,
      discarded: false,
      recreated: false,
      pitchSemitones: 0,
      eqLowDb: 0,
      eqHighDb: 0,
    });
    return this.pads[this.pads.length - 1];
  }

  activePads() {
    return this.pads.filter((p) => !p.discarded);
  }

  bankCount() {
    return Math.max(1, Math.ceil(this.activePads().length / this.pageSize));
  }

  padAtBankSlot(bank, slot) {
    const active = this.activePads();
    return active[bank * this.pageSize + slot] || null;
  }

  discard(id) {
    const p = this.pads.find((x) => x.id === id);
    if (p) p.discarded = true;
  }

  rename(id, name) {
    const p = this.pads.find((x) => x.id === id);
    if (p && name.trim()) p.name = name.trim();
  }

  moveBefore(fromId, toId) {
    if (!fromId || fromId === toId) return false;
    const from = this.pads.findIndex((p) => p.id === fromId && !p.discarded);
    if (from < 0) return false;
    const [item] = this.pads.splice(from, 1);
    if (!toId) {
      this.pads.push(item);
      return true;
    }
    const to = this.pads.findIndex((p) => p.id === toId && !p.discarded);
    if (to < 0) {
      this.pads.push(item);
      return true;
    }
    this.pads.splice(to, 0, item);
    return true;
  }

  swap(aId, bId) {
    if (!aId || !bId || aId === bId) return false;
    const i = this.pads.findIndex((p) => p.id === aId && !p.discarded);
    const j = this.pads.findIndex((p) => p.id === bId && !p.discarded);
    if (i < 0 || j < 0) return false;
    const tmp = this.pads[i];
    this.pads[i] = this.pads[j];
    this.pads[j] = tmp;
    return true;
  }

  nudge(id, delta) {
    const active = this.activePads();
    const ai = active.findIndex((p) => p.id === id);
    if (ai < 0) return false;
    const bi = ai + delta;
    if (bi < 0 || bi >= active.length) return false;
    return this.swap(active[ai].id, active[bi].id);
  }

  moveToActiveIndex(fromId, index) {
    const from = this.pads.findIndex((p) => p.id === fromId && !p.discarded);
    if (from < 0) return false;
    const [item] = this.pads.splice(from, 1);
    const active = this.pads.filter((p) => !p.discarded);
    const clamped = Math.max(0, Math.min(active.length, index));
    if (clamped >= active.length) {
      this.pads.push(item);
      return true;
    }
    const to = this.pads.findIndex((p) => p.id === active[clamped].id);
    this.pads.splice(to, 0, item);
    return true;
  }

  updatePcm(id, pcm, sampleRate) {
    const p = this.pads.find((x) => x.id === id);
    if (!p) return;
    p.pcm = pcm;
    p.sampleRate = sampleRate;
    p.recreated = true;
  }

  setFx(id, { pitchSemitones, eqLowDb, eqHighDb } = {}) {
    const p = this.pads.find((x) => x.id === id);
    if (!p) return;
    if (pitchSemitones != null) p.pitchSemitones = pitchSemitones;
    if (eqLowDb != null) p.eqLowDb = eqLowDb;
    if (eqHighDb != null) p.eqHighDb = eqHighDb;
  }

  /**
   * Duplicate an active pad.
   * @param {string} id
   * @param {'next'|'end'} where insert after source, or at end of kit
   */
  clonePad(id, where = "next") {
    const srcIdx = this.pads.findIndex((p) => p.id === id && !p.discarded);
    if (srcIdx < 0) return null;
    const src = this.pads[srcIdx];
    const copy = {
      id: `${this.idPrefix}${this._seq++}`,
      name: `${src.name}_copy`,
      kind: src.kind,
      confidence: src.confidence,
      pcm: src.pcm,
      sampleRate: src.sampleRate,
      discarded: false,
      recreated: src.recreated,
      pitchSemitones: src.pitchSemitones ?? 0,
      eqLowDb: src.eqLowDb ?? 0,
      eqHighDb: src.eqHighDb ?? 0,
    };
    if (where === "end") {
      this.pads.push(copy);
    } else {
      this.pads.splice(srcIdx + 1, 0, copy);
    }
    return copy;
  }

  async exportZip() {
    if (typeof JSZip === "undefined") throw new Error("JSZip missing");
    const zip = new JSZip();
    const kept = this.activePads();
    const samples = zip.folder("samples");
    const manifest = {
      name: this.sourceName,
      version: 1,
      type: this.exportName,
      sample_rate: kept[0]?.sampleRate || 44100,
      pads: [],
    };

    for (const p of kept) {
      const file = `${sanitize(p.name)}.wav`;
      samples.file(file, encodeWavMono(p.pcm, p.sampleRate));
      manifest.pads.push({
        file: `samples/${file}`,
        name: p.name,
        kind: p.kind,
        confidence: p.confidence,
        recreated: p.recreated,
        pitch_semitones: p.pitchSemitones ?? 0,
        eq_low_db: p.eqLowDb ?? 0,
        eq_high_db: p.eqHighDb ?? 0,
      });
    }
    zip.file("kit.json", JSON.stringify(manifest, null, 2));
    return zip.generateAsync({ type: "blob" });
  }
}

/** QWERTY sampler: 4×4 = 16 pads per page. */
class SamplerKit extends Kit {
  constructor() {
    super({ pageSize: 16, idPrefix: "s", exportName: "chops" });
  }
}

/** Drum replicator: 9 pads per bank. */
class DrumKit extends Kit {
  constructor() {
    super({ pageSize: 9, idPrefix: "d", exportName: "kit" });
  }
}

/** 4×4 map: QWER / ASDF / ZXCV / TYUI */
const SAMPLER_KEYS = [
  "q", "w", "e", "r",
  "a", "s", "d", "f",
  "z", "x", "c", "v",
  "t", "y", "u", "i",
];

const SAMPLER_KEY_LABELS = [
  "Q", "W", "E", "R",
  "A", "S", "D", "F",
  "Z", "X", "C", "V",
  "T", "Y", "U", "I",
];

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "pad";
}

/** 16-bit PCM WAV ArrayBuffer */
function encodeWavMono(float32, sampleRate) {
  const n = float32.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buffer;
}

window.Kit = Kit;
window.DrumKit = DrumKit;
window.SamplerKit = SamplerKit;
window.SAMPLER_KEYS = SAMPLER_KEYS;
window.SAMPLER_KEY_LABELS = SAMPLER_KEY_LABELS;
window.encodeWavMono = encodeWavMono;
