// Headless smoke test for audit log viewer logic.
//
// The page itself is small and read-only — it surfaces Storage.audit's
// existing API. This test exercises the data flows the viewer depends on:
//   - Storage.audit.list filter by action
//   - Storage.audit.list search across desc/user/action
//   - Storage.audit.list ordering (asc / desc) and limit
//   - Storage.audit.verify on a clean chain (ok)
//   - Storage.audit.verify on a tampered chain (reports brokenAt + reason)
//   - Distinct actions discovery for the filter dropdown
//
// We tamper with the chain by writing directly to IndexedDB through fake-
// indexeddb, simulating an attacker editing the database file.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
    clear()       { _store.clear(); },
  };
}

const Storage = await import('./src/storage.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_audit' });

// -----------------------------------------------------------------------------
console.log('[1] Seed a representative audit log');

await Storage.audit.append({ action: 'login',         user: 'admin',  desc: 'Login successful.' });
await Storage.audit.append({ action: 'add',           user: 'admin',  desc: 'Added: Webbing belt — 10 units (Auth: 12)' });
await Storage.audit.append({ action: 'cadet_add',     user: 'admin',  desc: 'Added cadet: CDT SMITH (8512345)' });
await Storage.audit.append({ action: 'issue',         user: 'admin',  desc: 'LN-1000: Webbing belt × 1 issued to CDT SMITH for Annual Camp' });
await Storage.audit.append({ action: 'return',        user: 'admin',  desc: 'LN-1000: Webbing belt × 1 returned by CDT SMITH — serviceable' });
await Storage.audit.append({ action: 'login_failed',  user: 'unknown', desc: 'Failed login attempt for usr-bad' });
await Storage.audit.append({ action: 'pin_change',    user: 'admin',  desc: 'PIN updated for admin.' });
await Storage.audit.append({ action: 'cadet_update',  user: 'admin',  desc: 'Updated cadet: CDTLCPL SMITH (8512345)' });

const totalAfterSeed = await Storage.audit.count();
eq(totalAfterSeed, 8, 'audit log has 8 entries after seed');

// -----------------------------------------------------------------------------
console.log('\n[2] Storage.audit.list filter by action');
const issues = await Storage.audit.list({ action: 'issue' });
eq(issues.length, 1, 'filter action=issue returns 1');
eq(issues[0].action, 'issue', 'returned row is an issue');

const cadetActs = await Storage.audit.list({ action: 'cadet_add' });
eq(cadetActs.length, 1, 'filter action=cadet_add returns 1');

const all = await Storage.audit.list({ action: 'all' });
eq(all.length, 8, 'filter action=all returns everything');

// -----------------------------------------------------------------------------
console.log('\n[3] Storage.audit.list search across desc/user/action');
const r1 = await Storage.audit.list({ search: 'SMITH' });
expect(r1.length === 4, `'SMITH' matches 4 rows (cadet_add, issue, return, cadet_update) — got ${r1.length}`);

const r2 = await Storage.audit.list({ search: 'unknown' });
eq(r2.length, 1, "'unknown' matches the failed-login row");

const r3 = await Storage.audit.list({ search: 'webbing' });
expect(r3.length === 3, `'webbing' (case-insensitive) matches 3 rows — got ${r3.length}`);

// -----------------------------------------------------------------------------
console.log('\n[4] Ordering and limit');
const desc = await Storage.audit.list({ order: 'desc' });
const asc  = await Storage.audit.list({ order: 'asc' });
expect(desc[0].seq > desc[desc.length - 1].seq, 'desc: first seq > last seq');
expect(asc[0].seq < asc[asc.length - 1].seq,    'asc: first seq < last seq');
eq(asc[0].action, 'login', 'asc first row is the login (oldest)');

const limited = await Storage.audit.list({ limit: 3 });
eq(limited.length, 3, 'limit:3 returns 3 rows');

// -----------------------------------------------------------------------------
console.log('\n[5] Distinct actions discovery (drives the filter dropdown)');
const allRows = await Storage.audit.list({ order: 'desc' });
const distinct = [...new Set(allRows.map((r) => r.action))].sort();
eq(distinct, [
  'add', 'cadet_add', 'cadet_update', 'issue',
  'login', 'login_failed', 'pin_change', 'return',
], 'distinct actions match what we appended');

// -----------------------------------------------------------------------------
console.log('\n[6] Storage.audit.verify on a clean chain returns ok');
const v1 = await Storage.audit.verify();
eq(v1.ok, true, 'clean chain verifies');
eq(v1.count, 8, 'count=8');
expect(v1.brokenAt === undefined || v1.brokenAt === null, 'no brokenAt on clean chain');

// -----------------------------------------------------------------------------
console.log('\n[7] Tamper with a row directly — verify reports the break');
// Open the raw IndexedDB and modify a row's desc field. This simulates an
// attacker editing the database file. The row's hash will no longer match
// what HMAC computes from the (modified) content.
const dbName = Storage.getDbName();
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open(dbName);
  req.onsuccess = () => resolve(req.result);
  req.onerror   = () => reject(req.error);
});

// Find seq=4 (the issue row) and tamper.
const tx = db.transaction('audit', 'readwrite');
const store = tx.objectStore('audit');
const tampered = await new Promise((resolve, reject) => {
  const req = store.get(4);
  req.onsuccess = () => resolve(req.result);
  req.onerror   = () => reject(req.error);
});
expect(tampered != null, `seq=4 row exists (action=${tampered?.action})`);
tampered.desc = 'TAMPERED: This was not the original description';
store.put(tampered);
await new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror    = reject;
});
db.close();

const v2 = await Storage.audit.verify();
eq(v2.ok, false,  'tampered chain reports ok=false');
eq(v2.brokenAt, 4, 'brokenAt points at the tampered seq');
expect(typeof v2.reason === 'string' && v2.reason.length > 0,
  `reason is non-empty: ${JSON.stringify(v2.reason)}`);

// -----------------------------------------------------------------------------
console.log('\n[8] After tampering, append still works (chain forks but new entries chain from current tail)');
// The append API reads the LAST entry's hash and chains from it. So new
// appends after tampering work, but verify will continue to fail because
// the original break-point is still in history.
await Storage.audit.append({ action: 'logout', user: 'admin', desc: 'Logout.' });
const v3 = await Storage.audit.verify();
eq(v3.ok, false, 'verify still fails after appending more entries (the original break is still in history)');
eq(v3.brokenAt, 4, 'brokenAt still points at the original break');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
