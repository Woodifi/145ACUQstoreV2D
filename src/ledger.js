// =============================================================================
// QStore IMS v2 — Stock movement ledger
// =============================================================================
// Stock figures are a *derived* quantity. This module owns the derivation.
//
// WHY THE STORED NUMBER CANNOT BE THE TRUTH
//
// This build has no central store: each install is a full, independent replica.
// When two of them are brought together, a stored count cannot be reconciled.
// If the Q-Store terminal issues 5 of an item and a laptop issues 3 of the same
// item, both starting from 40, the two databases hold 35 and 37. There is no
// rule that recovers 32 from those two numbers — not "take the newest", not
// "take the lowest", not "take the one from the more authoritative device".
// The information needed to compute 32 is not in either figure. It is in the
// two *movements*, and only if both were kept.
//
// So the movements are kept, and the count is computed from them. Merging two
// devices becomes a union of movement records — which is well defined, because
// each movement has a globally unique id — followed by a recomputation. Two
// concurrent issues both land. Nothing is chosen between and nothing is lost.
//
// ABSOLUTE VERSUS DELTA
//
// Not every stock event is a delta. A stocktake is a physical recount: it
// asserts "there are 38 of these, whatever the book said". Replaying that as a
// delta would be wrong, because it is not a change of 38 — it is a new
// baseline. Movements therefore come in two modes:
//
//   delta     'three went out'      — composes with other deltas
//   absolute  'there are 38'        — supersedes everything before it
//
// Derivation walks the movements in order, resetting at each absolute and
// accumulating deltas after it. That makes a stocktake do what a stocktake
// means, and makes concurrent issues compose, which is exactly the split the
// domain has.
//
// ORDERING
//
// Movements are ordered by (ts, device, id). The device token and id are
// tiebreakers, not judgements: they exist so that two installs given the same
// set of movements produce the same number, which is the property a merge
// depends on. Wall clocks between devices are not guaranteed to agree, and a
// device with a badly wrong clock can order its movements wrongly relative to
// another's. That is a real limitation. It is survivable for deltas, which
// compose in any order — addition is commutative — and matters only for
// absolutes, where an out-of-order stocktake could supersede a later one.
// summarise() reports the clock skew it sees so the condition is visible
// rather than silent.
//
// THE FIELDS
//
// Stock is three numbers, not one:
//   onHand   physically in the store
//   onLoan   out on issue
//   unsvc    unserviceable, a subset of what is held
// Availability is onHand − onLoan, computed at the point of use.
//
// A movement carries only the fields it touches; a field left null is not
// asserted and is passed through untouched. An issue moves onLoan and says
// nothing about unsvc.
// =============================================================================

/** The stock fields a movement can assert. */
export const FIELDS = Object.freeze(['onHand', 'onLoan', 'unsvc']);

/** Movement kinds. Descriptive — the mode is what drives the arithmetic. */
export const KINDS = Object.freeze({
  OPENING:   'opening',    // migration baseline for a pre-ledger item
  ISSUE:     'issue',
  RETURN:    'return',
  RECEIPT:   'receipt',    // stock in against an order
  STOCKTAKE: 'stocktake',  // physical recount — absolute
  ADJUST:    'adjust',     // manual correction, CSV import, item edit
  WRITEOFF:  'writeoff',   // AB174
});

export const MODE_DELTA    = 'delta';
export const MODE_ABSOLUTE = 'absolute';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Deterministic movement order.
 *
 * Sorting must be total and identical on every device, or two installs holding
 * the same movements would derive different counts — which would defeat the
 * point. ts first because it is the real-world order; device and id only to
 * break ties reproducibly.
 */
export function compareMovements(a, b) {
  const ta = String(a?.ts || '');
  const tb = String(b?.ts || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  const da = String(a?.device || '');
  const db = String(b?.device || '');
  if (da !== db) return da < db ? -1 : 1;
  const ia = String(a?.id || '');
  const ib = String(b?.id || '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Derive an item's stock from its movements.
 *
 * Pure: no database, no clock, no device. Given the same movements it returns
 * the same numbers, on any install, in any order of arrival. That is the
 * property that makes a merge a union rather than a negotiation.
 *
 * @param {object[]} movements  movements for ONE item, in any order
 * @returns {{onHand:number, onLoan:number, unsvc:number}}
 */
export function derive(movements) {
  const ordered = [...(movements || [])].sort(compareMovements);
  const out = { onHand: 0, onLoan: 0, unsvc: 0 };

  for (const m of ordered) {
    if (!m) continue;
    const absolute = m.mode === MODE_ABSOLUTE;
    for (const f of FIELDS) {
      const v = m[f];
      // null/undefined means "this movement does not speak to this field".
      // Zero does speak — a stocktake finding none of something is a real
      // assertion, and must not be skipped as though it were absent.
      if (v === null || v === undefined) continue;
      out[f] = absolute ? num(v) : out[f] + num(v);
    }
  }

  // A negative physical count is not a fact about the world; it is evidence of
  // a missing or duplicated movement. Clamp so the UI cannot show "-3 boots",
  // and let checkIntegrity report the underlying problem.
  for (const f of FIELDS) if (out[f] < 0) out[f] = 0;
  return out;
}

/**
 * Group movements by item and derive each.
 * @param {object[]} movements
 * @returns {Map<string, {onHand:number, onLoan:number, unsvc:number}>}
 */
export function deriveAll(movements) {
  const byItem = new Map();
  for (const m of movements || []) {
    if (!m?.itemId) continue;
    if (!byItem.has(m.itemId)) byItem.set(m.itemId, []);
    byItem.get(m.itemId).push(m);
  }
  const out = new Map();
  for (const [itemId, rows] of byItem) out.set(itemId, derive(rows));
  return out;
}

/**
 * Build a movement from the difference between two versions of an item.
 *
 * This is what makes the ledger complete without every call site having to
 * remember to write to it. Any code path that changes a stock field produces a
 * movement automatically, because the movement is computed from what actually
 * changed rather than from what the caller said it was doing.
 *
 * Returns null when no stock field moved — an item rename is not a stock event
 * and should not put a row in the ledger.
 *
 * @param {object|null} before  stored item, or null when newly created
 * @param {object} after        item about to be written
 * @returns {{onHand:number|null, onLoan:number|null, unsvc:number|null}|null}
 */
export function diffFields(before, after) {
  const delta = {};
  let moved = false;
  for (const f of FIELDS) {
    const b = num(before?.[f]);
    const a = num(after?.[f]);
    if (a !== b) { delta[f] = a - b; moved = true; }
    else delta[f] = null;
  }
  return moved ? delta : null;
}

/**
 * Check the ledger reproduces a set of stored items.
 *
 * The cached scalars on the item records are a materialised view of this
 * ledger. If they ever disagree, either a write bypassed the ledger or a
 * movement was lost, and both are the kind of fault that otherwise shows up as
 * a quietly wrong stock figure months later. Used by the invariant test and
 * available for a Settings self-check.
 *
 * @param {object[]} items
 * @param {object[]} movements
 * @returns {{ok:boolean, mismatches:Array}}
 */
export function checkIntegrity(items, movements) {
  const derived = deriveAll(movements);
  const mismatches = [];

  for (const item of items || []) {
    const d = derived.get(item.id) || { onHand: 0, onLoan: 0, unsvc: 0 };
    for (const f of FIELDS) {
      const stored = num(item[f]);
      if (stored !== d[f]) {
        mismatches.push({
          itemId: item.id, name: item.name || '', field: f,
          stored, derived: d[f], drift: d[f] - stored,
        });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Describe a merged movement set: where it came from, and anything a human
 * should look at before trusting the numbers.
 *
 * @param {object[]} movements
 */
export function summarise(movements) {
  const rows = [...(movements || [])].sort(compareMovements);
  const devices = new Map();
  const absolutesByItem = new Map();

  for (const m of rows) {
    const d = m.device || 'unknown';
    devices.set(d, (devices.get(d) || 0) + 1);
    if (m.mode === MODE_ABSOLUTE && m.itemId) {
      if (!absolutesByItem.has(m.itemId)) absolutesByItem.set(m.itemId, []);
      absolutesByItem.get(m.itemId).push(m);
    }
  }

  // Two devices independently recounting the same item is not an error, but it
  // is a fact a QM should see: the later count supersedes the earlier, and the
  // earlier one's work is discarded by that rule rather than by a decision
  // anyone made.
  const competingRecounts = [];
  for (const [itemId, list] of absolutesByItem) {
    const byDevice = new Set(list.map(m => m.device));
    if (byDevice.size > 1) {
      const ordered = list.sort(compareMovements);
      competingRecounts.push({
        itemId,
        counts: ordered.map(m => ({ device: m.device, ts: m.ts, onHand: m.onHand })),
        superseding: ordered[ordered.length - 1],
      });
    }
  }

  // Movements stamped in the future indicate a device clock that is wrong,
  // which is the one condition that can order absolutes incorrectly.
  const now = new Date().toISOString();
  const future = rows.filter(m => String(m.ts || '') > now);

  return {
    total: rows.length,
    devices: [...devices.entries()].map(([device, count]) => ({ device, count })),
    firstTs: rows[0]?.ts || null,
    lastTs:  rows[rows.length - 1]?.ts || null,
    competingRecounts,
    futureTimestamps: future.length,
  };
}
