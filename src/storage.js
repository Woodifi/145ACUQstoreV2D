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

import * as PII from './pii.js';
import { requireEdit } from './license.js';
import { inferPersonType } from './ranks.js';

// V2L sandbox: use a separate DB so learning data never touches production IDB.
const DEFAULT_DB_NAME = (typeof __V2L_DB_NAME__ !== 'undefined') ? __V2L_DB_NAME__ : 'qstore';
const DB_VERSION = 4;

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
  STOCKTAKE:     'stocktakeCounts',
  KITS:          'kits',
  SUPPLY_ORDERS: 'supplyOrders',
  STAFF:         'staff',
});

let _db = null;
let _auditKey = null;     // CryptoKey for HMAC, cached after init
let _initPromise = null;  // de-dupe concurrent init() calls
// PII CryptoKey is held inside pii.js — no local reference needed.

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
    await _loadOrGenPiiKey();
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
    // borrowerSvc is retained ONLY so existing databases still open and their
    // rows remain reachable for extraction to CEA before disposal. Nothing
    // written by this build populates it — see docs/IDENTIFIER-FREE-DESIGN.md.
    loans.createIndex('borrowerSvc', 'borrowerSvc', { unique: false });
    loans.createIndex('issueNo',     'issueNo',     { unique: false });
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
  if (oldVersion < 2) {
    db.createObjectStore(STORES.KITS, { keyPath: 'id' });
  }
  if (oldVersion < 3) {
    const orders = db.createObjectStore(STORES.SUPPLY_ORDERS, { keyPath: 'id' });
    orders.createIndex('docType',   'docType',   { unique: false });
    orders.createIndex('status',    'status',    { unique: false });
    orders.createIndex('importedAt','importedAt',{ unique: false });
  }
  if (oldVersion < 4) {
    // Staff — separate entity from cadets (officers, NCOs, DAHs).
    const staff = db.createObjectStore(STORES.STAFF, { keyPath: 'svcNo' });
    staff.createIndex('surname',    'surname',    { unique: false });
    staff.createIndex('personType', 'personType', { unique: false });
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
  const piiKeyBytes   = crypto.getRandomValues(new Uint8Array(32));
  const piiKeyB64     = _bytesToB64(piiKeyBytes);

  const tx = _db.transaction(STORES.META, 'readwrite');
  const store = tx.objectStore(STORES.META);
  store.put({ key: 'schemaVersion', value: DB_VERSION });
  store.put({ key: 'installId',     value: installId });
  store.put({ key: 'auditKey',      value: auditKeyB64 });
  store.put({ key: 'piiKey',        value: piiKeyB64 });
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

async function _loadOrGenPiiKey() {
  let b64 = await _kvGet(STORES.META, 'piiKey');
  if (!b64) {
    // Existing install upgraded — generate piiKey now (existing records are
    // plaintext and will be encrypted transparently on next write).
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    b64 = _bytesToB64(bytes);
    const tx = _db.transaction(STORES.META, 'readwrite');
    tx.objectStore(STORES.META).put({ key: 'piiKey', value: b64 });
    await _txDone(tx);
  }
  // Initialise the PII module with the raw base-64 key so it can perform
  // field-level AES-GCM encryption/decryption throughout the storage layer.
  await PII.init(b64);
  // One-time migration: encrypt any cadet records that pre-date PII encryption
  // (i.e. records where PII fields are still stored as plain text).
  await _migratePlainTextCadets();
  // One-time migration: strip email/notes from existing cadet records.
  await _stripCadetContactFields();
  // One-time migration: move adults an older build left in the cadet store.
  await _reclassifyStrandedStaff();
}

/**
 * Move adults out of the `cadets` store and into `staff`.
 *
 * An older build stored everyone in `cadets` and distinguished them by rank
 * alone — `personType` came later, and rows written before it are simply
 * missing the field. The Staff page has a migration for this, but it only
 * matches `personType === 'staff'` exactly, and it only runs when someone opens
 * the Staff page. So it misses on both counts: a CAPT-AAC with no personType
 * matches nothing, and a correctly-typed adult still sits in the cadet store
 * until somebody happens to navigate there.
 *
 * That is not cosmetic. `legacy.purge()` clears the whole cadets store and it
 * lives on the Settings page — a unit can import a dataset, extract, and purge
 * without ever opening Staff. A stranded adult is then destroyed as though they
 * were cadet PII: irreversibly, by the feature built to make disposal safe, and
 * counted in the audit entry as a "cadet record". The unit loses a staff record
 * and is told it complied.
 *
 * Hence this runs in the storage layer at init() and again after importAll(),
 * where it cannot be skipped by a route the operator didn't take, and it covers
 * both kinds: explicitly-typed adults and rank-only ones.
 *
 * Rank decides only when nothing else has. An explicit personType is always
 * believed over the rank — if a build recorded a decision, that decision stands.
 * inferPersonType() returns 'cadet' for empty, unknown, and every cadet rank
 * including OFFCDT, so an ambiguous row stays where it is and keeps the
 * protections that apply to a cadet record. Only an unmistakable adult rank
 * moves. Relocation, not disposal: the row lands in `staff` intact.
 */
async function _reclassifyStrandedStaff() {
  try {
    const cadetRows = await _all(STORES.CADETS);
    const stranded  = cadetRows.filter((r) =>
      r.personType === 'staff' || (!r.personType && inferPersonType(r.rank) === 'staff'));
    if (stranded.length === 0) return 0;

    const existingStaff = new Set((await _all(STORES.STAFF)).map((s) => s.svcNo));
    const moved = [];
    for (const row of stranded) {
      // A row already in `staff` is a duplicate of a record that has since been
      // edited there. The staff copy is the live one; drop the cadet-store
      // shadow rather than overwrite it with older values.
      if (!existingStaff.has(row.svcNo)) {
        const plain = await PII.decryptRecord(row, PII.PII_FIELDS_CADETS);
        moved.push(await PII.encryptRecord({
          svcNo:      plain.svcNo,
          surname:    plain.surname || '',
          given:      plain.given   || '',
          rank:       plain.rank    || '',
          position:   plain.position || '',
          company:    plain.company  || plain.plt || '',
          personType: 'staff',
          active:     plain.active !== false,
          createdAt:  plain.createdAt || new Date().toISOString(),
          migratedAt: new Date().toISOString(),
        }, PII.PII_FIELDS_STAFF));
      }
    }

    const tx = _db.transaction([STORES.CADETS, STORES.STAFF], 'readwrite');
    const staffOs = tx.objectStore(STORES.STAFF);
    for (const m of moved) staffOs.put(m);
    const cadetOs = tx.objectStore(STORES.CADETS);
    for (const row of stranded) cadetOs.delete(row.svcNo);
    await _txDone(tx);

    // Worth a trace: this moves adult records between stores, and a later
    // reader comparing a purge count against an old backup needs to know why
    // the cadet count dropped without a disposal. No names — the audit log is
    // the one place already carrying too many, and a count answers the question.
    await audit.append({
      action: 'staff_reclassified',
      user:   'system',
      desc:   `${stranded.length} adult record(s) moved from the cadet list to the staff `
            + `establishment (${moved.length} new, ${stranded.length - moved.length} already `
            + 'present in staff). Identified by rank where an older build recorded no person '
            + 'type. Relocation only — no record was destroyed, and these are not cadet data '
            + 'for extraction or disposal.',
    }).catch(() => {});

    console.info(`[storage] Reclassified ${stranded.length} adult record(s) `
      + `from the cadet store to staff (${moved.length} new, `
      + `${stranded.length - moved.length} already present).`);
    return stranded.length;
  } catch (err) {
    console.warn('[storage] Staff reclassification error:', err);
    return 0;   // Non-fatal — retried on next init.
  }
}

/**
 * Remove `email` and `notes` from every cadet record.
 *
 * Deleting the fields from the schema and the form stops NEW data being
 * collected; it does nothing about the values already sitting in a unit's
 * database. Without this, every cadet added before the change keeps their email
 * address and notes indefinitely — encrypted, unreachable from the UI, and
 * invisible. Dead PII you cannot see is worse than PII you can: it is still in
 * every export and every backup, and nobody remembers it is there.
 *
 * `notes` is the field this is really about. It is free text about a child, and
 * in practice free text about a child accumulates health and behavioural
 * information — sensitive information under the Privacy Act, a stricter category
 * than ordinary personal information, and never required to track equipment.
 *
 * Runs once per record: after the first pass the fields are absent and the
 * `in` checks are false, so the loop finds nothing to do. Deliberately silent
 * about the values it removes — logging them would defeat the point.
 */
async function _stripCadetContactFields() {
  try {
    const tx    = _db.transaction(STORES.CADETS, 'readwrite');
    const store = tx.objectStore(STORES.CADETS);
    const rows  = await _reqDone(store.getAll());
    let   count = 0;
    for (const row of rows) {
      if ('email' in row || 'notes' in row) {
        delete row.email;
        delete row.notes;
        store.put(row);
        count++;
      }
    }
    await _txDone(tx);
    if (count > 0) {
      console.info(`[storage] Removed email/notes from ${count} cadet record(s).`);
    }
  } catch (err) {
    console.warn('[storage] Cadet contact-field strip error:', err);
    // Non-fatal — retried on next init.
  }
}

async function _migratePlainTextCadets() {
  try {
    const tx    = _db.transaction(STORES.CADETS, 'readwrite');
    const store = tx.objectStore(STORES.CADETS);
    const rows  = await _reqDone(store.getAll());
    let   count = 0;
    for (const row of rows) {
      // A field is plain-text when it is a non-empty string not starting with '~enc:'
      const needsEnc = PII.PII_FIELDS_CADETS.some(
        f => typeof row[f] === 'string' && row[f].length > 0 && !row[f].startsWith('~enc:')
      );
      if (needsEnc) {
        const enc = await PII.encryptRecord(row, PII.PII_FIELDS_CADETS);
        store.put(enc);
        count++;
      }
    }
    await _txDone(tx);
    if (count > 0) console.info(`[storage] Migrated ${count} cadet record(s) to PII encryption.`);
  } catch (err) {
    console.warn('[storage] Cadet PII migration error:', err);
    // Non-fatal — records will still be encrypted on their next write.
  }
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

/**
 * Returns true if an NSN consists only of digits and hyphens (pure numeric NSN).
 * e.g. "8415-00-123-4567" → true,  "LOCAL-001" → false
 */
function _isNumericNsn(nsn) {
  return /^[\d-]+$/.test(nsn || '');
}

/**
 * Canonical item sort order: category A–Z, then within each category:
 *   1. Numeric-only NSNs first (digits + hyphens), sorted alphanumerically
 *   2. Alpha-inclusive NSNs next (contain letters), sorted alphanumerically
 *   3. Items with no NSN last
 * Exported so display layers (inventory, stocktake) can use the same comparator.
 */
export function compareItems(a, b) {
  const catCmp = (a.cat || '').localeCompare(b.cat || '', undefined, { sensitivity: 'base' });
  if (catCmp !== 0) return catCmp;
  const na = a.nsn || '';
  const nb = b.nsn || '';
  if (!na && !nb) return 0;
  if (!na) return 1;   // no NSN → last within category
  if (!nb) return -1;
  const aNum = _isNumericNsn(na);
  const bNum = _isNumericNsn(nb);
  if (aNum !== bNum) return aNum ? -1 : 1;   // numeric before alpha-inclusive
  return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
}

export const items = {
  async list({ category, search } = {}) {
    let rows = await _all(STORES.ITEMS);
    if (category) rows = rows.filter(i => i.cat === category);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(i =>
        (i.name  || '').toLowerCase().includes(q)
        || (i.nsn  || '').toLowerCase().includes(q)
        || (i.cat  || '').toLowerCase().includes(q)
        || (i.loc  || '').toLowerCase().includes(q)
        || (i.notes || '').toLowerCase().includes(q));
    }
    rows.sort(compareItems);
    return rows;
  },

  async get(id) {
    const tx = _db.transaction(STORES.ITEMS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.ITEMS).get(id))) || null;
  },

  async put(item) {
    requireEdit();
    if (!item?.id) throw new Error('Item.id required');
    const tx = _db.transaction(STORES.ITEMS, 'readwrite');
    tx.objectStore(STORES.ITEMS).put(item);
    await _txDone(tx);
  },

  /** Remove an item and any associated photo. */
  async delete(id) {
    requireEdit();
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
// Cadets / Personnel  (PII-encrypted: surname, given, email, notes)
// -----------------------------------------------------------------------------

/**
 * Cadets — LEGACY READ-ONLY.
 *
 * This build does not collect cadet records. The Cadets page is gone and put()
 * refuses new writes: HQ's position (17 July 2026) is conditional on the tool
 * not carrying PII, and a build that can still create a cadet record is a build
 * that carries PII the moment someone uses it.
 *
 * The store and its existing rows REMAIN, deliberately. A unit upgrading from an
 * earlier build has cadet records here, and they are not ours to destroy:
 * extraction to CEA documents comes first, and disposal needs HQ's direction
 * (controls statement §13.1). Issue history may be a Commonwealth record — see
 * DYM S1 Ch2 para 67 and the Archives Act 1983.
 *
 * list()/get() therefore stay, so the data is reachable for that extraction.
 * exportAll() still includes the store for the same reason: dropping it would
 * mean a backup-and-restore cycle silently destroyed the very records we are
 * required to extract before disposing of. Destruction by omission is still
 * destruction.
 *
 * A fresh install has no rows here and carries no PII. An upgraded one carries
 * legacy data pending disposal, and that is exactly why the direction at §13.1
 * is being sought.
 */
export const cadets = {
  async list() {
    const rows = await _all(STORES.CADETS);
    return PII.decryptAll(rows, PII.PII_FIELDS_CADETS);
  },

  async get(svcNo) {
    const tx  = _db.transaction(STORES.CADETS, 'readonly');
    const row = (await _reqDone(tx.objectStore(STORES.CADETS).get(svcNo))) || null;
    return row ? PII.decryptRecord(row, PII.PII_FIELDS_CADETS) : null;
  },

  /**
   * REFUSES ALL WRITES. This build does not collect cadet records.
   *
   * Fails closed rather than being deleted outright so that any caller still
   * trying to create one is found by a test, loudly, instead of silently
   * repopulating an identifier-free database. That is not hypothetical: the v1
   * import did exactly this to the loans store, and only the equivalent guard
   * on loans.put() caught it.
   */
  async put(_cadet) {
    throw new Error(
      'This build does not store cadet records. Items are issued to a location '
      + 'or an issue-document number — see docs/IDENTIFIER-FREE-DESIGN.md.'
    );
  },

  async _legacyPutDisabled(cadet) {
    requireEdit();
    if (!cadet?.svcNo) throw new Error('Cadet.svcNo required');
    const enc = await PII.encryptRecord(cadet, PII.PII_FIELDS_CADETS);
    const tx  = _db.transaction(STORES.CADETS, 'readwrite');
    tx.objectStore(STORES.CADETS).put(enc);
    await _txDone(tx);
  },

  async delete(svcNo) {
    requireEdit();
    const tx = _db.transaction(STORES.CADETS, 'readwrite');
    tx.objectStore(STORES.CADETS).delete(svcNo);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Loans
// -----------------------------------------------------------------------------
// This build carries NO person identifiers. A loan records that an item is out
// and, where it went to a person, only:
//
//   location: 'individual'   — that it is with a person, not which person
//   issueNo:  'ISS-0042'     — a reference to the document that says which
//
// The document is printed with identifier fields blank, completed by hand, and
// uploaded to the individual's CEA documents. CEA holds the person↔equipment
// link; this tool never does. Authority: HQ AAC ICT, 17 July 2026 — "so long as
// you're not carrying PII and it's purely for asset tracking, I'd see no issue".
//
// `remarks` is no longer PII-encrypted because it is no longer permitted to
// contain a person. See PII_FIELDS_LOANS in pii.js.

export const loans = {
  async list() {
    const rows = await _all(STORES.LOANS);
    return PII.decryptAll(rows, PII.PII_FIELDS_LOANS);
  },

  async listActive() {
    const all = await this.list();
    return all.filter(l => l.active);
  },

  /**
   * Loans against an issue document reference. Replaces listForCadet(svcNo):
   * this build has no cadet records to look up, and the issue number is the
   * only handle onto "what went out on that document".
   */
  async listForIssue(issueNo) {
    const tx   = _db.transaction(STORES.LOANS, 'readonly');
    const idx  = tx.objectStore(STORES.LOANS).index('issueNo');
    const rows = await _reqDone(idx.getAll(issueNo));
    return PII.decryptAll(rows, PII.PII_FIELDS_LOANS);
  },

  async get(ref) {
    const tx  = _db.transaction(STORES.LOANS, 'readonly');
    const row = (await _reqDone(tx.objectStore(STORES.LOANS).get(ref))) || null;
    return row ? PII.decryptRecord(row, PII.PII_FIELDS_LOANS) : null;
  },

  async put(loan) {
    requireEdit();
    if (!loan?.ref) throw new Error('Loan.ref required');
    // Fail closed. HQ's position is conditional on this build carrying no PII,
    // so a loan reaching storage with a person on it is a compliance breach and
    // not something to silently accept and encrypt. Throwing here means any
    // caller still passing a borrower is found by a test rather than by an
    // assessor. Legacy rows already in the database are stripped by migration,
    // not by this path.
    if (loan.borrowerName || loan.borrowerSvc) {
      throw new Error(
        'Loan carries a person identifier (borrowerName/borrowerSvc). This build '
        + 'records location + issueNo only — see docs/IDENTIFIER-FREE-DESIGN.md.'
      );
    }
    const enc = await PII.encryptRecord(loan, PII.PII_FIELDS_LOANS);
    const tx  = _db.transaction(STORES.LOANS, 'readwrite');
    tx.objectStore(STORES.LOANS).put(enc);
    await _txDone(tx);
  },

  async remove(ref) {
    if (!ref) throw new Error('Loan.ref required');
    const tx = _db.transaction(STORES.LOANS, 'readwrite');
    tx.objectStore(STORES.LOANS).delete(ref);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Users  (PII-encrypted: name, svcNo; username left plain — login credential)
// -----------------------------------------------------------------------------

export const users = {
  async list() {
    const rows = await _all(STORES.USERS);
    return PII.decryptAll(rows, PII.PII_FIELDS_USERS);
  },

  async get(id) {
    const tx  = _db.transaction(STORES.USERS, 'readonly');
    const row = (await _reqDone(tx.objectStore(STORES.USERS).get(id))) || null;
    return row ? PII.decryptRecord(row, PII.PII_FIELDS_USERS) : null;
  },

  async getByUsername(username) {
    const tx  = _db.transaction(STORES.USERS, 'readonly');
    const idx = tx.objectStore(STORES.USERS).index('username');
    const row = (await _reqDone(idx.get(username))) || null;
    return row ? PII.decryptRecord(row, PII.PII_FIELDS_USERS) : null;
  },

  async put(user) {
    requireEdit();
    if (!user?.id) throw new Error('User.id required');
    const enc = await PII.encryptRecord(user, PII.PII_FIELDS_USERS);
    const tx  = _db.transaction(STORES.USERS, 'readwrite');
    tx.objectStore(STORES.USERS).put(enc);
    await _txDone(tx);
  },

  async delete(id) {
    requireEdit();
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
// Staff  (PII-encrypted: surname, given, email, notes)
// -----------------------------------------------------------------------------

export const staff = {
  async list() {
    const rows = await _all(STORES.STAFF);
    return PII.decryptAll(rows, PII.PII_FIELDS_STAFF);
  },

  async get(svcNo) {
    const tx  = _db.transaction(STORES.STAFF, 'readonly');
    const row = (await _reqDone(tx.objectStore(STORES.STAFF).get(svcNo))) || null;
    return row ? PII.decryptRecord(row, PII.PII_FIELDS_STAFF) : null;
  },

  async put(member) {
    requireEdit();
    if (!member?.svcNo) throw new Error('Staff.svcNo required');
    const enc = await PII.encryptRecord(member, PII.PII_FIELDS_STAFF);
    const tx  = _db.transaction(STORES.STAFF, 'readwrite');
    tx.objectStore(STORES.STAFF).put(enc);
    await _txDone(tx);
  },

  async delete(svcNo) {
    requireEdit();
    const tx = _db.transaction(STORES.STAFF, 'readwrite');
    tx.objectStore(STORES.STAFF).delete(svcNo);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Pending requests (AB189 etc.)
// -----------------------------------------------------------------------------

/**
 * Equipment requests — LEGACY READ-ONLY. Same treatment as `cadets`.
 *
 * The Requests page is gone: a request is inherently "this person wants this
 * item", and the records carried requestorName/requestorRank/requestorSvc. Worse
 * than the cadet store did — pii.js declares PII_FIELDS_REQUESTS but the storage
 * layer never applied it, so those fields were held in PLAIN TEXT. That is the
 * defect disclosed at §8.3 of the controls statement; removing the module
 * removes it.
 *
 * Requests are now paper: print a blank AB189 from the Loans page, the member
 * completes it by hand, and the form is filed to their CEA documents.
 *
 * put() refuses. The store, its rows, list()/listByStatus() and its place in
 * exportAll() all REMAIN — those legacy rows contain plaintext PII that must be
 * extracted to CEA and disposed of per HQ direction (§13.1), and they cannot be
 * extracted if we have already dropped them.
 */
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

  /**
   * REFUSES ALL WRITES. This build does not store equipment requests — they are
   * paper (blank AB189 from the Loans page, completed by hand, filed to CEA).
   *
   * Fails closed rather than being deleted so a caller still trying is found by
   * a test, not by silently writing plaintext requestor details into a build
   * whose authority rests on carrying no PII.
   */
  async put(_req) {
    throw new Error(
      'This build does not store equipment requests. Print a blank AB189 from '
      + 'the Loans page — see docs/IDENTIFIER-FREE-DESIGN.md.'
    );
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

  async set(itemId, counted, opts = {}) {
    // opts: { countedBy, condition, notes }
    // condition + notes are per-row stocktake overrides applied at finalise.
    // Each call overwrites the previous record for the item, so the latest
    // entered value is what finalisation sees.
    const tx = _db.transaction(STORES.STOCKTAKE, 'readwrite');
    tx.objectStore(STORES.STOCKTAKE).put({
      itemId,
      counted,
      condition: opts.condition || null,
      notes:     opts.notes || '',
      countedBy: opts.countedBy || null,
      countedAt: new Date().toISOString(),
    });
    await _txDone(tx);
  },

  async remove(itemId) {
    const tx = _db.transaction(STORES.STOCKTAKE, 'readwrite');
    tx.objectStore(STORES.STOCKTAKE).delete(itemId);
    await _txDone(tx);
  },

  async clear() {
    const tx = _db.transaction(STORES.STOCKTAKE, 'readwrite');
    tx.objectStore(STORES.STOCKTAKE).clear();
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Issue Kits (named item templates for batch issue)
// -----------------------------------------------------------------------------
//
// Kit schema:
//   id          string  PK ('kit-<uuid>')
//   name        string  Display name, e.g. "Initial Issue — Male Cadet"
//   description string  Optional one-liner
//   lines       Array   [{ itemId, qty }] — ids only; names resolved at use-time
//   createdAt   string  ISO timestamp
//   updatedAt   string  ISO timestamp

export const kits = {
  list: () => _all(STORES.KITS),

  async get(id) {
    const tx = _db.transaction(STORES.KITS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.KITS).get(id))) || null;
  },

  async put(kit) {
    if (!kit?.id) throw new Error('Kit.id required');
    const tx = _db.transaction(STORES.KITS, 'readwrite');
    tx.objectStore(STORES.KITS).put(kit);
    await _txDone(tx);
  },

  async delete(id) {
    const tx = _db.transaction(STORES.KITS, 'readwrite');
    tx.objectStore(STORES.KITS).delete(id);
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Supply Orders (AAC QStore import tracking)
// -----------------------------------------------------------------------------
//
// Order schema:
//   id             string  PK ('order-<uuid>')
//   orderId        string  AAC order number, e.g. "21922"
//   orderCategory  string  "uniform" | "equipment" | "general"
//   docType        string  "request" | "issue"
//   orderStatus    string  Raw status string from PDF
//   status         string  "pending" | "approved" | "received"
//   date           string  ISO date "2026-04-05"
//   dateRaw        string  Human-readable date from PDF
//   requestorName  string
//   requestorRank  string
//   requestorSvcNo string
//   unit           string
//   items          Array   [{ nsn, description, qtyRequired, qtyRequisitioned, qtyReceived }]
//   importedAt     string  ISO timestamp of when QM imported the PDF
//   approvedAt     string  ISO timestamp if approved
//   approvedBy     string  User who approved
//   notes          string  Optional QM notes

export const orders = {
  list: () => _all(STORES.SUPPLY_ORDERS),

  async listByDocType(docType) {
    const tx = _db.transaction(STORES.SUPPLY_ORDERS, 'readonly');
    const idx = tx.objectStore(STORES.SUPPLY_ORDERS).index('docType');
    return _reqDone(idx.getAll(docType));
  },

  async get(id) {
    const tx = _db.transaction(STORES.SUPPLY_ORDERS, 'readonly');
    return (await _reqDone(tx.objectStore(STORES.SUPPLY_ORDERS).get(id))) || null;
  },

  async put(order) {
    if (!order?.id) throw new Error('Order.id required');
    const tx = _db.transaction(STORES.SUPPLY_ORDERS, 'readwrite');
    tx.objectStore(STORES.SUPPLY_ORDERS).put(order);
    await _txDone(tx);
  },

  async delete(id) {
    const tx = _db.transaction(STORES.SUPPLY_ORDERS, 'readwrite');
    tx.objectStore(STORES.SUPPLY_ORDERS).delete(id);
    await _txDone(tx);
  },

  async count() {
    const tx = _db.transaction(STORES.SUPPLY_ORDERS, 'readonly');
    return _reqDone(tx.objectStore(STORES.SUPPLY_ORDERS).count());
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
// Atomic multi-store writes — issue, return, and stocktake use IDB transactions
// to prevent partial-write corruption on crash between paired writes.
// PII encryption happens before the transaction opens (async crypto, not IDB).
// -----------------------------------------------------------------------------

export const atomic = {
  /**
   * Issue a loan and update item onLoan in one IDB transaction.
   * @param {object} loan - plaintext loan record (ref required)
   * @param {object} updatedItem - item with onLoan already incremented (id required)
   */
  async issue(loan, updatedItem) {
    if (!loan?.ref)        throw new Error('Loan.ref required');
    if (!updatedItem?.id)  throw new Error('Item.id required');
    const encLoan = await PII.encryptRecord(loan, PII.PII_FIELDS_LOANS);
    const tx = _db.transaction([STORES.ITEMS, STORES.LOANS], 'readwrite');
    tx.objectStore(STORES.ITEMS).put(updatedItem);
    tx.objectStore(STORES.LOANS).put(encLoan);
    await _txDone(tx);
  },

  /**
   * Mark a loan returned and update the item in one IDB transaction.
   * @param {object} loan - plaintext loan record (ref required, active=false)
   * @param {object} updatedItem - item with onHand/onLoan already updated (id required)
   */
  async return(loan, updatedItem) {
    if (!loan?.ref)        throw new Error('Loan.ref required');
    if (!updatedItem?.id)  throw new Error('Item.id required');
    const encLoan = await PII.encryptRecord(loan, PII.PII_FIELDS_LOANS);
    const tx = _db.transaction([STORES.ITEMS, STORES.LOANS], 'readwrite');
    tx.objectStore(STORES.ITEMS).put(updatedItem);
    tx.objectStore(STORES.LOANS).put(encLoan);
    await _txDone(tx);
  },

  /**
   * Finalise a stocktake: write all updated items and clear the stocktake
   * draft store in one IDB transaction.
   * @param {object[]} itemUpdates - array of updated item records (id required each)
   */
  async stocktakeFinalise(itemUpdates) {
    if (!Array.isArray(itemUpdates)) throw new Error('itemUpdates must be an array');
    const tx = _db.transaction([STORES.ITEMS, STORES.STOCKTAKE], 'readwrite');
    const itemsStore     = tx.objectStore(STORES.ITEMS);
    const stocktakeStore = tx.objectStore(STORES.STOCKTAKE);
    for (const item of itemUpdates) {
      if (!item?.id) throw new Error('Each item update must have an id');
      itemsStore.put(item);
    }
    stocktakeStore.clear();
    await _txDone(tx);
  },
};

// -----------------------------------------------------------------------------
// Maintenance: export, import, wipe
// -----------------------------------------------------------------------------

// =============================================================================
// Key rotation
// =============================================================================
// Needed because exportAll() shipped META — and therefore piiKey and auditKey —
// inside every snapshot pushed to OneDrive. Any blob written by a pre-fix build
// carries the keys that decrypt it. Sealing future pushes (see backup-crypto.js)
// stops the bleeding but does NOT help data already protected by a leaked key:
// turning encryption on merely seals the same burnt keys inside a new envelope.
// Rotation is what actually retires them.
//
// WHAT ROTATION CAN AND CANNOT DO — read this before writing anything about it.
//
//   piiKey: rotation genuinely restores confidentiality going forward. Records
//   are decrypted under the old key and re-encrypted under a fresh one, so the
//   leaked key no longer opens anything in this database.
//
//   auditKey: rotation CANNOT restore the integrity guarantee for entries that
//   already exist. The chain is HMAC(auditKey, ...). Once the key leaked, every
//   pre-rotation entry became forgeable, and no local operation undoes that.
//   Re-signing the chain under a new key is precisely what a forger would do —
//   it makes verify() pass again, it does not make the old entries trustworthy.
//   We re-sign so the app keeps working, and we write a permanent marker entry
//   recording the boundary honestly. Only entries AFTER the marker carry a
//   meaningful integrity guarantee.
//
// Neither operation touches the cloud copy. The old blob must be deleted from
// OneDrive, INCLUDING VERSION HISTORY, or the leaked keys remain retrievable.
//
// Stores carrying encrypted PII in v2: cadets, loans, users, staff.
// (pii.js also defines field lists for requests/orders/stocktake, but v2's
// storage layer never applies them — those stores hold plaintext PII. Out of
// scope here; tracked separately.)

const _PII_STORES = [
  { store: STORES.CADETS, fields: PII.PII_FIELDS_CADETS },
  { store: STORES.LOANS,  fields: PII.PII_FIELDS_LOANS  },
  { store: STORES.USERS,  fields: PII.PII_FIELDS_USERS  },
  { store: STORES.STAFF,  fields: PII.PII_FIELDS_STAFF  },
];

/**
 * Rotate piiKey and auditKey, re-encrypting all PII and re-signing the audit
 * chain under the new keys.
 *
 * Everything is computed in memory first and committed in a SINGLE multi-store
 * transaction, because the crypto awaits cannot live inside an IDB transaction
 * (same constraint the audit append path works around). A failure before the
 * commit leaves the database completely untouched.
 *
 * After rotation, other devices must Load from cloud to pick up the new keys —
 * their local copies are still encrypted under the old piiKey.
 *
 * @param {object}  opts
 * @param {string} [opts.reason]  Recorded in the marker entry.
 * @returns {Promise<{records:number, auditEntries:number}>}
 */
export async function rotateKeys({ reason } = {}) {
  if (!_db) throw new Error('Storage not initialised.');
  if (!PII.isReady()) throw new Error('PII key not loaded — cannot rotate.');

  // --- 1. Read and decrypt every PII record under the CURRENT key -----------
  const decrypted = [];
  for (const { store, fields } of _PII_STORES) {
    const rows = await _all(store);
    decrypted.push({ store, fields, rows: await PII.decryptAll(rows, fields) });
  }

  // --- 2. Read the audit chain in sequence order ---------------------------
  const auditRows = await _all(STORES.AUDIT);
  auditRows.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  // --- 3. Generate the new keys -------------------------------------------
  const newPiiB64   = _bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
  const newAuditB64 = _bytesToB64(crypto.getRandomValues(new Uint8Array(32)));

  // --- 4. Re-encrypt PII under the new key --------------------------------
  // PII.init swaps the module's key. From here the OLD key is gone from memory,
  // so step 1 must already be complete.
  await PII.init(newPiiB64);
  const reEncrypted = [];
  for (const { store, fields, rows } of decrypted) {
    const out = [];
    for (const row of rows) out.push(await PII.encryptRecord(row, fields));
    reEncrypted.push({ store, rows: out });
  }

  // --- 5. Re-sign the audit chain under the new auditKey -------------------
  // Recomputing a hash changes the next entry's prevHash, so walk in order and
  // rebuild both links as we go.
  const newAuditKey = await crypto.subtle.importKey(
    'raw', _b64ToBytes(newAuditB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const resigned = [];
  let prev = ZERO_HASH;
  for (const row of auditRows) {
    const payload = JSON.stringify([prev, row.ts, row.action, row.user || '', row.desc || '']);
    const sig  = await crypto.subtle.sign('HMAC', newAuditKey, new TextEncoder().encode(payload));
    const hash = _bytesToHex(new Uint8Array(sig));
    resigned.push({ ...row, prevHash: prev, hash });
    prev = hash;
  }

  // --- 6. Build the marker entry, signed under the new key ------------------
  const markerTs   = new Date().toISOString();
  const markerDesc = 'Encryption keys rotated'
    + (reason ? ` (${reason})` : '')
    + '. Entries before this point were re-signed with the new audit key and '
    + 'their integrity is NOT cryptographically assured — the previous key was '
    + 'exposed. Only entries after this marker carry a verifiable guarantee.';
  const markerPayload = JSON.stringify([prev, markerTs, 'keys_rotated', 'system', markerDesc]);
  const markerSig  = await crypto.subtle.sign('HMAC', newAuditKey, new TextEncoder().encode(markerPayload));
  const marker = {
    ts: markerTs,
    action: 'keys_rotated',
    user: 'system',
    desc: markerDesc,
    prevHash: prev,
    hash: _bytesToHex(new Uint8Array(markerSig)),
  };

  // --- 7. Commit atomically ------------------------------------------------
  const storeNames = [STORES.META, STORES.AUDIT, ..._PII_STORES.map((s) => s.store)];
  const tx = _db.transaction(storeNames, 'readwrite');
  tx.objectStore(STORES.META).put({ key: 'piiKey',   value: newPiiB64 });
  tx.objectStore(STORES.META).put({ key: 'auditKey', value: newAuditB64 });
  for (const { store, rows } of reEncrypted) {
    const os = tx.objectStore(store);
    for (const row of rows) os.put(row);
  }
  const auditOs = tx.objectStore(STORES.AUDIT);
  for (const row of resigned) auditOs.put(row);
  auditOs.add(marker);
  await _txDone(tx);

  // --- 8. Adopt the new audit key for subsequent appends -------------------
  _auditKey = await _loadAuditKey();

  return {
    records: reEncrypted.reduce((n, r) => n + r.rows.length, 0),
    auditEntries: resigned.length,
  };
}

/**
 * Dump the entire database to a plain JS object suitable for JSON
 * serialisation. Photos are encoded as base64 so the result round-trips
 * through JSON. Use for backups, handover, and the Settings → Export flow.
 *
 * EVERY store must be listed here. The `staff` store was added in schema v4 and
 * was not — so for the whole life of v4 the export silently omitted the unit's
 * entire staff establishment, importAll() had nothing to restore, and a unit
 * that restored a backup found the Staff page empty with no error anywhere. The
 * docstring above said "the entire database" throughout.
 *
 * A missing store here is invisible: the export succeeds, the file looks right,
 * and the loss only appears on the restore, on someone else's machine, possibly
 * months later. When adding a store to _runSchemaMigrations, add it here, in
 * importAll(), and in wipe() in the same commit. test-export-import.mjs now
 * asserts this list covers STORES so the next one fails a test instead.
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
    staff:           await _all(STORES.STAFF),
    loans:           await _all(STORES.LOANS),
    audit:           await _all(STORES.AUDIT),
    users:           await _all(STORES.USERS),
    pendingRequests: await _all(STORES.REQUESTS),
    stocktakeCounts: await _all(STORES.STOCKTAKE),
    kits:            await _all(STORES.KITS),
    supplyOrders:    await _all(STORES.SUPPLY_ORDERS),
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
/**
 * Restore from a snapshot.
 *
 * ⚠ THIS PATH BYPASSES THE PERSON GUARDS, AND THAT IS DELIBERATE.
 *
 * It writes rows straight to the object stores rather than through
 * cadets.put()/loans.put(), so the fail-closed guards never fire here. A legacy
 * backup therefore restores its cadet records, its loans carrying
 * borrowerName/borrowerSvc, and its requests with plaintext requestor details.
 *
 * The alternative — silently dropping them — is worse. The legacy stores exist
 * precisely so legacy data can be EXTRACTED to CEA before disposal (§13.1). A
 * restore that discarded them would leave a unit unable to extract the very
 * records they are required to extract, readable only by the old build, which is
 * the build with the key-exposure defect.
 *
 * So the data comes in, lands in the legacy stores, is invisible to the UI (the
 * Cadets and Requests pages are gone), and is disposed of on HQ's direction.
 * What must NOT happen is it arriving silently — hence the returned report and
 * the audit entry. The caller is responsible for telling the operator.
 *
 * @returns {Promise<{legacyPersonData: {cadets:number, loans:number, requests:number, total:number}}>}
 */
export async function importAll(snapshot) {
  if (!snapshot || !snapshot.schemaVersion) {
    throw new Error('Not a valid QStore backup (missing schemaVersion).');
  }
  if (snapshot.schemaVersion > DB_VERSION) {
    throw new Error('Backup is from a newer version of QStore (v' + snapshot.schemaVersion
      + '). Update the app before restoring.');
  }
  await wipe({ keepMeta: true });

  const stores = [
    STORES.META, STORES.SETTINGS, STORES.COUNTERS, STORES.ITEMS, STORES.CADETS,
    STORES.STAFF, STORES.LOANS, STORES.AUDIT, STORES.USERS, STORES.REQUESTS,
    STORES.STOCKTAKE, STORES.PHOTOS, STORES.KITS, STORES.SUPPLY_ORDERS,
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
  // Absent from every backup written before this fix — `snapshot.staff` will be
  // undefined for those, which put() treats as an empty list. Such a backup
  // carries no staff to restore and none can be recovered from it; the adults it
  // does still carry are the ones an older build left in `cadets`, and
  // _reclassifyStrandedStaff() below is what rescues those.
  put(STORES.STAFF,     snapshot.staff);
  put(STORES.LOANS,     snapshot.loans);
  put(STORES.AUDIT,     snapshot.audit);
  put(STORES.USERS,     snapshot.users);
  put(STORES.REQUESTS,  snapshot.pendingRequests);
  put(STORES.STOCKTAKE,     snapshot.stocktakeCounts);
  put(STORES.KITS,          snapshot.kits);
  put(STORES.SUPPLY_ORDERS, snapshot.supplyOrders);

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

  // An old backup stores adults in `cadets` and marks them by rank alone. Move
  // them before anything counts, displays, or purges them as cadet records.
  const reclassified = await _reclassifyStrandedStaff();

  // Count what arrived carrying a person, so the caller can say so. A loan is
  // "legacy" if it names a borrower; a modern loan carries location/issueNo and
  // nobody's name.
  //
  // Counted from the CADETS store, not from snapshot.cadets — after
  // reclassification those differ, and the number the operator is shown must be
  // the number of records actually facing extraction and disposal. Counting the
  // snapshot would name adults as cadets in the audit entry and overstate the
  // extraction backlog by exactly the records that no longer need it.
  const legacyPersonData = {
    cadets:   (await _all(STORES.CADETS)).length,
    loans:    (snapshot.loans || []).filter((l) => l && (l.borrowerName || l.borrowerSvc)).length,
    requests: (snapshot.pendingRequests || []).length,
    staffReclassified: reclassified,
  };
  legacyPersonData.total = legacyPersonData.cadets + legacyPersonData.loans + legacyPersonData.requests;

  if (legacyPersonData.total > 0) {
    const parts = [];
    if (legacyPersonData.cadets)   parts.push(`${legacyPersonData.cadets} cadet record(s)`);
    if (legacyPersonData.loans)    parts.push(`${legacyPersonData.loans} loan(s) naming a borrower`);
    if (legacyPersonData.requests) parts.push(`${legacyPersonData.requests} equipment request(s)`);
    try {
      await audit.append({
        action: 'legacy_pii_imported',
        user:   'system',
        desc:   `Restored backup contained personal information: ${parts.join(', ')}. `
              + 'This build does not display or collect it. Extract these records to the '
              + "members' CEA documents and dispose of them on HQ direction — do not leave "
              + 'them here.',
      });
    } catch (_) { /* never block a restore on the audit write */ }
  }
  return { legacyPersonData };
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
    STORES.CADETS, STORES.STAFF, STORES.LOANS, STORES.AUDIT, STORES.REQUESTS,
    STORES.STOCKTAKE, STORES.KITS, STORES.SUPPLY_ORDERS,
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

// =============================================================================
// Legacy person data — extraction and disposal
// =============================================================================
// The exit path for units upgrading from a build that stored cadets.
//
// HQ AAC ICT, 16 July 2026: "The local copy of the nominal roll should be
// disposed off once the data is entered in CEA" … "Once there is no enduring
// need to retain the data on local devices, it should be removed" … "produce PDF
// based exports of your respective cadet Q records, and upload them to the
// individual members CEA documents".
//
// So: extract to CEA, then remove. In that order, and never the reverse.
//
// The two halves are deliberately SEPARATE functions. Extraction is safe and
// repeatable. Disposal destroys Commonwealth records — DYM S1 Ch2 para 67
// carries criminal penalties under the Archives Act 1983 for getting it wrong.
// Nothing here should make it easy to do the second without the first.

export const legacy = {
  /**
   * Every legacy borrower found ON THE LOANS, with their loans.
   *
   * ★ Previously this walked the CADETS store and matched loans to it, which
   * deadlocked the whole flow: summary() counts every loan carrying a borrower,
   * but only cadet-matched loans were ever offered for export. Anything else was
   * counted forever and never exportable, so purge() refused permanently. A unit
   * could export every record it was shown and still be told records remained.
   *
   * Three kinds were invisible:
   *   - UNIT-LOAN — the old unit/activity loans. borrowerSvc is the literal
   *     'UNIT-LOAN' and borrowerName is an ACTIVITY, not a person.
   *   - staff loans — staff live in their own store, never in `cadets`.
   *   - phantom borrowers — a borrowerSvc with no matching record. Not
   *     hypothetical: this repo has a commit titled "detect and remove phantom
   *     borrowers from loan records". That feature was deleted in step 2; the
   *     data it existed for was not.
   *
   * So group on the LOANS, which is where the truth is, and resolve the member
   * from cadets → staff → the loan's own denormalised borrowerName. That last
   * fallback matters: borrowerName is enough to produce a Q record even when the
   * person record is long gone, which is precisely the phantom case.
   */
  async list() {
    const loans = await _all(STORES.LOANS);
    const withBorrower = loans.filter((l) => l.borrowerName || l.borrowerSvc);
    if (withBorrower.length === 0) return [];

    const cadets = await PII.decryptAll(await _all(STORES.CADETS), PII.PII_FIELDS_CADETS);
    const staff  = await PII.decryptAll(await _all(STORES.STAFF),  PII.PII_FIELDS_STAFF);
    const bySvc  = new Map();
    for (const c of cadets) bySvc.set(c.svcNo, c);
    for (const st of staff) if (!bySvc.has(st.svcNo)) bySvc.set(st.svcNo, st);

    const groups = new Map();
    for (const l of withBorrower) {
      const key = l.borrowerSvc || `name:${l.borrowerName}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    const out = [];
    for (const [key, ls] of groups) {
      // Activity loans are not a person. No Q record, no PDF — they convert to
      // a destination, which is what they always were.
      if (key === 'UNIT-LOAN') {
        out.push({ kind: 'activity', member: null, activity: ls[0].borrowerName || 'Unit / activity', loans: ls });
        continue;
      }
      const rec = bySvc.get(key);
      out.push({
        kind:   'person',
        member: rec || {
          // Synthesised from the loan. A phantom borrower still held equipment,
          // and their Q record still has to reach CEA.
          svcNo:   ls[0].borrowerSvc || '',
          surname: ls[0].borrowerName || 'Unknown',
          given:   '', rank: '', _synthesised: !rec,
        },
        loans: ls,
      });
    }
    return out;
  },

  /**
   * Convert the old unit/activity loans to destinations. No person involved, so
   * no export and no CEA document — borrowerName was an activity name all along.
   */
  async convertActivityLoans() {
    const rows = await _all(STORES.LOANS);
    const acts = rows.filter((l) => l.borrowerSvc === 'UNIT-LOAN');
    if (acts.length === 0) return { converted: 0 };
    const tx = _db.transaction(STORES.LOANS, 'readwrite');
    const os = tx.objectStore(STORES.LOANS);
    for (const l of acts) {
      const next = { ...l, location: l.borrowerName || 'Unit / activity', issueNo: '' };
      delete next.borrowerName;
      delete next.borrowerSvc;
      os.put(next);
    }
    await _txDone(tx);
    return { converted: acts.length };
  },

  /** Counts for the UI, without decrypting anything. */
  async summary() {
    const cadets = await _all(STORES.CADETS);
    const loans  = await _all(STORES.LOANS);
    const reqs   = await _all(STORES.REQUESTS);
    // Cadet LOGIN accounts. Counted here because they are cadet PII by a
    // different door: PII_FIELDS_USERS is ['name','svcNo','totpSecret'], so an
    // account with role 'cadet' holds a cadet's name and service number in the
    // USERS store, entirely independently of the cadets store. Emptying one
    // never emptied the other. They are refused at login and hidden from the
    // picker — but hidden is not absent, and the build's claim is absence.
    const users  = await _all(STORES.USERS);
    const cadetUsers = users.filter((u) => u.role === 'cadet').length;
    const borrowerLoans = loans.filter((l) => l.borrowerName || l.borrowerSvc).length;
    return {
      cadets:     cadets.length,
      loans:      borrowerLoans,
      requests:   reqs.length,
      cadetUsers,
      total:      cadets.length + borrowerLoans + reqs.length + cadetUsers,
    };
  },

  /**
   * Link a member's loans to the Q record just generated for them.
   *
   * This is what makes extraction a CONVERSION rather than a deletion. The issue
   * number stamped on the PDF is written onto their loans, and the borrower
   * fields are stripped. Afterwards the equipment record says "out to an
   * individual, see ISS-1042" — and ISS-1042 is the document now in CEA.
   *
   * Without this the loans would simply lose their borrower and become
   * untraceable. The link is not destroyed; it is moved to where HQ says it
   * belongs.
   */
  async linkToIssue(svcNo, issueNo, { borrowerName } = {}) {
    if (!issueNo) throw new Error('linkToIssue requires an issueNo.');
    if (!svcNo && !borrowerName) throw new Error('linkToIssue requires svcNo or borrowerName.');
    const rows = await _all(STORES.LOANS);
    // Match on svcNo where there is one; fall back to the denormalised name, so
    // a phantom borrower with no service number is still linkable rather than
    // stranded — stranded is what deadlocked purge().
    const mine = svcNo
      ? rows.filter((l) => l.borrowerSvc === svcNo)
      : rows.filter((l) => !l.borrowerSvc && l.borrowerName === borrowerName);
    if (mine.length === 0) return { linked: 0 };
    const tx = _db.transaction(STORES.LOANS, 'readwrite');
    const os = tx.objectStore(STORES.LOANS);
    for (const l of mine) {
      const next = { ...l, location: 'individual', issueNo };
      delete next.borrowerName;
      delete next.borrowerSvc;
      os.put(next);
    }
    await _txDone(tx);
    return { linked: mine.length };
  },

  /**
   * Remove all remaining legacy person data. IRREVERSIBLE.
   *
   * Refuses if any loan still names a borrower — that means a member has not
   * been extracted, and destroying their record before it reaches CEA is the
   * exact failure the Archives Act penalises. The caller cannot talk it out of
   * this: the check is on the data, not on a flag the UI passes in.
   */
  async purge({ confirmedUploadedToCEA } = {}) {
    if (confirmedUploadedToCEA !== true) {
      throw new Error('purge() requires explicit confirmation that every Q record is in CEA.');
    }
    const loans = await _all(STORES.LOANS);
    const unlinked = loans.filter((l) => l.borrowerName || l.borrowerSvc);
    if (unlinked.length > 0) {
      throw new Error(
        `${unlinked.length} loan(s) still name a borrower — those members have not been `
        + 'extracted. Generate and upload their Q records first. Refusing to destroy '
        + 'records that are not yet in CEA.'
      );
    }
    const cadetCount = (await _all(STORES.CADETS)).length;
    const reqCount   = (await _all(STORES.REQUESTS)).length;
    const cadetUsers = (await _all(STORES.USERS)).filter((u) => u.role === 'cadet');

    const tx = _db.transaction([STORES.CADETS, STORES.REQUESTS, STORES.USERS], 'readwrite');
    tx.objectStore(STORES.CADETS).clear();
    tx.objectStore(STORES.REQUESTS).clear();
    // Cadet login accounts go too. A cadet account is not a Q record and CEA
    // does not want it — it is a credential for a role that no longer exists,
    // carrying a name and service number. Deleting it destroys no record of any
    // transaction: the audit log is that record, and it is untouched.
    const uStore = tx.objectStore(STORES.USERS);
    for (const u of cadetUsers) uStore.delete(u.id);
    await _txDone(tx);

    await audit.append({
      action: 'legacy_pii_purged',
      user:   'system',
      desc:   `Legacy person data removed after extraction to CEA: ${cadetCount} cadet `
            + `record(s), ${reqCount} equipment request(s), ${cadetUsers.length} cadet login `
            + 'account(s). Loans retained as equipment records, linked to their issue '
            + 'documents. The audit log is unchanged — it is the record of what happened '
            + 'and remains verifiable. This action is irreversible.',
    });
    return { cadets: cadetCount, requests: reqCount, cadetUsers: cadetUsers.length };
  },
};
