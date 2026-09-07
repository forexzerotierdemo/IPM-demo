// ====================================================================
// Offline READ cache (field agents with no signal).
//
// The app shell has always survived offline — the service worker caches it —
// but every screen went blank, because API GETs were never stored. This keeps
// the JSON answer to each GET in IndexedDB so the same screens can be rendered
// from the last known data when the network is gone.
//
// Rules that matter:
//  - Entries are keyed by USER as well as path. A second agent signing in on a
//    shared phone must never be shown the first one's data.
//  - Nothing is cached unless the server said 200. A cached answer is only ever
//    used when the network fails, never in preference to it.
//  - The cache is bounded (age + count), so a phone that has been in the field
//    for a year does not carry a year of stale visits.
// Exposes window.ReadStore.
// ====================================================================
(function () {
  const DB_NAME = "pestcare-reads";
  const STORE = "reads";
  const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;   // three weeks
  const MAX_ENTRIES = 600;

  function openDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function op(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const holder = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(holder && holder.value);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const wrap = (req, holder) => { req.onsuccess = () => { holder.value = req.result; }; };

  // Who the cache belongs to. Anonymous ("0") entries are never read back once
  // a real user is known, which is what keeps a shared device honest.
  function uid() {
    try {
      const u = JSON.parse(localStorage.getItem("user") || "null");
      return u && u.id ? String(u.id) : "0";
    } catch (e) { return "0"; }
  }

  const keyFor = (path) => uid() + "|" + path;

  async function put(path, data) {
    if (data === undefined || data === null) return;
    const entry = { key: keyFor(path), uid: uid(), path, data, ts: Date.now() };
    try {
      await op("readwrite", s => { s.put(entry); return {}; });
    } catch (e) { /* a full or blocked IndexedDB must never break a live read */ }
  }

  async function get(path) {
    try {
      const h = {};
      await op("readonly", s => { wrap(s.get(keyFor(path)), h); return h; });
      const row = h.value;
      if (!row) return null;
      if (Date.now() - row.ts > MAX_AGE_MS) return null;
      return row;                     // {data, ts, path}
    } catch (e) { return null; }
  }

  // Fold a queued offline write into what the screen will read back, so an
  // agent who saves a report with no signal still sees their own text when they
  // reopen the visit. The server remains the authority once the queue drains.
  async function patch(path, fn) {
    const row = await get(path);
    if (!row) return false;
    try {
      const next = fn(row.data);
      if (next === undefined) return false;
      await put(path, next);
      return true;
    } catch (e) { return false; }
  }

  async function all() {
    const h = {};
    await op("readonly", s => { wrap(s.getAll(), h); return h; });
    return h.value || [];
  }

  // Age of the freshest thing we hold for this user — what the banner reports.
  async function newestTs() {
    try {
      const mine = (await all()).filter(r => r.uid === uid());
      return mine.reduce((max, r) => Math.max(max, r.ts || 0), 0) || null;
    } catch (e) { return null; }
  }

  async function stats() {
    try {
      const mine = (await all()).filter(r => r.uid === uid());
      return { entries: mine.length, newest: await newestTs() };
    } catch (e) { return { entries: 0, newest: null }; }
  }

  // Drop expired rows, anything belonging to a signed-out user, and the oldest
  // of what remains once the cap is passed.
  async function prune() {
    try {
      const rows = await all();
      const now = Date.now();
      const me = uid();
      const doomed = rows.filter(r => now - (r.ts || 0) > MAX_AGE_MS);
      const mine = rows.filter(r => r.uid === me && now - (r.ts || 0) <= MAX_AGE_MS)
                       .sort((a, b) => b.ts - a.ts);
      doomed.push(...mine.slice(MAX_ENTRIES));
      if (!doomed.length) return 0;
      await op("readwrite", s => { doomed.forEach(r => s.delete(r.key)); return {}; });
      return doomed.length;
    } catch (e) { return 0; }
  }

  // Signing out clears the read cache. Queued WRITES are deliberately left
  // alone — they are the agent's unsent work, not a convenience copy.
  async function clearAll() {
    try { await op("readwrite", s => { s.clear(); return {}; }); } catch (e) {}
  }

  window.ReadStore = { put, get, patch, stats, newestTs, prune, clearAll };
})();
