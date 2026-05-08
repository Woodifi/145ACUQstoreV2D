// Smoke tests for src/csv-import.js
//
// Covers:
//   - Header alias mapping (variant column names normalise to canonical)
//   - Required-field validation (missing name/cat/svcNo/surname)
//   - Row-level warnings (bad numerics, unknown condition, NSN format)
//   - new vs update detection (by id, by NSN, by svcNo)
//   - Commit merge behaviour (existing fields preserved on update)
//   - PapaParse handles Excel-style quoted fields with embedded newlines

import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.sessionStorage) {
  const _store = new Map();
  globalThis.sessionStorage = {
    getItem(k)    { return _store.has(k) ? _store.get(k) : null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
  };
}

const Storage = await import('./src/storage.js');
const Csv     = await import('./src/csv-import.js');

let pass = 0, fail = 0;
function ok(m)  { console.log('  ✓', m); pass++; }
function bad(m) { console.log('  ✗', m); fail++; }
function expect(cond, msg) { cond ? ok(msg) : bad(msg); }
function eq(a, b, m) {
  if (JSON.stringify(a) === JSON.stringify(b)) ok(`${m} (= ${JSON.stringify(a)})`);
  else bad(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

await Storage.init({ dbName: 'qstore_test_csv_import' });

// =============================================================================
// ITEMS
// =============================================================================

console.log('[1] parseItemsCsv: canonical headers');
{
  const csv = `name,cat,nsn,onHand,unsvc,authQty,condition,loc,notes
Slouch Hat,Headwear,8470-66-001-0001,50,0,60,serviceable,Bay 1,
Webbing Belt,Equipment,8465-66-001-0002,40,5,50,serviceable,Bay 2,Spare parts on shelf B`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.errors.length, 0, 'no file-level errors');
  eq(result.rows.length, 2, '2 data rows parsed');
  eq(result.rows[0].name, 'Slouch Hat', 'name on row 0');
  eq(result.rows[0].onHand, 50, 'onHand parsed as number');
  eq(result.rows[0]._status, 'new', 'first import → new');
  eq(result.rows[0].onLoan, 0, 'new row gets default onLoan=0');
}

// -----------------------------------------------------------------------------
console.log('\n[2] parseItemsCsv: header aliases (Item, Category, On Hand, Auth)');
{
  const csv = `Item,Category,Stock,Auth,Cond
Bush Hat,Headwear,30,30,serviceable`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.errors.length, 0, 'aliases recognised');
  eq(result.rows.length, 1, '1 row');
  eq(result.rows[0].name, 'Bush Hat', '"Item" mapped to name');
  eq(result.rows[0].cat,  'Headwear', '"Category" mapped to cat');
  eq(result.rows[0].onHand, 30, '"Stock" mapped to onHand');
  eq(result.rows[0].authQty, 30, '"Auth" mapped to authQty');
  eq(result.rows[0].condition, 'serviceable', '"Cond" mapped to condition');
}

// -----------------------------------------------------------------------------
console.log('\n[3] parseItemsCsv: missing required columns');
{
  const csv = `nsn,onHand
8470-66-001-0099,5`;
  const result = await Csv.parseItemsCsv(csv);
  expect(result.errors.length >= 2, `errors reported (got ${result.errors.length})`);
  expect(result.errors.some(e => /name/i.test(e)), 'errors mention "name"');
  expect(result.errors.some(e => /cat/i.test(e)),  'errors mention "cat"');
  eq(result.rows.length, 0, 'no rows returned when file invalid');
}

// -----------------------------------------------------------------------------
console.log('\n[4] parseItemsCsv: row-level warnings (bad numerics, unknown condition)');
{
  const csv = `name,cat,onHand,unsvc,condition
Test Item,Test,not-a-number,abc,potato`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.errors.length, 0, 'file parses');
  eq(result.rows.length, 1, '1 row');
  const row = result.rows[0];
  eq(row.onHand, 0, 'bad onHand defaults to 0');
  eq(row.unsvc,  0, 'bad unsvc defaults to 0');
  eq(row.condition, 'serviceable', 'unknown condition defaults to serviceable');
  expect(row._warnings.length >= 3, `at least 3 warnings (got ${row._warnings.length})`);
  expect(row._status !== 'invalid', 'row is still importable, not invalid');
}

// -----------------------------------------------------------------------------
console.log('\n[5] parseItemsCsv: row marked invalid when required field missing');
{
  const csv = `name,cat
,Headwear
Real Item,Test`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.rows.length, 2, '2 rows attempted');
  eq(result.rows[0]._status, 'invalid', 'row with empty name is invalid');
  eq(result.rows[1]._status, 'new', 'second row is fine');
}

// -----------------------------------------------------------------------------
console.log('\n[6] parseItemsCsv: existing item by id → update');
{
  // Pre-populate.
  await Storage.items.put({
    id: 'i-existing-1', name: 'Old Name', cat: 'OldCat',
    onHand: 1, onLoan: 5, unsvc: 0, authQty: 1, hasPhoto: true,
  });
  const csv = `id,name,cat,onHand,authQty
i-existing-1,New Name,NewCat,99,100`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.rows[0]._status, 'update', 'matched by id → update');
  eq(result.rows[0].id, 'i-existing-1', 'id preserved');
  eq(result.rows[0].name, 'New Name', 'name updated');
}

// -----------------------------------------------------------------------------
console.log('\n[7] parseItemsCsv: existing item by NSN (no id) → update + adopt id');
{
  await Storage.items.put({
    id: 'i-existing-2', name: 'Stable Item', nsn: '8470-66-001-0042',
    cat: 'Test', onHand: 1, onLoan: 0, unsvc: 0, authQty: 1, hasPhoto: false,
  });
  const csv = `name,cat,nsn,onHand
Updated Name,Test,8470-66-001-0042,77`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.rows[0]._status, 'update', 'matched by NSN → update');
  eq(result.rows[0].id, 'i-existing-2', 'existing id adopted into the upsert payload');
}

// -----------------------------------------------------------------------------
console.log('\n[8] parseItemsCsv: NSN warning, kept as-is');
{
  const csv = `name,cat,nsn
Local Item,Test,LOCAL-001`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.rows[0].nsn, 'LOCAL-001', 'non-standard NSN preserved');
  expect(result.rows[0]._warnings.some(w => /NSN.*format/i.test(w)),
    'NSN format warning present');
}

// -----------------------------------------------------------------------------
console.log('\n[9] commitItems: insert path');
{
  await Storage.items.put({ id: 'i-pre', name: 'Pre', cat: 'X', onHand: 0, onLoan: 0, unsvc: 0, authQty: 0 });
  const csv = `name,cat,onHand
Brand New,Headwear,10`;
  const result = await Csv.parseItemsCsv(csv);
  const before = (await Storage.items.list()).length;
  const counts = await Csv.commitItems(result.rows);
  const after  = (await Storage.items.list()).length;
  eq(counts.inserted, 1, '1 inserted');
  eq(counts.updated,  0, '0 updated');
  eq(after - before, 1, 'item count grew by 1');
}

// -----------------------------------------------------------------------------
console.log('\n[10] commitItems: update preserves onLoan / hasPhoto / createdAt');
{
  await Storage.items.put({
    id: 'i-merge', name: 'Original', cat: 'Test', nsn: '8470-66-009-0001',
    onHand: 5, onLoan: 3, unsvc: 0, authQty: 5,
    hasPhoto: true, createdAt: '2026-01-15T08:00:00Z',
  });
  const csv = `id,name,cat,onHand,authQty
i-merge,Renamed,Test,99,100`;
  const result = await Csv.parseItemsCsv(csv);
  await Csv.commitItems(result.rows);
  const after = await Storage.items.get('i-merge');
  eq(after.name,      'Renamed',  'name updated');
  eq(after.onHand,    99,         'onHand updated');
  eq(after.authQty,   100,        'authQty updated');
  eq(after.onLoan,    3,          'onLoan PRESERVED from existing');
  eq(after.hasPhoto,  true,       'hasPhoto PRESERVED from existing');
  eq(after.createdAt, '2026-01-15T08:00:00Z', 'createdAt PRESERVED');
  expect(after.updatedAt, 'updatedAt set on merge');
}

// =============================================================================
// CADETS
// =============================================================================

console.log('\n[11] parseCadetsCsv: canonical headers');
{
  const csv = `svcNo,surname,given,rank,plt,active
8512345,SMITH,John,CDT,1,true
8512346,JONES,Mary,CDTLCPL,2,true`;
  const result = await Csv.parseCadetsCsv(csv);
  eq(result.errors.length, 0, 'no errors');
  eq(result.rows.length, 2, '2 rows');
  eq(result.rows[0].surname, 'SMITH', 'surname parsed');
  eq(result.rows[0].rank,    'CDT',   'rank kept');
  eq(result.rows[0].personType, 'cadet', 'CDT → cadet');
}

// -----------------------------------------------------------------------------
console.log('\n[12] parseCadetsCsv: rank canonicalisation + personType inference');
{
  const csv = `svcNo,surname,given,rank
8512347,BROWN,Sarah,Cdt
8512348,GREY,Tim,Captain
8512349,WHITE,Sue,WO2`;
  const result = await Csv.parseCadetsCsv(csv);
  eq(result.rows[0].rank, 'CDT',  'lowercase Cdt canonicalised to CDT');
  eq(result.rows[0].personType, 'cadet', 'CDT → cadet');
  expect(result.rows[1].personType === 'staff' || result.rows[2].personType === 'staff',
    'at least one row inferred as staff');
}

// -----------------------------------------------------------------------------
console.log('\n[13] parseCadetsCsv: missing required columns');
{
  const csv = `surname,given
SMITH,John`;
  const result = await Csv.parseCadetsCsv(csv);
  expect(result.errors.length >= 1, 'errors reported');
  expect(result.errors.some(e => /svcNo/i.test(e)), 'errors mention svcNo');
}

// -----------------------------------------------------------------------------
console.log('\n[14] parseCadetsCsv: active flag accepts variants');
{
  const csv = `svcNo,surname,active
8512360,A,TRUE
8512361,B,yes
8512362,C,no
8512363,D,0
8512364,E,1
8512365,F,maybe
8512366,G,`;
  const result = await Csv.parseCadetsCsv(csv);
  eq(result.rows[0].active, true,  'TRUE → true');
  eq(result.rows[1].active, true,  'yes → true');
  eq(result.rows[2].active, false, 'no → false');
  eq(result.rows[3].active, false, '0 → false');
  eq(result.rows[4].active, true,  '1 → true');
  eq(result.rows[5].active, true,  'maybe → defaults true with warning');
  eq(result.rows[6].active, true,  'blank → defaults true');
  expect(result.rows[5]._warnings.length > 0, 'unrecognised "maybe" warned');
}

// -----------------------------------------------------------------------------
console.log('\n[15] parseCadetsCsv: existing svcNo → update');
{
  await Storage.cadets.put({
    svcNo: '8512370', surname: 'OLD', given: 'Name',
    rank: 'CDT', plt: '1', personType: 'cadet', active: true,
  });
  const csv = `svcNo,surname,given,rank
8512370,NEW,Name,CDTLCPL`;
  const result = await Csv.parseCadetsCsv(csv);
  eq(result.rows[0]._status, 'update', 'matched svcNo → update');
}

// -----------------------------------------------------------------------------
console.log('\n[16] PapaParse handles Excel quoted fields with commas inside');
{
  const csv = `name,cat,notes
"Pack, Field","Equipment","With, embedded, commas"`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.rows.length, 1, '1 row');
  eq(result.rows[0].name,  'Pack, Field', 'name with embedded comma');
  eq(result.rows[0].notes, 'With, embedded, commas', 'notes with embedded commas');
}

// -----------------------------------------------------------------------------
console.log('\n[17] Unrecognised columns surface in preview');
{
  const csv = `name,cat,SomeWeirdField,Custom Excel Column
Test,Test,abc,def`;
  const result = await Csv.parseItemsCsv(csv);
  eq(result.errors.length, 0, 'no fatal errors');
  expect(result.columns.unrecognised.length === 2,
    `2 unrecognised columns (got ${result.columns.unrecognised.length}: ${result.columns.unrecognised.join(', ')})`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
