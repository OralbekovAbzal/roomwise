/*
 * Roomwise calculation history — offline storage in the browser (IndexedDB).
 * Shared by the calculator (auto-save), the AI page (auto-save) and the
 * history screen (list / filter / delete). Exposed as window.HistoryDB.
 */
(function () {
  const DB_NAME = "roomwise";
  const DB_VERSION = 1;
  const STORE = "calculations";

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("createdAt", "createdAt", { unique: false });
          store.createIndex("createdDay", "createdDay", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // Local calendar day "YYYY-MM-DD" for grouping/filtering.
  function localDay(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function saveCalculation(record) {
    const now = record.createdAt || Date.now();
    const full = Object.assign({}, record, {
      createdAt: now,
      createdDay: localDay(now),
    });
    return tx("readwrite").then(function (store) {
      return reqToPromise(store.add(full));
    });
  }

  /*
   * One page of history, newest first, for lazy loading.
   * beforeKey: pass null for the first page; for the next page pass the
   * createdAt of the last item received. Returns array of records.
   */
  function queryPage(beforeKey, limit) {
    limit = limit || 20;
    return tx("readonly").then(function (store) {
      const index = store.index("createdAt");
      const range = beforeKey != null ? IDBKeyRange.upperBound(beforeKey, true) : null;
      return new Promise(function (resolve, reject) {
        const out = [];
        const cursorReq = index.openCursor(range, "prev");
        cursorReq.onsuccess = function () {
          const cursor = cursorReq.result;
          if (!cursor || out.length >= limit) { resolve(out); return; }
          out.push(cursor.value);
          cursor.continue();
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    });
  }

  // All records whose createdAt is within [fromMs, toMs], newest first.
  function queryByDateRange(fromMs, toMs) {
    return tx("readonly").then(function (store) {
      const index = store.index("createdAt");
      const range = IDBKeyRange.bound(fromMs, toMs);
      return new Promise(function (resolve, reject) {
        const out = [];
        const cursorReq = index.openCursor(range, "prev");
        cursorReq.onsuccess = function () {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(out); return; }
          out.push(cursor.value);
          cursor.continue();
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    });
  }

  // Total number of calculations made on a given local day (independent of paging).
  function countByDay(dayStr) {
    return tx("readonly").then(function (store) {
      return reqToPromise(store.index("createdDay").count(IDBKeyRange.only(dayStr)));
    });
  }

  function deleteCalculation(id) {
    return tx("readwrite").then(function (store) {
      return reqToPromise(store.delete(id));
    });
  }

  function countAll() {
    return tx("readonly").then(function (store) {
      return reqToPromise(store.count());
    });
  }

  window.HistoryDB = {
    openDB: openDB,
    saveCalculation: saveCalculation,
    queryPage: queryPage,
    queryByDateRange: queryByDateRange,
    countByDay: countByDay,
    deleteCalculation: deleteCalculation,
    countAll: countAll,
    localDay: localDay,
  };
})();
