// Headless test for what a viewer may see of the audit log (src/audit-view.js).
//
// An upgraded install carries audit entries naming cadets who used the earlier
// build. Those entries stay exactly as they are — they are signed, and they are
// the record. This test holds two things at once:
//   - a role without the 'audit' permission never receives a cadet's name or a
//     description from the log, by any route the dashboard takes;
//   - a role with it receives the stored entry unchanged, and the chain still
//     verifies afterwards. Masking that altered the log would pass the first
//     half and be worse than the leak.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
    clear()       { _store.clear(); },
  };
}

const Storage   = await import('./src/storage.js');
const AuditView = await import('./src/audit-view.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_audit_view' });

// -----------------------------------------------------------------------------
console.log('[1] Seed an upgraded install: an adult QM, a cadet account, and history naming both');

await Storage.users.put({ id: 'usr-qm',  name: 'LT Adult',  username: 'qm',  role: 'qm' });
await Storage.users.put({ id: 'usr-cdt', name: 'CDT Minor', username: 'cdt', role: 'cadet' });

await Storage.audit.append({ action: 'stocktake_finalise', user: 'LT Adult',  desc: 'Stocktake finalised: 40 items.' });
await Storage.audit.append({ action: 'login',              user: 'CDT Minor', desc: 'Login successful.' });
await Storage.audit.append({ action: 'issue',              user: 'LT Adult',  desc: 'LN-1000: Webbing belt × 1 issued to CDT MINOR for Annual Camp' });
await Storage.audit.append({ action: 'login',              user: 'CAPT Departed', desc: 'Login successful.' });
await Storage.audit.append({ action: 'staff_reclassified', user: 'system',    desc: '1 adult record(s) moved.' });

const stored = JSON.stringify(await Storage.audit.list({ order: 'asc' }));
const leaks  = (v) => /minor/i.test(JSON.stringify(v));

// -----------------------------------------------------------------------------
console.log('\n[2] adultNames — cadet accounts are excluded by role');
const adults = AuditView.adultNames(await Storage.users.list());
expect(adults.has('LT Adult'),   'adult account name is known');
expect(adults.has('system'),     'the system actor is not a person and is known');
expect(!adults.has('CDT Minor'), 'cadet account name is NOT known');
expect(!adults.has('cdt'),       'cadet username is NOT known');

// -----------------------------------------------------------------------------
console.log('\n[3] projectEntry — viewer without the audit permission');
const rows = await Storage.audit.list({ order: 'asc' });
const seen = rows.map((r) => AuditView.projectEntry(r, { canAudit: false, adults }));

eq(seen[1].user, AuditView.MASKED_USER, 'a cadet actor is masked');
eq(seen[3].user, AuditView.MASKED_USER, 'a name on no current account is masked, not assumed adult');
eq(seen[0].user, 'LT Adult', 'a known adult actor is shown');
eq(seen[4].user, 'system',   'the system actor is shown');
expect(seen.every((e) => e.desc === ''), 'no description reaches this viewer');
expect(!leaks(seen), 'the cadet is named nowhere in what this viewer receives');
eq(AuditView.projectEntry(rows[1], { canAudit: false }).user, AuditView.MASKED_USER,
   'with no adult list at all, every name is masked');
eq(AuditView.projectEntry(rows[1], { canAudit: 'yes', adults }).user, AuditView.MASKED_USER,
   'only canAudit === true unmasks');

// -----------------------------------------------------------------------------
console.log('\n[4] projectEntry — viewer with the audit permission');
const full = rows.map((r) => AuditView.projectEntry(r, { canAudit: true, adults }));
eq(JSON.stringify(full), stored, 'the entries are exactly as stored');

// -----------------------------------------------------------------------------
console.log('\n[5] forDashboard — the route the dashboard takes');
const forStaff = await AuditView.forDashboard(Storage, false);
eq(forStaff.recent.length, 0, 'no activity feed without the audit permission');
eq(forStaff.lastStocktake?.user, 'LT Adult', 'last stocktake still shows who finalised it, when an adult');
eq(forStaff.lastStocktake?.desc, '', 'last stocktake carries no description');
expect(!leaks(forStaff), 'the cadet is named nowhere in the staff dashboard data');

const forQm = await AuditView.forDashboard(Storage, true);
eq(forQm.recent.length, 5, 'activity feed present with the audit permission');
expect(leaks(forQm), 'and it is unmasked — the cadet entries are there to be read');

// A stocktake finalised by someone who is no longer a known adult.
await Storage.audit.append({ action: 'stocktake_finalise', user: 'CDT Minor', desc: 'Stocktake finalised.' });
const later = await AuditView.forDashboard(Storage, false);
eq(later.lastStocktake?.user, AuditView.MASKED_USER, 'a non-adult finaliser is masked on the dashboard');
expect(!!later.lastStocktake?.ts, 'the date is still there');

// -----------------------------------------------------------------------------
console.log('\n[6] The log itself is untouched');
const after = await Storage.audit.list({ order: 'asc' });
eq(JSON.stringify(after.slice(0, 5)), stored, 'stored entries are byte-for-byte what was written');
const v = await Storage.audit.verify();
eq(v.ok, true, 'the chain still verifies');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
