// =============================================================================
// QStore IMS v2 — Storage Layer
// =============================================================================
// IndexedDB-backed persistence for items, cadets, loans, audit log, users,
// pending requests, settings, and counters. Photos live in their own object
// store as Blob records (not base64) so item records stay small.
//
// All operations are async. Callers should treat this as the single source of
// truth: there is no in-memory `state` object to keep in sync.
//
// AUDIT CHAIN
//   Audit entries are HMAC-chained: each entry stores prevHash + hash, where
//   hash = HMAC-SHA256(installKey, [prevHash, ts, action, user, desc]).
//   The key is generated once on first init() and stored in the meta store.
//   This is tamper EVIDENCE, not tamper PREVENTION — anyone with DevTools open
//   can read the key and recompute hashes silently. The chain detects
//   accidental edits, drive-by tampering, or partial-blob corruption; it does
//   not stop a determined attacker. For real protection you need server-side
//   anchoring (v2.5+).
//
// CONCURRENCY
//   Within a single tab, audit appends are serialised through a JS-side
//   promise lock to prevent two appends racing on the same prevHash. Across
//   tabs, IndexedDB serialises writes per-store but two tabs can still
//   compute prevHash before either commits, producing a fork that audit.verify()
//   will catch. QStore's deployment is single-QM single-tab so this is
//   acceptable; document the limitation.
//
// SECURE CONTEXT
//   crypto.subtle (HMAC) requires a secure context (HTTPS, localhost, or
//   file://). crypto.randomUUID requires HTTPS or localhost — file:// users
//   fall back to a Math.random UUID. Both crypto APIs work in Chromium-based
//   browsers from file:// for HMAC; Firefox is stricter. Document Edge/Chrome
//   as the supported browsers.
// =============================================================================

const DEFAULT_DB_NAME = 'qstore';
const DB_VERSION = 1;

let _dbName = DEFAULT_DB_NAME;

export const STORES = Object.freeze({
  META:      'meta',
  SETTINGS:  'settings',
  COUNTERS:  'counters',
  ITEMS:     'items',
  PHOTOS:    'photos',
  CADETS:    'cadets',
  LOANS:     'loans',
  AUDIT:     'audit',
  USERS:     'users',
  REQUESTS:  'pendingRequests',
  STOCKTAKE: 'stocktakeCounts',
});

let _db = null;
let _auditKey = null;     // CryptoKey for HMAC, cached after init
let _initPromise = null;  // de-dupe concurrent init() calls

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

/**
 * Return the database name currently in use. Useful for tests that need
 * to open IndexedDB directly to simulate corruption or external tampering
 * (those tests can't go through the Storage API because the API is what
 * they're testing). Without this, tests have to hardcode 'qstore' which
 * means they target the real app's database instead of the test database.
 */
export function getDbName() {
  return _dbName;
}

/**
 * Open the IndexedDB connection, create stores on first run, generate the
 * install identity and audit key if needed. Safe to call repeatedly — caches
 * the open promise.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbName]  Override the database name. Used by the test
 *   harness to avoid colliding with the real app's database. Once set, all
 *   subsequent operations use this name until dropDatabase() is called.
 */
export async function init({ dbName } = {}) {
  if (dbName && dbName !== _dbName) {
    if (_db) { _db.close(); _db = null; }
    _auditKey = null;
    _initPromise = null;
    _dbName = dbName;
  }
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    _db = await _openDB();
    await _ensureMeta();
    _auditKey = await _loadAuditKey();
    return _db;
  })();
  try {
    return await _initPromise;
  } catch (err) {
    _initPromise = null;  // allow retry on failure
    throw err;
  }
}

function _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_dbName, DB_VERSION);
    req.onupgradeneeded = (e) => _runSchemaMigrations(req.result, e.oldVersion);
    req.onsuccess       = () => resolve(req.result);
    req.onerror         = () => reject(new Error('IndexedDB open failed: ' + (req.error?.message || 'unknown')));
    req.onblocked       = () => reject(new Error('IndexedDB blocked — close other QStore tabs and reload.'));
  });
}

function _runSchemaMigrations(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore(STORES.META,     { keyPath: 'key' });
    db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
    db.createObjectStore(STORES.COUNTERS, { keyPath: 'key' });

    const items = db.createObjectStore(STORES.ITEMS, { keyPath: 'id' });
    items.createIndex('nsn',  'nsn',  { unique: false });
    items.createIndex('cat',  'cat',  { unique: false });
    items.createIndex('name', 'name', { unique: false });

    db.createObjectStore(STORES.PHOTOS, { keyPath: 'id' });

    const cadets = db.createObjectStore(STORES.CADETS, { keyPath: 'svcNo' });
    cadets.createIndex('surname',    'surname',    { unique: false });
    cadets.createIndex('plt',        'plt',        { unique: false });
    cadets.createIndex('personType', 'personType', { unique: false });

    const loans = db.createObjectStore(STORES.LOANS, { keyPath: 'ref' });
    loans.createIndex('borrowerSvc', 'borrowerSvc', { unique: false });
    loans.createIndex('itemId',      'itemId',      { unique: false });
    loans.createIndex('active',      'active',      { unique: false });
    loans.createIndex('dueDate',     'dueDate',     { unique: false });

    const audit = db.createObjectStore(STORES.AUDIT, { keyPath: 'seq', autoIncrement: true });
    audit.createIndex('ts',     'ts',     { unique: false });
    audit.createIndex('action', 'action', { unique: false });
    audit.createIndex('user',   'user',   { unique: false });

    const users = db.createObjectStore(STORES.USERS, { keyPath: 'id' });
    users.createIndex('username', 'username', { unique: true });
    users.createIndex('svcNo',    'svcNo',    { unique: false });

    const reqs = db.createObjectStore(STORES.REQUESTS, { keyPath: 'id' });
    reqs.createIndex('status',       'status',       { unique: false });
    reqs.createIndex('requestorSvc', 'requestorSvc', { unique: false });

    db.createObjectStore(STORES.STOCKTAKE, { keyPath: 'itemId' });
  }
  // Future schema upgrades go here. Bump DB_VERSION above and add a new
  // `if (oldVersion < N)` block. NEVER remove old blocks — users on older
  // versions still need to walk the full upgrade path.
}

async function _ensureMeta() {
  const existing = await _kvGet(STORES.META, 'installId');
  if (existing) return;

  const installId     = _uuid();
  const auditKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const auditKeyB64   = _bytesToB64(auditKeyBytes);

  const tx = _db.transaction(STORES.META, 'readwrite');
  const store = tx.objectStore(STORES.META);
  store.put({ key: 'schemaVersion', value: DB_VERSION });
  store.put({ key: 'installId',     value: installId });
  store.put({ key: 'auditKey',      value: auditKeyB64 });
  store.put({ key: 'createdAt',     value: new Date().toISOString() });
  await _txDone(tx);
}

async function _loadAuditKey() {
  const b64 = await _kvGet(STORES.META, 'auditKey');
  if (!b64) throw new Error('Audit key missing — DB not properly initialised.');
  const bytes = _b64ToBytes(b64);
  return crypto.subtle.importKey(
    'raw', bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
}

/**
 * Request that the browser persist this database against eviction. Returns
 * true if persistent storage was granted. Quotas and eviction policies vary
 * per browser; without this, Safari and Firefox may evict QStore data after
 * a period of disuse.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function _txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function _reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _kvGet(storeName, key) {
  const tx = _db.transaction(storeName, 'readonly');
  const row = await _reqDone(tx.objectStore(storeName).get(key));
  return row ? row.value : null;
}

async function _kvSet(storeName, key, value) {
  const tx = _db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put({ key, value });
  await _txDone(tx);
}

async function _all(storeName) {
  const tx = _db.transaction(storeName, 'readonly');
  return _reqDone(tx.objectStore(storeName).getAll());
}

function _uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts. Not cryptographically random but
  // sufficient for an opaque install ID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function _bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function _b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function _bytesToHex(bytes) {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i].toString(16).padStart(2, '0');
  return out.join('');
}

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------

export const items = {
  async list({ category, search } = {}) {
    let rows = await _all(STORES.ITEMS);
    if (category) rows = rows.filter(i => i.cat === category);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(i =>
        (i.name || '').toLowerCase().includes(q)
        || (i.nsn  || '').toLowerCase().includes(q)
        || (i.cat  || '').toLowerCase().includes(q));
    }
    return rows;
  },

  async get(id) {
    const tx = _db.transaction(STORES.ITEMS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.ITEMS).get(id))) || null;
  },

  async put(item) {
    if (!item?.id) throw new Error('Item.id required');
    const tx = _db.transaction(STORES.ITEMS, 'readwrite');
    tx.objectStore(STORES.ITEMS).put(item);
    await _txDone(tx);
  },

  /** Remove an item and any associated photo. */
  async delete(id) {
    const tx = _db.transaction([STORES.ITEMS, STORES.PHOTOS], 'readwrite');
    tx.objectStore(STORES.ITEMS).delete(id);
    tx.objectStore(STORES.PHOTOS).delete(id);
    await _txDone(tx);
  },

  async count() {
    const tx = _db.transaction(STORES.ITEMS, 'readonly');
    return _reqDone(tx.objectStore(STORES.ITEMS).count());
  },
};

// -----------------------------------------------------------------------------
// Photos (Blob storage, keyed to item id)
// -----------------------------------------------------------------------------

export const photos = {
  async put(itemId, blob) {
    if (!itemId) throw new Error('itemId required');
    if (!(blob instanceof Blob)) throw new Error('blob must be a Blob');
    const tx = _db.transaction(STORES.PHOTOS, 'readwrite');
    tx.objectStore(STORES.PHOTOS).put({
      id:          itemId,
      blob,
      contentType: blob.type || 'image/jpeg',
      sizeBytes:   blob.size,
      addedAt:     new Date().toISOString(),
    });
    await _txDone(tx);
  },

  async get(itemId) {
    const tx = _db.transaction(STORES.PHOTOS, 'readonly');
    const row = await _reqDone(tx.objectStore(STORES.PHOTOS).get(itemId));
    return row ? row.blob : null;
  },

  /**
   * Returns an object URL for the photo, or null. CALLER MUST revoke the URL
   * via URL.revokeObjectURL(url) when no longer needed, or the Blob stays in
   * memory for the lifetime of the document.
   */
  async getURL(itemId) {
    const blob = await this.get(itemId);
    return blob ? URL.createObjectURL(blob) : null;
  },

  async delete(itemId) {
    const tx = _db.transaction(STORES.PHOTOS, 'readwrite');
    tx.objectStore(STORES.PHOTOS).delete(itemId);
    await _txDone(tx);
  },

  async has(itemId) {
    const tx = _db.transaction(STORES.PHOTOS, 'readonly');
    const c = await _reqDone(tx.objectStore(STORES.PHOTOS).count(itemId));
    return c > 0;
  },
};

// -----------------------------------------------------------------------------
// Cadets / Personnel
// -----------------------------------------------------------------------------

export const cadets = {
  list: () => _all(STORES.CADETS),

  async get(svcNo) {
    const tx = _db.transaction(STORES.CADETS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.CADETS).get(svcNo))) || null;
  },

  async put(cadet) {
    if (!cadet?.svcNo) throw new Error('Cadet.svcNo required');
    const tx = _db.transaction(STORES.CADETS, 'readwrite');
    tx.objectStore(STORES.CADETS).put(cadet);
    await _txDone(tx);
  },

  async delete(svcNo) {
    const tx = _db.transaction(STORES.CADETS, 'readwrite');
    tx.objectStore(STORES.CADETS).delete(svcNo);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Loans
// -----------------------------------------------------------------------------

export const loans = {
  list: () => _all(STORES.LOANS),

  async listActive() {
    const all = await _all(STORES.LOANS);
    return all.filter(l => l.active);
  },

  async listForCadet(svcNo) {
    const tx = _db.transaction(STORES.LOANS, 'readonly');
    const idx = tx.objectStore(STORES.LOANS).index('borrowerSvc');
    return _reqDone(idx.getAll(svcNo));
  },

  async get(ref) {
    const tx = _db.transaction(STORES.LOANS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.LOANS).get(ref))) || null;
  },

  async put(loan) {
    if (!loan?.ref) throw new Error('Loan.ref required');
    const tx = _db.transaction(STORES.LOANS, 'readwrite');
    tx.objectStore(STORES.LOANS).put(loan);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

export const users = {
  list: () => _all(STORES.USERS),

  async get(id) {
    const tx = _db.transaction(STORES.USERS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.USERS).get(id))) || null;
  },

  async getByUsername(username) {
    const tx = _db.transaction(STORES.USERS, 'readonly');
    const idx = tx.objectStore(STORES.USERS).index('username');
    return (await _reqDone(idx.get(username))) || null;
  },

  async put(user) {
    if (!user?.id) throw new Error('User.id required');
    const tx = _db.transaction(STORES.USERS, 'readwrite');
    tx.objectStore(STORES.USERS).put(user);
    await _txDone(tx);
  },

  async delete(id) {
    const tx = _db.transaction(STORES.USERS, 'readwrite');
    tx.objectStore(STORES.USERS).delete(id);
    await _txDone(tx);
  },

  async count() {
    const tx = _db.transaction(STORES.USERS, 'readonly');
    return _reqDone(tx.objectStore(STORES.USERS).count());
  },
};

// -----------------------------------------------------------------------------
// Pending requests (AB189 etc.)
// -----------------------------------------------------------------------------

export const requests = {
  list: () => _all(STORES.REQUESTS),

  async listByStatus(status) {
    const tx = _db.transaction(STORES.REQUESTS, 'readonly');
    const idx = tx.objectStore(STORES.REQUESTS).index('status');
    return _reqDone(idx.getAll(status));
  },

  async get(id) {
    const tx = _db.transaction(STORES.REQUESTS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.REQUESTS).get(id))) || null;
  },

  async put(req) {
    if (!req?.id) throw new Error('Request.id required');
    const tx = _db.transaction(STORES.REQUESTS, 'readwrite');
    tx.objectStore(STORES.REQUESTS).put(req);
    await _txDone(tx);
  },

  async delete(id) {
    const tx = _db.transaction(STORES.REQUESTS, 'readwrite');
    tx.objectStore(STORES.REQUESTS).delete(id);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Stocktake counts (transient, cleared after each stocktake is finalised)
// -----------------------------------------------------------------------------

export const stocktake = {
  list: () => _all(STORES.STOCKTAKE),

  async get(itemId) {
    const tx = _db.transaction(STORES.STOCKTAKE, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.STOCKTAKE).get(itemId))) || null;
  },

  async set(itemId, counted, countedBy) {
    const tx = _db.transaction(STORES.STOCKTAKE, 'readwrite');
    tx.objectStore(STORES.STOCKTAKE).put({
      itemId, counted,
      countedBy: countedBy || null,
      countedAt: new Date().toISOString(),
    });
    await _txDone(tx);
  },

  async clear() {
    const tx = _db.transaction(STORES.STOCKTAKE, 'readwrite');
    tx.objectStore(STORES.STOCKTAKE).clear();
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Audit log (HMAC-chained, append-only at the API level)
// -----------------------------------------------------------------------------

const ZERO_HASH = '0'.repeat(64);

// JS-side promise lock — serialises audit appends within a single tab so
// two appends can't race on the same prevHash. Cross-tab is not protected;
// audit.verify() will detect a fork if it happens.
let _auditLock = Promise.resolve();

function _withAuditLock(fn) {
  const next = _auditLock.then(fn, fn);
  _auditLock = next.catch(() => {});  // don't break the chain on a rejection
  return next;
}

async function _hmac(prevHash, ts, action, user, desc) {
  const payload = JSON.stringify([prevHash, ts, action, user || '', desc || '']);
  const sig = await crypto.subtle.sign('HMAC', _auditKey, new TextEncoder().encode(payload));
  return _bytesToHex(new Uint8Array(sig));
}

async function _readLastAuditHash() {
  // Separate readonly tx — we can't keep a tx alive across the HMAC await,
  // so we read prevHash here, compute HMAC outside the tx, then write in a
  // new tx. The audit lock above prevents same-tab races between read and
  // write.
  const tx = _db.transaction(STORES.AUDIT, 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(STORES.AUDIT).openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      resolve(cur ? cur.value.hash : ZERO_HASH);
    };
    req.onerror = () => reject(req.error);
  });
}

export const audit = {
  /**
   * Append an audit entry. Computes the chain hash from the previous entry's
   * hash. Returns the inserted entry (with seq, prevHash, hash populated).
   *
   * @param {object} entry
   * @param {string} entry.action       Required. e.g. 'issue', 'return', 'add'.
   * @param {string} [entry.user]       User who performed the action.
   * @param {string} [entry.desc]       Free-text description.
   * @param {string} [entry.ts]         ISO timestamp; defaults to now.
   * @param {boolean} [entry.imported]  Marks an entry imported from v1.
   * @param {string} [entry.historicalTs]  Original timestamp if imported.
   */
  async append({ action, user, desc, ts, imported, historicalTs } = {}) {
    if (!action) throw new Error('audit.action required');
    return _withAuditLock(async () => {
      const prevHash = await _readLastAuditHash();
      const entryTs  = ts || new Date().toISOString();
      const hash     = await _hmac(prevHash, entryTs, action, user, desc);
      const entry = {
        ts:    entryTs,
        action,
        user:  user || '',
        desc:  desc || '',
        prevHash, hash,
      };
      if (imported)     entry.imported = true;
      if (historicalTs) entry.historicalTs = historicalTs;

      const tx = _db.transaction(STORES.AUDIT, 'readwrite');
      const req = tx.objectStore(STORES.AUDIT).add(entry);
      const seq = await _reqDone(req);
      await _txDone(tx);
      return { ...entry, seq };
    });
  },

  async list({ since, action, search, limit, order = 'desc' } = {}) {
    let rows = await _all(STORES.AUDIT);
    if (action && action !== 'all') rows = rows.filter(r => r.action === action);
    if (since)  rows = rows.filter(r => r.ts >= since);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        (r.desc   || '').toLowerCase().includes(q)
        || (r.user || '').toLowerCase().includes(q)
        || (r.action || '').toLowerCase().includes(q));
    }
    rows.sort((a, b) => order === 'asc' ? a.seq - b.seq : b.seq - a.seq);
    if (limit) rows = rows.slice(0, limit);
    return rows;
  },

  async count() {
    const tx = _db.transaction(STORES.AUDIT, 'readonly');
    return _reqDone(tx.objectStore(STORES.AUDIT).count());
  },

  /**
   * Walk the chain in seq order and verify each entry's prevHash matches
   * the previous entry's hash, and each entry's hash matches what HMAC
   * recomputes from its content.
   *
   * @returns {{ok: true, count: number} | {ok: false, brokenAt: number, reason: string, count: number}}
   */
  async verify() {
    const all = await _all(STORES.AUDIT);
    all.sort((a, b) => a.seq - b.seq);

    let prev = ZERO_HASH;
    for (const e of all) {
      if (e.prevHash !== prev) {
        return { ok: false, brokenAt: e.seq, reason: 'prevHash mismatch', count: all.length };
      }
      const recomputed = await _hmac(e.prevHash, e.ts, e.action, e.user, e.desc);
      if (recomputed !== e.hash) {
        return { ok: false, brokenAt: e.seq, reason: 'entry hash mismatch', count: all.length };
      }
      prev = e.hash;
    }
    return { ok: true, count: all.length };
  },
};

// -----------------------------------------------------------------------------
// Settings (KV — flat namespace; v1 nested settings are flattened on migration)
// -----------------------------------------------------------------------------

export const settings = {
  get:    (key)        => _kvGet(STORES.SETTINGS, key),
  set:    (key, value) => _kvSet(STORES.SETTINGS, key, value),

  async getAll() {
    const rows = await _all(STORES.SETTINGS);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },

  async setMany(obj) {
    const tx = _db.transaction(STORES.SETTINGS, 'readwrite');
    const store = tx.objectStore(STORES.SETTINGS);
    for (const [k, v] of Object.entries(obj)) store.put({ key: k, value: v });
    await _txDone(tx);
  },

  async delete(key) {
    const tx = _db.transaction(STORES.SETTINGS, 'readwrite');
    tx.objectStore(STORES.SETTINGS).delete(key);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Counters (atomic increment for loan refs etc.)
// -----------------------------------------------------------------------------

export const counters = {
  /**
   * Atomically increment a named counter and return the new value. If the
   * counter doesn't exist, it starts at startAt and the first call returns
   * startAt. Subsequent calls return startAt+1, startAt+2, etc.
   */
  async next(key, startAt = 1000) {
    const tx = _db.transaction(STORES.COUNTERS, 'readwrite');
    const store = tx.objectStore(STORES.COUNTERS);
    const row = await _reqDone(store.get(key));
    const n = row ? row.value + 1 : startAt;
    store.put({ key, value: n });
    await _txDone(tx);
    return n;
  },

  peek: (key)        => _kvGet(STORES.COUNTERS, key),
  set:  (key, value) => _kvSet(STORES.COUNTERS, key, value),
};

// -----------------------------------------------------------------------------
// Meta (install ID, audit key, schema version)
// -----------------------------------------------------------------------------

export const meta = {
  get: (key)        => _kvGet(STORES.META, key),
  set: (key, value) => _kvSet(STORES.META, key, value),

  async delete(key) {
    const tx = _db.transaction(STORES.META, 'readwrite');
    tx.objectStore(STORES.META).delete(key);
    await _txDone(tx);
  },

  async getAll() {
    const rows = await _all(STORES.META);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
};

// -----------------------------------------------------------------------------
// Maintenance: export, import, wipe
// -----------------------------------------------------------------------------

/**
 * Dump the entire database to a plain JS object suitable for JSON
 * serialisation. Photos are encoded as base64 so the result round-trips
 * through JSON. Use for backups, handover, and the Settings → Export flow.
 */
export async function exportAll() {
  const out = {
    schemaVersion: DB_VERSION,
    exportedAt:    new Date().toISOString(),
    meta:            await _all(STORES.META),
    settings:        await _all(STORES.SETTINGS),
    counters:        await _all(STORES.COUNTERS),
    items:           await _all(STORES.ITEMS),
    cadets:          await _all(STORES.CADETS),
    loans:           await _all(STORES.LOANS),
    audit:           await _all(STORES.AUDIT),
    users:           await _all(STORES.USERS),
    pendingRequests: await _all(STORES.REQUESTS),
    stocktakeCounts: await _all(STORES.STOCKTAKE),
  };

  const photoRows = await _all(STORES.PHOTOS);
  out.photos = await Promise.all(photoRows.map(async (p) => ({
    id:          p.id,
    contentType: p.contentType,
    sizeBytes:   p.sizeBytes,
    addedAt:     p.addedAt,
    base64:      await _blobToB64(p.blob),
  })));
  return out;
}

async function _blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function _b64ToBlob(b64, contentType) {
  const bytes = _b64ToBytes(b64);
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

/**
 * Restore from a snapshot produced by exportAll(). WIPES existing operational
 * data first; preserves the install meta (audit key, install ID) so the
 * imported audit chain remains verifiable.
 *
 * IMPORTANT — meta handling:
 *   The snapshot's `meta` block (containing the auditKey and installId of the
 *   source device) IS restored. This means after import, the receiving device
 *   adopts the source's audit chain and can verify it. Without this, the
 *   audit chain would fail verification because the local HMAC key wouldn't
 *   match the keys used to compute the imported entries' hashes.
 *
 *   The cached _auditKey is reloaded after the meta restore so subsequent
 *   audit appends use the new key.
 *
 *   Cloud sync depends on this behaviour to keep the audit chain verifiable
 *   across devices. If you change it, the audit chain will break.
 */
export async function importAll(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== DB_VERSION) {
    throw new Error('Snapshot schema mismatch — expected v' + DB_VERSION
      + ', got v' + (snapshot?.schemaVersion ?? '?'));
  }
  await wipe({ keepMeta: true });

  const stores = [
    STORES.META, STORES.SETTINGS, STORES.COUNTERS, STORES.ITEMS, STORES.CADETS,
    STORES.LOANS, STORES.AUDIT, STORES.USERS, STORES.REQUESTS,
    STORES.STOCKTAKE, STORES.PHOTOS,
  ];
  const tx = _db.transaction(stores, 'readwrite');
  const put = (name, rows) => {
    const s = tx.objectStore(name);
    for (const r of rows || []) s.put(r);
  };
  // Meta first — overwrites the local audit key with the snapshot's so
  // subsequent audit chain verification succeeds. The local install ID is
  // also replaced; this is fine because installId is informational only.
  if (snapshot.meta && Array.isArray(snapshot.meta)) {
    put(STORES.META, snapshot.meta);
  }
  put(STORES.SETTINGS,  snapshot.settings);
  put(STORES.COUNTERS,  snapshot.counters);
  put(STORES.ITEMS,     snapshot.items);
  put(STORES.CADETS,    snapshot.cadets);
  put(STORES.LOANS,     snapshot.loans);
  put(STORES.AUDIT,     snapshot.audit);
  put(STORES.USERS,     snapshot.users);
  put(STORES.REQUESTS,  snapshot.pendingRequests);
  put(STORES.STOCKTAKE, snapshot.stocktakeCounts);

  const photoStore = tx.objectStore(STORES.PHOTOS);
  for (const p of snapshot.photos || []) {
    try {
      photoStore.put({
        id:          p.id,
        blob:        _b64ToBlob(p.base64, p.contentType),
        contentType: p.contentType,
        sizeBytes:   p.sizeBytes,
        addedAt:     p.addedAt,
      });
    } catch (e) {
      console.warn('Photo import failed for', p.id, e);
    }
  }
  await _txDone(tx);

  // The cached audit key may have changed if snapshot.meta replaced the
  // local meta. Reload it now so subsequent audit.append() calls use the
  // correct (imported) key.
  _auditKey = await _loadAuditKey();
}

/**
 * Clear operational data. By default preserves users and meta; pass
 * { keepUsers: false } to also wipe user accounts, or { keepMeta: false }
 * to drop the install identity (which will break verifiability of any
 * exports made before this call).
 */
export async function wipe({ keepMeta = true, keepUsers = true } = {}) {
  const targets = [
    STORES.SETTINGS, STORES.COUNTERS, STORES.ITEMS, STORES.PHOTOS,
    STORES.CADETS, STORES.LOANS, STORES.AUDIT, STORES.REQUESTS,
    STORES.STOCKTAKE,
  ];
  if (!keepUsers) targets.push(STORES.USERS);
  if (!keepMeta)  targets.push(STORES.META);

  const tx = _db.transaction(targets, 'readwrite');
  for (const name of targets) tx.objectStore(name).clear();
  await _txDone(tx);
}

/**
 * Drop the entire database. Next init() call recreates everything from scratch
 * with a NEW install identity and audit key — any existing exports become
 * unverifiable. Almost always you want wipe() instead.
 *
 * IndexedDB's deleteDatabase races with connection close: db.close() flags
 * the connection as pending-close but the actual close completes only after
 * all transactions on it finish. deleteDatabase fired immediately after
 * close() will often see the connection as still open and fire onblocked.
 * To handle this we retry up to 5 times with backoff. If all retries hit
 * onblocked, the user almost certainly has another QStore tab open holding
 * a connection — the error tells them what to do.
 */
export async function dropDatabase() {
  if (_db) { _db.close(); _db = null; }
  _auditKey = null;
  _initPromise = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(_dbName);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error || new Error('deleteDatabase failed'));
        req.onblocked = () => reject(new Error('__blocked__'));
      });
      return;
    } catch (e) {
      if (e.message === '__blocked__' && attempt < 4) {
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      if (e.message === '__blocked__') {
        throw new Error('Database delete blocked after 5 attempts — close other QStore tabs and retry.');
      }
      throw e;
    }
  }
}
