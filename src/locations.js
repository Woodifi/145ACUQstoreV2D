// Issue destinations — where an item goes when it leaves the Q-Store.
//
// Replaces the borrower. This build carries no person identifiers (HQ AAC ICT,
// 17 July 2026 — see docs/IDENTIFIER-FREE-DESIGN.md), so an issue records a
// *destination*, not a recipient:
//
//   INDIVIDUAL  — the item is with a person. WHICH person is recorded only on
//                 the printed document, which goes to that member's CEA
//                 documents. The tool holds the issue number, nothing more.
//   anything else — an activity or a place. Not a person at all.
//
// MANAGED LIST, NOT FREE TEXT — and this is the important part.
//
// HQ's position is conditional on the tool not carrying PII. A free-text
// destination field would be typed into: "Smith's section", "issued to CDT
// Jones". The tool would then be carrying PII, in an unencrypted field, with no
// schema to point at and nothing to detect it. The condition would be breached
// silently — which is exactly how piiKey ended up in the OneDrive blob.
//
// So destinations come from a list the OC curates. A determined user can still
// name a location "CDT Jones", and no code can stop that. What this prevents is
// doing it *by accident*, and it means anything odd is visible in one place in
// Settings rather than smeared across a thousand loan rows.

const SETTINGS_KEY = 'loans.locations';

/**
 * The sentinel destination meaning "a person holds this". Deliberately not a
 * name, not an ID, not a reference to anyone — the entire point is that the
 * tool knows an item is with *someone* and cannot say who.
 */
export const INDIVIDUAL = 'individual';

/** Human label for the sentinel. */
export const INDIVIDUAL_LABEL = 'Individual (see issue document)';

/**
 * Starting list for a new install. Places and activities a Q-Store actually
 * issues to. The OC edits these in Settings; they are not fixed.
 */
export const DEFAULT_LOCATIONS = Object.freeze([
  'Field exercise',
  'Bivouac',
  'Range practice',
  'Ceremonial parade',
  'Adventure training',
  'Unit activity',
  'Maintenance / repair',
  'On loan to another unit',
]);

/**
 * Load the curated list. INDIVIDUAL is always present and always first — it is
 * structural, not a preference, and the OC must not be able to delete the only
 * destination that represents a person and thereby force staff to invent a
 * free-text workaround.
 */
export async function list(Storage) {
  let saved = null;
  try {
    saved = await Storage.settings.get(SETTINGS_KEY);
  } catch { /* fall through to defaults */ }

  const custom = Array.isArray(saved) && saved.length
    ? saved.filter((v) => typeof v === 'string' && v.trim() && v !== INDIVIDUAL)
    : DEFAULT_LOCATIONS.slice();

  return [INDIVIDUAL, ...custom];
}

/**
 * Persist the curated list. INDIVIDUAL is stripped before saving — it is
 * re-added by list() on every read, so it cannot be lost by a bad write.
 */
export async function save(Storage, locations) {
  const clean = (locations || [])
    .map((v) => String(v || '').trim())
    .filter((v) => v && v !== INDIVIDUAL);
  await Storage.settings.set(SETTINGS_KEY, clean);
  return [INDIVIDUAL, ...clean];
}

/** True when this destination means "a person has it". */
export function isIndividual(location) {
  return location === INDIVIDUAL;
}

/** Display label for a destination. */
export function label(location) {
  return isIndividual(location) ? INDIVIDUAL_LABEL : String(location || '');
}

/**
 * Next issue-document reference. Monotonic via the counters store, same
 * mechanism as loan refs, so it survives tabs and (once the counter is pulled)
 * devices. Format 'ISS-NNNN' from ISS-1000.
 *
 * This number is the ONLY link between an item and the person holding it. It is
 * written on the printed document; the document goes to CEA. Lose the document
 * and the link is gone — which is the design, not a defect.
 */
export async function nextIssueNo(Storage) {
  const n = await Storage.counters.next('issue', 1000);
  return `ISS-${n}`;
}

// ---------------------------------------------------------------------------
// Loan remarks — curated vocabulary
// ---------------------------------------------------------------------------
// `remarks` was a free-text box on both the issue and return forms. It is the
// single most likely field in the app to acquire a name: it sits next to the
// word "issue", it invites a sentence, and a sentence about a loan tends to
// name the person who has it. "Returned by Smith, bent." carries PII in an
// unencrypted field, and nothing would detect it.
//
// The observation itself is operationally real — "returned unserviceable, bent"
// is worth recording — so the field is constrained rather than deleted. A select
// over a curated list cannot hold a sentence, and therefore cannot hold a name.
//
// Equipment observations that don't fit the list belong in the item's
// maintenance log (inventory.js), which is retained: it is about the item, not
// about a person, and it is the right home for "bent on exercise, straightened".

const REMARKS_KEY = 'loans.remarks';

export const DEFAULT_REMARKS = Object.freeze([
  'Issued serviceable',
  'Returned serviceable',
  'Returned unserviceable — damaged',
  'Returned unserviceable — worn',
  'Returned incomplete',
  'Returned late',
  'Not returned — written off',
  'Exchanged for correct size',
  'Replacement issue',
]);

/** Curated remark list. Empty string is always available, meaning "no remark". */
export async function remarks(Storage) {
  let saved = null;
  try { saved = await Storage.settings.get(REMARKS_KEY); } catch { /* defaults */ }
  const custom = Array.isArray(saved) && saved.length
    ? saved.filter((v) => typeof v === 'string' && v.trim())
    : DEFAULT_REMARKS.slice();
  return custom;
}

export async function saveRemarks(Storage, list) {
  const clean = (list || []).map((v) => String(v || '').trim()).filter(Boolean);
  await Storage.settings.set(REMARKS_KEY, clean);
  return clean;
}
