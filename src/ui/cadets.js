// =============================================================================
// QStore IMS v2 — Cadets page
// =============================================================================
// Lists the unit's nominal roll. The same store backs cadet AND staff
// records — distinguished by a `personType` field set at save time from
// the rank, with the same logic as the migration uses (ranks.js's
// inferPersonType). v1 used a single 'cadets' table for the same purpose,
// so we keep the name and join the conventions.
//
// PERMISSION GATING (defence in depth)
//   1. UI: add/edit/delete buttons hidden when AUTH.can('manageCadets') is false
//   2. Handlers: AUTH.requirePermission('manageCadets') throws on submit
//   View itself only requires the 'view' perm — anyone logged in can see
//   the roll, which matches v1's behaviour.
//
// SCHEMA (per cadet record)
//   svcNo      — primary key. AAC service number. Required, trimmed.
//   surname    — uppercased on save (matches v1 convention).
//   given      — given names, mixed case as entered. v1 used the same
//                field name. Optional — legacy records may not have it.
//   rank       — free text, validated against ranks.js vocabulary as a hint
//                only. Datalist offers staff + cadet ranks for autocomplete.
//   plt        — platoon, free text (legacy / structure-not-configured).
//                Retained for backward compat; new records use `platoon`.
//   company    — company name from unit structure (e.g. 'A Coy'). Set by
//                the cascading dropdown when structure is configured.
//   platoon    — platoon name from unit structure (e.g. '1 Plt').
//                Replaces free-text plt on first edit after structure setup.
//   section    — section name from unit structure (e.g. '1 Sec').
//   personType — derived from rank on save: 'cadet' | 'staff'. Used by the
//                indexed-lookup in storage.js. Not exposed as its own form
//                field — flipping it requires changing the rank, which is
//                the field that conveys the meaning.
//   active     — boolean. Inactive cadets stay in the list (with a marker)
//                for historical loan integrity; future Issue/Loans pages
//                will exclude them from pickers.
//   email      — optional. Format-validated if present.
//   notes      — optional free text.
//
// MUTATIONS RE-FETCH BY KEY
//   The submit handler always re-reads the cadet from Storage by svcNo
//   before updating. If the cadet was deleted in another tab between
//   modal-open and submit we surface that and close. svcNo is the PK so
//   uniqueness checks on add are deterministic.
//
// AUDIT
//   add    → 'cadet_add',    desc "Added cadet: <rank> <surname> (<svcNo>)"
//   edit   → 'cadet_update', desc "Updated cadet: <rank> <surname> (<svcNo>)"
//   delete → 'cadet_delete', desc "Deleted cadet: <rank> <surname> (<svcNo>) — reason: <reason>"
// =============================================================================

import * as Storage   from '../storage.js';
import * as AUTH      from '../auth.js';
import * as Sync      from '../sync.js';
import * as Structure from '../structure.js';
import {
  STAFF_RANKS_CANONICAL,
  CADET_RANKS,
  normalizeRank,
  inferPersonType,
  compareRanks,
} from '../ranks.js';
import { generateNominalRoll, downloadPdf }  from '../pdf.js';
import { openModal }                        from './modal.js';
import { esc, $, $$, render, fmtDateOnly }  from './util.js';
import { showToast }                        from './toast.js';

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let _root          = null;
let _searchTerm    = '';
let _pltFilter     = '';    // legacy platoon filter (when no structure configured)
let _coFilter      = '';    // company filter (structure mode)
let _pltFilterStr  = '';    // platoon filter (structure mode)
let _secFilter     = '';    // section filter (structure mode)
let _showInactive  = false;
let _structure     = [];    // unit structure cache — loaded once per mount

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  AUTH.requirePermission('view');
  _root         = rootEl;
  _searchTerm   = '';
  _pltFilter    = '';
  _coFilter     = '';
  _pltFilterStr = '';
  _secFilter    = '';
  _showInactive = false;
  // Load unit structure once per mount — updated by settings, unlikely to
  // change mid-session, so caching is safe.
  _structure    = await Structure.load();
  await _render();
  return function unmount() { _root = null; };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  const all       = await Storage.cadets.list();
  const useStruct = _structure.length > 0;

  // Sort using structure-aware comparator if configured, otherwise plain sort.
  const comparator = useStruct
    ? Structure.makeComparator(_structure, compareRanks)
    : (a, b) => {
        const typeA = a.personType === 'staff' ? 0 : 1;
        const typeB = b.personType === 'staff' ? 0 : 1;
        return (typeA - typeB) || compareRanks(a.rank, b.rank) ||
          (a.surname || '').localeCompare(b.surname || '');
      };
  all.sort(comparator);

  // Apply filters in JS — the dataset is small (typical AAC unit < 200
  // cadets) so a single-pass filter is fast enough without indexes.
  const term     = _searchTerm.trim().toLowerCase();
  const filtered = all.filter((c) => {
    if (!_showInactive && c.active === false) return false;
    // Structure mode filters
    if (useStruct) {
      if (_coFilter     && (c.company  || '') !== _coFilter)     return false;
      if (_pltFilterStr && (c.platoon  || c.plt || '') !== _pltFilterStr) return false;
      if (_secFilter    && (c.section  || '') !== _secFilter)    return false;
    } else {
      // Legacy mode: single plt filter
      if (_pltFilter && (c.plt || '') !== _pltFilter) return false;
    }
    if (term) {
      const hay = [
        c.surname, c.given, c.svcNo, c.rank,
        c.plt, c.company, c.platoon, c.section,
        c.email, c.notes,
      ].join(' ').toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });

  const canManage = AUTH.can('manageCadets');

  // Build filter controls based on mode.
  let filterHtml = '';
  if (useStruct) {
    const companies = Structure.getCompanies(_structure);
    const platoons  = _coFilter ? Structure.getPlatoons(_structure, _coFilter) : [];
    const sections  = (_coFilter && _pltFilterStr)
      ? Structure.getSections(_structure, _coFilter, _pltFilterStr)
      : [];
    filterHtml = `
      <select class="cad__co-filter" aria-label="Filter by company">
        <option value="">All companies</option>
        ${companies.map((co) => `<option value="${esc(co)}" ${co === _coFilter ? 'selected' : ''}>${esc(co)}</option>`).join('')}
      </select>
      ${_coFilter && platoons.length > 0 ? `
        <select class="cad__plt-filter-str" aria-label="Filter by platoon">
          <option value="">All platoons</option>
          ${platoons.map((p) => `<option value="${esc(p)}" ${p === _pltFilterStr ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      ` : ''}
      ${_pltFilterStr && sections.length > 0 ? `
        <select class="cad__sec-filter" aria-label="Filter by section">
          <option value="">All sections</option>
          ${sections.map((s) => `<option value="${esc(s)}" ${s === _secFilter ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      ` : ''}
    `;
  } else {
    const plts = [...new Set(all.map((c) => c.plt).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    filterHtml = `
      <select class="cad__plt-filter" aria-label="Filter by platoon">
        <option value="">All platoons</option>
        ${plts.map((p) =>
          `<option value="${esc(p)}" ${p === _pltFilter ? 'selected' : ''}>Plt ${esc(p)}</option>`
        ).join('')}
      </select>
    `;
  }

  const hasFilter = _searchTerm || _pltFilter || _coFilter || _pltFilterStr || _secFilter || !_showInactive;

  render(_root, `
    <section class="cad">
      <header class="cad__toolbar">
        <div class="cad__filters">
          <input type="search"
                 class="cad__search"
                 placeholder="Search name, service number, rank…"
                 aria-label="Search cadets"
                 value="${esc(_searchTerm)}">
          ${filterHtml}
          <label class="cad__inactive-toggle">
            <input type="checkbox" data-action="toggle-inactive"
                   ${_showInactive ? 'checked' : ''}>
            Show inactive
          </label>
        </div>
        <div class="cad__actions">
          <button type="button" class="btn btn--ghost" data-action="print-roll"
                  title="Print the currently-shown nominal roll">⎙ Print roll</button>
          ${canManage ? `<button type="button" class="btn btn--primary" data-action="add">+ Add cadet</button>` : ''}
        </div>
      </header>

      <div class="cad__meta">
        ${filtered.length} ${filtered.length === 1 ? 'person' : 'people'} shown
        ${hasFilter && all.length !== filtered.length
          ? `<span class="cad__meta-of"> of ${all.length}</span>`
          : ''}
      </div>

      <div class="cad__table-wrap">
        ${filtered.length === 0
          ? _emptyStateHtml(all.length, canManage)
          : _tableHtml(filtered, { canManage, useStruct })}
      </div>
    </section>
  `);

  _wireEventListeners();
}

function _emptyStateHtml(totalCadets, canManage) {
  if (totalCadets === 0) {
    return `
      <div class="cad__empty">
        <p>No cadets in the nominal roll yet.</p>
        ${canManage
          ? `<button type="button" class="btn btn--primary" data-action="add">+ Add first cadet</button>`
          : `<p class="cad__empty-hint">Ask your QM or OC to add the roll.</p>`}
      </div>`;
  }
  return `
    <div class="cad__empty">
      <p>No cadets match the current filters.</p>
      <button type="button" class="btn btn--ghost" data-action="clear-filters">Clear filters</button>
    </div>`;
}

function _tableHtml(cadets, { canManage, useStruct }) {
  // Column count used for group-header colspan calculation.
  // Fixed cols: rank, surname, given, svc, status = 5.
  // Struct mode adds company + platoon + section (3); legacy adds plt (1).
  // Optional actions col adds 1.
  const colCount = 5 + (useStruct ? 3 : 1) + (canManage ? 1 : 0);

  // Build rows, injecting group-header <tr>s when the group changes.
  let prevGroupKey = null;
  const rows = cadets.map((c) => {
    let groupHeader = '';
    if (useStruct) {
      const isStaff = c.personType === 'staff';
      const company = c.company  || '';
      const platoon = c.platoon  || c.plt || '';
      const section = c.section  || '';
      const key = isStaff ? '__staff__' : `${company}\x00${platoon}\x00${section}`;
      if (key !== prevGroupKey) {
        let label;
        if (isStaff) {
          label = 'Staff';
        } else {
          const parts = [company, platoon, section].filter(Boolean);
          label = parts.join(' › ') || 'Unassigned';
        }
        groupHeader = `<tr class="cad__group-header">
          <td colspan="${colCount}">${esc(label)}</td>
        </tr>`;
        prevGroupKey = key;
      }
    }
    return groupHeader + _cadetRowHtml(c, { canManage, useStruct });
  }).join('');

  return `
    <table class="cad__table">
      <thead>
        <tr>
          <th class="cad__col-rank">Rank</th>
          <th class="cad__col-surname">Surname</th>
          <th class="cad__col-givens">Given names</th>
          <th class="cad__col-svc">Service No.</th>
          ${useStruct
            ? `<th class="cad__col-company">Company</th>
               <th class="cad__col-plt">Platoon</th>
               <th class="cad__col-section">Section</th>`
            : `<th class="cad__col-plt">Plt</th>`}
          <th class="cad__col-status">Status</th>
          ${canManage ? `<th class="cad__col-actions">Actions</th>` : ''}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

function _cadetRowHtml(c, { canManage, useStruct }) {
  const inactive    = c.active === false;
  const typeBadge   = c.personType === 'staff' ? 'Staff' : '';
  const platoonDisp = c.platoon || c.plt || '';
  return `
    <tr class="cad__row ${inactive ? 'cad__row--inactive' : ''}"
        data-svc="${esc(c.svcNo)}">
      <td class="cad__rank">${esc(c.rank || '')}</td>
      <td class="cad__surname">${esc(c.surname || '')}</td>
      <td class="cad__givens">${esc(c.given || '')}</td>
      <td class="cad__svc">${esc(c.svcNo)}</td>
      ${useStruct
        ? `<td class="cad__company">${esc(c.company || '')}</td>
           <td class="cad__plt">${esc(platoonDisp)}</td>
           <td class="cad__section">${esc(c.section || '')}</td>`
        : `<td class="cad__plt">${esc(c.plt || '')}</td>`}
      <td class="cad__status">
        ${inactive
          ? `<span class="cad__badge cad__badge--inactive">Inactive</span>`
          : typeBadge
            ? `<span class="cad__badge cad__badge--staff">${typeBadge}</span>`
            : ''}
      </td>
      ${canManage ? `
        <td class="cad__col-actions">
          <div class="cad__row-actions">
            <button type="button" class="btn btn--sm btn--ghost"
                    data-action="edit" data-svc="${esc(c.svcNo)}">Edit</button>
            <button type="button" class="btn btn--sm btn--danger"
                    data-action="delete" data-svc="${esc(c.svcNo)}">Delete</button>
          </div>
        </td>
      ` : ''}
    </tr>`;
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  $('.cad__search',         _root)?.addEventListener('input',  _onSearchInput);
  $('.cad__plt-filter',     _root)?.addEventListener('change', _onPltChange);
  $('.cad__co-filter',      _root)?.addEventListener('change', _onCoFilterChange);
  $('.cad__plt-filter-str', _root)?.addEventListener('change', _onPltFilterStrChange);
  $('.cad__sec-filter',     _root)?.addEventListener('change', _onSecFilterChange);
  _root.addEventListener('click',  _onRootClick);
  _root.addEventListener('change', _onRootChange);
}

function _onSearchInput(e) {
  _searchTerm = e.target.value;
  // Re-render on input. List is small, no debounce needed at this scale.
  _render();
}

function _onPltChange(e) {
  _pltFilter = e.target.value;
  _render();
}

function _onCoFilterChange(e) {
  _coFilter     = e.target.value;
  _pltFilterStr = '';   // reset child filters when parent changes
  _secFilter    = '';
  _render();
}

function _onPltFilterStrChange(e) {
  _pltFilterStr = e.target.value;
  _secFilter    = '';
  _render();
}

function _onSecFilterChange(e) {
  _secFilter = e.target.value;
  _render();
}

function _onRootChange(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-inactive') {
    _showInactive = !!e.target.checked;
    _render();
  }
}

async function _onRootClick(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const svcNo = e.target.closest('[data-svc]')?.dataset.svc;
  switch (action) {
    case 'add':    await _openAddModal();        break;
    case 'edit':   await _openEditModal(svcNo);  break;
    case 'delete': await _openDeleteModal(svcNo); break;
    case 'clear-filters':
      _searchTerm = ''; _pltFilter = '';
      _coFilter = ''; _pltFilterStr = ''; _secFilter = '';
      _showInactive = false;
      await _render();
      break;
    case 'print-roll': await _doPrintRoll(e.target.closest('button')); break;
  }
}

// Print the currently-filtered cadet list. We re-derive the filter inline
// so the print reflects exactly what the user sees on screen at click time
// (search term, plt/company/section filter, inactive toggle all honoured).
// The PDF generator handles the layout; this function is just the bridge.
async function _doPrintRoll(button) {
  if (button) { button.disabled = true; button.textContent = 'Building PDF…'; }
  try {
    const all       = await Storage.cadets.list();
    const useStruct = _structure.length > 0;
    const term      = _searchTerm.trim().toLowerCase();

    const comparator = useStruct
      ? Structure.makeComparator(_structure, compareRanks)
      : (a, b) => {
          const typeA = a.personType === 'staff' ? 0 : 1;
          const typeB = b.personType === 'staff' ? 0 : 1;
          return (typeA - typeB) || compareRanks(a.rank, b.rank) ||
            (a.surname || '').localeCompare(b.surname || '');
        };

    const filtered = all.filter((c) => {
      if (!_showInactive && c.active === false) return false;
      if (useStruct) {
        if (_coFilter     && (c.company  || '') !== _coFilter)     return false;
        if (_pltFilterStr && (c.platoon  || c.plt || '') !== _pltFilterStr) return false;
        if (_secFilter    && (c.section  || '') !== _secFilter)    return false;
      } else {
        if (_pltFilter && (c.plt || '') !== _pltFilter) return false;
      }
      if (term) {
        const hay = [
          c.surname, c.given, c.svcNo, c.rank,
          c.plt, c.company, c.platoon, c.section, c.email, c.notes,
        ].join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    filtered.sort(comparator);

    // Subtitle describes the current filter state so the printout makes
    // sense out of context (a roll labelled "A Coy · 1 Plt only" tells the
    // reader why the count looks different from the unit total).
    const filterParts = [];
    if (_coFilter)             filterParts.push(_coFilter);
    if (_pltFilterStr)         filterParts.push(_pltFilterStr);
    if (_secFilter)            filterParts.push(_secFilter);
    if (_pltFilter)            filterParts.push(`Plt ${_pltFilter}`);
    if (!_showInactive)        filterParts.push('Active only');
    if (_searchTerm)           filterParts.push(`Search: "${_searchTerm}"`);
    const subtitle = filterParts.join(' · ');

    const unit   = await Storage.settings.getAll();
    const result = await generateNominalRoll(filtered, { unit, subtitle, structure: _structure });
    downloadPdf(result);
  } catch (err) {
    showToast('Roll generation failed: ' + (err.message || err), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '⎙ Print roll'; }
  }
}

// -----------------------------------------------------------------------------
// Add / edit modal
// -----------------------------------------------------------------------------

async function _openAddModal() {
  AUTH.requirePermission('manageCadets');
  _openCadetFormModal({ mode: 'add', cadet: null });
}

async function _openEditModal(svcNo) {
  AUTH.requirePermission('manageCadets');
  const cadet = await Storage.cadets.get(svcNo);
  if (!cadet) {
    showToast('That cadet has been deleted. Refreshing the list.', 'warn');
    await _render();
    return;
  }
  _openCadetFormModal({ mode: 'edit', cadet });
}

function _openCadetFormModal({ mode, cadet }) {
  const isEdit = mode === 'edit';
  const c = cadet || {};

  // Datalist offers BOTH staff and cadet ranks. Cadet QMs and other
  // legitimately-cadet-rank roles need to be selectable; the field still
  // accepts free text for unusual cases.
  const rankOptions = [...STAFF_RANKS_CANONICAL, ...CADET_RANKS]
    .map((r) => `<option value="${esc(r)}">`)
    .join('');

  const useStruct = _structure.length > 0;

  // When structure is configured: cascading company → platoon → section dropdowns.
  // When not: single free-text plt field (legacy).
  let structFieldsHtml = '';
  if (useStruct) {
    const companies = Structure.getCompanies(_structure);
    const curCo     = c.company  || '';
    const curPlt    = c.platoon  || c.plt || '';
    const curSec    = c.section  || '';
    const platoons  = curCo  ? Structure.getPlatoons(_structure, curCo)         : [];
    const sections  = (curCo && curPlt) ? Structure.getSections(_structure, curCo, curPlt) : [];
    structFieldsHtml = `
      <div class="form__row">
        <label class="form__field">
          <span class="form__label">Company</span>
          <select name="company" class="cad__form-company">
            <option value="">— None —</option>
            ${companies.map((co) =>
              `<option value="${esc(co)}" ${co === curCo ? 'selected' : ''}>${esc(co)}</option>`
            ).join('')}
          </select>
        </label>
        <label class="form__field cad__form-plt-wrap" ${!curCo || platoons.length === 0 ? 'style="display:none"' : ''}>
          <span class="form__label">Platoon</span>
          <select name="platoon" class="cad__form-platoon">
            <option value="">— None —</option>
            ${platoons.map((p) =>
              `<option value="${esc(p)}" ${p === curPlt ? 'selected' : ''}>${esc(p)}</option>`
            ).join('')}
          </select>
        </label>
        <label class="form__field cad__form-sec-wrap" ${!curPlt || sections.length === 0 ? 'style="display:none"' : ''}>
          <span class="form__label">Section</span>
          <select name="section" class="cad__form-section">
            <option value="">— None —</option>
            ${sections.map((s) =>
              `<option value="${esc(s)}" ${s === curSec ? 'selected' : ''}>${esc(s)}</option>`
            ).join('')}
          </select>
        </label>
      </div>`;
  } else {
    structFieldsHtml = `
      <div class="form__row">
        <label class="form__field">
          <span class="form__label">Platoon</span>
          <input type="text" name="plt" maxlength="16"
                 value="${esc(c.plt || '')}"
                 placeholder="e.g. 1, 2, HQ">
        </label>
      </div>`;
  }

  openModal({
    titleHtml: isEdit ? 'Edit cadet' : 'Add cadet',
    size:      'md',
    bodyHtml: `
      <form class="form" data-form="cadet" autocomplete="off">
        <div class="form__row">
          <label class="form__field">
            <span class="form__label">Service number *</span>
            <input type="text" name="svcNo" required maxlength="16"
                   value="${esc(c.svcNo || '')}"
                   ${isEdit ? 'readonly' : ''}
                   spellcheck="false" autocapitalize="off"
                   placeholder="e.g. 8512345">
            ${isEdit
              ? `<span class="form__hint">Service number is the record key — to change it, delete and re-add.</span>`
              : `<span class="form__hint">Required. Used as the record key.</span>`}
          </label>
          <label class="form__field">
            <span class="form__label">Rank *</span>
            <input type="text" name="rank" required maxlength="16"
                   value="${esc(c.rank || '')}"
                   list="cad-rank-options" spellcheck="false"
                   placeholder="e.g. CDT, CAPT-AAC, DAH">
            <datalist id="cad-rank-options">${rankOptions}</datalist>
            <span class="form__hint">Staff or cadet rank — choose from list or type</span>
          </label>
        </div>

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Surname *</span>
            <input type="text" name="surname" required maxlength="80"
                   value="${esc(c.surname || '')}"
                   style="text-transform: uppercase;"
                   placeholder="SURNAME">
            <span class="form__hint">Stored in uppercase per AAC convention</span>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">Given names</span>
            <input type="text" name="given" maxlength="80"
                   value="${esc(c.given || '')}"
                   placeholder="Given names">
          </label>
        </div>

        ${structFieldsHtml}

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Email</span>
            <input type="email" name="email" maxlength="120"
                   value="${esc(c.email || '')}"
                   spellcheck="false"
                   placeholder="optional">
          </label>
          <label class="form__field cad__active-field">
            <span class="form__label">Status</span>
            <label class="form__checkbox-inline">
              <input type="checkbox" name="active"
                     ${c.active !== false ? 'checked' : ''}>
              Active
            </label>
            <span class="form__hint">Inactive cadets stay listed but are excluded from new issues</span>
          </label>
        </div>

        <label class="form__field">
          <span class="form__label">Notes</span>
          <textarea name="notes" rows="2" maxlength="500"
                    placeholder="optional">${esc(c.notes || '')}</textarea>
        </label>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--primary">
            ${isEdit ? 'Save changes' : 'Add cadet'}
          </button>
        </div>
      </form>`,
    onMount(panel, close) {
      const form  = $('form[data-form="cadet"]', panel);
      const errEl = $('.form__error', panel);

      // Wire cascading dropdowns (structure mode only).
      if (useStruct) {
        const coSel  = $('select[name="company"]',  panel);
        const pltSel = $('select[name="platoon"]',  panel);
        const secSel = $('select[name="section"]',  panel);
        const pltWrap = $('.cad__form-plt-wrap', panel);
        const secWrap = $('.cad__form-sec-wrap', panel);

        coSel.addEventListener('change', () => {
          const co      = coSel.value;
          const platoons = co ? Structure.getPlatoons(_structure, co) : [];
          pltSel.innerHTML = '<option value="">— None —</option>' +
            platoons.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
          secSel.innerHTML = '<option value="">— None —</option>';
          pltWrap.style.display = (co && platoons.length > 0) ? '' : 'none';
          secWrap.style.display = 'none';
        });

        pltSel.addEventListener('change', () => {
          const co       = coSel.value;
          const plt      = pltSel.value;
          const sections = (co && plt) ? Structure.getSections(_structure, co, plt) : [];
          secSel.innerHTML = '<option value="">— None —</option>' +
            sections.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
          secWrap.style.display = (plt && sections.length > 0) ? '' : 'none';
        });
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        let data;
        try {
          data = _readFormData(form, useStruct);
        } catch (err) {
          errEl.textContent = err.message;
          return;
        }
        try {
          if (isEdit) await _saveEdit(c.svcNo, data);
          else        await _saveAdd(data);
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Save failed.';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Form parsing & validation
// -----------------------------------------------------------------------------

function _readFormData(form, useStruct = false) {
  const fd = new FormData(form);
  const svcNo      = String(fd.get('svcNo')      || '').trim();
  const rankRaw    = String(fd.get('rank')       || '').trim();
  const surname    = String(fd.get('surname')    || '').trim().toUpperCase();
  const given      = String(fd.get('given')      || '').trim();
  const email      = String(fd.get('email')      || '').trim();
  const notes      = String(fd.get('notes')      || '').trim();
  const active     = fd.get('active') === 'on';

  // Structure mode: read cascading dropdowns. Legacy mode: read free-text plt.
  const plt     = useStruct ? '' : String(fd.get('plt')     || '').trim();
  const company = useStruct ? String(fd.get('company')  || '').trim() : '';
  const platoon = useStruct ? String(fd.get('platoon')  || '').trim() : '';
  const section = useStruct ? String(fd.get('section')  || '').trim() : '';

  if (!svcNo)   throw new Error('Service number is required.');
  if (!rankRaw) throw new Error('Rank is required.');
  if (!surname) throw new Error('Surname is required.');

  // svcNo: no whitespace, reasonable length. We're permissive on format —
  // AAC uses 7-digit numerics for cadets and a similar pattern for staff,
  // but acting/temporary records sometimes use placeholders.
  if (/\s/.test(svcNo)) throw new Error('Service number must not contain whitespace.');
  if (svcNo.length > 16) throw new Error('Service number is too long (max 16 chars).');

  // Rank normalisation — uppercase, strip dots/spaces, and apply the -AAC
  // suffix to bare officer ranks (CAPT → CAPT-AAC) so manual entry produces
  // the same canonical form that the v1→v2 migration produces for legacy
  // records. We don't reject unknown ranks (units occasionally have
  // legitimate non-canonical ones) but we do clean up the input.
  const rank = normalizeRank(rankRaw);

  // Email format is permissive but catches typos.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email is not in a valid format.');
  }

  // personType: derive from rank. Same logic the migration uses for
  // legacy records — keeps the inference consistent across all entry
  // points to the cadets store.
  const personType = inferPersonType(rank);

  return { svcNo, rank, surname, given, plt, company, platoon, section, personType, active, email, notes };
}

// -----------------------------------------------------------------------------
// Save handlers
// -----------------------------------------------------------------------------

async function _saveAdd(data) {
  AUTH.requirePermission('manageCadets');

  // Uniqueness check on PK before write.
  const existing = await Storage.cadets.get(data.svcNo);
  if (existing) {
    throw new Error(`A cadet with service number ${data.svcNo} already exists.`);
  }

  await Storage.cadets.put({
    ...data,
    createdAt: new Date().toISOString(),
  });

  await Storage.audit.append({
    action: 'cadet_add',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Added cadet: ${data.rank} ${data.surname} (${data.svcNo})`,
  });

  Sync.notifyChanged();
}

async function _saveEdit(svcNo, data) {
  AUTH.requirePermission('manageCadets');

  // Re-read by PK — if the record was deleted by another tab between
  // modal-open and submit, we surface that instead of resurrecting it.
  const existing = await Storage.cadets.get(svcNo);
  if (!existing) {
    throw new Error('This cadet has been deleted in another tab. Close the modal and refresh.');
  }

  // svcNo is the PK and read-only in edit mode — the form posts the
  // existing value but we ignore data.svcNo and use the original.
  await Storage.cadets.put({
    ...existing,
    ...data,
    svcNo,                        // belt-and-braces: lock to original PK
    updatedAt: new Date().toISOString(),
  });

  await Storage.audit.append({
    action: 'cadet_update',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Updated cadet: ${data.rank} ${data.surname} (${svcNo})`,
  });

  Sync.notifyChanged();
}

// -----------------------------------------------------------------------------
// Delete modal
// -----------------------------------------------------------------------------

async function _openDeleteModal(svcNo) {
  AUTH.requirePermission('manageCadets');
  const cadet = await Storage.cadets.get(svcNo);
  if (!cadet) {
    showToast('That cadet has been deleted already. Refreshing.', 'warn');
    await _render();
    return;
  }

  // Check for active loans against this cadet. We block deletion if any
  // exist — the loan record references svcNo and removing the cadet
  // would orphan the loan. The user is told to return the items first.
  //
  // Loan schema (matches v1): the `active` boolean is the canonical flag;
  // a loan is open while active === true and closed (returned) when false.
  // listForCadet queries the borrowerSvc index, so we get all loans for
  // this cadet historical or current, and filter to active in JS.
  const allLoans = await Storage.loans.listForCadet(svcNo).catch(() => []);
  const activeLoans = allLoans.filter((l) => l.active === true);

  const label = `${cadet.rank} ${cadet.surname} (${cadet.svcNo})`;

  if (activeLoans.length > 0) {
    openModal({
      titleHtml: 'Cannot delete — active loans',
      size:      'sm',
      bodyHtml: `
        <p class="modal__body">
          <strong>${esc(label)}</strong> has
          ${activeLoans.length} active ${activeLoans.length === 1 ? 'loan' : 'loans'}.
        </p>
        <p class="modal__body">
          Return all items first, or mark this cadet as inactive instead
          (Edit cadet → uncheck Active). Inactive cadets stay in the list
          for audit purposes but are excluded from new issues.
        </p>
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
        </div>`,
    });
    return;
  }

  openModal({
    titleHtml: 'Delete cadet',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        Permanently delete <strong>${esc(label)}</strong> from the nominal roll?
      </p>
      <p class="modal__body modal__body--small">
        Loan history referencing this cadet will be preserved (the audit log
        and loan records keep the original ${esc(svcNo)} reference). Marking
        the cadet inactive is usually preferable — only delete if the record
        was created in error.
      </p>
      <form class="form" data-form="delete-cadet">
        <label class="form__field">
          <span class="form__label">Reason for deletion</span>
          <input type="text" name="reason" required maxlength="120"
                 placeholder="e.g. duplicate record, data entry error">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Delete cadet</button>
        </div>
      </form>`,
    onMount(panel, close) {
      const form  = $('form[data-form="delete-cadet"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const reason = String(new FormData(form).get('reason') || '').trim();
        if (!reason) { errEl.textContent = 'A reason is required.'; return; }
        try {
          await _doDelete(svcNo, label, reason);
          close();
          await _render();
        } catch (err) {
          errEl.textContent = err.message || 'Delete failed.';
        }
      });
    },
  });
}

async function _doDelete(svcNo, label, reason) {
  AUTH.requirePermission('manageCadets');
  await Storage.cadets.delete(svcNo);
  await Storage.audit.append({
    action: 'cadet_delete',
    user:   AUTH.getSession()?.name || 'unknown',
    desc:   `Deleted cadet: ${label} — reason: ${reason}`,
  });
  Sync.notifyChanged();
}
