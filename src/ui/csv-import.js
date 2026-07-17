// =============================================================================
// QStore IMS v2 — CSV import (UI layer)
// =============================================================================
// One public flow: openItemsCsvImport(). The cadet importer is gone — this
// build stores no cadet records.
//
// Flow:
//   1. File picker → read file → call src/csv-import.js parser
//   2. Preview modal showing column mapping, sample rows, counts, warnings
//   3. "Import" button on the modal → commit → success summary
//
// Why a preview is mandatory:
// CSV imports are easy to get wrong. A column ordering mistake or a
// header alias miss can silently produce 200 garbage records. Showing the
// user what's about to land — and what's been auto-mapped vs not — gives
// them a chance to bail before the database is touched.
//
// Reuses the existing settings.js modal helper rather than rolling our
// own, so visual style and dismiss behaviour are consistent.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import * as Sync    from '../sync.js';
import { openModal } from './modal.js';
import { esc, $, $$ } from './util.js';
import * as Csv from '../csv-import.js';
import { showToast } from './toast.js';

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

export function openItemsCsvImport() {
  _openCsvFlow({
    label:   'inventory items',
    parser:  Csv.parseItemsCsv,
    commit:  Csv.commitItems,
    auditAction: 'csv_import_items',
    schemaHint: `
      <p><strong>Expected columns:</strong> <code>name</code>, <code>cat</code>
      (required); <code>nsn</code>, <code>onHand</code>, <code>unsvc</code>,
      <code>authQty</code>, <code>condition</code>, <code>loc</code>,
      <code>notes</code>, <code>id</code> (optional).</p>
      <p>Common variants are auto-mapped: <code>Item</code> → name,
      <code>Category</code> → cat, <code>Stock</code>/<code>Qty</code> →
      onHand, <code>Auth</code>/<code>MaxQty</code> → authQty, etc.</p>
    `,
    sampleColumns: ['nsn', 'name', 'cat', 'onHand', 'unsvc', 'authQty', 'condition'],
  });
}