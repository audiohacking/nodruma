/** Kit state: keep / rename / discard + ZIP export. */

class Kit {
  constructor() {
    /** @type {Array<{id:string,name:string,kind:string,confidence:number,pcm:Float32Array,sampleRate:number,discarded:boolean,recreated:boolean}>} */
    this.pads = [];
    this.sourceName = "kit";
  }

  reset(sourceName) {
    this.pads = [];
    this.sourceName = (sourceName || "kit").replace(/\.[^.]+$/, "");
  }

  addPad(meta, pcm, sampleRate) {
    const id = `p${this.pads.length}`;
    const kind = meta.kind || "unknown";
    const name = `${String(this.pads.length).padStart(3, "0")}_${kind}`;
    this.pads.push({
      id,
      name,
      kind,
      confidence: meta.confidence ?? 0,
      pcm,
      sampleRate,
      discarded: false,
      recreated: false,
    });
    return this.pads[this.pads.length - 1];
  }

  activePads() {
    return this.pads.filter((p) => !p.discarded);
  }

  bankCount() {
    return Math.max(1, Math.ceil(this.activePads().length / 9));
  }

  padAtBankSlot(bank, slot) {
    const active = this.activePads();
    return active[bank * 9 + slot] || null;
  }

  discard(id) {
    const p = this.pads.find((x) => x.id === id);
    if (p) p.discarded = true;
  }

  rename(id, name) {
    const p = this.pads.find((x) => x.id === id);
    if (p && name.trim()) p.name = name.trim();
  }

  updatePcm(id, pcm, sampleRate) {
    const p = this.pads.find((x) => x.id === id);
    if (!p) return;
    p.pcm = pcm;
    p.sampleRate = sampleRate;
    p.recreated = true;
  }

  async exportZip() {
    if (typeof JSZip === "undefined") throw new Error("JSZip missing");
    const zip = new JSZip();
    const kept = this.activePads();
    const samples = zip.folder("samples");
    const manifest = {
      name: this.sourceName,
      version: 1,
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
      });
    }
    zip.file("kit.json", JSON.stringify(manifest, null, 2));
    return zip.generateAsync({ type: "blob" });
  }
}

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
window.encodeWavMono = encodeWavMono;
