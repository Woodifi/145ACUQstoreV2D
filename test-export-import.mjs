// Headless smoke test — runs the same Storage code the UI runs, without
// the UI. Validates: exportAll → wipe → importAll roundtrip preserves
// items / photos / audit, and the audit chain re-verifies after import.
//
// Mirrors what _doExportData and _performImport call in settings.js, plus
// what the test harness (Tests/test-harness.html) already exercises in the
// browser. Running it here gives confidence before delivery.

import 'fake-indexeddb/auto';
// Polyfills missing in older Node — present in 20+ but we set up defensively
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.Blob) {
  const { Blob: NodeBlob } = await import('node:buffer');
  globalThis.Blob = NodeBlob;
}
if (!globalThis.FileReader) {
  // Minimal FileReader for _blobToB64 — only readAsDataURL with onload.
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type};base64,${b64}`;
        if (this.onload) this.onload();
      }).catch((err) => {
        this.error = err;
        if (this.onerror) this.onerror();
      });
    }
  };
}

const Storage = await import('./src/storage.js');

// ---------- helpers ----------
let pass = 0, fail = 0;
function ok(msg)  { console.log('  ✓', msg); pass++; }
function bad(msg) { console.log('  ✗', msg); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(actual, expected, msg) {
  if (actual === expected) ok(`${msg} (= ${JSON.stringify(actual)})`);
  else bad(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------- run ----------
console.log('Initialising storage...');
await Storage.init({ dbName: 'qstore_test_export_import' });

console.log('\n[1] Seed data');
await Storage.items.put({
  id: 'I1', nsn: '8470-66-001-0001', cat: 'Uniform', name: 'Slouch hat',
  authQty: 100, onHand: 95, onLoan: 5, unsvc: 0, condition: 'serviceable',
});
await Storage.photos.put('I1', new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/jpeg' }));
await Storage.users.put({
  id: 'usr-1', name: 'Test CO', username: 'test', role: 'co',
  pinHash: '$argon2id$v=19$m=65536,t=3,p=1$AAAA$AAAA',
  pinHashAlgorithm: 'argon2id', svcNo: '', lastLogin: null,
  createdAt: new Date().toISOString(),
});
await Storage.audit.append({ action: 'add', user: 'system', desc: 'Seed item' });
await Storage.audit.append({ action: 'add', user: 'system', desc: 'Seed user' });
await Storage.settings.set('unitName', '145 ACU Test');
await Storage.settings.set('unitCode', '145ACU-TEST');
ok('seed OK');

console.log('\n[2] Audit chain verifies before export');
const v1 = await Storage.audit.verify();
expect(v1.ok, `chain valid pre-export (count=${v1.count})`);

console.log('\n[3] Export builds a complete snapshot');
const snapshot = await Storage.exportAll();
eq(snapshot.schemaVersion, 2, 'schemaVersion');
expect(typeof snapshot.exportedAt === 'string' && snapshot.exportedAt.includes('T'),
  'exportedAt is ISO');
expect(snapshot.items.length === 1, 'items present');
expect(snapshot.photos.length === 1, 'photos present (as base64)');
expect(typeof snapshot.photos[0].base64 === 'string' && snapshot.photos[0].base64.length > 0,
  'photo base64 non-empty');
expect(snapshot.users.length === 1, 'users present');
expect(snapshot.audit.length >= 2, 'audit entries present');
expect(snapshot.meta && snapshot.meta.length > 0, 'meta block present (auditKey + installId)');
const auditKeyEntry = snapshot.meta.find((m) => m.key === 'auditKey');
expect(auditKeyEntry && typeof auditKeyEntry.value === 'string', 'auditKey present in meta');

console.log('\n[4] Stringifying snapshot for download (what the export button does)');
const json = JSON.stringify(snapshot);
expect(json.length > 100, `JSON serialises (${json.length} bytes)`);

console.log('\n[5] Wipe + reimport from the parsed string');
const reparsed = JSON.parse(json);
await Storage.wipe({ keepMeta: true });
eq(await Storage.items.count(), 0, 'wipe cleared items');
await Storage.importAll(reparsed);
const item = await Storage.items.get('I1');
eq(item?.name, 'Slouch hat', 'item restored');
const photo = await Storage.photos.get('I1');
expect(photo instanceof Blob, 'photo is a Blob');
const bytes = new Uint8Array(await photo.arrayBuffer());
eq(bytes[0], 1, 'photo byte 0');
eq(bytes[4], 5, 'photo byte 4');
const user = await Storage.users.get('usr-1');
eq(user?.name, 'Test CO', 'user restored');

console.log('\n[6] Audit chain still verifies after roundtrip');
const v2 = await Storage.audit.verify();
expect(v2.ok, `chain valid post-import (count=${v2.count}; brokenAt=${v2.brokenAt || 'n/a'})`);

console.log('\n[7] Append after import (simulates the data_imported audit entry)');
const appended = await Storage.audit.append({
  action: 'data_imported', user: 'test', desc: 'Restore test',
});
expect(appended.seq > 0, `appended seq=${appended.seq}`);
const v3 = await Storage.audit.verify();
expect(v3.ok, `chain valid after appending (count=${v3.count}; brokenAt=${v3.brokenAt || 'n/a'})`);

console.log('\n[8] Schema-mismatch import is rejected');
let threw = false;
try {
  await Storage.importAll({ schemaVersion: 999 });
} catch (err) {
  threw = err.message.includes('newer version') || err.message.includes('schema');
}
expect(threw, 'importAll rejects bad schemaVersion');

console.log('\n[9] Filename helper produces a safe slug');
const settings = await Storage.settings.getAll();
const unitTag = (settings.unitCode || settings.unitName || 'qstore')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'qstore';
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const filename = `qstore-backup-${unitTag}-${stamp}.json`;
expect(/^qstore-backup-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(filename),
  `filename: ${filename}`);

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
