// =============================================================================
// QStore IMS v2 — CSV import (UI layer)
// =============================================================================
// Two public flows: openItemsCsvImport(), openCadetsCsvImport().
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

export function openCadetsCsvImport() {
  _openCsvFlow({
    label:   'cadets',
    parser:  Csv.parseCadetsCsv,
    commit:  Csv.commitCadets,
    auditAction: 'csv_import_cadets',
    schemaHint: `
      <p><strong>Expected columns:</strong> <code>svcNo</code>,
      <code>surname</code> (required); <code>given</code>, <code>rank</code>,
      <code>plt</code>, <code>email</code>, <code>active</code>,
      <code>notes</code> (optional).</p>
      <p>Rank values are normalised — <code>Cdt</code>, <code>cdt</code>,
      <code>CDT</code> all become <code>CDT</code>. The active flag accepts
      true/false/yes/no/1/0.</p>
    `,
    sampleColumns: ['svcNo', 'surname', 'given', 'rank', 'plt', 'active'],
  });
}

// -----------------------------------------------------------------------------
// Flow controller — same shape for items and cadets
// -----------------------------------------------------------------------------

function _openCsvFlow(spec) {
  // Build a temporary file input and click it. We don't reuse a hidden
  // input on the page because the items vs cadets distinction would
  // require different handlers, and constructing on demand is simpler.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,text/csv';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  const cleanup = () => fileInput.remove();

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    cleanup();
    if (!file) return;
    await _handleSelectedFile(file, spec);
  });

  // If the user cancels the picker, the change event never fires. We
  // schedule a cleanup on focus return as a safety net so we don't leak
  // detached input elements on the body.
  setTimeout(() => {
    if (document.body.contains(fileInput) && (!fileInput.files || fileInput.files.length === 0)) {
      // Hold off another moment — Chrome fires change a bit late on some
      // platforms.
      setTimeout(() => {
        if (document.body.contains(fileInput) && (!fileInput.files || fileInput.files.length === 0)) {
          cleanup();
        }
      }, 1000);
    }
  }, 500);

  fileInput.click();
}

async function _handleSelectedFile(file, spec) {
  let text;
  try {
    text = await file.text();
  } catch (err) {
    showToast(`Could not read file: ${err.message || err}`, 'error');
    return;
  }

  let result;
  try {
    result = await spec.parser(text);
  } catch (err) {
    showToast(`CSV parse failed: ${err.message || err}`, 'error');
    return;
  }

  // File-level errors (missing required columns, fatal parse issues) —
  // show a small modal and stop, no preview.
  if (result.errors && result.errors.length > 0) {
    openModal({
      titleHtml: `Could not import ${esc(spec.label)}`,
      size:      'sm',
      bodyHtml: `
        <div class="modal__warn">
          <strong>The CSV file has problems and was not imported.</strong>
        </div>
        <ul class="settings__import-summary">
          ${result.errors.map(e => `<li>${esc(e)}</li>`).join('')}
        </ul>
        ${spec.schemaHint}
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
        </div>
      `,
    });
    return;
  }

  _showPreview(file.name, result, spec);
}

// -----------------------------------------------------------------------------
// Preview modal
// -----------------------------------------------------------------------------

function _showPreview(filename, parseResult, spec) {
  const { rows, columns } = parseResult;

  // Tally counts.
  const newCount      = rows.filter(r => r._status === 'new').length;
  const updateCount   = rows.filter(r => r._status === 'update').length;
  const invalidCount  = rows.filter(r => r._status === 'invalid').length;
  const warningCount  = rows.reduce((n, r) =>
    n + (r._warnings && r._warnings.length ? 1 : 0), 0);
  const importable = newCount + updateCount;

  // Up to 5 sample rows for the preview table.
  const samples = rows.slice(0, 5);

  // Up to 10 invalid rows + 10 warning rows for the issues panel.
  const invalidRows = rows.filter(r => r._status === 'invalid').slice(0, 10);
  const warningRows = rows.filter(r => r._status !== 'invalid' && r._warnings.length).slice(0, 10);

  // Column mapping summary
  const mappedHtml = Object.keys(columns.mapped).map(canonical =>
    `<li><code>${esc(canonical)}</code> ← column ${columns.mapped[canonical] + 1}</li>`
  ).join('');

  const unrecognisedHtml = (columns.unrecognised || []).length === 0
    ? '<li class="settings__import-empty">All columns recognised.</li>'
    : columns.unrecognised.map(c =>
        `<li><span class="settings__csv-unrecog">${esc(c)}</span> (ignored)</li>`
      ).join('');

  // Sample table — show the columns we actually intend to import.
  const sampleColsAvailable = spec.sampleColumns.filter(c => c in (samples[0] || {}));
  const sampleTableHtml = samples.length === 0
    ? '<p class="settings__import-empty">No rows in file.</p>'
    : `
      <table class="settings__csv-preview">
        <thead>
          <tr>
            <th>Line</th>
            <th>Status</th>
            ${sampleColsAvailable.map(c => `<th>${esc(c)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${samples.map(row => `
            <tr class="settings__csv-row settings__csv-row--${esc(row._status)}">
              <td>${esc(String(row._line))}</td>
              <td><span class="settings__csv-status settings__csv-status--${esc(row._status)}">${esc(row._status)}</span></td>
              ${sampleColsAvailable.map(c => `<td>${esc(String(row[c] ?? ''))}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  const issuesHtml = (invalidRows.length === 0 && warningRows.length === 0)
    ? ''
    : `
      <details class="settings__details">
        <summary>${invalidCount + warningCount} row(s) with issues</summary>
        <div class="settings__details-body">
          ${invalidRows.length ? `
            <p><strong>${invalidCount} invalid row(s) — will be skipped:</strong></p>
            <ul class="settings__import-summary">
              ${invalidRows.map(r =>
                `<li>Line ${esc(String(r._line))}: ${esc(r._warnings.join('; '))}</li>`
              ).join('')}
              ${invalidCount > invalidRows.length ?
                `<li><em>… and ${invalidCount - invalidRows.length} more.</em></li>` : ''}
            </ul>
          ` : ''}
          ${warningRows.length ? `
            <p><strong>${warningCount} row(s) with warnings — will still be imported:</strong></p>
            <ul class="settings__import-summary">
              ${warningRows.map(r =>
                `<li>Line ${esc(String(r._line))}: ${esc(r._warnings.join('; '))}</li>`
              ).join('')}
              ${warningCount > warningRows.length ?
                `<li><em>… and ${warningCount - warningRows.length} more.</em></li>` : ''}
            </ul>
          ` : ''}
        </div>
      </details>
    `;

  openModal({
    titleHtml: `Import ${esc(spec.label)} from CSV — preview`,
    size:      'lg',
    bodyHtml: `
      <p class="modal__body">
        File: <code>${esc(filename)}</code> &middot;
        ${esc(String(rows.length))} row(s) total.
      </p>

      <div class="settings__csv-counts">
        <div class="settings__csv-count settings__csv-count--new">
          <strong>${esc(String(newCount))}</strong> new
        </div>
        <div class="settings__csv-count settings__csv-count--update">
          <strong>${esc(String(updateCount))}</strong> to update
        </div>
        ${invalidCount > 0 ? `
          <div class="settings__csv-count settings__csv-count--invalid">
            <strong>${esc(String(invalidCount))}</strong> invalid (skipped)
          </div>
        ` : ''}
        ${warningCount > 0 ? `
          <div class="settings__csv-count settings__csv-count--warn">
            <strong>${esc(String(warningCount))}</strong> with warnings
          </div>
        ` : ''}
      </div>

      <details class="settings__details">
        <summary>Column mapping</summary>
        <div class="settings__details-body">
          <p><strong>Recognised columns:</strong></p>
          <ul class="settings__import-summary">${mappedHtml}</ul>
          ${columns.unrecognised && columns.unrecognised.length > 0 ? `
            <p><strong>Unrecognised columns (will be ignored):</strong></p>
            <ul class="settings__import-summary">${unrecognisedHtml}</ul>
          ` : ''}
        </div>
      </details>

      <details class="settings__details" open>
        <summary>Preview (first ${esc(String(samples.length))} row(s))</summary>
        <div class="settings__details-body">
          ${sampleTableHtml}
        </div>
      </details>

      ${issuesHtml}

      <div class="modal__warn" style="margin-top: 16px;">
        Updates merge with existing records — fields not in the CSV (like
        <code>onLoan</code>, photos, creation timestamps) are preserved.
      </div>

      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary"
                data-action="csv-confirm"
                ${importable === 0 ? 'disabled' : ''}>
          Import ${esc(String(importable))} row(s)
        </button>
      </div>
    `,
    onMount(panel, close) {
      const confirmBtn = $('[data-action="csv-confirm"]', panel);
      if (!confirmBtn) return;
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Importing…';
        try {
          await _doCommit(rows, spec, importable);
          close();
        } catch (err) {
          showToast(`Import failed: ${err.message || err}`, 'error');
          confirmBtn.disabled = false;
          confirmBtn.textContent = `Import ${importable} row(s)`;
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Commit + summary
// -----------------------------------------------------------------------------

async function _doCommit(rows, spec, importable) {
  const counts = await spec.commit(rows);

  // Audit the import. The action key follows the convention used elsewhere
  // in the audit log; the description carries the totals so a future audit
  // viewer entry is self-explanatory.
  await Storage.audit.append({
    action: spec.auditAction,
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `CSV import: ${counts.inserted} inserted, ${counts.updated} updated` +
            (counts.skipped > 0 ? `, ${counts.skipped} skipped` : '') +
            ` (${spec.label}).`,
  });
  Sync.notifyChanged();

  openModal({
    titleHtml: 'Import complete',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        Imported ${esc(spec.label)} from CSV successfully.
      </p>
      <ul class="settings__import-summary">
        <li><strong>${esc(String(counts.inserted))}</strong> new record(s) inserted</li>
        <li><strong>${esc(String(counts.updated))}</strong> existing record(s) updated</li>
        ${counts.skipped > 0 ?
          `<li><strong>${esc(String(counts.skipped))}</strong> invalid row(s) skipped</li>` : ''}
      </ul>
      <p class="modal__body modal__body--small">
        Reload or navigate to the relevant page to see the imported data.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
      </div>
    `,
  });
}
