// =============================================================================
// QStore IMS v2 — Audit entries as a viewer may see them
// =============================================================================
// The audit log names whoever performed each action, and on an upgraded install
// that includes cadets who signed in to the earlier build (controls statement
// §4.3). Those entries cannot be changed: the chain signs `user` and `desc`, and
// the log is the record of what happened. So what a person may SEE is decided
// here, on the way out, and the stored row is never touched.
//
// WHO SEES WHAT
//   'audit' permission (OC, QM) — the entry exactly as stored. Verification,
//   investigation and any access request need the real thing.
//
//   everyone else — no description at all, and the user's name only where it is
//   positively known to belong to an adult.
//
// WHY THE DESCRIPTION IS WITHHELD RATHER THAN MASKED
//   It is free text. An older build wrote "issued to CDT SMITH" and "Added
//   cadet: CDT SMITH (8512345)" into it, in no fixed position. Anything that
//   tried to find the name inside the sentence would miss one eventually.
//
// WHY AN ALLOW-LIST
//   After legacy.purge() the cadet login accounts are gone, so nothing left in
//   the database can say "this name was a cadet". What can still be said is
//   "this name is a current adult account". A name that is not on that list is
//   masked — including a departed adult, which costs a staff member a name on
//   the dashboard, and never the other way round.
// =============================================================================

export const MASKED_USER = 'Former user';

// Written by the code itself when there is no session to name. Not people.
const NON_PERSON_ACTORS = Object.freeze(['system', 'OC', 'unknown']);

/**
 * Names that may be shown to a viewer without the audit permission: the
 * non-person actors, plus every current account that is not a cadet account.
 * A cadet account survives on an upgraded install until purge — it is excluded
 * here by role, not left to chance.
 *
 * @param {Array<{name?:string, username?:string, role?:string}>} users
 * @returns {Set<string>}
 */
export function adultNames(users) {
  const names = new Set(NON_PERSON_ACTORS);
  for (const u of users || []) {
    if (!u || u.role === 'cadet') continue;
    if (u.name)     names.add(u.name);
    if (u.username) names.add(u.username);
  }
  return names;
}

/**
 * One audit entry as this viewer may see it. Returns a new object for a viewer
 * without the audit permission; the stored row is not modified either way.
 *
 * @param {object} entry
 * @param {object} viewer
 * @param {boolean} viewer.canAudit
 * @param {Set<string>} [viewer.adults]  from adultNames()
 */
export function projectEntry(entry, { canAudit, adults } = {}) {
  if (!entry) return null;
  if (canAudit === true) return entry;
  const known = !!entry.user && !!adults && adults.has(entry.user);
  return {
    seq:    entry.seq,
    ts:     entry.ts,
    action: entry.action,
    user:   known ? entry.user : (entry.user ? MASKED_USER : ''),
    desc:   '',
    masked: !known,
  };
}

/**
 * What the dashboard may draw from the audit log for this viewer.
 *
 * `recent` is the activity feed and is audit content in full — user and
 * description — so a viewer without the permission gets none of it, and the
 * rows are not read on their behalf. `lastStocktake` is a date every role
 * needs; it goes through projectEntry() so the name beside it obeys the same
 * rule as everywhere else.
 *
 * @param {object} Storage   the storage module
 * @param {boolean} canAudit
 * @returns {Promise<{recent: object[], lastStocktake: object|null}>}
 */
export async function forDashboard(Storage, canAudit) {
  const last = await Storage.audit.list({ action: 'stocktake_finalise', limit: 1, order: 'desc' });
  if (canAudit === true) {
    return {
      recent:        await Storage.audit.list({ limit: 5, order: 'desc' }),
      lastStocktake: last[0] || null,
    };
  }
  const adults = adultNames(await Storage.users.list());
  return {
    recent:        [],
    lastStocktake: projectEntry(last[0] || null, { canAudit: false, adults }),
  };
}
