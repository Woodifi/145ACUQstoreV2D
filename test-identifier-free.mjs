// Identifier-free build — the storage layer must not accept a person.
//
// HQ AAC ICT, 17 July 2026: "So long as you're not carrying PII and it's purely
// for asset tracking, I'd see no issue." That is a CONDITION. If a loan reaches
// storage with a borrower on it, the tool is carrying PII and the basis for HQ's
// position is gone — so storage fails closed rather than quietly encrypting it.
//
// These tests exist because the failure mode is silent: nothing breaks, nothing
// logs, the field is just there. That is precisely how piiKey ended up in the
// OneDrive blob for months.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) {
  const { Blob: NodeBlob } = await import('node:buffer');
  globalThis.Blob = NodeBlob;
}
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const Storage = await import('./src/storage.js');
const PII     = await import('./src/pii.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.error(`  FAIL ${name}`); }
}
async function throws(name, fn, match) {
  try { await fn(); ok(name, false); }
  catch (e) { ok(name, !match || match.test(e.message)); }
}

function rawRead(storeName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('qstore');
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

console.log('=== identifier-free storage ===');

await Storage.init();

// --- loans no longer declare a person as PII -------------------------------
ok('PII_FIELDS_LOANS is empty', Array.isArray(PII.PII_FIELDS_LOANS)
  && PII.PII_FIELDS_LOANS.length === 0);
ok('borrowerName is not a loan PII field', !PII.PII_FIELDS_LOANS.includes('borrowerName'));

// --- the shape this build writes -------------------------------------------
await Storage.loans.put({
  ref: 'LN-0001', itemId: 'IT-1', qty: 1, active: true,
  location: 'individual', issueNo: 'ISS-0042',
  issuedAt: new Date().toISOString(), dueDate: null,
});
await Storage.loans.put({
  ref: 'LN-0002', itemId: 'IT-2', qty: 6, active: true,
  location: 'Bivouac area', issueNo: 'ISS-0043',
  issuedAt: new Date().toISOString(), dueDate: null,
});

const l1 = await Storage.loans.get('LN-0001');
ok('loan to a person records location: individual', l1.location === 'individual');
ok('loan to a person records only an issue number', l1.issueNo === 'ISS-0042');
ok('loan carries no borrower name', !('borrowerName' in l1));
ok('loan carries no borrower service number', !('borrowerSvc' in l1));
ok('loan to an activity records the activity', (await Storage.loans.get('LN-0002')).location === 'Bivouac area');

// --- fail closed: a person must not reach storage --------------------------
await throws('put() rejects a loan carrying borrowerName',
  () => Storage.loans.put({ ref: 'LN-9', itemId: 'IT-1', borrowerName: 'CDT Smith J.' }),
  /person identifier/i);
await throws('put() rejects a loan carrying borrowerSvc',
  () => Storage.loans.put({ ref: 'LN-9', itemId: 'IT-1', borrowerSvc: '8012345' }),
  /person identifier/i);
await throws('put() rejects both together',
  () => Storage.loans.put({ ref: 'LN-9', itemId: 'IT-1', borrowerName: 'X', borrowerSvc: 'Y' }),
  /person identifier/i);
ok('rejected loans were not written', (await Storage.loans.get('LN-9')) === null);

// --- the wire test: nothing personal in the stored bytes -------------------
const raw = await rawRead('loans');
const wire = JSON.stringify(raw);
ok('stored loans leak no borrower name', !/Smith/i.test(wire));
ok('stored loans leak no service number', !/8012345/.test(wire));
ok('stored loans contain the issue reference', wire.includes('ISS-0042'));

// --- issue lookup replaces cadet lookup ------------------------------------
ok('listForCadet is gone', typeof Storage.loans.listForCadet === 'undefined');
ok('listForIssue exists', typeof Storage.loans.listForIssue === 'function');
const byIssue = await Storage.loans.listForIssue('ISS-0042');
ok('listForIssue finds the loan', byIssue.length === 1 && byIssue[0].ref === 'LN-0001');
ok('listForIssue does not bleed across issues',
  (await Storage.loans.listForIssue('ISS-0043')).every((l) => l.ref === 'LN-0002'));

// --- active/list still work (the tool must remain useful) ------------------
ok('listActive still works', (await Storage.loans.listActive()).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
