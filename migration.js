// =============================================================================
// QStore IMS v2 — Migration Shim (v1 localStorage → v2 IndexedDB)
// =============================================================================
// One-way migration. Reads v1's qstore_data and qstore_od_cfg localStorage
// blobs, writes the equivalent records into IndexedDB, and starts a fresh
// HMAC audit chain anchored at a "migration" entry. Historical v1 audit
// entries are preserved verbatim and re-emitted into the new chain, marked
// with imported:true.
//
// USAGE
//   import * as Migration from './migration.js';
//
//   const status = await Migration.check();
//   if (status.needed) {
//       const { blob, suggestedName } = await Migration.exportV1Backup();
//       // — Show user a UI: download the backup, then click "Continue"
//       await Migration.run({
//         onProgress: (msg, pct) => console.log(pct + '% — ' + msg),
//       });
//   }
//
// SAFETY
//   - run() refuses if v2 is already populated (defensive — prevents accidental
//     overwrite if the migration flag failed to write previously).
//   - The v1 localStorage blob is NEVER deleted by this code. Call
//     clearV1Backstop() manually (e.g. via a Settings → Maintenance button)
//     after a recovery window has passed.
//   - Migration runs roughly half a dozen separate transactions. If any one
//     throws, we surface the error and the user can retry. The migration flag
//     is only set on full success, so partial state is recoverable by either
//     fixing the cause and re-running, or by wiping IDB and re-importing the
//     v1 backup file produced by exportV1Backup().
// =============================================================================

import * as Storage from './storage.js';

const V1_DATA_KEY    = 'qstore_data';
const V1_OD_CFG_KEY  = 'qstore_od_cfg';
const V1_INVALIDATED = 'qstore_session_invalidated_at';

const MIGRATION_FLAG = 'migrationFromV1';

/**
 * Inspect storage and report whether migration is needed.
 *
 * Possible results:
 *   { needed: false, reason: 'already_migrated' }
 *   { needed: false, reason: 'no_v1_data' }
 *   { needed: false, reason: 'v1_corrupt', error }
 *   { needed: false, reason: 'v2_populated', hint }
 *   { needed: true,  v1Stats: {...} }
 */
export async function check() {
  await Storage.init();

  const alreadyMigrated = await Storage.meta.get(MIGRATION_FLAG);
  if (alreadyMigrated) return { needed: false, reason: 'already_migrated' };

  const v1Raw = localStorage.getItem(V1_DATA_KEY);
  if (!v1Raw) return { needed: false, reason: 'no_v1_data' };

  let v1;
  try {
    v1 = JSON.parse(v1Raw);
  } catch (e) {
    return { needed: false, reason: 'v1_corrupt', error: e.message };
  }

  // Defensive: refuse to migrate if v2 stores are already populated. This
  // can happen if a prior migration succeeded but the flag write failed,
  // or if someone imported data without clearing the v1 blob first.
  const itemCount  = await Storage.items.count();
  const auditCount = await Storage.audit.count();
  if (itemCount > 0 || auditCount > 0) {
    return {
      needed: false,
      reason: 'v2_populated',
      hint:   'IndexedDB already has data. To force re-migration, wipe the DB '
              + 'and clear the migration flag from the meta store first.',
    };
  }

  return {
    needed: true,
    v1Stats: {
      items:           (v1.items           || []).length,
      cadets:          (v1.cadets          || []).length,
      loans:           (v1.loans           || []).length,
      auditEntries:    (v1.auditLog        || []).length,
      users:           (v1.users           || []).length,
      pendingRequests: (v1.pendingRequests || []).length,
      photoBytes:      _estimatePhotoBytes(v1.items || []),
      rawBytes:        v1Raw.length,
    },
  };
}

/**
 * Build a downloadable backup of the v1 state. Returns { blob, suggestedName }.
 * MUST be called and the resulting file saved BEFORE run(). If the migration
 * fails or produces unexpected results, the user can re-import this into v1
 * (manually, by pasting it back into localStorage) to recover.
 */
export async function exportV1Backup() {
  const v1Raw     = localStorage.getItem(V1_DATA_KEY);
  if (!v1Raw) throw new Error('No v1 data to back up.');
  const v1OdCfg   = localStorage.getItem(V1_OD_CFG_KEY);
  const invalidat = localStorage.getItem(V1_INVALIDATED);

  const bundle = {
    backupVersion: 1,
    backedUpAt:    new Date().toISOString(),
    note:          'Pre-v2-migration backup. Contains v1 localStorage state '
                   + 'verbatim. To restore in v1, paste qstore_data back into '
                   + 'localStorage under that key and reload.',
    v1: {
      qstore_data:                   v1Raw,
      qstore_od_cfg:                 v1OdCfg,
      qstore_session_invalidated_at: invalidat,
    },
  };

  const blob  = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { blob, suggestedName: `qstore_v1_backup_${stamp}.json` };
}

/**
 * Run the migration. Throws if not needed (call check() first). Idempotent
 * only in the sense that you can retry after a failure — but each successful
 * run sets the migration flag, after which subsequent calls throw.
 *
 * @param {object} [opts]
 * @param {(msg: string, pct: number) => void} [opts.onProgress]
 */
export async function run({ onProgress = () => {} } = {}) {
  await Storage.init();

  const status = await check();
  if (!status.needed) {
    throw new Error('Migration not needed: ' + status.reason);
  }

  const v1 = JSON.parse(localStorage.getItem(V1_DATA_KEY));

  onProgress('Importing settings…', 5);
  await _migrateSettings(v1);

  onProgress('Importing OneDrive configuration…', 10);
  await _migrateOneDriveConfig();

  onProgress('Importing inventory items and photos…', 25);
  await _migrateItemsAndPhotos(v1);

  onProgress('Importing personnel register…', 40);
  const cadetStats = await _migrateCadets(v1);

  onProgress('Importing loans…', 55);
  await _migrateLoans(v1);

  onProgress('Importing users…', 65);
  await _migrateUsers(v1);

  onProgress('Importing pending requests…', 75);
  await _migrateRequests(v1);

  onProgress('Importing stocktake counts…', 80);
  await _migrateStocktake(v1);

  onProgress('Restoring loan counter…', 85);
  await Storage.counters.set('loanCounter', v1.loanCounter || 1000);

  onProgress('Re-chaining audit log…', 90);
  await _migrateAuditLog(v1, { cadetStats });

  onProgress('Finalising migration…', 98);
  await Storage.meta.set(MIGRATION_FLAG, {
    completedAt: new Date().toISOString(),
    v1RawBytes:  localStorage.getItem(V1_DATA_KEY).length,
    counts:      status.v1Stats,
  });

  onProgress('Migration complete.', 100);
  return { ok: true, counts: status.v1Stats };
}

// -----------------------------------------------------------------------------
// Per-entity migration
// -----------------------------------------------------------------------------

async function _migrateSettings(v1) {
  const s = v1.settings || {};
  // Flatten v1's nested settings object into the v2 KV settings store.
  // Keys are preserved verbatim.
  await Storage.settings.setMany({
    unitName: s.unitName || '',
    unitCode: s.unitCode || '',
    qmName:   s.qmName   || '',
    qmRank:   s.qmRank   || '',
    coName:   s.coName   || '',
    state:    s.state    || '',
    qmEmail:  s.qmEmail  || '',
    coEmail:  s.coEmail  || '',
  });
}

async function _migrateOneDriveConfig() {
  const raw = localStorage.getItem(V1_OD_CFG_KEY);
  if (!raw) return;
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return; }

  // Map v1 OneDrive keys into a `cloud.*` namespace so v2 can host multiple
  // providers later (cloud.provider = 'onedrive' | 'gdrive' | …).
  await Storage.settings.setMany({
    'cloud.provider': 'onedrive',
    'cloud.clientId': cfg.clientId || '',
    'cloud.folder':   cfg.folder   || 'QStore',
    'cloud.filename': cfg.filename || 'qstore_data.json',
    'cloud.autoSync': cfg.autoSync !== false,
  });
}

async function _migrateItemsAndPhotos(v1) {
  for (const i of v1.items || []) {
    const itemCopy = { ...i };
    delete itemCopy.photoData;        // photo is moving to its own store
    if (i.photoData) itemCopy.hasPhoto = true;

    await Storage.items.put(itemCopy);

    if (i.photoData) {
      try {
        const blob = _dataUrlToBlob(i.photoData);
        await Storage.photos.put(i.id, blob);
      } catch (e) {
        // Don't fail the whole migration on a malformed photo. Drop it,
        // unset hasPhoto, and continue.
        console.warn('Photo migration failed for item', i.id, e);
        itemCopy.hasPhoto = false;
        await Storage.items.put(itemCopy);
      }
    }
  }
}

// =============================================================================
// AAC RANK STRUCTURE (canonical reference)
// =============================================================================
// Source: QM, 1 ACTU, Brisbane.
//
// CADET RANKS (junior → senior):
//   CDTRCT   Recruit
//   CDT      Cadet
//   CDTLCPL  Lance Corporal
//   CDTCPL   Corporal
//   CDTSGT   Sergeant
//   WO2      Warrant Officer Class 2  ← AAC senior cadet, NOT an ADF warrant officer
//   WO1      Warrant Officer Class 1  ← AAC senior cadet, NOT an ADF warrant officer
//   CUO      Cadet Under Officer
//
// STAFF RANKS (Officers of Cadets / non-ranking adult staff):
//   2LT-AAC    2nd Lieutenant
//   LT-AAC     Lieutenant
//   CAPT-AAC   Captain
//   MAJ-AAC    Major
//   LTCOL-AAC  Lieutenant Colonel
//   COL-AAC    Colonel
//   DAH        Defence Approved Helper (non-ranking adult)
//
// The "-AAC" suffix is mandatory for all officer ranks — it differentiates
// AAC staff from regular ADF members holding the same nominal rank. DAH does
// not take the suffix. v1 records sometimes stored bare officer ranks
// without the suffix; migration normalises these to the canonical form.
//
// For v1 records that pre-date the personType field, default to 'cadet' (the
// more common case) and only promote to 'staff' for explicit officer ranks
// or DAH. Civilian instructors and edge cases default to 'cadet' and need
// manual correction in the UI — better to under-classify than over-classify.
//
// FUTURE: this list belongs in a shared src/ranks.js module once AUTH and
// the v1-page refactor need it for form dropdowns and validation.
// =============================================================================

// Officer rank bases (no suffix). Used to detect legacy v1 records that
// need the -AAC suffix added during migration.
const OFFICER_RANK_BASES = new Set([
  '2LT', 'LT', 'CAPT', 'MAJ', 'LTCOL', 'COL',
]);

// Canonical v2 staff rank codes — the only forms allowed going forward.
const STAFF_RANKS_CANONICAL = new Set([
  '2LT-AAC', 'LT-AAC', 'CAPT-AAC', 'MAJ-AAC', 'LTCOL-AAC', 'COL-AAC',
  'DAH',
]);

// All recognised staff rank forms (canonical + legacy bare officer ranks).
// Used for personType classification on input; the rank field itself is
// always rewritten to canonical form by _normalizeRank.
const STAFF_RANKS_RECOGNISED = new Set([
  ...STAFF_RANKS_CANONICAL,
  ...OFFICER_RANK_BASES,
]);

function _normaliseRankInput(rank) {
  return String(rank || '').toUpperCase().replace(/[\s.]/g, '');
}

/**
 * Rewrite a rank to its canonical v2 form. Officer ranks without the -AAC
 * suffix get the suffix added; everything else is returned as the
 * uppercase, whitespace/dot-stripped input.
 *
 *   'CAPT'      → 'CAPT-AAC'
 *   'capt.'     → 'CAPT-AAC'
 *   'CAPT-AAC'  → 'CAPT-AAC'  (idempotent)
 *   'DAH'       → 'DAH'       (no suffix; DAH is non-ranking staff)
 *   'WO2'       → 'WO2'       (cadet rank; no suffix)
 *   'cadet'     → 'CADET'     (unknown — preserved, user fixes manually)
 */
function _normalizeRank(rank) {
  if (!rank) return rank;
  const norm = _normaliseRankInput(rank);
  if (OFFICER_RANK_BASES.has(norm)) return norm + '-AAC';
  return norm;
}

function _inferPersonType(rank) {
  if (!rank) return 'cadet';
  const norm = _normaliseRankInput(rank);
  return STAFF_RANKS_RECOGNISED.has(norm) ? 'staff' : 'cadet';
}

async function _migrateCadets(v1) {
  const stats = {
    inferredStaff:  0,
    inferredCadet:  0,
    explicit:       0,
    rankNormalised: 0,
  };
  for (const c of v1.cadets || []) {
    let personType;
    if (c.personType) {
      personType = c.personType;
      stats.explicit++;
    } else {
      personType = _inferPersonType(c.rank);
      if (personType === 'staff') stats.inferredStaff++; else stats.inferredCadet++;
    }
    const newRank = _normalizeRank(c.rank);
    if (newRank !== c.rank) stats.rankNormalised++;
    await Storage.cadets.put({ ...c, rank: newRank, personType });
  }
  return stats;
}

async function _migrateLoans(v1) {
  for (const l of v1.loans || []) {
    await Storage.loans.put(l);  // shape compatible
  }
}

async function _migrateUsers(v1) {
  for (const u of v1.users || []) {
    const u2 = { ...u };
    // Mark v1 PIN hashes for transparent rehash on next successful login.
    // Old hash kept under legacyPinHash so AUTH can verify against it,
    // then upgrade to argon2id and clear this field.
    if (u.pinHash && !u.pinHashAlgorithm) {
      u2.legacyPinHash    = u.pinHash;
      u2.pinHashAlgorithm = 'legacy-sha';
      delete u2.pinHash;
    }
    await Storage.users.put(u2);
  }
}

async function _migrateRequests(v1) {
  for (const r of v1.pendingRequests || []) {
    await Storage.requests.put(r);  // shape compatible
  }
}

async function _migrateStocktake(v1) {
  const sc = v1.stocktakeCounts || {};
  for (const [itemId, counted] of Object.entries(sc)) {
    await Storage.stocktake.set(itemId, counted, 'migration');
  }
}

async function _migrateAuditLog(v1, notes = {}) {
  // First entry: anchor. Establishes the chain start.
  await Storage.audit.append({
    action: 'migration',
    user:   'system',
    desc:   `Migrated from v1 localStorage. ${(v1.auditLog || []).length} historical entries follow.`,
  });

  // Second: any "we made this change during migration" summaries, so the
  // user has a single chain of provenance for each transformation that
  // wasn't a verbatim copy. These are NOT marked imported — they are real
  // v2-era audit entries describing what the migration tool did.
  const cs = notes.cadetStats;
  if (cs && (cs.inferredStaff || cs.inferredCadet || cs.rankNormalised)) {
    const parts = [];
    if (cs.inferredStaff || cs.inferredCadet) {
      parts.push(`Inferred personType for ${cs.inferredStaff + cs.inferredCadet} `
        + `personnel records: ${cs.inferredStaff} staff, ${cs.inferredCadet} cadet `
        + `(${cs.explicit} already had personType set)`);
    }
    if (cs.rankNormalised) {
      parts.push(`normalised ${cs.rankNormalised} legacy officer rank(s) to canonical -AAC form`);
    }
    parts.push('Review on Personnel page and correct any misclassifications — '
      + 'WO2/WO1 are AAC senior cadet ranks, not ADF warrant officers');
    await Storage.audit.append({
      action: 'migration',
      user:   'system',
      desc:   parts.join('. ') + '.',
    });
  }

  // Then re-emit each v1 entry into the chain. Their original ts is preserved
  // as the canonical timestamp; the chain hash includes that ts so the
  // sequence is internally consistent. Each entry is flagged imported:true
  // so the UI can render them with a "(historical)" marker.
  for (const e of v1.auditLog || []) {
    await Storage.audit.append({
      action:        e.action || 'unknown',
      user:          e.user   || '',
      desc:          e.desc   || '',
      ts:            e.ts     || new Date().toISOString(),
      imported:      true,
    });
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function _dataUrlToBlob(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('Not a base64 data URL');
  const contentType = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

function _estimatePhotoBytes(items) {
  // base64 expands ~33% — multiply by 0.75 to estimate decoded bytes. Used
  // to give the user a rough idea of how big the migration will be.
  let total = 0;
  for (const i of items) {
    if (i.photoData) total += Math.round(i.photoData.length * 0.75);
  }
  return total;
}

/**
 * Remove the v1 localStorage backstop after migration. Refuses unless
 * migration is recorded as complete AND the audit chain still verifies.
 *
 * Recommended UX: don't expose this for at least 30 days post-migration.
 * Once exposed, behind a "I've verified the v2 data is correct" confirm.
 */
export async function clearV1Backstop() {
  const flag = await Storage.meta.get(MIGRATION_FLAG);
  if (!flag) throw new Error('Refuse: no migration completion marker found.');

  const v = await Storage.audit.verify();
  if (!v.ok) {
    throw new Error('Refuse: audit chain broken at seq ' + v.brokenAt
      + ' (' + v.reason + ') — investigate before clearing the v1 backstop.');
  }

  localStorage.removeItem(V1_DATA_KEY);
  localStorage.removeItem(V1_OD_CFG_KEY);
  localStorage.removeItem(V1_INVALIDATED);
}
