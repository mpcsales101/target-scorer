// Sessions live in IndexedDB on the phone; small settings in localStorage.

const DB = 'target-scorer', STORE = 'sessions';
let dbp = null;

function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}

export const sessions = {
  put: s => run('readwrite', st => st.put(s)),
  get: id => run('readonly', st => st.get(id)),
  del: id => run('readwrite', st => st.delete(id)),
  clear: () => run('readwrite', st => st.clear()),
  all: async () => ((await run('readonly', st => st.getAll())) || []).sort((a, b) => b.started - a.started),
};

export function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem('ts.' + key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

export function saveJSON(key, value) {
  try { localStorage.setItem('ts.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
