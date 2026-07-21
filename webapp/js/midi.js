/**
 * WebMIDI → drum / sampler pad map.
 *
 * Octave layout (MIDI note numbers, C2 = 36):
 *   C2–G♯2 (36–44)  → drums pads 1–9 (current bank)
 *   C3+    (48+)     → sampler 4×4 pages (16 pads/page, chromatic)
 *
 * Velocity scales playback gain.
 */

const MIDI_DRUM_BASE = 36; // C2
const MIDI_SAMPLE_BASE = 48; // C3
const MIDI_DRUM_SLOTS = 9;
const MIDI_SAMPLE_PAGE = 16;

/**
 * @param {number} note MIDI note number
 * @returns {{kind:'drums'|'sampler', slot:number, page?:number}|null}
 */
function mapMidiNote(note) {
  if (note >= MIDI_DRUM_BASE && note < MIDI_DRUM_BASE + 12) {
    const slot = note - MIDI_DRUM_BASE;
    if (slot >= MIDI_DRUM_SLOTS) return null;
    return { kind: "drums", slot };
  }
  if (note >= MIDI_SAMPLE_BASE) {
    const idx = note - MIDI_SAMPLE_BASE;
    return {
      kind: "sampler",
      slot: idx % MIDI_SAMPLE_PAGE,
      page: Math.floor(idx / MIDI_SAMPLE_PAGE),
    };
  }
  return null;
}

function midiVelocityGain(velocity) {
  const v = Math.max(0, Math.min(127, velocity | 0)) / 127;
  // Gentle curve so soft hits aren't silent
  return 0.08 + 0.92 * v * v;
}

/**
 * @param {{
 *   onNote: (mapped: ReturnType<typeof mapMidiNote>, velocity: number) => void,
 *   onStatus: (msg: string, ok?: boolean) => void,
 * }} handlers
 */
function createMidiController(handlers) {
  let access = null;
  /** @type {Map<string, MIDIInput>} */
  const wired = new Map();

  function status(msg, ok) {
    handlers.onStatus?.(msg, ok);
  }

  function onMessage(ev) {
    const data = ev.data;
    if (!data || data.length < 2) return;
    const cmd = data[0] & 0xf0;
    const note = data[1];
    const vel = data.length > 2 ? data[2] : 0;

    // Note on (or note off with vel 0)
    if (cmd === 0x90 && vel > 0) {
      const mapped = mapMidiNote(note);
      if (mapped) handlers.onNote(mapped, vel);
      return;
    }
    // Note off — one-shots; ignore
  }

  function wireInput(input) {
    if (wired.has(input.id)) return;
    input.addEventListener("midimessage", onMessage);
    wired.set(input.id, input);
  }

  function unwireAll() {
    for (const input of wired.values()) {
      input.removeEventListener("midimessage", onMessage);
    }
    wired.clear();
  }

  function refreshInputs() {
    if (!access) return;
    unwireAll();
    for (const input of access.inputs.values()) {
      wireInput(input);
    }
    const names = [...access.inputs.values()].map((i) => i.name || i.id);
    if (names.length) {
      status(`MIDI · ${names.join(", ")}`, true);
    } else {
      status("MIDI · no controllers", false);
    }
  }

  async function enable() {
    if (!navigator.requestMIDIAccess) {
      status("MIDI unsupported", false);
      return false;
    }
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.addEventListener("statechange", refreshInputs);
      refreshInputs();
      return true;
    } catch (err) {
      console.warn("MIDI access denied", err);
      status("MIDI · permission denied", false);
      return false;
    }
  }

  return { enable, refreshInputs, mapMidiNote };
}

window.createMidiController = createMidiController;
window.mapMidiNote = mapMidiNote;
window.midiVelocityGain = midiVelocityGain;
window.MIDI_DRUM_BASE = MIDI_DRUM_BASE;
window.MIDI_SAMPLE_BASE = MIDI_SAMPLE_BASE;
