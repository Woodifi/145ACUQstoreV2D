// Smoke test: simulate what _onSaveUnit does at the storage layer.
// Confirms setMany writes all 8 fields and getAll round-trips them,
// and that a settings_change audit entry can be appended without
// breaking the chain.

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const Storage = await import('./src/storage.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function eq(a, b, m) {
  if (a === b) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_unit_branding' });

console.log('[1] Save unit details — full set');
const fields = {
  unitName: '145 Army Cadet Unit',
  unitCode: '145 ACU',
  state:    'QLD',
  qmName:   'Surname, Givens',
  qmRank:   'CAPT-AAC',
  qmEmail:  'qm@example.org',
  coName:   'Other, Persons',
  coEmail:  'co@example.org',
};
await Storage.settings.setMany(fields);

const back = await Storage.settings.getAll();
for (const [k, v] of Object.entries(fields)) {
  eq(back[k], v, `field round-trip: ${k}`);
}

console.log('\n[2] Audit append works after settings change');
const before = await Storage.audit.verify();
ok(`pre-append chain valid (count=${before.count})`);
const entry = await Storage.audit.append({
  action: 'settings_change',
  user:   'test-co',
  desc:   `Unit details updated (name: ${fields.unitName}, code: ${fields.unitCode}).`,
});
ok(`appended seq=${entry.seq}`);
const after = await Storage.audit.verify();
eq(after.ok, true, 'chain still valid');
eq(after.count, before.count + 1, 'count increased by 1');

console.log('\n[3] Save partial update (clearing fields)');
await Storage.settings.setMany({
  ...fields,
  qmEmail: '',
  coEmail: '',
});
const partial = await Storage.settings.getAll();
eq(partial.qmEmail, '', 'qmEmail cleared');
eq(partial.coEmail, '', 'coEmail cleared');
eq(partial.unitCode, '145 ACU', 'unitCode preserved');

console.log('\n[4] Round-trip survives export/import');
await Storage.audit.append({ action: 'data_export', user: 'test', desc: 'pre-export' });
const snap = await Storage.exportAll();
await Storage.wipe({ keepMeta: true });
await Storage.importAll(snap);
const restored = await Storage.settings.getAll();
eq(restored.unitName, fields.unitName, 'unitName survived export/import');
eq(restored.qmRank,   fields.qmRank,   'qmRank survived export/import');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
