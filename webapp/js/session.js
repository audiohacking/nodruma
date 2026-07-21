/**
 * Persist drums + sampler + looper in IndexedDB across reloads.
 * Cleared only via Clear session (or when storage is wiped).
 *
 * PCM is stored as standalone ArrayBuffer copies — IDB Float32Array views
 * can fail to feed AudioBuffers after reload if not copied out.
 */

const NODRUMA_SESSION_DB = "nodruma-session";
const NODRUMA_SESSION_STORE = "kv";
const NODRUMA_SESSION_KEY = "current";
const NODRUMA_SESSION_VERSION = 2;

function openSessionDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(NODRUMA_SESSION_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NODRUMA_SESSION_STORE)) {
        db.createObjectStore(NODRUMA_SESSION_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

/** Own ArrayBuffer copy of mono float PCM (safe for IDB). */
function pcmToArrayBuffer(pcm) {
  if (!pcm || !pcm.length) return null;
  const src = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
  return src.slice().buffer;
}

/** Restore Float32Array from IDB value (ArrayBuffer, view, or Float32Array). */
function pcmFromStored(stored) {
  if (!stored) return null;
  try {
    if (stored instanceof Float32Array) {
      return stored.slice();
    }
    if (stored instanceof ArrayBuffer) {
      return new Float32Array(stored.slice(0));
    }
    if (ArrayBuffer.isView(stored)) {
      const bytes = stored.byteLength;
      const ab = stored.buffer.slice(
        stored.byteOffset,
        stored.byteOffset + bytes
      );
      if (bytes % 4 === 0) return new Float32Array(ab);
      return null;
    }
    if (Array.isArray(stored) && stored.length) {
      return Float32Array.from(stored);
    }
  } catch (err) {
    console.warn("pcmFromStored failed", err);
  }
  return null;
}

/**
 * @returns {Promise<object|null>}
 */
async function loadSession() {
  try {
    const db = await openSessionDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(NODRUMA_SESSION_STORE, "readonly");
      const req = tx.objectStore(NODRUMA_SESSION_STORE).get(NODRUMA_SESSION_KEY);
      req.onsuccess = () => {
        const raw = req.result || null;
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(
            typeof structuredClone === "function" ? structuredClone(raw) : raw
          );
        } catch {
          resolve(raw);
        }
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch (err) {
    console.warn("session load failed", err);
    return null;
  }
}

/**
 * @param {object} data
 */
async function saveSession(data) {
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(NODRUMA_SESSION_STORE, "readwrite");
      tx.objectStore(NODRUMA_SESSION_STORE).put(data, NODRUMA_SESSION_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn("session save failed", err);
    return false;
  }
}

async function clearSession() {
  try {
    const db = await openSessionDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(NODRUMA_SESSION_STORE, "readwrite");
      tx.objectStore(NODRUMA_SESSION_STORE).delete(NODRUMA_SESSION_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (err) {
    console.warn("session clear failed", err);
    return false;
  }
}

/**
 * Debounced saver — coalesce rapid pad/FX edits.
 * @param {() => object|null|Promise<object|null>} build
 * @param {number} [ms]
 */
function createSessionSaver(build, ms = 800) {
  let timer = 0;
  let pending = null;
  let suspended = false;

  function schedule() {
    if (suspended) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      void flush();
    }, ms);
  }

  async function flush() {
    if (suspended) return;
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        const data = await build();
        if (!data) return;
        data.v = NODRUMA_SESSION_VERSION;
        data.savedAt = Date.now();
        await saveSession(data);
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  function suspend(on) {
    suspended = !!on;
    if (suspended && timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  return { schedule, flush, suspend };
}

window.loadSession = loadSession;
window.saveSession = saveSession;
window.clearSession = clearSession;
window.createSessionSaver = createSessionSaver;
window.pcmToArrayBuffer = pcmToArrayBuffer;
window.pcmFromStored = pcmFromStored;
window.NODRUMA_SESSION_VERSION = NODRUMA_SESSION_VERSION;
