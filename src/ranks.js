// =============================================================================
// QStore IMS v2 — Rank vocabulary (shared)
// =============================================================================
// Canonical rank lists for AAC. Migration uses these to normalise legacy
// records; UI uses them to populate dropdowns and validate input.
//
// AAC RANK STRUCTURE
//   Cadets:      CDT, CDTLCPL, CDTCPL, CDTSGT, CDTSSGT, CDTWO2, CDTWO1, UO
//                (UO = Under Officer; cadet senior leadership rank)
//   Staff:       Officer ranks always carry the -AAC suffix to distinguish
//                from regular Army equivalents:
//                  2LT-AAC   2nd Lieutenant
//                  LT-AAC    Lieutenant
//                  CAPT-AAC  Captain
//                  MAJ-AAC   Major
//                  LTCOL-AAC Lieutenant Colonel
//                  COL-AAC   Colonel
//                Plus DAH (Defence Approved Helper — non-ranking staff
//                including civilian instructors).
//
// LEGACY HANDLING
//   v1 sometimes stored officer ranks without the -AAC suffix (e.g. 'CAPT'
//   instead of 'CAPT-AAC'). _normalizeRank rewrites these to canonical form
//   on migration. Going forward, only canonical forms should be written.
//
// FUTURE
//   When the cadets page lands, it'll import from here for rank dropdowns.
//   When the AB189 generator lands, it'll use STAFF_RANKS_CANONICAL to
//   validate that the QM signing the form is actually staff.
// =============================================================================

/** Officer rank bases without the -AAC suffix. Used for legacy detection. */
export const OFFICER_RANK_BASES = Object.freeze([
  '2LT', 'LT', 'CAPT', 'MAJ', 'LTCOL', 'COL',
]);

/**
 * Canonical staff ranks — the only forms that should be written to v2 records.
 * Used by AB189, QM signature blocks, role assignment forms.
 */
export const STAFF_RANKS_CANONICAL = Object.freeze([
  '2LT-AAC', 'LT-AAC', 'CAPT-AAC', 'MAJ-AAC', 'LTCOL-AAC', 'COL-AAC',
  'DAH',
]);

/**
 * Cadet ranks. Order is hierarchical (lowest → highest) for display purposes.
 */
export const CADET_RANKS = Object.freeze([
  'CDT', 'CDTLCPL', 'CDTCPL', 'CDTSGT', 'CDTSSGT', 'CDTWO2', 'CDTWO1', 'UO',
]);

/**
 * Recognised forms accepted on input. Includes legacy bare officer ranks
 * which _normalizeRank then rewrites. Don't expose this to the UI — it's
 * for migration only.
 */
export const STAFF_RANKS_RECOGNISED = Object.freeze([
  ...STAFF_RANKS_CANONICAL,
  ...OFFICER_RANK_BASES,
]);

/**
 * Strip whitespace and dots, uppercase. Idempotent. Used as a pre-step
 * before classification or canonicalisation.
 */
export function normaliseRankInput(rank) {
  return String(rank || '').toUpperCase().replace(/[\s.]/g, '');
}

/**
 * Rewrite a rank to its canonical v2 form. Officer rank bases get the
 * -AAC suffix; everything else is returned uppercase and stripped.
 *
 *   'CAPT'      → 'CAPT-AAC'
 *   'capt.'     → 'CAPT-AAC'
 *   'CAPT-AAC'  → 'CAPT-AAC'  (idempotent)
 *   'DAH'       → 'DAH'       (no suffix; DAH is non-ranking staff)
 *   'WO2'       → 'WO2'       (cadet rank; no suffix)
 *   ''/null     → ''/null     (preserved)
 */
export function normalizeRank(rank) {
  if (!rank) return rank;
  const norm = normaliseRankInput(rank);
  if (OFFICER_RANK_BASES.includes(norm)) return norm + '-AAC';
  return norm;
}

/**
 * Classify a rank as 'cadet' or 'staff'. Used by migration to fill in
 * personType for legacy records. DAH is staff. Bare officer ranks are
 * staff (about to get -AAC suffix). CADET_RANKS are cadet. Anything
 * unrecognised defaults to 'cadet' — better to under-classify than
 * over-classify (a misclassified cadet can't sign AB189s; a misclassified
 * officer might accidentally be granted permissions they shouldn't have).
 */
export function inferPersonType(rank) {
  if (!rank) return 'cadet';
  const norm = normaliseRankInput(rank);
  return STAFF_RANKS_RECOGNISED.includes(norm) ? 'staff' : 'cadet';
}
