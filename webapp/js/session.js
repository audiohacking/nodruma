/**
 * Persist drums + sampler + looper in IndexedDB across reloads.
 * Cleared only via Clear session (or when storage is wiped).
 */

const NODRUMA_SESSION_DB = "nodruma-session";
const NODRUMA_SESSION_STORE = "kv";
const NODRUMA_SESSION_KEY = "current";
const NODRUMA_SESSION_VERSION = 1;

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

/**
 * @returns {Promise<object|null>}
 */
async function loadSession() {
  try {
    const db = await openSessionDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(NODRUMA_SESSION_STORE, "readonly");
      const req = tx.objectStore(NODRUMA_SESSION_STORE).get(NODRUMA_SESSION_KEY);
      req.onsuccess = () => resolve(req.result || null);
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
window.NODRUMA_SESSION_VERSION = NODRUMA_SESSION_VERSION;
