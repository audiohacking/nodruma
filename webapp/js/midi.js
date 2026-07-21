/**
 * WebMIDI → drum / sampler pad map.
 *
 * Octave layout (MIDI note numbers, C2 = 36):
 *   C2–G♯2 (36–44)  → drums pads 1–9 (current bank)
 *   C3+    (48+)     → sampler 4×4 pages (16 pads/page, chromatic)
 *
 * Velocity scales playback gain.
 *
 * Permission must be requested from a user gesture (Chrome 124+).
 * Do not call enable() on page load unless Permissions API says granted.
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

function midiSupported() {
  return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
}

/**
 * @returns {Promise<'granted'|'denied'|'prompt'|'unsupported'>}
 */
async function queryMidiPermission() {
  if (!midiSupported()) return "unsupported";
  if (!navigator.permissions?.query) return "prompt";
  try {
    const result = await navigator.permissions.query({ name: "midi", sysex: false });
    return result.state; // granted | denied | prompt
  } catch {
    // Safari / older Chrome may reject the midi permission name
    return "prompt";
  }
}

/**
 * @param {{
 *   onNote: (mapped: ReturnType<typeof mapMidiNote>, velocity: number) => void,
 *   onStatus: (msg: string, ok?: boolean) => void,
 * }} handlers
 */
function createMidiController(handlers) {
  let access = null;
  /** @type {Promise<boolean>|null} */
  let pending = null;
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

    // Note on (ignore note-off / vel 0 — one-shots)
    if (cmd === 0x90 && vel > 0) {
      const mapped = mapMidiNote(note);
      if (mapped) handlers.onNote(mapped, vel);
    }
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
      status("MIDI · on (no devices)", true);
    }
  }

  /**
   * Request MIDI access. Must be called from a click/tap when permission
   * is still "prompt", otherwise Chrome will not show the dialog.
   * @returns {Promise<boolean>}
   */
  async function enable() {
    if (!midiSupported()) {
      status("MIDI unsupported", false);
      return false;
    }
    if (access) {
      refreshInputs();
      return true;
    }
    if (pending) return pending;

    status("MIDI · allow in browser…");
    pending = (async () => {
      try {
        access = await navigator.requestMIDIAccess({ sysex: false });
        access.addEventListener("statechange", refreshInputs);
        refreshInputs();
        return true;
      } catch (err) {
        console.warn("MIDI access denied", err);
        const name = err && err.name;
        if (name === "SecurityError" || name === "NotAllowedError") {
          status("MIDI · blocked — click again or check site settings", false);
        } else {
          status("MIDI · failed", false);
        }
        return false;
      } finally {
        pending = null;
      }
    })();

    return pending;
  }

  /**
   * Connect only if permission was already granted (safe on page load).
   * @returns {Promise<boolean>}
   */
  async function enableIfGranted() {
    const state = await queryMidiPermission();
    if (state === "unsupported") {
      status("MIDI unsupported", false);
      return false;
    }
    if (state === "granted") return enable();
    if (state === "denied") {
      status("MIDI · denied", false);
      return false;
    }
    status("MIDI", undefined);
    return false;
  }

  return { enable, enableIfGranted, refreshInputs, mapMidiNote, midiSupported };
}

window.createMidiController = createMidiController;
window.mapMidiNote = mapMidiNote;
window.midiVelocityGain = midiVelocityGain;
window.midiSupported = midiSupported;
window.MIDI_DRUM_BASE = MIDI_DRUM_BASE;
window.MIDI_SAMPLE_BASE = MIDI_SAMPLE_BASE;
