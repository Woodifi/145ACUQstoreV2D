// =============================================================================
// QStore IMS v2 — Merge two devices
// =============================================================================
// Bringing a second device's data into this one WITHOUT destroying either.
//
// This is the counterpart to importAll, which replaces. Replace is correct when
// you are restoring a backup onto a machine whose data you intend to discard.
// It is wrong when two devices have both been used, because whichever you
// restore, the other's work is gone — and until now that was the only option
// this build offered.
//
// WHAT MAKES A MERGE POSSIBLE AT ALL
//
// Three properties, none of which the database had a version ago:
//
//   Globally unique keys.  Loan refs and issue numbers used to come from a
//   local counter, so two devices minted LN-1000 for different issues. A union
//   would have collapsed them. Refs are now namespaced by device; the ones
//   minted before that are detected here and refused rather than guessed at.
//
//   Per-record provenance.  updatedAt/updatedBy on every write, so when the
//   same record exists on both sides there is something to compare.
//
//   A movement ledger.  Stock is derived, not stored, so two concurrent issues
//   compose instead of one overwriting the other.
//
// WHAT IS MERGED, AND WHAT IS DELIBERATELY NOT
//
//   movements   union by id. Append-only; nothing is ever overwritten. This is
//               the ledger, and it is what makes the stock figures correct.
//   items       union by id; descriptive fields by last-write-wins. Stock
//               fields are taken from NEITHER side — they are recomputed from
//               the merged ledger afterwards, which is the whole point.
//   loans       union by ref, last-write-wins on state (returned, condition).
//               A ref present on both sides describing different issues is a
//               CONFLICT and is reported, never merged.
//   staff, kits, orders, photos
//               union by key, last-write-wins.
//
//   users       NOT merged. These carry PIN hashes, roles and TOTP secrets.
//               Silently importing another device's accounts would be a way to
//               grant access, and access is not a data-sync question.
//   settings    NOT merged. Unit details, theme, timeouts — local preferences,
//               and merging them would make a device change behaviour because
//               somebody else's laptop said so.
//   counters    NOT merged. They are now per-device ref namespaces. Taking the
//               other device's counter would produce refs in ITS namespace.
//   audit       NOT merged, and this one is not a preference. Each install has
//               its own HMAC chain. Interleaving two chains breaks verification
//               for both, and re-signing the result is indistinguishable from
//               forging it — the same reasoning recorded at §4.3 of the
//               controls statement. The incoming chain stays on the device that
//               wrote it; this device records that a merge happened and from
//               where, in its own chain.
//   stocktake   NOT merged. A draft count is the state of a job somebody is in
//   drafts      the middle of, on a particular device, in a particular room.
//               Another device's half-finished count is not information about
//               this one.
//
// DRY RUN FIRST
//
// plan() computes everything and writes nothing. The operator sees what would
// be added, updated, skipped and — most importantly — what conflicts before
// anything happens. A merge that silently resolved an ambiguous loan ref would
// be worse than no merge, because the resulting stock figure would look
// authoritative and be wrong.
// =============================================================================

import * as Ledger from './ledger.js';
import { isLegacyRef } from './device.js';

/** Stores whose records merge by key with last-write-wins. */
const LWW_STORES = Object.freeze([
  { key: 'items',  idField: 'id'    },
  { key: 'staff',  idField: 'svcNo' },
  { key: 'kits',   idField: 'id'    },
  { key: 'orders', idField: 'id'    },
  { key: 'photos', idField: 'id'    },
]);

/** Reasons a store is intentionally left alone. Shown to the operator. */
export const NOT_MERGED = Object.freeze({
  users:    'User accounts carry PIN hashes, roles and 2FA secrets. Granting access is not a data-sync decision.',
  settings: 'Unit details and preferences are local to this device.',
  counters: 'Counters are this device\'s reference namespace. Taking another device\'s would mint references in its name.',
  audit:    'Each device has its own tamper-evident audit chain. Interleaving two chains breaks verification for both, and a re-signed chain cannot be told apart from a forged one.',
  stocktakeCounts: 'A stocktake draft is a job in progress on that device. Another device\'s half-finished count is not information about this one.',
});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Which of two records is newer.
 *
 * updatedAt first. A record with no stamp predates provenance and always
 * loses — it cannot be shown to be newer, so it is not treated as newer.
 * updatedBy breaks exact ties so that both devices reach the same answer;
 * it is a tiebreaker, not a ranking of devices.
 *
 * @returns {number} >0 if a wins, <0 if b wins, 0 if indistinguishable
 */
export function compareRecency(a, b) {
  const ta = String(a?.updatedAt || '');
  const tb = String(b?.updatedAt || '');
  if (ta !== tb) return ta > tb ? 1 : -1;
  const da = String(a?.updatedBy || '');
  const db = String(b?.updatedBy || '');
  if (da !== db) return da > db ? 1 : -1;
  return 0;
}

/**
 * Do two loan records describe the same issue?
 *
 * Only asked when the same ref appears on both sides. If the refs are
 * namespaced they cannot have been minted independently and the answer is yes.
 * If either is a pre-namespace ref, the two devices may have minted it
 * separately for different issues, and the only honest test is whether the
 * substance matches.
 */
function sameIssue(a, b) {
  return String(a.itemId || '') === String(b.itemId || '')
      && num(a.qty) === num(b.qty)
      && String(a.issuedAt || a.createdAt || '') === String(b.issuedAt || b.createdAt || '');
}

/**
 * Compute what a merge would do. Writes nothing.
 *
 * @param {object} local     current data, by store name
 * @param {object} incoming  a snapshot from exportAll() on another device
 * @returns {object} the plan
 */
export function plan(local, incoming) {
  const out = {
    movements: { add: [] },
    records:   {},
    conflicts: [],
    warnings:  [],
    skipped:   [],
    sourceDevice: null,
    totals: { added: 0, updated: 0, unchanged: 0 },
  };

  if (!incoming || !incoming.schemaVersion) {
    throw new Error('Not a valid QStore backup (missing schemaVersion).');
  }

  out.sourceDevice = (incoming.meta || []).find(r => r.key === 'installId')?.value || null;

  // ── The ledger: union by id, nothing overwritten ─────────────────────────
  const localMvIds = new Set((local.movements || []).map(m => m.id));
  for (const m of incoming.movements || []) {
    if (!m?.id || localMvIds.has(m.id)) continue;
    out.movements.add.push(m);
  }

  // A snapshot with stock but no ledger cannot contribute movements. Its
  // figures cannot be reconciled with this device's — the numbers are the
  // outcome of movements that were never recorded.
  if (!Array.isArray(incoming.movements) || incoming.movements.length === 0) {
    const hasItems = (incoming.items || []).length > 0;
    if (hasItems) {
      out.warnings.push({
        kind: 'no-ledger',
        message: 'The incoming backup was written before the movement ledger existed, so it '
               + 'carries stock figures but no record of how they were reached. Its item '
               + 'details will merge, but its stock figures cannot be reconciled with this '
               + 'device\'s and will be ignored — this device\'s ledger remains the source '
               + 'of the counts.',
      });
    }
  }

  // ── Records that merge by key ────────────────────────────────────────────
  for (const { key, idField } of LWW_STORES) {
    const localRows = local[key] || [];
    const incRows   = incoming[key] || [];
    const byId = new Map(localRows.map(r => [r[idField], r]));
    const bucket = { add: [], update: [], unchanged: 0 };

    for (const inc of incRows) {
      const id = inc?.[idField];
      if (id === undefined || id === null || id === '') continue;
      const mine = byId.get(id);
      if (!mine) { bucket.add.push(inc); continue; }

      const cmp = compareRecency(inc, mine);
      if (cmp > 0) bucket.update.push(inc);
      else bucket.unchanged++;
    }

    out.records[key] = bucket;
    out.totals.added   += bucket.add.length;
    out.totals.updated += bucket.update.length;
    out.totals.unchanged += bucket.unchanged;
  }

  // ── Loans: union by ref, with collision detection ────────────────────────
  {
    const localRows = local.loans || [];
    const incRows   = incoming.loans || [];
    const byRef = new Map(localRows.map(r => [r.ref, r]));
    const bucket = { add: [], update: [], unchanged: 0 };

    for (const inc of incRows) {
      if (!inc?.ref) continue;
      const mine = byRef.get(inc.ref);
      if (!mine) { bucket.add.push(inc); continue; }

      // Same ref on both sides. If either ref predates namespacing the two
      // devices may have minted it independently for different issues, and
      // merging would silently destroy one of them.
      if ((isLegacyRef(inc.ref) || isLegacyRef(mine.ref)) && !sameIssue(inc, mine)) {
        out.conflicts.push({
          kind: 'loan-ref-collision',
          ref: inc.ref,
          message: `Reference ${inc.ref} exists on both devices but describes different `
                 + 'issues. It was created before references carried a device tag, so both '
                 + 'devices minted it independently. Neither can be discarded automatically.',
          local:    { itemName: mine.itemName || '', qty: mine.qty, location: mine.location || '' },
          incoming: { itemName: inc.itemName  || '', qty: inc.qty,  location: inc.location  || '' },
        });
        continue;
      }

      if (compareRecency(inc, mine) > 0) bucket.update.push(inc);
      else bucket.unchanged++;
    }

    out.records.loans = bucket;
    out.totals.added   += bucket.add.length;
    out.totals.updated += bucket.update.length;
    out.totals.unchanged += bucket.unchanged;
  }

  // ── Deliberate omissions, stated ─────────────────────────────────────────
  // Listed whether or not the incoming snapshot has any, because the operator
  // is entitled to know what a merge does not touch — particularly the audit
  // chain, where not merging is a correctness constraint rather than a
  // preference. describe() drops the empty ones so the summary stays readable.
  for (const [store, reason] of Object.entries(NOT_MERGED)) {
    out.skipped.push({ store, count: (incoming[store] || []).length, reason });
  }

  // ── Items arriving with figures but no movements behind them ─────────────
  // A pre-ledger backup carries stock counts and no record of how they were
  // reached. Its items still merge, but with nothing in the ledger for them the
  // derivation would be zero and the recompute would show the unit no stock for
  // items it plainly has.
  //
  // They are given an opening balance, exactly as an upgraded local database
  // is: absolute, attributed to the device the backup came from, and labelled
  // as carried forward. That is the honest claim — the movements that produced
  // the figures happened somewhere with nowhere to record them.
  //
  // Only for items this device does not already hold. Where both sides have the
  // item, THIS device's ledger already accounts for it, and synthesising a
  // baseline from the other side's stale figure would overwrite a derivation
  // that is correct with one that is merely recent.
  {
    const haveMovementsFor = new Set([
      ...(local.movements || []).map(m => m.itemId),
      ...out.movements.add.map(m => m.itemId),
    ]);
    const localItemIds = new Set((local.items || []).map(i => i.id));
    const sourceTag = String(out.sourceDevice || 'IMPORT').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'IMPT';
    const ts = (incoming.exportedAt && String(incoming.exportedAt)) || new Date().toISOString();

    for (const item of incoming.items || []) {
      if (!item?.id) continue;
      if (localItemIds.has(item.id)) continue;
      if (haveMovementsFor.has(item.id)) continue;

      out.movements.add.push({
        id:     `MV-${sourceTag}-opening-${item.id}`,
        itemId: item.id,
        ts,
        device: sourceTag,
        kind:   Ledger.KINDS.OPENING,
        mode:   Ledger.MODE_ABSOLUTE,
        onHand: num(item.onHand),
        onLoan: num(item.onLoan),
        unsvc:  num(item.unsvc),
        ref:    '',
        reason: 'Opening balance carried forward from a backup written before the movement ledger existed.',
        user:   '',
      });
      out.warnings.push({
        kind: 'synthesised-opening',
        itemId: item.id,
        message: `"${item.name || item.id}" arrived from a device with no movement ledger. Its `
               + 'figures have been recorded as an opening balance so they can be reconciled '
               + 'from here on, but the movements that produced them are not recoverable.',
      });
    }
  }

  // ── What the merged ledger will look like ────────────────────────────────
  const mergedMovements = [...(local.movements || []), ...out.movements.add];
  const summary = Ledger.summarise(mergedMovements);
  out.ledgerSummary = summary;

  for (const c of summary.competingRecounts) {
    out.warnings.push({
      kind: 'competing-recount',
      itemId: c.itemId,
      message: 'This item was recounted on more than one device. The later count supersedes '
             + 'the earlier one, which means the earlier device\'s count is discarded by that '
             + 'rule rather than by anyone\'s decision. Check it is the count you meant to keep.',
      counts: c.counts,
    });
  }

  if (summary.futureTimestamps > 0) {
    out.warnings.push({
      kind: 'clock-skew',
      message: `${summary.futureTimestamps} movement(s) are stamped in the future, which means `
             + 'a device clock is wrong. Deltas are unaffected — they add up in any order — but '
             + 'a stocktake could supersede the wrong one. Check the clocks before relying on '
             + 'the counts.',
    });
  }

  // Movements for items neither side holds: the ledger would derive stock for
  // something that does not exist.
  {
    const known = new Set([
      ...(local.items || []).map(i => i.id),
      ...(incoming.items || []).map(i => i.id),
    ]);
    const orphans = new Set();
    for (const m of out.movements.add) if (m.itemId && !known.has(m.itemId)) orphans.add(m.itemId);
    if (orphans.size) {
      out.warnings.push({
        kind: 'orphan-movements',
        message: `${orphans.size} item(s) referenced by incoming movements are not present on `
               + 'either device. Their movements will be stored but derive stock for nothing.',
        itemIds: [...orphans],
      });
    }
  }

  out.hasConflicts = out.conflicts.length > 0;
  out.willChange = out.totals.added + out.totals.updated + out.movements.add.length > 0;
  return out;
}

/**
 * A one-line-per-point summary for the operator, and for the audit entry.
 * @param {object} p  a plan
 */
export function describe(p) {
  const lines = [];
  lines.push(`${p.movements.add.length} new stock movement(s)`);
  for (const [store, b] of Object.entries(p.records)) {
    if (!b.add.length && !b.update.length) continue;
    const bits = [];
    if (b.add.length)    bits.push(`${b.add.length} added`);
    if (b.update.length) bits.push(`${b.update.length} updated`);
    lines.push(`${store}: ${bits.join(', ')}`);
  }
  for (const s of p.skipped) if (s.count > 0) lines.push(`${s.store}: ${s.count} not merged`);
  if (p.conflicts.length) lines.push(`${p.conflicts.length} conflict(s) requiring a decision`);
  return lines;
}
