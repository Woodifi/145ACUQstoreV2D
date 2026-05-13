// Smoke test: ranks.js produces the same outputs the old in-line versions
// did, on the test data the migration test harness uses.

import {
  normaliseRankInput,
  normalizeRank,
  inferPersonType,
  STAFF_RANKS_CANONICAL,
  CADET_RANKS,
} from './src/ranks.js';

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { pass++; console.log(`  ✓ ${msg} (${JSON.stringify(actual)})`); }
  else { fail++; console.log(`  ✗ ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log('normalizeRank — officer base ranks gain -AAC');
eq(normalizeRank('CAPT'),    'CAPT-AAC', 'CAPT');
eq(normalizeRank('capt.'),   'CAPT-AAC', 'capt. (lowercased + dot)');
eq(normalizeRank(' MAJ '),   'MAJ-AAC',  'MAJ with whitespace');
eq(normalizeRank('2LT'),     '2LT-AAC',  '2LT');

console.log('\nnormalizeRank — already-canonical inputs unchanged');
eq(normalizeRank('CAPT-AAC'), 'CAPT-AAC', 'CAPT-AAC idempotent');
eq(normalizeRank('DAH'),      'DAH',      'DAH');

console.log('\nnormalizeRank — cadet ranks unchanged');
eq(normalizeRank('CDT'),     'CDT',     'CDT');
eq(normalizeRank('CDTLCPL'), 'CDTLCPL', 'CDTLCPL');
eq(normalizeRank('UO'),      'UO',      'UO');
eq(normalizeRank('WO2'),     'WO2',     'WO2 (cadet rank)');

console.log('\nnormalizeRank — empty/null preserved');
eq(normalizeRank(''),        '',        'empty string');
eq(normalizeRank(null),      null,      'null');
eq(normalizeRank(undefined), undefined, 'undefined');

console.log('\ninferPersonType — staff identification');
eq(inferPersonType('CAPT'),     'staff', 'CAPT (legacy bare officer)');
eq(inferPersonType('CAPT-AAC'), 'staff', 'CAPT-AAC');
eq(inferPersonType('DAH'),      'staff', 'DAH');
eq(inferPersonType('LTCOL'),    'staff', 'LTCOL legacy');

console.log('\ninferPersonType — cadet identification');
eq(inferPersonType('CDT'),     'cadet', 'CDT');
eq(inferPersonType('CDTLCPL'), 'cadet', 'CDTLCPL');
eq(inferPersonType('UO'),      'cadet', 'UO');

console.log('\ninferPersonType — defaults');
eq(inferPersonType(''),        'cadet', 'empty');
eq(inferPersonType(null),      'cadet', 'null');
eq(inferPersonType('UNKNOWN'), 'cadet', 'unknown defaults to cadet');

console.log('\nnormaliseRankInput — strip-and-uppercase');
eq(normaliseRankInput(' capt. '), 'CAPT', 'spaces and dots stripped');
eq(normaliseRankInput('cdt sgt'), 'CDTSGT', 'inner whitespace stripped');

console.log('\nVocabulary integrity');
eq(STAFF_RANKS_CANONICAL.includes('DAH'),     true, 'DAH in staff canonical');
eq(STAFF_RANKS_CANONICAL.includes('CAPT-AAC'), true, 'CAPT-AAC in staff canonical');
eq(STAFF_RANKS_CANONICAL.includes('CAPT'),     false, 'bare CAPT NOT in canonical');
eq(CADET_RANKS.includes('UO'),                true, 'UO is a cadet rank');
eq(CADET_RANKS.includes('CDT'),               true, 'CDT is a cadet rank');

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
