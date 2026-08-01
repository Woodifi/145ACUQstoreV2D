// =============================================================================
// QStore IMS v2 — Device identity
// =============================================================================
// This build has no central store. Each install is a full, independent replica,
// and a unit may run several — the Q-Store terminal, a laptop taken to the
// store room, a tablet used on a stocktake. Those replicas have to be able to
// exchange data later without silently destroying each other's records.
//
// Nothing here merges anything. This module supplies the three things a merge
// needs to exist at all, and which the database did not previously have:
//
//   1. A STABLE IDENTITY PER INSTALL.  installId has existed since v2.0 but was
//      documented as "informational only" and was overwritten by restore — the
//      receiving device adopted the sending device's identity, so after two
//      restores three machines could claim to be the same one. It is now
//      preserved across import (see storage.importAll) and surfaced in
//      Settings, because an operator reconciling two devices has to be able to
//      tell them apart.
//
//   2. GLOBALLY UNIQUE RECORD KEYS.  Loan refs and issue numbers came from a
//      local counter starting at 1000. Two devices each issuing their first
//      loan both minted LN-1000, for different issues. Loans are keyed by ref,
//      so a merge would collapse two distinct issues into one: one record
//      vanishes and the stock figure is wrong, with nothing shown to the
//      operator. Refs now carry a device token — LN-K7M2-1000 — so records
//      minted on different devices cannot collide.
//
//   3. PER-RECORD PROVENANCE.  Rows carried no timestamp of any kind, so there
//      was nothing to compare when the same record existed on two devices.
//      Writes are now stamped with updatedAt and updatedBy.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not make quantities safe to merge, and no timestamp ever will. If one
// device issues 5 and another issues 3 against a stock of 40, the later
// timestamp tells you which edit landed last (35, or 37) — not what both edits
// did (32). Counts have to be derived from the union of the ledger, not chosen
// between. updatedAt is for descriptive fields: an item's name, NSN, category,
// location, condition. Treating it as sufficient for a count would produce a
// confident, wrong number, which is worse for accountability than a visible
// conflict.
//
// It also does not touch refs that already exist. A printed AB189 or issue
// voucher carries the ref that was minted when it was raised; rewriting the
// stored ref would leave the paper and the database disagreeing. Historic
// unnamespaced refs stay exactly as they are and are recorded as legacy, so a
// future merge knows they are the ones that need collision-checking rather
// than assuming every ref is safe.
// =============================================================================

const META_INSTALL_ID  = 'installId';
const META_NS_FROM     = 'refNamespaceFrom';
const SETTING_DEV_NAME = 'device.name';

// Crockford-style alphabet: no I, L, O or U, so a token read off a screen and
// written onto a form cannot be confused with 1, 0, or a rude word.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_LEN = 4;

let _tokenCache = null;

/**
 * Derive the short device token from an install ID.
 *
 * Pure and synchronous so it can be unit-tested without a database. This is a
 * namespace label, not a secret — it only has to be stable and well spread, so
 * FNV-1a is sufficient and avoids making every ref mint await a crypto digest.
 *
 * 32^4 ≈ 1.05M tokens. For the handful of devices in a unit the chance of two
 * colliding is negligible, and a collision degrades to the situation we have
 * today rather than to something worse — which is why the merge must still
 * collision-check rather than trust the token.
 *
 * @param {string} installId  UUID from the meta store
 * @returns {string} e.g. 'K7M2'
 */
export function tokenFromInstallId(installId) {
  const s = String(installId || '');
  if (!s) return '0000';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime, via shifts to stay inside 32 bits without Math.imul overflow.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  let out = '';
  for (let i = 0; i < TOKEN_LEN; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length) || (h ^ 0x9e3779b9) >>> 0;
  }
  return out;
}

/**
 * This install's ID. Created once at first boot and preserved across import.
 * @param {object} Storage  the storage module (passed in to avoid a cycle)
 */
export async function getInstallId(Storage) {
  return (await Storage.meta.get(META_INSTALL_ID)) || '';
}

/**
 * This install's short token, used to namespace minted references.
 * Cached — it cannot change for the life of the database.
 */
export async function getDeviceToken(Storage) {
  if (_tokenCache) return _tokenCache;
  const id = await getInstallId(Storage);
  _tokenCache = tokenFromInstallId(id);
  return _tokenCache;
}

/** Clear the cached token. Only needed by tests that swap databases. */
export function _resetTokenCache() {
  _tokenCache = null;
}

/**
 * Operator-set label for this device, e.g. "Q-Store terminal" or "QM laptop".
 * Falls back to the token so the device is never nameless in a report.
 */
export async function getDeviceName(Storage) {
  const name = await Storage.settings.get(SETTING_DEV_NAME);
  if (name && String(name).trim()) return String(name).trim();
  return 'Device ' + (await getDeviceToken(Storage));
}

export async function setDeviceName(Storage, name) {
  await Storage.settings.set(SETTING_DEV_NAME, String(name || '').trim());
}

/**
 * Mint a namespaced reference: PREFIX-TOKEN-NNNN.
 *
 * The counter stays local and monotonic; the token is what makes the result
 * unique across devices. Both parts matter — the counter keeps refs readable
 * and ordered within a device, the token keeps them from colliding between
 * devices.
 *
 * @param {object} Storage
 * @param {string} prefix      'LN' | 'ISS'
 * @param {string} counterKey  key in the counters store
 * @param {number} startAt
 * @returns {Promise<string>} e.g. 'LN-K7M2-1000'
 */
export async function mintRef(Storage, prefix, counterKey, startAt = 1000) {
  const token = await getDeviceToken(Storage);
  const n = await Storage.counters.next(counterKey, startAt);
  return `${prefix}-${token}-${n}`;
}

/**
 * Whether a reference was minted before namespacing was introduced.
 *
 * Legacy refs are the ones that can collide with another device's, so a merge
 * has to treat them as suspect rather than as identity. Namespaced refs have
 * three hyphen-separated parts; legacy ones have two.
 *
 * @param {string} ref
 */
export function isLegacyRef(ref) {
  return String(ref || '').split('-').length < 3;
}

/**
 * Stamp a record with provenance, immediately before it is written.
 *
 * updatedAt is the wall clock of the writing device. Clocks between devices are
 * not guaranteed to agree, which is a known limitation of comparing them: a
 * device with a badly wrong clock can win a comparison it should lose. The
 * merge is expected to surface an implausible skew rather than silently trust
 * it, which is another reason counts are not resolved this way.
 *
 * Records arriving through importAll are written straight to the object stores
 * and are NOT re-stamped — they keep the provenance of the device that made
 * them, which is the whole point of recording it.
 *
 * @param {object} Storage
 * @param {object} record
 * @returns {Promise<object>} a copy carrying updatedAt/updatedBy
 */
export async function stamp(Storage, record) {
  return {
    ...record,
    updatedAt: new Date().toISOString(),
    updatedBy: await getDeviceToken(Storage),
  };
}

/**
 * Record that this install now namespaces the refs it mints.
 *
 * Written once, on the first boot after upgrading. Refs already in the database
 * predate it and are the ones a merge must collision-check. Absent entirely on
 * a database that has never been upgraded, which a merge should read as "every
 * ref here is legacy".
 */
export async function markNamespaceStart(Storage) {
  const existing = await Storage.meta.get(META_NS_FROM);
  if (existing) return existing;
  const now = new Date().toISOString();
  await Storage.meta.set(META_NS_FROM, now);
  return now;
}

export async function getNamespaceStart(Storage) {
  return (await Storage.meta.get(META_NS_FROM)) || null;
}
