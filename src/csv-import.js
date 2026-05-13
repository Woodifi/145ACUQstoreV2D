// =============================================================================
// QStore IMS v2 — CSV import (core, DOM-free)
// =============================================================================
// Pure functions for CSV → typed-rows pipeline. No DOM. No storage writes.
// The settings UI calls these to: parse the file, build a preview, then
// (after user confirmation) submit the validated rows back through this
// module to commit them via Storage.
//
// Two domain functions:
//   parseItemsCsv(text)   → { rows, columns, errors }
//   parseCadetsCsv(text)  → { rows, columns, errors }
//
// Each row in `rows` is a normalised object ready for storage.put(), plus
// metadata: sourceLine, status ('new' | 'update' | 'invalid'), warnings.
//
// Why a separate module from the UI:
// - Test the parsing without spinning up a browser
// - Lets a future "watch a OneDrive folder for CSV drops" workflow reuse
//   the same validators
// - The UI module is thin glue; this is where the schema decisions live
//
// Why we use PapaParse:
// CSV is a swamp. Quoted fields with embedded newlines, mixed line endings,
// BOM markers from Excel, locale-specific number formatting. A hand-rolled
// parser would silently drop rows and frustrate users when their Excel
// export "doesn't work". PapaParse is 19KB minified, well-tested, and the
// QM workflow rewards reliability over bundle size.
// =============================================================================

import Papa from 'papaparse';
import * as Storage from './storage.js';
import { normalizeRank } from './ranks.js';
import { CONDITIONS } from './conditions.js';

// -----------------------------------------------------------------------------
// Column-name normalisation
// -----------------------------------------------------------------------------
// Header rows in the wild are inconsistent ("On Hand", "On hand", "OnHand",
// "OH"). We map known variants to canonical schema field names. Unknown
// columns are kept in the parse but ignored for storage — surfaced in the
// preview so the user knows what was dropped.

const ITEM_COLUMN_ALIASES = {
  // canonical → list of aliases (lowercased, whitespace stripped)
  // Field names match the v2 item schema in src/ui/inventory.js — extra
  // columns in the CSV (e.g. 'unit', 'lastStocktakeDate') are tolerated
  // but ignored, surfacing in the preview's unrecognised list.
  id:         ['id', 'itemid', 'sku'],
  nsn:        ['nsn', 'partnumber', 'pn'],
  name:       ['name', 'itemname', 'item', 'description', 'desc'],
  cat:        ['cat', 'category', 'group'],
  onHand:     ['onhand', 'oh', 'qty', 'quantity', 'stock'],
  unsvc:      ['unsvc', 'unserviceable', 'unservqty'],
  authQty:    ['authqty', 'authorised', 'authorized', 'auth', 'maxqty'],
  condition:  ['condition', 'cond', 'state'],
  notes:      ['notes', 'comment', 'comments', 'remarks'],
  loc:        ['loc', 'location', 'shelf', 'bin'],
};

const CADET_COLUMN_ALIASES = {
  // Field names match the v2 cadet schema in src/ui/cadets.js. The schema
  // is intentionally lean (no phone/dob/joinDate) — see cadets.js for the
  // rationale. CSV columns for those will be tolerated but ignored.
  svcNo:      ['svcno', 'serviceno', 'servicenumber', 'no', 'number'],
  surname:    ['surname', 'lastname', 'familyname', 'last'],
  given:      ['given', 'givenname', 'givennames', 'firstname', 'first'],
  rank:       ['rank'],
  plt:        ['plt', 'platoon'],
  email:      ['email', 'emailaddress'],
  active:     ['active', 'status'],
  notes:      ['notes', 'comment', 'comments'],
};

// Build reverse lookup at module load: alias → canonical.
function _buildLookup(aliases) {
  const m = new Map();
  for (const canonical of Object.keys(aliases)) {
    m.set(canonical.toLowerCase(), canonical);
    for (const alias of aliases[canonical]) {
      m.set(alias, canonical);
    }
  }
  return m;
}
const ITEM_LOOKUP  = _buildLookup(ITEM_COLUMN_ALIASES);
const CADET_LOOKUP = _buildLookup(CADET_COLUMN_ALIASES);

function _normaliseHeader(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// -----------------------------------------------------------------------------
// Public: parse + validate
// -----------------------------------------------------------------------------

/**
 * Parse a CSV text blob containing inventory items.
 *
 * @param {string} text  Raw CSV content.
 * @returns {Promise<{rows: Array, columns: ColumnReport, errors: Array}>}
 *
 *   rows: Array of row objects. Each row has:
 *     { _line, _status, _warnings, ...itemFields }
 *     - _line: source line number (2-based — line 1 is header)
 *     - _status: 'new' | 'update' | 'invalid'
 *     - _warnings: Array of human-readable warning strings
 *
 *   columns: { mapped: {canonical: header}, unrecognised: Array<header> }
 *
 *   errors: Array of file-level errors (parse failures, missing required
 *     headers). If errors.length > 0, rows may still be present but should
 *     not be committed.
 */
export async function parseItemsCsv(text) {
  const parsed = _parseCsv(text);
  if (parsed.fatalError) {
    return { rows: [], columns: { mapped: {}, unrecognised: [] }, errors: [parsed.fatalError] };
  }

  const { headers, rows: rawRows } = parsed;
  const columnMap = _mapHeaders(headers, ITEM_LOOKUP);
  const errors = [];

  // Using `== null` because the mapped value is a column INDEX. Index 0
  // is a valid first column; falsy checks would mistake "name in column 0"
  // for "name missing".
  if (columnMap.mapped.name == null) {
    errors.push('Missing required column: name (also accepts: itemname, item, description).');
  }
  if (columnMap.mapped.cat == null) {
    errors.push('Missing required column: cat (also accepts: category, group).');
  }

  if (errors.length > 0) {
    return { rows: [], columns: columnMap, errors };
  }

  // Pre-fetch existing items so we can mark new vs update.
  const existing = await Storage.items.list();
  const byId  = new Map(existing.map((i) => [String(i.id || '').trim(), i]));
  const byNsn = new Map(existing
    .filter((i) => i.nsn)
    .map((i) => [String(i.nsn).trim().toLowerCase(), i]));

  const rows = rawRows.map((raw, idx) => _validateItemRow(raw, idx, columnMap.mapped, byId, byNsn));
  return { rows, columns: columnMap, errors: [] };
}

/**
 * Parse a CSV text blob containing cadet records.
 * Same return shape as parseItemsCsv.
 */
export async function parseCadetsCsv(text) {
  const parsed = _parseCsv(text);
  if (parsed.fatalError) {
    return { rows: [], columns: { mapped: {}, unrecognised: [] }, errors: [parsed.fatalError] };
  }

  const { headers, rows: rawRows } = parsed;
  const columnMap = _mapHeaders(headers, CADET_LOOKUP);
  const errors = [];

  // See comment in parseItemsCsv re: == null vs falsy on column indexes.
  if (columnMap.mapped.svcNo == null) {
    errors.push('Missing required column: svcNo (also accepts: serviceNo, number).');
  }
  if (columnMap.mapped.surname == null) {
    errors.push('Missing required column: surname (also accepts: lastName, familyName).');
  }

  if (errors.length > 0) {
    return { rows: [], columns: columnMap, errors };
  }

  const existing = await Storage.cadets.list();
  const bySvcNo = new Map(existing.map((c) => [String(c.svcNo || '').trim(), c]));

  const rows = rawRows.map((raw, idx) => _validateCadetRow(raw, idx, columnMap.mapped, bySvcNo));
  return { rows, columns: columnMap, errors: [] };
}

// -----------------------------------------------------------------------------
// Commit — caller passes back the validated rows (or a filtered subset)
// -----------------------------------------------------------------------------

/**
 * Write validated item rows to storage. Skips rows with status 'invalid'.
 * Returns counts so the UI can show a summary.
 */
export async function commitItems(rows) {
  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    if (row._status === 'invalid') { skipped++; continue; }
    // Strip metadata fields before persisting.
    const { _line, _status, _warnings, ...payload } = row;
    if (_status === 'update') {
      // Merge with existing so derived fields (onLoan, hasPhoto, createdAt)
      // survive the import. CSV doesn't carry these — overwriting blindly
      // would zero them out. Set updatedAt to mark the merge.
      const existing = await Storage.items.get(payload.id);
      if (existing) {
        await Storage.items.put({
          ...existing,
          ...payload,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // Row claimed update but the record was deleted between preview
        // and commit — fall through to insert.
        await Storage.items.put({
          ...payload,
          onLoan:    0,
          hasPhoto:  false,
          createdAt: new Date().toISOString(),
        });
      }
      updated++;
    } else {
      await Storage.items.put(payload);
      inserted++;
    }
  }
  return { inserted, updated, skipped };
}

export async function commitCadets(rows) {
  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    if (row._status === 'invalid') { skipped++; continue; }
    const { _line, _status, _warnings, ...payload } = row;
    if (_status === 'update') {
      const existing = await Storage.cadets.get(payload.svcNo);
      if (existing) {
        await Storage.cadets.put({
          ...existing,
          ...payload,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await Storage.cadets.put({
          ...payload,
          createdAt: new Date().toISOString(),
        });
      }
      updated++;
    } else {
      await Storage.cadets.put(payload);
      inserted++;
    }
  }
  return { inserted, updated, skipped };
}

// -----------------------------------------------------------------------------
// Internal: PapaParse wrapper
// -----------------------------------------------------------------------------

function _parseCsv(text) {
  // skipEmptyLines: 'greedy' drops rows that are empty OR whitespace-only.
  // Excel often emits trailing blank lines; without this they'd become
  // bogus "row 47 is invalid" errors.
  const result = Papa.parse(text, {
    header:           false,    // we handle headers manually for alias mapping
    skipEmptyLines:   'greedy',
    transform:        (v) => String(v).trim(),
  });

  if (result.errors && result.errors.length > 0) {
    // Catastrophic errors only — PapaParse reports row-level issues here too,
    // but we treat them as warnings unless the parse couldn't continue.
    const fatal = result.errors.find((e) => e.code === 'UndetectableDelimiter' || e.type === 'Quotes');
    if (fatal) {
      return { fatalError: `CSV parse failed: ${fatal.message}` };
    }
  }

  if (!result.data || result.data.length < 2) {
    return { fatalError: 'CSV is empty or has no data rows.' };
  }

  return {
    headers: result.data[0],
    rows:    result.data.slice(1),
  };
}

// -----------------------------------------------------------------------------
// Internal: header mapping
// -----------------------------------------------------------------------------

function _mapHeaders(headers, lookup) {
  const mapped = {};
  const unrecognised = [];
  headers.forEach((h, idx) => {
    const norm = _normaliseHeader(h);
    const canonical = lookup.get(norm);
    if (canonical) {
      // Store column INDEX so row lookup is by position not by original header.
      mapped[canonical] = idx;
    } else if (h) {
      unrecognised.push(h);
    }
  });
  return { mapped, unrecognised };
}

// -----------------------------------------------------------------------------
// Internal: row validation
// -----------------------------------------------------------------------------

function _validateItemRow(raw, idx, columnIdx, byId, byNsn) {
  const line = idx + 2;  // +1 for header, +1 for 1-indexing
  const warnings = [];
  const get = (canonical) => {
    const i = columnIdx[canonical];
    return i != null ? (raw[i] || '') : '';
  };

  const name = get('name').trim();
  const cat  = get('cat').trim();
  if (!name) {
    return { _line: line, _status: 'invalid', _warnings: ['Missing required field: name.'] };
  }
  if (!cat) {
    return { _line: line, _status: 'invalid', _warnings: ['Missing required field: cat.'] };
  }

  // Numeric fields with graceful fallback.
  const onHand  = _parseInt(get('onHand'),  warnings, 'onHand');
  const unsvc   = _parseInt(get('unsvc'),   warnings, 'unsvc');
  const authQty = _parseInt(get('authQty'), warnings, 'authQty');

  // Condition validation against canonical list.
  let condition = (get('condition') || 'serviceable').toLowerCase().trim();
  const validConditions = CONDITIONS.map((c) => c.value);
  if (!validConditions.includes(condition)) {
    warnings.push(`Unknown condition "${condition}", defaulted to "serviceable".`);
    condition = 'serviceable';
  }

  // NSN soft validation — warn on non-standard format but accept.
  const nsn = get('nsn').trim();
  if (nsn && !/^\d{4}-\d{2}-\d{3}-\d{4}$/.test(nsn)) {
    warnings.push(`NSN "${nsn}" is not in standard 4-2-3-4 format (kept as-is).`);
  }

  // Determine status. Match priority: explicit id > nsn match > new.
  let id = get('id').trim();
  let status = 'new';
  if (id && byId.has(id)) {
    status = 'update';
  } else if (nsn && byNsn.has(nsn.toLowerCase())) {
    const existing = byNsn.get(nsn.toLowerCase());
    id = id || existing.id;   // adopt the existing id for the upsert
    status = 'update';
  } else {
    // Generate id if missing — Storage.items.put requires one.
    id = id || _newItemId();
  }

  // Build the row in the schema shape that Storage.items.put() expects.
  // Defaults match what _saveAdd() in inventory.js writes for a manual
  // create — onLoan starts at 0 (it's derived from active loans, never
  // imported), hasPhoto false, createdAt is now.
  // For 'update' status we leave onLoan/hasPhoto/createdAt out of the
  // payload — commitItems merges with the existing record so those
  // fields are preserved from the previous row.
  const base = {
    _line:     line,
    _status:   status,
    _warnings: warnings,
    id, nsn, name, cat,
    onHand,
    unsvc,
    authQty,
    condition,
    loc:       get('loc')   || '',
    notes:     get('notes') || '',
  };
  if (status === 'new') {
    base.onLoan    = 0;
    base.hasPhoto  = false;
    base.createdAt = new Date().toISOString();
  }
  return base;
}

function _validateCadetRow(raw, idx, columnIdx, bySvcNo) {
  const line = idx + 2;
  const warnings = [];
  const get = (canonical) => {
    const i = columnIdx[canonical];
    return i != null ? (raw[i] || '') : '';
  };

  const svcNo   = get('svcNo').trim();
  const surname = get('surname').trim();
  if (!svcNo) {
    return { _line: line, _status: 'invalid', _warnings: ['Missing required field: svcNo.'] };
  }
  if (!surname) {
    return { _line: line, _status: 'invalid', _warnings: ['Missing required field: surname.'] };
  }

  // Service numbers should be reasonably numeric — warn if not, but accept.
  if (!/^\d{4,10}$/.test(svcNo)) {
    warnings.push(`svcNo "${svcNo}" is not 4-10 digits (kept as-is).`);
  }

  const rawRank = get('rank').trim();
  const rank = rawRank ? normalizeRank(rawRank) : '';
  if (rawRank && !rank) {
    warnings.push(`Rank "${rawRank}" not recognised — kept blank.`);
  }

  // active: accept TRUE/FALSE/yes/no/1/0; default true if blank.
  const activeRaw = get('active').toLowerCase().trim();
  const active = activeRaw === '' ? true
    : ['true', 'yes', 'y', '1', 'active'].includes(activeRaw) ? true
    : ['false', 'no', 'n', '0', 'inactive'].includes(activeRaw) ? false
    : true;
  if (activeRaw && !['true','yes','y','1','active','false','no','n','0','inactive'].includes(activeRaw)) {
    warnings.push(`active "${activeRaw}" not recognised — defaulted to true.`);
  }

  const status = bySvcNo.has(svcNo) ? 'update' : 'new';

  // Build the row in the v2 cadet schema. personType is derived from rank
  // the same way the manual add path and the migration both do, so manual
  // entry, v1-imported, and CSV-imported cadets all carry the same field
  // and the cadets list filters work consistently.
  const personType = _inferPersonType(rank);

  const base = {
    _line:     line,
    _status:   status,
    _warnings: warnings,
    svcNo,
    surname,
    given:    get('given'),
    rank,
    plt:      get('plt'),
    personType,
    email:    get('email'),
    active,
    notes:    get('notes'),
  };
  if (status === 'new') {
    base.createdAt = new Date().toISOString();
  }
  return base;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _parseInt(s, warnings, fieldName) {
  const t = String(s).trim();
  if (t === '') return 0;
  const n = parseInt(t, 10);
  if (isNaN(n)) {
    warnings.push(`${fieldName} "${s}" is not a number (defaulted to 0).`);
    return 0;
  }
  return n;
}

function _newItemId() {
  // Same shape as the manual-add path in inventory.js.
  return 'i-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// -----------------------------------------------------------------------------
// personType inference — duplicated from ui/cadets.js to avoid creating a
// dependency from src/* on src/ui/*. The logic is small and stable; if it
// ever needs to grow, lift it into ranks.js so all three callers share one
// implementation.
// -----------------------------------------------------------------------------

function _inferPersonType(rank) {
  if (!rank) return 'cadet';
  // Cadet ranks all start with 'CDT'; staff ranks don't.
  return /^CDT/.test(rank) ? 'cadet' : 'staff';
}
