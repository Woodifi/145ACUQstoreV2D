// =============================================================================
// QStore IMS v2 — Settings page
// =============================================================================
// CO-only. Manages cloud sync configuration and provides the data import/
// export controls. v2.0 covers cloud config + manual sync; later rounds
// extend with unit details, user management, audit log viewer, etc.
//
// Cloud config:
//   - Azure Application (client) ID  — required to enable sync
//   - Folder name in OneDrive (default: QStore)
//   - File name (default: qstore_data.json)
//   - Auto-sync toggle (default: on)
//
// Cloud actions:
//   - Sign in / Sign out
//   - Sync now            — manual push
//   - Load from cloud     — destructive download with confirmation
//
// REDIRECT URI HINT
//   We display the redirect URI prominently because mismatching it with
//   the Azure registration is the single most common deployment error.
//   The page shows the exact value to paste into Azure's portal.
// =============================================================================

import * as Storage   from '../storage.js';
import * as AUTH      from '../auth.js';
import * as Sync      from '../sync.js';
import { getProvider } from '../cloud.js';
import { openModal }   from './modal.js';
import { esc, $, $$, render, fmtDate } from './util.js';
import { STAFF_RANKS_CANONICAL, CADET_RANKS } from '../ranks.js';
import * as Recovery   from '../recovery.js';
import * as Keyring    from '../sync-keyring.js';
import * as Migration  from '../migration.js';
import * as TotpSetup  from './totp-setup.js';
import * as CsvUi      from './csv-import.js';
import { getLicenseState, activateKey, deviceActivate } from '../license.js';
import { generateLegacyQRecord, downloadPdf } from '../pdf.js';
import * as Locations from '../locations.js';
import { showToast }   from './toast.js';
import * as Structure  from '../structure.js';
import { CATEGORIES as DEFAULT_CATEGORIES } from './inventory.js';
import { INITIAL_ISSUE } from './loans.js';
import { applyTheme }   from '../theme.js';

let _root           = null;
let _controller     = null;  // AbortController — cleaned up on unmount
let _statusListener = null;

export async function mount(rootEl) {
  _root       = rootEl;
  _controller = new AbortController();
  AUTH.requireCO();

  await _render();

  // Wire root click once here — not inside _wireEventListeners()/_render()
  // to prevent accumulation across re-renders.
  _root.addEventListener('click', _onRootClick, { signal: _controller.signal });

  // Listen for sync status changes so the page reflects sign-in/out, busy,
  // and error states without a full re-render.
  _statusListener = (status) => _refreshSyncBlock(status);
  Sync.addStatusListener(_statusListener);

  return function unmount() {
    _controller.abort();
    _controller = null;
    if (_statusListener) {
      Sync.removeStatusListener(_statusListener);
      _statusListener = null;
    }
    _root = null;
  };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

let _legacySummary = { cadets: 0, loans: 0, requests: 0, total: 0 };

async function _render() {
  const settings       = await Storage.settings.getAll();
  // Legacy person data left over from a build that stored cadets. Zero on a
  // fresh install; the section renders nothing in that case.
  try { _legacySummary = await Storage.legacy.summary(); } catch (_) { /* non-fatal */ }
  const status         = Sync.getStatus();
  // Recovery status is per-user. The settings page already requires the OC
  // role at mount time, so the session userId is the OC's. If somehow we
  // end up with no session here we render a 'no code' state — defensive,
  // shouldn't happen in practice.
  const sess           = AUTH.getSession();
  const recoveryStatus = sess?.userId
    ? await Recovery.statusForUser(sess.userId)
    : { exists: false, createdAt: null };
  const totpUser       = sess?.userId ? await Storage.users.get(sess.userId) : null;
  const unitStructure  = await Structure.load();
  const licenseState   = getLicenseState();
  // Stored categories — null means "use defaults".
  const storedCats     = await Storage.settings.get('categories');
  const activeCats     = Array.isArray(storedCats) && storedCats.length > 0
    ? storedCats
    : DEFAULT_CATEGORIES;

  render(_root, `
    <section class="settings">
      <div class="settings__column">
        ${_unitSectionHtml(settings)}
        ${_structureSectionHtml(unitStructure)}
        ${_categoriesSectionHtml(activeCats)}
        ${_loanSettingsSectionHtml(settings)}
        ${_appearanceSectionHtml(settings)}
        ${_recoverySectionHtml(recoveryStatus)}
        ${_totpSectionHtml(totpUser)}
        ${_securitySectionHtml(settings)}
        ${_cloudSectionHtml(settings, status)}
        ${_legacySectionHtml(_legacySummary)}
        ${_syncCryptoSectionHtml(settings)}
        ${_dataSectionHtml(settings)}
        ${_subscriptionSectionHtml(licenseState)}
        ${_aboutSectionHtml()}
      </div>
    </section>
  `);

  _wireEventListeners();
}

// -----------------------------------------------------------------------------
// Unit branding section
// -----------------------------------------------------------------------------
// Surfaces the unit identity fields that v1 carried but v2 had no UI for.
// All values flow into the same flat 'settings' KV that the migration writes
// to, so a v1-migrated unit's existing values populate this form on first
// load. Keys consumed elsewhere:
//   - unitName / unitCode  → shell.js header, login.js title
//   - qmName / qmRank      → AB189 signature block (when that lands)
//   - coName (OC/QM)       → AB189 approver name + reports
//   - state                → AB189 (form footer)
//   - qmEmail / coEmail    → reserved for future notifications
//
// QM AND APPROVER ROLES
//   The QM may be either staff OR a cadet. Cadet QMs are a designed-in
//   role: cadets run day-to-day operations under staff oversight. The
//   rank datalist therefore offers BOTH staff ranks and cadet ranks as
//   suggestions, with staff ranks listed first since they remain the
//   more common arrangement. The field accepts any value regardless —
//   datalist is suggestions, not a constraint.
//
//   The approver field is labelled "OC/QM" because either the OC or a
//   staff QM can be the in-unit approving authority on AB189s. AB189s
//   are in-unit only — battalion Q-Store requests go through CadetNet
//   pro-formas, outside this app's scope. Two signatures (issuer + OC/QM
//   approver) are sufficient; no third signatory field is needed.
//
// SCHEMA KEY vs LABEL
//   The settings KV keys 'coName' and 'coEmail' predate the OC/QM
//   labelling decision and remain unchanged to avoid a migration step
//   for what is a cosmetic relabel. Treat them as 'approver name/email'
//   internally; only the visible label matters to the user.
//
// The state field is a fixed dropdown of AU codes; the AB189 form needs an
// exact match.
// -----------------------------------------------------------------------------

const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function _unitSectionHtml(settings) {
  const unitName   = settings.unitName  || '';
  const unitCode   = settings.unitCode  || '';
  const state      = settings.state     || '';
  const qmName     = settings.qmName    || '';
  const qmRank     = settings.qmRank    || '';
  const qmEmail    = settings.qmEmail   || '';
  const coName     = settings.coName    || '';
  const coEmail    = settings.coEmail   || '';
  const logoDataUrl = settings.unitLogo || null;

  const stateOptions = ['', ...AU_STATES].map((code) => {
    const label = code || '— Select —';
    const sel   = code === state ? ' selected' : '';
    return `<option value="${esc(code)}"${sel}>${esc(label)}</option>`;
  }).join('');

  // Staff ranks first (more common QM arrangement), cadet ranks after.
  // The full list is suggestions only — the field accepts any value.
  const rankOptions = [...STAFF_RANKS_CANONICAL, ...CADET_RANKS].map((r) =>
    `<option value="${esc(r)}">`
  ).join('');

  const isFirstSetup = !unitName.trim();

  return `
    <section class="settings__section settings__section--unit-details" data-section="unit">
      <header class="settings__section-header">
        <h2 class="settings__section-title">
          Unit details
          ${isFirstSetup
            ? `<span class="settings__setup-badge">⬅ Start here</span>`
            : ''}
        </h2>
        <p class="settings__section-hint">
          These fields appear in the app header, on the login screen, and on
          generated AB189 forms and reports. Only the OC can edit them.
        </p>
      </header>

      <form class="form" data-form="unit-config" autocomplete="off">
        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">Unit name</span>
            <input type="text" name="unitName" value="${esc(unitName)}" maxlength="80"
                   placeholder="1 Australian Cadet Training Unit">
            <span class="form__hint">Full name shown in the app header and login screen</span>
          </label>
          <label class="form__field">
            <span class="form__label">Unit code</span>
            <input type="text" name="unitCode" value="${esc(unitCode)}" maxlength="16"
                   placeholder="1 ACTU" spellcheck="false">
            <span class="form__hint">Short code (e.g. 145 ACU)</span>
          </label>
        </div>

        <div class="form__row">
          <label class="form__field">
            <span class="form__label">State</span>
            <select name="state">${stateOptions}</select>
            <span class="form__hint">Used on AB189 form footer</span>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">OC/QM name</span>
            <input type="text" name="coName" value="${esc(coName)}" maxlength="80"
                   placeholder="Surname, Given names">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">OC/QM email</span>
            <input type="email" name="coEmail" value="${esc(coEmail)}" maxlength="120"
                   placeholder="co@example.com" spellcheck="false">
          </label>
        </div>

        <div class="form__row">
          <label class="form__field">
            <span class="form__label">QM rank</span>
            <input type="text" name="qmRank" value="${esc(qmRank)}" maxlength="16"
                   placeholder="e.g. CAPT-AAC, CDTWO1, DAH"
                   list="qm-rank-options" spellcheck="false">
            <datalist id="qm-rank-options">${rankOptions}</datalist>
            <span class="form__hint">Staff or cadet rank — choose from list or type</span>
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">QM name</span>
            <input type="text" name="qmName" value="${esc(qmName)}" maxlength="80"
                   placeholder="Surname, Given names">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">QM email</span>
            <input type="email" name="qmEmail" value="${esc(qmEmail)}" maxlength="120"
                   placeholder="qm@example.com" spellcheck="false">
          </label>
        </div>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary">Save unit details</button>
        </div>
      </form>

      <div class="settings__logo">
        <h3 class="settings__logo-title">Unit logo</h3>
        <p class="settings__section-hint">
          Displayed in the app header at top-left. PNG or SVG recommended
          (preserves transparency). Resized to fit the header automatically.
          Max 5 MB.
        </p>
        ${logoDataUrl ? `
          <div class="settings__logo-preview-wrap">
            <img class="settings__logo-preview" src="${esc(logoDataUrl)}" alt="Current unit logo">
          </div>
        ` : `
          <p class="settings__section-hint" style="margin-top:8px">No logo set.</p>
        `}
        <div class="form__actions" style="margin-top:8px">
          <label class="btn btn--ghost settings__logo-upload-label">
            ${logoDataUrl ? 'Replace logo' : 'Upload logo'}
            <input type="file" accept="image/*" data-target="logo-file-input" hidden>
          </label>
          ${logoDataUrl ? `
            <button type="button" class="btn btn--ghost" data-action="logo-remove">
              Remove logo
            </button>
            <button type="button" class="btn btn--primary" data-action="logo-download-copy">
              Download unit copy
            </button>
          ` : ''}
        </div>
        ${logoDataUrl ? `
          <p class="settings__section-hint" style="margin-top:6px">
            "Download unit copy" creates a version of this app with your logo pre-embedded.
            Share this file — the logo will show on first open on any device, even before sign-in.
          </p>
        ` : ''}
        <div class="form__error" data-target="logo-error" role="alert"></div>
      </div>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Recovery code section — OC-only PIN reset coverage
// -----------------------------------------------------------------------------
// The settings page is gated by AUTH.requireCO at mount time, so every
// visitor here is an OC. Each OC's recovery code is bound to their own
// user record — if the unit has multiple OC accounts, each has their own
// independent code.
//
// "Retrievable while logged in" semantics: because we only store the
// argon2id hash, we cannot show the plaintext of an existing code. The
// retrieve flow is therefore actually a regenerate flow: pressing the
// button generates a new code, invalidates the old one, and shows the
// new code in a one-shot display modal. This is the honest behaviour
// given the storage choice — pretending we can "show" an existing code
// would require storing it reversibly, which would mean the recovery
// code has weaker protection at rest than the PIN it recovers. Not an
// acceptable trade.

// -----------------------------------------------------------------------------
// Unit sub-structure section
// -----------------------------------------------------------------------------
// The CO defines the unit's hierarchy: Companies → Platoons → Sections.
// When configured, cadets can be assigned to a company/platoon/section
// via cascading dropdowns in the Cadets add/edit form. The nominal roll
// groups and demarcates cadets by this hierarchy.
// If not configured the Cadets page falls back to the legacy free-text
// platoon field.

function _structureSectionHtml(structure) {
  const configured = structure.length > 0;
  const summary = configured
    ? structure.map((co) => {
        const plts = (co.platoons || []).length;
        return `<li>${esc(co.name)} — ${plts} platoon${plts === 1 ? '' : 's'}</li>`;
      }).join('')
    : '';

  return `
    <section class="settings__section" data-section="structure">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Unit sub-structure</h2>
        <p class="settings__section-hint">
          Define companies, platoons, and sections. When configured, cadets can
          be assigned to a company → platoon → section hierarchy and the nominal
          roll groups them with demarcation headers. Leave unconfigured to use
          the original free-text platoon field.
        </p>
      </header>
      ${configured
        ? `<ul class="struct__summary">${summary}</ul>`
        : `<p class="settings__section-hint">Not configured — using free-text platoon field.</p>`
      }
      <div class="settings__actions">
        <button type="button" class="btn btn--ghost" data-action="configure-structure">
          ${configured ? 'Edit structure' : 'Configure structure'}
        </button>
        ${configured ? `
          <button type="button" class="btn btn--danger btn--sm" data-action="clear-structure">Clear structure</button>
        ` : ''}
      </div>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Category management section
// -----------------------------------------------------------------------------

function _categoriesSectionHtml(categories) {
  const isCustom = JSON.stringify(categories) !== JSON.stringify(DEFAULT_CATEGORIES);
  return `
    <section class="settings__section" data-section="categories">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Item categories</h2>
        <p class="settings__section-hint">
          Manage the category list shown in the inventory add/edit form and
          the category filter. ${isCustom
            ? 'Custom list active.'
            : 'Using default list — customise below to add or remove categories.'}
        </p>
      </header>
      <ul class="cat__list">
        ${categories.map(c => `
          <li class="cat__item">
            <span class="cat__name">${esc(c)}</span>
          </li>
        `).join('')}
      </ul>
      <div class="settings__actions">
        <button type="button" class="btn btn--ghost" data-action="manage-categories">
          Manage categories
        </button>
        ${isCustom
          ? `<button type="button" class="btn btn--ghost btn--sm" data-action="reset-categories">
               Reset to defaults
             </button>`
          : ''}
      </div>
    </section>
  `;
}

async function _onManageCategories() {
  const storedRaw = await Storage.settings.get('categories');
  const current   = Array.isArray(storedRaw) && storedRaw.length > 0
    ? storedRaw
    : [...DEFAULT_CATEGORIES];

  // Draft is a mutable copy.
  let draft = [...current];

  // Build the <ul> contents only — the scroll container is persistent in the DOM.
  function buildListHtml(d) {
    if (d.length === 0) {
      return `<p class="settings__section-hint" style="padding:8px 12px;margin:0">
        No categories — add one below.
      </p>`;
    }
    return `<ul class="cat__editor-list">` +
      d.map((c, i) => `
        <li class="cat__editor-item" data-idx="${i}" draggable="true">
          <span class="cat__editor-drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
          <span class="cat__editor-name">${esc(c)}</span>
          <div class="cat__editor-btns">
            <button type="button" class="btn btn--ghost btn--sm" data-cat-action="up"
                    data-idx="${i}" ${i === 0 ? 'disabled' : ''}
                    title="Move up (Shift+click: move to top)">↑</button>
            <button type="button" class="btn btn--ghost btn--sm" data-cat-action="down"
                    data-idx="${i}" ${i === d.length - 1 ? 'disabled' : ''}
                    title="Move down (Shift+click: move to bottom)">↓</button>
            <button type="button" class="btn btn--danger btn--sm"
                    data-cat-action="remove" data-idx="${i}" title="Remove">✕</button>
          </div>
        </li>
      `).join('') + `</ul>`;
  }

  openModal({
    titleHtml: 'Manage item categories',
    size:      'sm',
    bodyHtml:  `
      <div class="cat__editor-wrap">
        <div class="cat__editor-scroll" data-target="cat-list">${buildListHtml(draft)}</div>
        <div class="cat__editor-add">
          <input type="text" class="cat__editor-input" placeholder="New category name…"
                 maxlength="60" aria-label="New category">
          <button type="button" class="btn btn--ghost" data-cat-action="add">+ Add</button>
        </div>
      </div>
      <div class="cat__editor-footer">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-cat-action="save">Save</button>
      </div>
    `,
    onMount(panel, close) {
      const listEl   = panel.querySelector('[data-target="cat-list"]');
      const addInput = panel.querySelector('.cat__editor-input');

      function refresh() {
        listEl.innerHTML = buildListHtml(draft);
      }

      // ── Click handler: up/down (with Shift-click to jump), remove, add, save ──
      panel.addEventListener('click', async (e) => {
        const catAction = e.target.dataset.catAction;
        const idx = e.target.dataset.idx != null ? parseInt(e.target.dataset.idx, 10) : -1;

        if (catAction === 'up' && idx > 0) {
          if (e.shiftKey) {
            // Shift+↑ → jump to top
            const [moved] = draft.splice(idx, 1);
            draft.unshift(moved);
          } else {
            [draft[idx - 1], draft[idx]] = [draft[idx], draft[idx - 1]];
          }
          refresh();
        } else if (catAction === 'down' && idx < draft.length - 1) {
          if (e.shiftKey) {
            // Shift+↓ → jump to bottom
            const [moved] = draft.splice(idx, 1);
            draft.push(moved);
          } else {
            [draft[idx], draft[idx + 1]] = [draft[idx + 1], draft[idx]];
          }
          refresh();
        } else if (catAction === 'remove' && idx >= 0) {
          // "Initial Issue" is a protected loan purpose — prevent accidental removal
          // even if it somehow appears in the custom category list.
          if (draft[idx]?.toLowerCase() === INITIAL_ISSUE.toLowerCase()) {
            showToast(`"${INITIAL_ISSUE}" is a protected loan purpose and cannot be removed.`, 'warn');
            return;
          }
          draft.splice(idx, 1);
          refresh();
        } else if (catAction === 'add') {
          const name = addInput.value.trim();
          if (!name) { addInput.focus(); return; }
          if (draft.includes(name)) {
            showToast(`"${name}" is already in the list.`, 'warn');
            return;
          }
          draft.push(name);
          addInput.value = '';
          refresh();
          // Scroll new item into view
          listEl.scrollTop = listEl.scrollHeight;
          addInput.focus();
        } else if (catAction === 'save') {
          if (draft.length === 0) {
            showToast('Category list must not be empty.', 'warn');
            return;
          }
          await Storage.settings.set('categories', draft);
          Sync.notifyChanged();
          close();
          showToast('Categories saved.', 'success');
          await _render();
        }
      });

      // Allow pressing Enter in the add input.
      addInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          panel.querySelector('[data-cat-action="add"]')?.click();
        }
      });

      // ── Drag-and-drop reordering ──────────────────────────────────────────────
      let _dragIdx = -1;

      listEl.addEventListener('dragstart', (e) => {
        const li = e.target.closest('.cat__editor-item');
        if (!li) return;
        _dragIdx = parseInt(li.dataset.idx, 10);
        e.dataTransfer.effectAllowed = 'move';
        // Defer class add so the drag ghost renders cleanly before the row fades.
        setTimeout(() => li.classList.add('cat__editor-item--dragging'), 0);
      });

      listEl.addEventListener('dragend', () => {
        $$('.cat__editor-item--dragging', listEl)
          .forEach((el) => el.classList.remove('cat__editor-item--dragging'));
        $$('.cat__editor-item--drag-over', listEl)
          .forEach((el) => el.classList.remove('cat__editor-item--drag-over'));
        _dragIdx = -1;
      });

      listEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const li = e.target.closest('.cat__editor-item');
        if (!li) return;
        const overIdx = parseInt(li.dataset.idx, 10);
        if (overIdx === _dragIdx) return;
        $$('.cat__editor-item--drag-over', listEl)
          .forEach((el) => el.classList.remove('cat__editor-item--drag-over'));
        li.classList.add('cat__editor-item--drag-over');
      });

      listEl.addEventListener('dragleave', (e) => {
        // Only clear highlight when the pointer truly leaves the list container.
        if (!listEl.contains(e.relatedTarget)) {
          $$('.cat__editor-item--drag-over', listEl)
            .forEach((el) => el.classList.remove('cat__editor-item--drag-over'));
        }
      });

      listEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const li = e.target.closest('.cat__editor-item');
        if (!li || _dragIdx < 0) return;
        const dropIdx = parseInt(li.dataset.idx, 10);
        if (dropIdx === _dragIdx) { _dragIdx = -1; return; }
        const [moved] = draft.splice(_dragIdx, 1);
        draft.splice(dropIdx, 0, moved);
        _dragIdx = -1;
        refresh();
      });
    },
  });
}

async function _onResetCategories() {
  openModal({
    titleHtml: 'Reset categories to defaults?',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        This will replace your custom category list with the built-in defaults.
        Existing items keep their category values — only the selectable list changes.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-reset-cats">Reset to defaults</button>
      </div>
    `,
    onMount(panel, close) {
      panel.querySelector('[data-action="confirm-reset-cats"]')
        ?.addEventListener('click', async () => {
          await Storage.settings.delete('categories');
          Sync.notifyChanged();
          close();
          showToast('Categories reset to defaults.', 'success');
          await _render();
        });
    },
  });
}

function _openStructureModal(existingStructure) {
  // Deep-clone so edits don't mutate the passed-in array until Save.
  let draft = JSON.parse(JSON.stringify(existingStructure.length > 0
    ? existingStructure
    : []));

  function buildTreeHtml(d) {
    if (d.length === 0) {
      return `<p class="struct__empty-hint">No companies added yet. Click "+ Add company" below.</p>`;
    }
    return d.map((co, ci) => `
      <div class="struct__company">
        <div class="struct__company-header">
          <input type="text" class="struct__name-input" placeholder="Company name, e.g. A Coy"
                 value="${esc(co.name)}" data-path="co.${ci}.name" aria-label="Company name">
          <button type="button" class="btn btn--danger btn--sm struct__remove"
                  data-path="co.${ci}">✕</button>
        </div>
        <div class="struct__platoons">
          ${(co.platoons || []).map((plt, pi) => `
            <div class="struct__platoon">
              <div class="struct__platoon-header">
                <input type="text" class="struct__name-input" placeholder="Platoon name, e.g. 1 Plt"
                       value="${esc(plt.name)}" data-path="plt.${ci}.${pi}.name" aria-label="Platoon name">
                <button type="button" class="btn btn--danger btn--sm struct__remove"
                        data-path="plt.${ci}.${pi}">✕</button>
              </div>
              <div class="struct__sections">
                ${(plt.sections || []).map((sec, si) => `
                  <div class="struct__section">
                    <input type="text" class="struct__name-input struct__name-input--sm"
                           placeholder="Section, e.g. 1 Sec"
                           value="${esc(sec)}" data-path="sec.${ci}.${pi}.${si}" aria-label="Section name">
                    <button type="button" class="btn btn--danger btn--sm struct__remove"
                            data-path="sec.${ci}.${pi}.${si}">✕</button>
                  </div>
                `).join('')}
                <button type="button" class="btn btn--ghost btn--sm struct__add-btn"
                        data-add="sec.${ci}.${pi}">+ Add section</button>
              </div>
            </div>
          `).join('')}
          <button type="button" class="btn btn--ghost btn--sm struct__add-btn"
                  data-add="plt.${ci}">+ Add platoon</button>
        </div>
      </div>
    `).join('');
  }

  openModal({
    titleHtml: 'Configure unit sub-structure',
    size:      'md',
    persistent: true,
    bodyHtml:  `
      <p class="modal__body">
        Add companies, then platoons within each company, then sections within each platoon.
        Sections are optional — leave them out if your unit doesn't use section-level grouping.
      </p>
      <div class="struct__tree" data-target="structure-tree">
        ${buildTreeHtml(draft)}
      </div>
      <div class="struct__tree-actions">
        <button type="button" class="btn btn--ghost btn--sm struct__add-btn" data-add="co">+ Add company</button>
      </div>
      <div class="form__error" role="alert"></div>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--primary" data-action="save-structure">Save structure</button>
      </div>
    `,
    onMount(panel, close) {
      const treeEl = panel.querySelector('[data-target="structure-tree"]');
      const errEl  = panel.querySelector('.form__error');

      function rerender() {
        treeEl.innerHTML = buildTreeHtml(draft);
      }

      // Flush text inputs into draft before any add/remove action.
      function flushInputs() {
        panel.querySelectorAll('input[data-path]').forEach((input) => {
          const parts = input.dataset.path.split('.');
          const [type, ...indices] = parts;
          const [ci, pi, si] = indices.map(Number);
          if (type === 'co') draft[ci].name = input.value;
          else if (type === 'plt') draft[ci].platoons[pi].name = input.value;
          else if (type === 'sec') draft[ci].platoons[pi].sections[si] = input.value;
        });
      }

      panel.addEventListener('click', (e) => {
        const addBtn = e.target.closest('[data-add]');
        const removeBtn = e.target.closest('.struct__remove[data-path]');
        const saveBtn = e.target.closest('[data-action="save-structure"]');
        if (!addBtn && !removeBtn && !saveBtn) return;

        flushInputs();

        if (addBtn) {
          const spec = addBtn.dataset.add;
          const parts = spec.split('.');
          if (parts[0] === 'co') {
            draft.push({ name: '', platoons: [] });
          } else if (parts[0] === 'plt') {
            const ci = Number(parts[1]);
            draft[ci].platoons.push({ name: '', sections: [] });
          } else if (parts[0] === 'sec') {
            const [, ci, pi] = parts.map(Number);
            draft[ci].platoons[pi].sections.push('');
          }
          rerender();
          return;
        }

        if (removeBtn) {
          const spec  = removeBtn.dataset.path;
          const parts = spec.split('.');
          if (parts[0] === 'co') {
            draft.splice(Number(parts[1]), 1);
          } else if (parts[0] === 'plt') {
            const [, ci, pi] = parts.map(Number);
            draft[ci].platoons.splice(pi, 1);
          } else if (parts[0] === 'sec') {
            const [, ci, pi, si] = parts.map(Number);
            draft[ci].platoons[pi].sections.splice(si, 1);
          }
          rerender();
          return;
        }

        if (saveBtn) {
          flushInputs();
          // Validate: all named companies/platoons must have non-empty names.
          for (const co of draft) {
            if (!co.name.trim()) {
              errEl.textContent = 'All companies must have a name.';
              return;
            }
            for (const plt of co.platoons || []) {
              if (!plt.name.trim()) {
                errEl.textContent = `All platoons in "${co.name}" must have a name.`;
                return;
              }
            }
          }
          // Clean up: remove empty section strings from all platoons.
          const cleaned = draft.map((co) => ({
            name:     co.name.trim(),
            platoons: (co.platoons || []).map((plt) => ({
              name:     plt.name.trim(),
              sections: (plt.sections || []).map((s) => s.trim()).filter(Boolean),
            })),
          }));
          Structure.save(cleaned).then(() => {
            close();
            showToast('Unit structure saved.', 'success');
            _render();
          }).catch((err) => {
            errEl.textContent = err.message || 'Save failed.';
          });
        }
      });
    },
  });
}

function _recoverySectionHtml(recoveryStatus) {
  const exists = recoveryStatus.exists;
  const createdAt = exists && recoveryStatus.createdAt
    ? fmtDate(recoveryStatus.createdAt)
    : null;

  const statusBlock = exists
    ? `<div class="settings__status settings__status--ok">
         <strong>Active.</strong> Generated ${esc(createdAt)}.
       </div>`
    : `<div class="settings__status settings__status--warn">
         <strong>No active recovery code.</strong>
         If you forget your PIN there is no in-app recovery path. Generate
         one now.
       </div>`;

  const buttonLabel = exists ? 'Regenerate recovery code' : 'Generate recovery code';

  return `
    <section class="settings__section" data-section="recovery">
      <header class="settings__section-header">
        <h2 class="settings__section-title">OC PIN recovery</h2>
        <p class="settings__section-hint">
          A 12-character one-shot code that resets your PIN from the login
          screen if you forget it. Store it off this device &mdash; a
          printed copy in the unit safe or key cabinet is appropriate.
        </p>
      </header>
      ${statusBlock}
      <div class="form__actions">
        <button type="button" class="btn btn--primary"
                data-action="recovery-generate">${esc(buttonLabel)}</button>
      </div>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Two-factor authentication section
// -----------------------------------------------------------------------------

function _totpSectionHtml(user) {
  const enabled  = user?.totpEnabled === true;
  const backups  = enabled ? (user?.totpHashedBackups || []).length : 0;

  const statusBlock = enabled ? `
    <div class="settings__status-block settings__status-block--ok">
      <span class="badge badge--success">Enabled</span>
      Two-factor authentication is active on your account.
      Backup codes remaining: <strong>${backups}</strong>.
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--outline" data-action="manage-2fa">
        Manage 2FA (disable / regenerate backup codes)
      </button>
    </div>
  ` : `
    <div class="settings__status-block settings__status-block--warn">
      <span class="badge badge--neutral">Not enabled</span>
      Your account is protected by PIN only. Enabling 2FA adds a time-based
      code from an authenticator app as a second sign-in step.
    </div>
    <div class="form__actions">
      <button type="button" class="btn btn--primary" data-action="setup-2fa">
        Set up two-factor authentication
      </button>
    </div>
  `;

  return `
    <section class="settings__section" data-section="2fa">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Two-factor authentication (2FA)</h2>
        <p class="settings__section-hint">
          When enabled, signing in requires both your PIN and a 6-digit code
          from an authenticator app (Google Authenticator, Microsoft Authenticator,
          Authy, etc.). Works fully offline — no internet required.
        </p>
      </header>
      ${statusBlock}
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Cloud sync encryption section
// -----------------------------------------------------------------------------
// The snapshot pushed to OneDrive contains the META store, and META contains
// piiKey (the key protecting all cadet PII) and auditKey. Without an envelope
// the blob is self-decrypting. This section is what turns the envelope on.
// Sync refuses to push until it is configured — see sync.js _push().

// True when this artefact was built with `node build.js --defence`, which
// resolves cloud.js/sync.js to stubs so no cloud code is bundled at all.
const IS_DEFENCE_BUILD =
  (typeof __QSTORE_DEFENCE__ !== 'undefined') && __QSTORE_DEFENCE__;

/**
 * Legacy person data — extract to CEA, then remove.
 *
 * Renders NOTHING when there is none, which is every fresh install. A unit that
 * never held cadet data must never see this.
 */
function _legacySectionHtml(sum) {
  if (!sum || sum.total === 0) return '';
  const bits = [];
  if (sum.cadets)   bits.push(`${sum.cadets} cadet record${sum.cadets === 1 ? '' : 's'}`);
  if (sum.loans)    bits.push(`${sum.loans} loan${sum.loans === 1 ? '' : 's'} naming a borrower`);
  if (sum.requests) bits.push(`${sum.requests} equipment request${sum.requests === 1 ? '' : 's'}`);

  return `
    <section class="settings__section" data-section="legacy">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Legacy cadet data &mdash; action required</h2>
        <p class="settings__section-hint">
          This database still holds personal information from an earlier version.
          It must be exported to each member's CEA documents and then removed.
        </p>
      </header>

      <div class="settings__status-block settings__status-block--warn">
        <span class="badge badge--neutral">Found</span>
        ${esc(bits.join(', '))}. This information is not shown anywhere else in
        the app and cannot be edited here.
      </div>

      <div class="modal__warn" style="margin-top:12px">
        <strong>Read this before you start.</strong>
        <ul style="margin:6px 0 0 18px">
          <li>These are <strong>Commonwealth records</strong>. Under the Defence
              Youth Manual (Section 1, Chapter 2, para 67), failure to comply with
              records management obligations may expose you to
              <strong>criminal penalties under the Archives Act 1983</strong>.
              Deleting them before they reach CEA is not a shortcut &mdash; it is
              the offence.</li>
          <li>Every document generated here <strong>must be uploaded</strong> to
              the member's CEA documents, in the unit's
              <strong>approved CadetNet M365 location</strong>.</li>
          <li><strong>Not</strong> a personal Microsoft account. <strong>Not</strong>
              a personal OneDrive. <strong>Not</strong> any other cloud service.
              Storing cadet information outside approved systems is what caused
              this data to require removal in the first place.</li>
          <li>If a document is generated and not uploaded, that member's equipment
              can no longer be traced to them &mdash; the issue number on the
              document is the only remaining link.</li>
        </ul>
      </div>

      <div class="form__actions" style="margin-top:12px">
        <button type="button" class="btn btn--primary" data-action="legacy-export">
          &#9113; 1. Export Q records (one PDF per member)
        </button>
      </div>
      <div class="form__actions">
        <button type="button" class="btn btn--danger" data-action="legacy-purge">
          2. Remove legacy data &mdash; only after every record is in CEA
        </button>
      </div>
      <p class="settings__section-hint">
        Step 2 refuses to run while any member is still un-exported. Export first;
        the order is enforced in the storage layer, not just here.
      </p>
    </section>
  `;
}

// Assigned via a constant ternary rather than guarded with an early return, so
// esbuild can constant-fold __QSTORE_DEFENCE__ and DROP the unused branch
// entirely. An `if (IS_DEFENCE_BUILD) return ''` at the top of a function
// declaration leaves the whole body — including every cloud string — sitting in
// the artefact where a reviewer greps it. Dead code still reads as cloud code.
const _syncCryptoSectionHtml = (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
  // Defence build has no blob to seal, but rotation must stay reachable: a unit
  // migrating off a pre-fix build has compromised keys in its local database
  // whether or not this build can sync.
  ? _defenceKeyRotationSectionHtml
  : function _syncCryptoSectionHtmlImpl(settings) {
  // Nothing to configure if cloud sync is switched off entirely.
  if (settings['cloud.disabled'] === true) return '';

  const configured = Keyring.isConfigured();

  const statusBlock = configured
    ? `<div class="settings__status-block settings__status-block--ok">
         <span class="badge badge--success">Encrypted</span>
         Snapshots pushed to cloud are sealed on this device. The cloud copy
         cannot be read without the sync passphrase or the recovery code.
       </div>`
    : `<div class="settings__status-block settings__status-block--warn">
         <span class="badge badge--neutral">Not set up</span>
         <strong>Cloud sync is blocked until you set a passphrase.</strong>
         Snapshots contain the encryption key for cadet personal information,
         so they must never be written to cloud storage unsealed.
       </div>`;

  const body = configured
    ? `<div class="form__actions">
         <button type="button" class="btn btn--outline"
                 data-action="sync-crypto-reset">Reset encryption (re-key this device)</button>
       </div>`
    : `<form class="form" data-form="sync-crypto-setup" autocomplete="off">
         <label class="form__field">
           <span class="form__label">Sync passphrase</span>
           <input type="password" name="passphrase" minlength="12" required
                  autocomplete="new-password" placeholder="At least 12 characters">
         </label>
         <label class="form__field">
           <span class="form__label">Confirm passphrase</span>
           <input type="password" name="confirm" minlength="12" required
                  autocomplete="new-password">
         </label>
         <p class="settings__section-hint">
           Every device that syncs this unit's data needs this same passphrase
           entered once. It is not stored in the cloud copy and cannot be
           recovered from it &mdash; which is the point.
         </p>
         <div class="form__actions">
           <button type="submit" class="btn btn--primary"
                   data-action="sync-crypto-setup">Turn on cloud encryption</button>
         </div>
       </form>`;

  return `
    <section class="settings__section" data-section="sync-crypto">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Cloud sync encryption</h2>
        <p class="settings__section-hint">
          Seals the snapshot before it leaves this device. You will be given a
          one-shot recovery code &mdash; the only way back in if the passphrase
          is lost.
        </p>
      </header>
      ${statusBlock}
      ${body}
      <div class="settings__status-block settings__status-block--warn" style="margin-top:12px">
        <strong>Rotate keys after any exposure.</strong>
        Snapshots written by builds before this one carried the PII and audit
        keys inside the file. If this unit has ever synced with an older build,
        those keys must be replaced &mdash; enabling encryption alone just seals
        the same compromised keys inside a new envelope.
      </div>
      <div class="form__actions">
        <button type="button" class="btn btn--danger"
                data-action="rotate-keys">Rotate encryption keys…</button>
      </div>
    </section>
  `;
};

/**
 * Defence build: no sync, so no passphrase and no envelope — but a unit that
 * previously ran a pre-fix build still has keys in its local database that were
 * published to OneDrive, so rotation must remain reachable.
 */
function _defenceKeyRotationSectionHtml() {
  return `
    <section class="settings__section" data-section="sync-crypto">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Encryption keys</h2>
        <p class="settings__section-hint">
          This build has no cloud sync. Data stays in this browser's storage on
          this device and is never written to third-party cloud storage.
        </p>
      </header>
      <div class="settings__status-block settings__status-block--ok">
        <span class="badge badge--success">No cloud egress</span>
        Cloud sync is not present in this build &mdash; it is compiled out, not
        switched off.
      </div>
      <div class="settings__status-block settings__status-block--warn" style="margin-top:12px">
        <strong>Rotate if this unit ever synced with an older build.</strong>
        Snapshots written by builds before this one carried the encryption keys
        inside the file. If any such snapshot reached cloud storage, the keys in
        this database must be replaced.
      </div>
      <div class="form__actions">
        <button type="button" class="btn btn--danger"
                data-action="rotate-keys">Rotate encryption keys…</button>
      </div>
    </section>
  `;
}

// Same constant-ternary treatment: in the Defence build this whole body — Azure
// client ID, folder, blob filename, sign-in controls — must not merely be
// unreachable, it must be absent from the artefact.
const _cloudSectionHtml = (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
  ? () => ''
  : function _cloudSectionHtmlImpl(settings, status) {
  // Cloud sync requires a stable HTTP(S) origin for the OAuth redirect URI.
  // file:// origins can't be registered in Azure, so we disable the config
  // UI entirely and explain the situation rather than silently failing.
  if (window.location.protocol === 'file:') {
    return _cloudUnavailableFileProtocolHtml();
  }

  const clientId = settings['cloud.clientId'] || '';
  const folder   = settings['cloud.folder']   || 'QStore';
  const filename = settings['cloud.filename'] || 'qstore_data.json';
  const autoSync = settings['cloud.autoSync'] !== false;
  const lastSync = settings['cloud.lastSync'] || null;
  const redirect = status.redirectUri;

  // Cloud-disabled toggle: when true, the cloud sync UI collapses to just
  // the policy notice + the toggle itself, and Sync.notifyChanged is a
  // no-op. Useful for deployments where cloud sync is policy-prohibited
  // (e.g. defence-issued laptops where ITSO has restricted it) or where
  // the QM simply doesn't want it.
  const cloudDisabled = settings['cloud.disabled'] === true;

  return `
    <section class="settings__section" data-section="cloud">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Cloud sync — Microsoft OneDrive</h2>
        <p class="settings__section-hint">
          Sync your Q-Store data to OneDrive so it's backed up and accessible
          from other devices. Requires an Azure app registration; the unit's
          IT support or CO needs to do this once.
        </p>
      </header>

      <div class="settings__notice settings__notice--policy">
        <strong>Use unit-owned cloud storage only.</strong>
        Australian Army Cadet units are permitted to use their own
        OneDrive accounts (personal Microsoft, family, or unit-purchased
        Microsoft 365 Business) for Q-Store data. <strong>Do not sign in
        with a defence-issued account</strong> &mdash; defence M365
        tenants are not approved for this tool. If you're unsure which
        account is which, check with your unit's IT contact or the
        brigade ITSO before signing in.
      </div>

      <label class="form__field form__check">
        <input type="checkbox" name="cloudDisabled"
               data-action="toggle-cloud-disabled"
               ${cloudDisabled ? 'checked' : ''}>
        <span>Disable cloud sync entirely (sign out and hide the rest of this section)</span>
      </label>

      ${cloudDisabled ? `
        <p class="settings__section-hint">
          Cloud sync is off. Local data continues to work normally, and
          you can still use manual export/import below to back up the
          database to a file.
        </p>
      ` : `
      <div class="settings__cloud-status" data-target="sync-block">
        ${_syncBlockHtml(status, lastSync)}
      </div>

      <form class="form" data-form="cloud-config" autocomplete="off">
        ${clientId && lastSync ? `
        <div class="form__field">
          <span class="form__label">Azure Application (client) ID</span>
          <input type="hidden" name="clientId" value="${esc(clientId)}" data-cloud-id-hidden>
          <div class="cloud-id-row" data-cloud-id-badge>
            <div class="cloud-id-success">
              <span class="cloud-id-success__icon">✓</span>
              <span class="cloud-id-success__label">Client ID configured</span>
            </div>
            <button type="button" class="btn btn--ghost btn--sm cloud-id-reveal"
                    data-action="reveal-client-id"
                    data-client-id="${esc(clientId)}">Hold to reveal</button>
            <button type="button" class="btn btn--ghost btn--sm"
                    data-action="change-client-id">Change</button>
          </div>
          <div class="form__field" data-cloud-id-edit style="display:none;margin-top:0.5rem;">
            <input type="text" name="clientId_edit"
                   placeholder="00000000-0000-0000-0000-000000000000"
                   spellcheck="false">
            <span class="form__hint">Enter new Client ID, then save below. Leave blank to keep current.</span>
          </div>
        </div>
        ` : `
        <label class="form__field">
          <span class="form__label">Azure Application (client) ID</span>
          <input type="text" name="clientId" value="${esc(clientId)}"
                 placeholder="00000000-0000-0000-0000-000000000000"
                 spellcheck="false">
          <span class="form__hint">From Azure Portal → App registrations → Overview → Application (client) ID</span>
        </label>
        `}

        <div class="form__row">
          <label class="form__field form__field--grow">
            <span class="form__label">OneDrive folder</span>
            <input type="text" name="folder" value="${esc(folder)}" maxlength="80"
                   placeholder="QStore">
          </label>
          <label class="form__field form__field--grow">
            <span class="form__label">File name</span>
            <input type="text" name="filename" value="${esc(filename)}" maxlength="120"
                   placeholder="qstore_data.json">
          </label>
        </div>

        <label class="form__field form__check">
          <input type="checkbox" name="autoSync" ${autoSync ? 'checked' : ''}>
          <span>Auto-sync after every change (debounced 5 s)</span>
        </label>

        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary">Save settings</button>
        </div>
      </form>

      <details class="settings__details">
        <summary>Azure registration details</summary>
        <div class="settings__details-body">
          <p>
            To enable cloud sync, register a Single-Page Application in the
            Azure portal under your Microsoft account or unit M365 tenant.
            Use exactly this redirect URI:
          </p>
          <code class="settings__redirect">${esc(redirect)}</code>
          <p>
            After registering, copy the Application (client) ID into the field
            above. The app needs the delegated permissions
            <code>Files.ReadWrite</code> and <code>User.Read</code>. No admin
            consent is required.
          </p>
        </div>
      </details>
      `}
    </section>
  `;
};

function _cloudUnavailableFileProtocolHtml() {
  return `
    <section class="settings__section">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Cloud sync — unavailable</h2>
      </header>
      <div class="modal__warn">
        <strong>This page is loaded from a local file (file://).</strong>
        Cloud sync requires the app to be served from a stable web URL
        (HTTP or HTTPS) because Microsoft Entra ID needs a registered
        redirect URI. file:// origins can't be registered.
      </div>
      <p class="settings__section-hint" style="margin-top:12px">
        To use cloud sync, host this page on a web server. Options include:
      </p>
      <ul class="settings__section-hint" style="line-height:1.8">
        <li>A unit-internal web server</li>
        <li>SharePoint Online (upload the file and access via its URL)</li>
        <li>A simple local server: <code>python3 -m http.server 8000</code> in this folder</li>
      </ul>
      <p class="settings__section-hint">
        Local-only operation works fine without cloud sync — you just won't
        get automatic backup or cross-device sync.
      </p>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Data backup section — manual export/import
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Loan settings — default due date
// -----------------------------------------------------------------------------

function _loanSettingsSectionHtml(settings) {
  const stored = parseInt(settings['loans.defaultDueDays'], 10);
  // Default: 7 days. 0 means "leave due date blank".
  const current = isNaN(stored) ? 7 : stored;

  const opts = [
    { value: 0,   label: 'No default (leave blank)' },
    { value: 1,   label: 'Next day' },
    { value: 3,   label: '3 days' },
    { value: 7,   label: '1 week' },
    { value: 14,  label: '2 weeks' },
    { value: 30,  label: '1 month' },
    { value: 90,  label: '3 months' },
    { value: 180, label: '6 months' },
  ].map(({ value, label }) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');

  return `
    <section class="settings__section" data-section="loan-settings">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Loan defaults</h2>
        <p class="settings__section-hint">
          Pre-fill the due date when issuing items. The QM can always change
          the date on any individual issue. "Initial Issue" always uses
          a 6-year return date regardless of this setting.
        </p>
      </header>

      <div class="form__row form__row--align-center">
        <label class="form__label" for="default-due-days-select">Default loan duration</label>
        <select id="default-due-days-select" class="form__select"
                data-action="save-default-due-days">
          ${opts}
        </select>
      </div>
      <p class="form__hint" data-loan-default-hint>
        ${current === 0
          ? 'Due date field will start blank — QM must enter it manually.'
          : `New loans will default to <strong>${current} day${current === 1 ? '' : 's'}</strong> from today.`
        }
      </p>
    </section>
  `;
}

// Security section — auto-lock idle timeout
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Appearance — theme toggle (dark / light / system)
// -----------------------------------------------------------------------------

function _appearanceSectionHtml(settings) {
  const current = settings['ui.theme'] || 'dark';
  const opts = [
    { value: 'dark',   label: 'Dark (default)' },
    { value: 'light',  label: 'Light' },
    { value: 'system', label: 'Follow system preference' },
  ].map(({ value, label }) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');

  return `
    <section class="settings__section" data-section="appearance">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Appearance</h2>
        <p class="settings__section-hint">
          Choose a colour theme. "Follow system preference" switches automatically
          with your device's light/dark mode setting.
        </p>
      </header>

      <div class="form__row form__row--align-center">
        <label class="form__label" for="theme-select">Colour theme</label>
        <select id="theme-select" class="form__select settings__theme-select"
                data-action="save-theme">
          ${opts}
        </select>
      </div>
    </section>
  `;
}

function _securitySectionHtml(settings) {
  const stored = parseInt(settings['security.idleTimeoutMinutes'], 10);
  // Enforce minimum 5 min — 0 (disabled) is not permitted on security grounds.
  const current = (!isNaN(stored) && stored >= 5) ? stored : 15;

  const opts = [
    { value: 5,  label: '5 minutes' },
    { value: 10, label: '10 minutes' },
    { value: 15, label: '15 minutes' },
    { value: 30, label: '30 minutes' },
    { value: 60, label: '1 hour' },
  ].map(({ value, label }) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');

  return `
    <section class="settings__section" data-section="security">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Security</h2>
        <p class="settings__section-hint">
          Auto-lock the session after a period of inactivity. The screen is
          locked and a PIN is required to resume — useful on shared devices
          such as a duty computer or parade-night tablet.
        </p>
      </header>

      <div class="form__row form__row--align-center">
        <label class="form__label" for="idle-timeout-select">Auto-lock after idle</label>
        <select id="idle-timeout-select" class="form__select settings__idle-select"
                data-action="save-idle-timeout">
          ${opts}
        </select>
      </div>
      <p class="form__hint">
        Any mouse, keyboard, or touch activity resets the timer. The lock also
        triggers immediately on wake from sleep or when returning to this tab
        if the idle period has elapsed.
        Session will lock after <strong>${current} minute${current === 1 ? '' : 's'}</strong> of inactivity.
      </p>
    </section>
  `;
}

// Independent of cloud sync. Works on any origin including file://. Provides
// the only recovery path when cloud sync isn't configured.
//
// Export: builds the snapshot, triggers a download via a transient anchor.
//   Logs a 'data_export' audit entry BEFORE building the snapshot so the
//   entry is present in the export itself — the file self-documents when it
//   was created.
//
// Import: destructive. Wipes operational data and replaces it with the
//   snapshot. Same OVERWRITE-typed confirmation as cloud load, then a file
//   picker, then importAll. After success, force a reload so every page
//   picks up the new data and the audit key change.
//
// Both operations can take a few seconds on large datasets (lots of photos);
// buttons are disabled while in progress.
// -----------------------------------------------------------------------------

function _dataSectionHtml(settings) {
  const unitCode = settings.unitCode || '';
  const unitName = settings.unitName || '';
  const lastExport = settings['data.lastExport'] || null;
  const lastImport = settings['data.lastImport'] || null;

  const unitLabel = (unitCode || unitName)
    ? `<span class="settings__section-meta">${esc(unitCode || unitName)}</span>`
    : '';

  return `
    <section class="settings__section" data-section="data">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Data backup &amp; restore ${unitLabel}</h2>
        <p class="settings__section-hint">
          Export a complete snapshot of this Q-Store to a file you can keep
          off-device, or restore from a previously exported file. Use this
          for end-of-cycle archives, transferring to a new computer, or as a
          fallback when cloud sync isn't available.
        </p>
      </header>

      <div class="modal__warn" style="margin-bottom:12px">
        <strong>The export contains sensitive data.</strong>
        Staff details, the audit log, and (hashed) user PINs are all included.
        The export is always encrypted. Store it on encrypted media or the
        unit's approved CadetNet M365 location &mdash; never on a personal
        Microsoft account or personal OneDrive.
        ${_legacySummary?.total > 0 ? `
          <br><br><strong>This database still holds legacy cadet personal
          information</strong> (see &ldquo;Legacy cadet data&rdquo; above), so an
          export taken now will contain it too. Extract and remove it first if
          you can.
        ` : ''}
      </div>

      <div class="form__row">
        <div class="form__field form__field--grow">
          <span class="form__label">Last export</span>
          <span class="settings__data-meta">${esc(fmtDate(lastExport))}</span>
        </div>
        <div class="form__field form__field--grow">
          <span class="form__label">Last import</span>
          <span class="settings__data-meta">${esc(fmtDate(lastImport))}</span>
        </div>
      </div>

      <div class="form__actions">
        <button type="button" class="btn btn--primary"
                data-action="export-data">Download backup file</button>
        <button type="button" class="btn btn--danger"
                data-action="import-data">Restore from backup file&hellip;</button>
      </div>

      <details class="settings__details">
        <summary>Import data from a v1 backup file</summary>
        <div class="settings__details-body">
          <p>
            One-time migration from a QStore v1 backup file (filename pattern
            <code>qstore_&lt;unitcode&gt;_&lt;date&gt;.json</code>). This is a
            destructive operation: it clears the v2 database first, then
            imports the v1 contents through a schema migration. Use this when
            transitioning a unit from v1 to v2 for the first time.
          </p>
          <p>
            <strong>Not the same as Restore from backup file</strong> above —
            that's the v2-to-v2 path. Picking the wrong button is rejected
            by a file-shape sanity check, but the buttons are kept distinct
            for clarity.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--danger"
                    data-action="import-v1">Import from v1 backup file&hellip;</button>
          </div>
        </div>
      </details>

      <details class="settings__details">
        <summary>Import items from CSV</summary>
        <div class="settings__details-body">
          <p>
            Bulk-import inventory items from a spreadsheet. Useful when
            transitioning a unit from a non-QStore system (Excel, paper).
            Existing items match by <code>id</code> or <code>nsn</code> and
            are updated in place — fields not in the CSV (like
            <code>onLoan</code>, photos, creation timestamps) are preserved.
          </p>
          <p>
            A preview is shown before any data is written. You can review
            the column mapping and row counts and cancel without committing.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--primary"
                    data-action="import-items-csv">Import items from CSV&hellip;</button>
          </div>
        </div>
      </details>

      <input type="file" data-target="import-file"
             accept="application/json,.json,.qstore" hidden>
      <input type="file" data-target="import-v1-file"
             accept="application/json,.json" hidden>
    </section>
  `;
}

function _syncBlockHtml(status, lastSync) {
  const account = status.account;
  const stateMsg = _stateMessage(status);
  const lastSyncTxt = lastSync ? `Last sync: ${fmtDate(lastSync)}` : 'Never synced';

  return `
    <div class="settings__sync-status settings__sync-status--${esc(status.state)}">
      <div class="settings__sync-state">
        <span class="settings__sync-dot"></span>
        ${esc(stateMsg)}
      </div>
      ${account ? `
        <div class="settings__sync-account">
          <span class="settings__sync-account-name">${esc(account.name || account.username)}</span>
          ${account.username && account.username !== account.name
            ? `<span class="settings__sync-account-mail">${esc(account.username)}</span>`
            : ''}
        </div>
      ` : ''}
      <div class="settings__sync-meta">${esc(lastSyncTxt)}</div>
      ${status.lastError ? `
        <div class="settings__sync-error">
          ${esc(status.lastError)}
        </div>
      ` : ''}
      <div class="settings__sync-actions">
        ${_syncActionsHtml(status)}
      </div>
    </div>
  `;
}

function _stateMessage(status) {
  switch (status.state) {
    case 'unconfigured':  return 'Not configured';
    case 'not-signed-in': return 'Configured, not signed in';
    case 'signed-in':     return status.pending ? 'Sync pending…' : 'Signed in';
    case 'busy':          return 'Syncing…';
    case 'error':         return 'Sync error';
    default:              return status.state;
  }
}

function _syncActionsHtml(status) {
  const buttons = [];
  if (status.state === 'unconfigured') {
    return `<span class="settings__sync-hint">Save your Client ID below to enable sign-in.</span>`;
  }
  if (status.state === 'not-signed-in' || status.state === 'error') {
    buttons.push(`<button type="button" class="btn btn--primary" data-action="sign-in">Sign in to OneDrive</button>`);
    // Recovery button — clears stuck MSAL interaction state. Shown alongside
    // Sign in so users with interaction_in_progress errors have a self-service fix.
    buttons.push(`<button type="button" class="btn btn--ghost" data-action="reset-auth-state"
                         title="Use this if sign-in is stuck or shows an error after refreshing">
                    Reset sign-in state
                  </button>`);
  }
  if (status.state === 'signed-in' || status.state === 'busy') {
    buttons.push(`<button type="button" class="btn btn--primary" data-action="sync-now" ${status.busy ? 'disabled' : ''}>Sync now</button>`);
    buttons.push(`<button type="button" class="btn btn--ghost" data-action="load-from-cloud" ${status.busy ? 'disabled' : ''}>Load from cloud…</button>`);
    buttons.push(`<button type="button" class="btn btn--ghost" data-action="sign-out">Sign out</button>`);
  }
  return buttons.join('');
}

// -----------------------------------------------------------------------------
// Live status updates
// -----------------------------------------------------------------------------

async function _refreshSyncBlock(status) {
  if (!_root) return;
  const block = $('[data-target="sync-block"]', _root);
  if (!block) return;
  const settings = await Storage.settings.getAll();
  block.innerHTML = _syncBlockHtml(status, settings['cloud.lastSync']);
}

// -----------------------------------------------------------------------------
// Event wiring
// -----------------------------------------------------------------------------

function _wireEventListeners() {
  // Note: _root.addEventListener('click', _onRootClick) is wired once in
  // mount() with { signal } — not here — to avoid accumulation across re-renders.
  const cloudForm = $('form[data-form="cloud-config"]', _root);
  if (cloudForm) cloudForm.addEventListener('submit', _onSaveConfig);
  const unitForm = $('form[data-form="unit-config"]', _root);
  if (unitForm) unitForm.addEventListener('submit', _onSaveUnit);
  const keyForm = $('form[data-form="activate-key"]', _root);
  if (keyForm) keyForm.addEventListener('submit', _onActivateKey);

  const syncCryptoForm = $('form[data-form="sync-crypto-setup"]', _root);
  if (syncCryptoForm) {
    syncCryptoForm.addEventListener('submit', (e) => {
      e.preventDefault();
      _doSetupSyncEncryption(e.currentTarget);
    });
  }

  const logoInput = $('input[data-target="logo-file-input"]', _root);
  if (logoInput) logoInput.addEventListener('change', _onLogoFileChange);

  // Cloud-disabled toggle. The checkbox lives outside any <form>, so we
  // listen for the change event directly on the root and dispatch from
  // the data-action attribute. Saving the setting is async — we mark
  // the checkbox disabled while the save runs to prevent rapid-fire
  // toggling that could leave settings and runtime out of step.
  const cloudToggle = $('input[data-action="toggle-cloud-disabled"]', _root);
  if (cloudToggle) {
    cloudToggle.addEventListener('change', _onToggleCloudDisabled);
  }

  const revealBtn = $('[data-action="reveal-client-id"]', _root);
  if (revealBtn) _wireRevealButton(revealBtn);

  const changeBtn = $('[data-action="change-client-id"]', _root);
  if (changeBtn) {
    changeBtn.addEventListener('click', () => {
      const editDiv = $('[data-cloud-id-edit]', _root);
      if (editDiv) {
        editDiv.style.display = '';
        const inp = editDiv.querySelector('input');
        if (inp) inp.focus();
      }
    });
  }

  const idleSelect = $('[data-action="save-idle-timeout"]', _root);
  if (idleSelect) idleSelect.addEventListener('change', _onIdleTimeoutChange);

  const dueDaysSelect = $('[data-action="save-default-due-days"]', _root);
  if (dueDaysSelect) dueDaysSelect.addEventListener('change', _onDefaultDueDaysChange);

  const themeSelect = $('[data-action="save-theme"]', _root);
  if (themeSelect) themeSelect.addEventListener('change', _onThemeChange);
}

async function _onDefaultDueDaysChange(e) {
  const select = e.target;
  const days   = parseInt(select.value, 10);
  select.disabled = true;
  try {
    await Storage.settings.set('loans.defaultDueDays', isNaN(days) ? 7 : days);
    showToast(
      days === 0
        ? 'Default loan duration cleared — due date will start blank.'
        : `Default loan duration set to ${days} day${days === 1 ? '' : 's'}.`,
      'success'
    );
    await _render();   // refresh hint text
  } catch (err) {
    showToast('Failed to save loan default.', 'error');
  } finally {
    select.disabled = false;
  }
}

async function _onThemeChange(e) {
  const select = e.target;
  const theme  = select.value;
  select.disabled = true;
  try {
    await Storage.settings.set('ui.theme', theme);
    // Apply immediately — save to localStorage for fast next-boot application.
    applyTheme(theme);
    showToast(
      theme === 'dark'   ? 'Theme set to dark.'  :
      theme === 'light'  ? 'Theme set to light.' :
                           'Theme will follow your system preference.',
      'success'
    );
  } catch (err) {
    showToast('Failed to save theme setting.', 'error');
  } finally {
    select.disabled = false;
  }
}

async function _onIdleTimeoutChange(e) {
  const select  = e.target;
  const minutes = parseInt(select.value, 10);
  select.disabled = true;
  try {
    await Storage.settings.set('security.idleTimeoutMinutes', isNaN(minutes) ? 0 : minutes);
    // Notify the shell so it restarts the idle watcher immediately.
    document.dispatchEvent(new CustomEvent('qstore:idle-timeout-changed'));
    showToast(
      minutes > 0
        ? `Auto-lock set to ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'Auto-lock disabled.',
      'success'
    );
    await _render();   // refresh hint text
  } catch (err) {
    showToast('Failed to save auto-lock setting.', 'error');
  } finally {
    select.disabled = false;
  }
}

function _wireRevealButton(btn) {
  const original = 'Hold to reveal';
  const show = () => {
    btn.textContent = btn.dataset.clientId;
    btn.classList.add('cloud-id-reveal--active');
  };
  const hide = () => {
    btn.textContent = original;
    btn.classList.remove('cloud-id-reveal--active');
  };
  btn.addEventListener('mousedown',    show);
  btn.addEventListener('mouseup',      hide);
  btn.addEventListener('mouseleave',   hide);
  btn.addEventListener('touchstart',   (e) => { e.preventDefault(); show(); }, { passive: false });
  btn.addEventListener('touchend',     hide);
  btn.addEventListener('touchcancel',  hide);
}

async function _onToggleCloudDisabled(e) {
  const checkbox = e.target;
  const desiredDisabled = checkbox.checked;
  checkbox.disabled = true;
  try {
    await Storage.settings.set('cloud.disabled', desiredDisabled);
    if (desiredDisabled) {
      // If the user is currently signed in, sign them out so the
      // disabled state is genuinely "no cloud activity". This also
      // clears any cached MSAL tokens. Errors from sign-out are
      // non-fatal — the setting is still applied.
      try {
        const provider = getProvider();
        if (provider && provider.isSignedIn && provider.isSignedIn()) {
          await provider.signOut();
        }
      } catch (err) {
        console.warn('Sign-out during cloud-disable failed:', err);
      }
    }
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   desiredDisabled
        ? 'Cloud sync disabled (UI hidden, sync engine stopped, signed out).'
        : 'Cloud sync re-enabled.',
    });
    Sync.notifyChanged();   // trigger a status emit so the sync block
                            // updates if it's now visible
    await _render();
  } catch (err) {
    showToast('Failed to update cloud-disabled setting: ' + (err.message || err), 'error');
    // Roll back the visual state so the UI matches storage.
    checkbox.checked = !desiredDisabled;
  } finally {
    checkbox.disabled = false;
  }
}

async function _onSaveUnit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $('.form__error', form);
  errEl.textContent = '';

  const fd = new FormData(form);
  // Trim everything; empty strings are valid (clears the field).
  const fields = {
    unitName: String(fd.get('unitName') || '').trim(),
    unitCode: String(fd.get('unitCode') || '').trim(),
    state:    String(fd.get('state')    || '').trim(),
    qmName:   String(fd.get('qmName')   || '').trim(),
    qmRank:   String(fd.get('qmRank')   || '').trim().toUpperCase(),
    qmEmail:  String(fd.get('qmEmail')  || '').trim(),
    coName:   String(fd.get('coName')   || '').trim(),
    coEmail:  String(fd.get('coEmail')  || '').trim(),
  };

  // Light validation only — emails optional, but if present must look like one.
  // We are deliberately permissive on rank: free text with a datalist of
  // suggestions is enough; AB189 generation can validate strictly at use.
  for (const key of ['qmEmail', 'coEmail']) {
    if (fields[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[key])) {
      errEl.textContent = `${key === 'qmEmail' ? 'QM' : 'OC/QM'} email is not in a valid format.`;
      return;
    }
  }

  try {
    await Storage.settings.setMany(fields);
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Unit details updated (name: ${fields.unitName || '(empty)'}, code: ${fields.unitCode || '(empty)'}).`,
    });
    // Soft-update the shell brand without a re-render so we don't lose the
    // settings page's open state. We deliberately don't try to update the
    // login screen because the user is logged in — login screen's values
    // refresh next time it mounts.
    // Soft-update the shell brand. name+code now live inside .shell__brand-text
    // so the parent for new element insertion is that wrapper, not .shell__brand.
    const brand     = document.querySelector('.shell__brand');
    const brandText = brand && brand.querySelector('.shell__brand-text');
    const brandName = brandText && brandText.querySelector('.shell__brand-name');
    if (brandName) brandName.textContent = fields.unitName || 'QStore IMS';
    if (brandText) {
      let brandCode = brandText.querySelector('.shell__brand-code');
      if (fields.unitCode) {
        if (!brandCode) {
          brandCode = document.createElement('div');
          brandCode.className = 'shell__brand-code';
          brandText.appendChild(brandCode);
        }
        brandCode.textContent = fields.unitCode;
      } else if (brandCode) {
        brandCode.remove();
      }
    }
    _flashSuccess('Unit details saved.');
  } catch (err) {
    errEl.textContent = err.message || 'Could not save unit details.';
  }
}

// Cloud config form handler. The form never renders in the Defence build, but
// an unreachable handler still ships its strings — including the blob filename
// — into the artefact. Ternary so esbuild drops it.
const _onSaveConfig = (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
  ? async function _onSaveConfigDefence(e) { e.preventDefault(); }
  : async function _onSaveConfigStandard(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errEl = $('.form__error', form);
  errEl.textContent = '';

  const fd = new FormData(form);
  // clientId_edit is present when the user clicked "Change" on a configured ID.
  // If it's non-empty, use it; otherwise fall back to the hidden clientId field.
  const editedId = String(fd.get('clientId_edit') || '').trim();
  const clientId = editedId || String(fd.get('clientId') || '').trim();
  const folder   = String(fd.get('folder')   || '').trim() || 'QStore';
  const filename = String(fd.get('filename') || '').trim() || 'qstore_data.json';
  const autoSync = fd.get('autoSync') === 'on';

  // Validate the client ID is at least the right shape — Azure GUIDs are
  // 8-4-4-4-12 hex. Empty is allowed (clears the configuration).
  if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    errEl.textContent = 'Client ID should be a GUID like 00000000-0000-0000-0000-000000000000.';
    return;
  }

  try {
    await Storage.settings.set('cloud.autoSync', autoSync);
    await getProvider().configure({ clientId, folder, filename });
    // Reset sync state so any previous error clears.
    await Sync.init();
    await Storage.audit.append({
      action: 'settings_change',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Cloud config updated (clientId set: ${clientId ? 'yes' : 'no'}, folder: ${folder}, file: ${filename}, autoSync: ${autoSync}).`,
    });
    // Re-render the full settings page so the Client ID badge reflects the
    // newly saved ID (the badge's data-client-id is baked in at render time).
    await _render();
    _flashSuccess('Cloud settings saved.');
  } catch (err) {
    errEl.textContent = err.message || 'Could not save settings.';
  }
};

async function _onRootClick(e) {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  switch (action) {
    case 'sign-in':           await _doSignIn();           break;
    case 'sign-out':          await _doSignOut();          break;
    case 'sync-now':          await _doSyncNow();          break;
    case 'load-from-cloud':   await _doLoadFromCloud();    break;
    case 'reset-auth-state':  await _doResetAuthState();   break;
    case 'export-data':     await _doExportData(e.target.closest('button')); break;
    case 'import-data':     await _doImportData(e.target.closest('button')); break;
    case 'import-v1':       await _doImportV1(e.target.closest('button')); break;
    case 'import-items-csv':  CsvUi.openItemsCsvImport();  break;
    case 'recovery-generate':    await _doGenerateRecovery(e.target.closest('button')); break;
    case 'sync-crypto-reset':    await _doResetSyncEncryption(); break;
    case 'rotate-keys':          await _doRotateKeys(); break;
    case 'legacy-export':        await _doLegacyExport(); break;
    case 'legacy-purge':         await _doLegacyPurge(); break;
    case 'setup-2fa':            { const s = AUTH.getSession(); if (s?.userId) TotpSetup.openTotpSetup(s.userId); } break;
    case 'manage-2fa':           { const s = AUTH.getSession(); if (s?.userId) TotpSetup.openTotpManage(s.userId); } break;
    case 'logo-remove':          await _doRemoveLogo(); break;
    case 'logo-download-copy':  await _doDownloadUnitCopy(); break;
    case 'configure-structure':  await _onConfigureStructure(); break;
    case 'clear-structure':      await _onClearStructure(e.target.closest('button')); break;
    case 'manage-categories':   await _onManageCategories(); break;
    case 'reset-categories':    await _onResetCategories();  break;
  }
}

async function _onConfigureStructure() {
  const existing = await Structure.load();
  _openStructureModal(existing);
}

async function _onClearStructure(btn) {
  if (btn) { btn.disabled = true; }
  openModal({
    titleHtml: 'Clear unit structure?',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        This removes the company/platoon/section configuration. Cadets already assigned
        to a company/platoon/section will retain those values on their records, but the
        cascading dropdowns will no longer be available in the edit form. The nominal roll
        will revert to the flat list view.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn--danger" data-action="confirm-clear-structure">Clear structure</button>
      </div>
    `,
    onMount(panel, close) {
      $('[data-action="confirm-clear-structure"]', panel)?.addEventListener('click', async () => {
        await Structure.save([]);
        close();
        showToast('Unit structure cleared.', 'info');
        await _render();
      });
    },
  });
  if (btn) btn.disabled = false;
}

// -----------------------------------------------------------------------------
// Platoon migration wizard
// -----------------------------------------------------------------------------
// Reads all cadets that have a `plt` value but no `company` set, groups them
// by unique plt string, then shows a mapping table so the QM can assign each
// existing plt value to a company → platoon → section in the new structure.
// On confirm, rewrites each cadet record with the selected structure fields.
// -----------------------------------------------------------------------------


async function _doResetAuthState() {
  try {
    await getProvider().resetAuthState();
    // Re-initialise so the provider picks up the cleared state.
    await getProvider().init();
    await _refreshSyncBlock(Sync.getStatus());
    showToast('Sign-in state cleared. You can now sign in again.', 'success');
  } catch (err) {
    showToast('Reset failed: ' + (err.message || err), 'error');
  }
}

async function _doSignIn() {
  try {
    await getProvider().signIn();
    // On desktop popup, the sign-in is now complete and we can refresh.
    // On mobile redirect, the page has navigated away and this code never
    // executes — the next page load will resume.
    await _refreshSyncBlock(Sync.getStatus());
  } catch (err) {
    showToast('Sign-in failed: ' + (err.message || err), 'error');
  }
}

async function _doSignOut() {
  if (!confirm('Sign out of OneDrive? Local data will not be affected.')) return;
  try {
    await getProvider().signOut();
    await _refreshSyncBlock(Sync.getStatus());
  } catch (err) {
    showToast('Sign-out failed: ' + (err.message || err), 'error');
  }
}

async function _doSyncNow() {
  try {
    await Sync.syncNow();
    _flashSuccess('Synced to OneDrive.');
  } catch (err) {
    showToast('Sync failed: ' + (err.message || err), 'error');
  }
}

async function _doLoadFromCloud() {
  openModal({
    titleHtml: 'Load from OneDrive — confirm',
    size: 'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the version
        currently in OneDrive. Local changes since the last sync will be lost.
        This cannot be undone.
      </div>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-load">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Replace local data</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-load"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        try {
          let result = await Sync.loadFromCloud();
          // Sealed blob and this device holds no key — ask for the passphrase
          // or recovery code, then retry once with it. unlockFrom() caches the
          // recovered blob key, so later syncs on this device won't prompt.
          if (!result.ok && result.needsSecret) {
            const secret = await _promptSyncSecret();
            if (!secret) {
              errEl.textContent = 'Cancelled — the cloud copy is encrypted and cannot be read without it.';
              return;
            }
            result = await Sync.loadFromCloud({ secret });
          }
          if (!result.ok) {
            errEl.textContent = (result.error?.message) || 'Download failed.';
            return;
          }
          if (!result.imported) {
            errEl.textContent = 'No data file found in OneDrive yet.';
            return;
          }
          if (result.legacy) {
            showToast(
              'Loaded an UNENCRYPTED cloud backup. Its keys are compromised — '
              + 'set a sync passphrase and re-sync, then purge the old OneDrive file.',
              'warn',
            );
          }
          close();
          // Force a full reload so every page picks up the new data.
          // This is brutal but correct — the page-level state of the
          // current tab is now stale (item lists, filters, etc.) and the
          // simplest correct response is to start fresh.
          location.reload();
        } catch (err) {
          errEl.textContent = err.message || 'Download failed.';
        }
      });
    },
  });
}

// -----------------------------------------------------------------------------
// Data backup / restore handlers
// -----------------------------------------------------------------------------
// These run from the data section buttons. Each disables its trigger button
// while running so a frantic double-click can't kick off two exports or two
// imports racing each other through the same IndexedDB transaction queue.

// ---------------------------------------------------------------------------
// Encrypted backup helpers
// Encrypted file format: { qstoreEncrypted: true, v: 1, salt: b64, iv: b64, data: b64 }
// Key derivation: PBKDF2 (SHA-256, 310000 iterations) → AES-256-GCM
// ---------------------------------------------------------------------------

function _b64(buf) {
  // Spread operator on large Uint8Array blows the call stack for big backups.
  // Chunk the conversion to stay well within argument limits.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function _fromB64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function _encryptBackup(jsonStr, password) {
  const enc      = new TextEncoder();
  const salt     = crypto.getRandomValues(new Uint8Array(32));
  const iv       = crypto.getRandomValues(new Uint8Array(12));
  const baseKey  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aesKey   = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(jsonStr));
  return JSON.stringify({ qstoreEncrypted: true, v: 1, salt: _b64(salt), iv: _b64(iv), data: _b64(ciphertext) });
}

async function _decryptBackup(encObj, password) {
  if (!encObj?.qstoreEncrypted || encObj.v !== 1) throw new Error('Not a QStore encrypted backup.');
  const enc     = new TextEncoder();
  const salt    = _fromB64(encObj.salt);
  const iv      = _fromB64(encObj.iv);
  const data    = _fromB64(encObj.data);
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aesKey  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
  } catch {
    throw new Error('Incorrect password or corrupted backup file.');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

async function _doExportData(btn) {
  if (btn) btn.disabled = true;
  try {
    // Audit BEFORE building the snapshot, so the export self-documents.
    // The audit entry will be inside the snapshot we hand the user.
    await Storage.audit.append({
      action: 'data_export',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   'Manual data export to file.',
    });

    const snapshot = await Storage.exportAll();

    const settings = await Storage.settings.getAll();
    const unitTag = (settings.unitCode || settings.unitName || 'qstore')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'qstore';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const baseFilename = `qstore-backup-${unitTag}-${stamp}`;

    // Prompt for the export password. Encryption is NOT optional: the snapshot
    // carries piiKey and auditKey in its META block, so a plain-JSON export
    // would publish the key alongside the ciphertext it opens. Import still
    // accepts legacy plain files so existing backups remain restorable.
    openModal({
      titleHtml: 'Export backup',
      size: 'sm',
      bodyHtml: `
        <p class="modal__body">
          Backups are always encrypted. The snapshot contains the keys that
          protect cadet personal information, so an unencrypted copy would hand
          anyone who finds the file both the data and the key to it.
          You will need this password to restore.
        </p>
        <div class="modal__warn">
          <strong>There is no way to recover this password.</strong> Store it
          with the unit's other credentials. Your live data is unaffected if you
          lose it &mdash; only this backup file becomes unreadable.
        </div>
        <form class="form" data-form="export-pw" autocomplete="off">
          <label class="form__field">
            <span class="form__label">Password</span>
            <input type="password" name="pw" required minlength="12"
                   autocomplete="new-password"
                   placeholder="At least 12 characters">
          </label>
          <label class="form__field">
            <span class="form__label">Confirm password</span>
            <input type="password" name="pw2" autocomplete="new-password"
                   placeholder="Repeat password">
          </label>
          <div class="form__error" role="alert"></div>
          <div class="form__actions">
            <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
            <button type="submit" class="btn btn--primary">Export backup</button>
          </div>
        </form>
      `,
      onMount(panel, close) {
        const form  = $('form[data-form="export-pw"]', panel);
        const errEl = $('.form__error', panel);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errEl.textContent = '';
          const fd  = new FormData(form);
          const pw  = String(fd.get('pw')  || '');
          const pw2 = String(fd.get('pw2') || '');
          // Encryption is mandatory: exportAll() emits META, and META holds
          // piiKey and auditKey. An unencrypted export publishes the key that
          // decrypts the very PII sitting beside it in the same file — the same
          // defect that put those keys in the OneDrive blob.
          if (pw.length < 12) {
            errEl.textContent = 'Password must be at least 12 characters.';
            return;
          }
          if (pw !== pw2) {
            errEl.textContent = 'Passwords do not match.';
            return;
          }
          const submitBtn = form.querySelector('[type="submit"]');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Exporting…'; }
          try {
            const outStr   = await _encryptBackup(JSON.stringify(snapshot), pw);
            const filename = `${baseFilename}.qstore`;
            const mimeType = 'application/octet-stream';
            const blob = new Blob([outStr], { type: mimeType });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            close();
            await Storage.settings.set('data.lastExport', new Date().toISOString());
            await _render();
            _flashSuccess(`Backup saved as ${filename} (encrypted).`);
          } catch (err) {
            console.error('Export failed:', err);
            errEl.textContent = 'Export failed: ' + (err.message || err);
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Export backup'; }
          }
        });
      },
    });
  } catch (err) {
    console.error('Export failed:', err);
    showToast('Export failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _doImportData(btn) {
  // Step 1 — typed-OVERWRITE confirmation dialog. Same pattern as cloud load.
  // Only after the user types OVERWRITE do we open the file picker. This
  // keeps the destructive action behind a deliberate gate.
  openModal({
    titleHtml: 'Restore from backup — confirm',
    size: 'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the contents of
        the backup file you select. Local changes since that backup was made
        will be lost. This cannot be undone.
      </div>
      <p>The backup file's user accounts will replace the current ones — make
      sure you know the PINs for the accounts in the backup before continuing,
      or you may lock yourself out.</p>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-restore">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Choose file&hellip;</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-restore"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        close();
        // Trigger the hidden file input. The file picker dialog itself
        // serves as the second-stage gate — cancelling it cancels the
        // operation cleanly.
        const fileInput = $('input[data-target="import-file"]', _root);
        if (!fileInput) {
          showToast('Something went wrong — please reload the page and try again.', 'error');
          return;
        }
        // One-shot listener so repeated imports don't stack handlers.
        const onChange = async () => {
          fileInput.removeEventListener('change', onChange);
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // allow re-selecting the same file later
          if (!file) return;
          await _performImport(file, btn);
        };
        fileInput.addEventListener('change', onChange);
        fileInput.click();
      });
    },
  });
}

/**
 * Prompt the user for a decryption password when importing an encrypted backup.
 * Returns the decrypted snapshot object, or null if the user cancels.
 */
function _promptDecrypt(encObj) {
  return new Promise((resolve) => {
    openModal({
      titleHtml: 'Encrypted backup — enter password',
      size: 'sm',
      bodyHtml: `
        <p class="modal__body">
          This backup file is password-protected. Enter the password that was
          used when the backup was exported.
        </p>
        <form class="form" data-form="decrypt-pw" autocomplete="off">
          <label class="form__field">
            <span class="form__label">Backup password</span>
            <input type="password" name="pw" autocomplete="current-password" required
                   autofocus placeholder="Enter backup password">
          </label>
          <div class="form__error" role="alert"></div>
          <div class="form__actions">
            <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
            <button type="submit" class="btn btn--primary">Decrypt &amp; restore</button>
          </div>
        </form>
      `,
      onMount(panel, close) {
        const form  = $('form[data-form="decrypt-pw"]', panel);
        const errEl = $('.form__error', panel);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errEl.textContent = '';
          const pw = String(new FormData(form).get('pw') || '');
          const submitBtn = form.querySelector('[type="submit"]');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Decrypting…'; }
          try {
            const snapshot = await _decryptBackup(encObj, pw);
            close();
            resolve(snapshot);
          } catch (err) {
            errEl.textContent = err.message || 'Decryption failed.';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Decrypt & restore'; }
          }
        });
        // If the modal is closed without submitting, resolve null so the
        // import caller knows to abort cleanly.
        panel.closest('.modal')?.addEventListener('modal-close', () => resolve(null), { once: true });
      },
    });
  });
}

async function _performImport(file, btn) {
  if (btn) btn.disabled = true;
  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast('That file is not valid JSON. Choose a backup file produced by QStore.', 'error');
      if (btn) btn.disabled = false;
      return;
    }

    // Detect encrypted backup (.qstore format)
    let snapshot;
    if (parsed?.qstoreEncrypted === true) {
      snapshot = await _promptDecrypt(parsed);
      if (!snapshot) { if (btn) btn.disabled = false; return; } // user cancelled
    } else {
      snapshot = parsed;
    }

    if (!snapshot || typeof snapshot !== 'object' || !snapshot.schemaVersion) {
      showToast('That file is not a QStore backup (missing schemaVersion).', 'error');
      if (btn) btn.disabled = false;
      return;
    }
    // Storage.importAll throws on schema mismatch; we surface that cleanly.
    const { legacyPersonData } = await Storage.importAll(snapshot);

    // Mirror logo to localStorage so splash shows it on the forced reload below.
    try {
      const ls = await Storage.settings.getAll();
      if (ls.unitLogo) localStorage.setItem('qstore2_logo', ls.unitLogo);
      else localStorage.removeItem('qstore2_logo');
    } catch (_) {}

    await Storage.audit.append({
      action: 'data_imported',
      user:   AUTH.getSession()?.name || 'unknown',
      desc:   `Manual restore from backup file: ${file.name} (snapshot exported ${snapshot.exportedAt || 'unknown date'}).`,
    });
    await Storage.settings.set('data.lastImport', new Date().toISOString());

    // Force a reload — the current page state is now stale, and the
    // session may also be invalid (the imported users table might not
    // contain the currently-logged-in user).
    //
    // BUT NOT UNTIL THE OPERATOR HAS SEEN THE LEGACY-PII WARNING. The modal
    // below was previously opened moments before this reload fired, which
    // destroyed it — the alert existed and was unreachable. Reported from a
    // walkthrough as "nothing alerts the user". Correct report: the code ran,
    // the reload ate it.
    const reloadNow = () => {
      showToast('Backup restored. The page will now reload.', 'success', 2000);
      location.reload();
    };
    if (legacyPersonData?.total > 0) {
      const bits = [];
      if (legacyPersonData.cadets)   bits.push(`${legacyPersonData.cadets} cadet record(s)`);
      if (legacyPersonData.loans)    bits.push(`${legacyPersonData.loans} loan(s) naming a borrower`);
      if (legacyPersonData.requests) bits.push(`${legacyPersonData.requests} equipment request(s)`);
      openModal({
        titleHtml: 'This backup contains personal information',
        size: 'sm',
        persistent: true,
        bodyHtml: `
          <div class="modal__warn">
            <strong>Action required.</strong> The backup contained
            ${esc(bits.join(', '))}.
          </div>
          <p class="modal__body">
            This build does not collect or display personal information. These
            records are restored so they can be <strong>exported to the members'
            CEA documents</strong> and then removed — see
            <strong>Settings &rarr; Legacy cadet data</strong> after the reload.
          </p>
          <p class="modal__body">
            These are Commonwealth records. Do not leave them here, and do not
            delete them before they are in CEA.
          </p>
          <div class="form__actions">
            <button type="button" class="btn btn--primary" data-action="ack-legacy-import">
              Understood — reload
            </button>
          </div>
        `,
        onMount(panel, close) {
          panel.querySelector('[data-action="ack-legacy-import"]')
            ?.addEventListener('click', () => { close(); reloadNow(); });
        },
      });
      return;   // reload happens on acknowledgement, not before it
    }
    reloadNow();
  } catch (err) {
    console.error('Import failed:', err);
    showToast('Restore failed: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function _flashSuccess(message) {
  // TODO: replace with a proper toast in v2.1.
  // For now we use a small overlay that fades on its own.
  const flash = document.createElement('div');
  flash.className = 'flash flash--success';
  flash.textContent = message;
  document.body.appendChild(flash);
  setTimeout(() => flash.classList.add('is-leaving'), 2000);
  setTimeout(() => flash.remove(), 2600);
}


// -----------------------------------------------------------------------------
// Recovery-code generation handler
// -----------------------------------------------------------------------------
// Generates (or regenerates — same flow) a recovery code for the currently-
// logged-in OC. Disables the button during the argon2 hash to prevent
// double-submit (which would otherwise generate two codes and invalidate
// the first immediately).
//
// We use the existing setPin pathway? — No. setPin is for changing the PIN
// itself; here we want to replace JUST the recovery hash without touching
// the PIN. Recovery.generateForUser handles the storage write directly.
//
// Audit: 'recovery_set' for fresh generation, 'recovery_rotated' for
// regeneration of an existing code. Distinguishing them in the audit log
// helps a future investigator answer "when was this code last refreshed".

async function _doGenerateRecovery(button) {
  const sess = AUTH.getSession();
  if (!sess?.userId) {
    showToast('No active session — cannot generate recovery code.', 'warn');
    return;
  }

  // Confirm if we're about to overwrite an existing code.
  const before = await Recovery.statusForUser(sess.userId);
  if (before.exists) {
    const ok = confirm(
      'Generating a new recovery code will invalidate the existing one.\n\n' +
      'Make sure you can update or replace any printed copy of the previous code.\n\n' +
      'Continue?'
    );
    if (!ok) return;
  }

  if (button) button.disabled = true;
  try {
    const formattedCode = await Recovery.generateForUser(sess.userId);
    await Storage.audit.append({
      action: before.exists ? 'recovery_rotated' : 'recovery_set',
      user:   sess.name || 'unknown',
      desc:   before.exists
        ? `Recovery code regenerated for ${sess.username || sess.userId} from settings.`
        : `Recovery code generated for ${sess.username || sess.userId} from settings.`,
    });
    // Re-render the section so the status block updates from "no active code"
    // to "active, generated <date>". Quickest way: re-render the whole page.
    // It's cheap because we're already on the settings page.
    await _render();
    // Show the code AFTER the re-render so the modal sits on top of the
    // updated status block — gives the user feedback that something changed
    // even before they read the code.
    _openRecoveryFromSettings(formattedCode, before.exists);
  } catch (err) {
    showToast('Failed to generate recovery code: ' + (err.message || err), 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

// =============================================================================
// Cloud sync encryption — setup, recovery-code display, reset, unlock
// =============================================================================

async function _doSetupSyncEncryption(form) {
  const pass    = form.elements.passphrase.value;
  const confirm_ = form.elements.confirm.value;
  const btn     = $('button[data-action="sync-crypto-setup"]', form);

  if (pass !== confirm_) {
    showToast('Passphrases do not match.', 'warn');
    return;
  }
  if (!pass || pass.length < 12) {
    showToast('Passphrase must be at least 12 characters.', 'warn');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const { recoveryCodeFormatted } = await Keyring.setup(pass);
    const sess = AUTH.getSession();
    await Storage.audit.append({
      action: 'sync_encryption_enabled',
      user:   sess?.name || 'unknown',
      desc:   'Cloud sync encryption enabled; blob key wrapped under passphrase and recovery code.',
    });
    await _render();
    _openSyncRecoveryCode(recoveryCodeFormatted);
  } catch (err) {
    showToast('Could not enable cloud encryption: ' + (err.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Show-once display for the sync recovery code. Mirrors the OC PIN recovery
 * modal deliberately — same shape, same drawer in the unit safe, so it reads as
 * the same kind of object to the user. This code is NOT stored anywhere in
 * recoverable form; only an argon2id hash is kept, and a hash cannot derive a
 * key. If this is lost along with the passphrase, the cloud copy is
 * unrecoverable — local data is unaffected.
 */
function _openSyncRecoveryCode(formattedCode) {
  openModal({
    titleHtml: 'Cloud sync recovery code',
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">
        Write this down and store it OFF this device. You will not see it again.
        It is the only way to read the cloud copy if the sync passphrase is lost.
      </p>
      <div class="recovery-code__display" role="textbox" aria-readonly="true"
           aria-label="Sync recovery code">${esc(formattedCode)}</div>
      <div class="modal__warn">
        <strong>Store this code OFF this device.</strong> A printed copy in a
        sealed envelope in the unit safe is appropriate. Anyone with this code
        can decrypt the unit's cloud backup, including cadet personal
        information.
      </div>
      <form class="form" data-form="ack-sync-recovery">
        <label class="form__field">
          <input type="checkbox" name="ack" required>
          I have stored this code somewhere safe.
        </label>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="print-sync-code">Print</button>
          <button type="submit" class="btn btn--primary" disabled
                  data-action="ack-submit">Done</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form = $('form[data-form="ack-sync-recovery"]', panel);
      const cb   = $('input[name="ack"]', panel);
      const btn  = $('button[data-action="ack-submit"]', panel);
      cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
      $('button[data-action="print-sync-code"]', panel)
        .addEventListener('click', () => window.print());
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (cb.checked) close();
      });
    },
  });
}

/**
 * Rotate piiKey and auditKey. Deliberately an explicit operator action rather
 * than something that fires on upgrade: it is destructive-ish (every PII record
 * is rewritten), it must be auditable as a deliberate response to the exposure,
 * and on a multi-device unit it has to happen once, on the primary device, and
 * then propagate by sync — an automatic rotation on each device would have them
 * fighting over last-write-wins with mutually unreadable data.
 */
async function _doRotateKeys() {
  const ok = confirm(
    'Rotate encryption keys?\n\n'
    + 'Every cadet, staff, loan and user record will be re-encrypted under a new '
    + 'key, and the audit chain will be re-signed.\n\n'
    + 'IMPORTANT:\n'
    + '  • Do this on the PRIMARY device only, then sync. Other devices must '
    + 'then Load from cloud — their local data stays encrypted under the old key.\n'
    + '  • This does NOT clean the cloud copy. Delete the old file from OneDrive, '
    + 'including version history, or the leaked keys remain retrievable.\n'
    + '  • Audit entries before this point cannot be made trustworthy again. '
    + 'They will be re-signed and marked accordingly.\n\n'
    + 'Continue?'
  );
  if (!ok) return;

  const sess = AUTH.getSession();
  try {
    showToast('Rotating keys — do not close this tab…', 'info');
    const result = await Storage.rotateKeys({
      reason: `operator rotation by ${sess?.name || 'unknown'} following key exposure`,
    });
    // Re-sync is required: the cloud copy is still sealed over the old keys.
    await _render();
    showToast(
      `Keys rotated: ${result.records} records re-encrypted, `
      + `${result.auditEntries} audit entries re-signed. Sync now, then delete `
      + 'the old OneDrive file including version history.',
      'success',
    );
  } catch (err) {
    showToast('Key rotation FAILED: ' + (err.message || err)
      + ' — no changes were made.', 'error');
  }
}

/**
 * Step 1 — export a Q record per member and link their loans to it.
 *
 * The linking is the part that matters. Each member gets an issue number, it is
 * stamped on their PDF, and it is written onto their loan records as the export
 * runs. Afterwards the equipment record says "out to an individual, see
 * ISS-1042" and ISS-1042 is the document going to CEA. The link is not
 * destroyed — it is moved to where HQ says it belongs.
 *
 * Safe to re-run: a member already extracted has no borrower left on their
 * loans, so they are simply skipped.
 */
async function _doLegacyExport() {
  let entries;
  try { entries = await Storage.legacy.list(); }
  catch (err) { showToast('Could not read legacy data: ' + (err.message || err), 'error'); return; }

  const pending = entries.filter((e) => e.loans.length > 0);
  if (pending.length === 0) {
    showToast('No members left to export — every Q record has been generated.', 'info');
    return;
  }

  // In-app modal, not confirm(). A native dialog can be suppressed by the
  // browser — the same failure that made the Remove button look dead — and this
  // flow must never silently not-happen.
  const ok = await new Promise((resolve) => {
    let settled = false;
    openModal({
      titleHtml: `Export ${pending.length} Q record${pending.length === 1 ? '' : 's'}?`,
      size: 'sm',
      bodyHtml: `
        <p class="modal__body">
          One PDF per member. Each must then be uploaded to that member's
          <strong>CEA documents</strong>, in the unit's approved CadetNet M365
          location.
        </p>
        <div class="modal__warn">
          <strong>Not a personal Microsoft account. Not a personal OneDrive.</strong>
          Storing cadet information outside approved systems is what caused this
          data to require removal.
        </div>
        <p class="modal__body">Your browser will download them one at a time.</p>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="go-export">Export</button>
        </div>
      `,
      onMount(panel, close) {
        panel.querySelector('[data-action="go-export"]')?.addEventListener('click', () => {
          settled = true; close(); resolve(true);
        });
      },
      onClose() { if (!settled) resolve(false); },
    });
  });
  if (!ok) return;

  const unit = await Storage.settings.getAll();
  const sess = AUTH.getSession();
  let done = 0;
  for (const { member, loans } of pending) {
    try {
      const issueNo = await Locations.nextIssueNo(Storage);
      downloadPdf(await generateLegacyQRecord({ member, loans, unit, issueNo }));
      // Link BEFORE counting it done. If this throws, the member keeps their
      // borrower fields and will be picked up on the next run — better a
      // duplicate PDF than a member silently dropped from the extraction.
      await Storage.legacy.linkToIssue(member.svcNo, issueNo);
      await Storage.audit.append({
        action: 'legacy_qrecord_exported',
        user:   sess?.name || 'unknown',
        desc:   `Q record exported for service number ${member.svcNo} as ${issueNo}; `
              + `${loans.length} loan(s) linked. MUST be uploaded to the member's CEA `
              + 'documents in the approved CadetNet M365 location.',
      });
      done++;
    } catch (err) {
      showToast(`Export failed for ${member.svcNo}: ${err.message || err}`, 'error');
      break;
    }
  }
  await _render();
  if (done > 0) {
    openModal({
      titleHtml: `${done} Q record${done === 1 ? '' : 's'} exported`,
      size: 'sm',
      bodyHtml: `
        <div class="modal__warn">
          <strong>These are not finished.</strong> Each PDF must now be uploaded
          to that member's CEA documents, in the unit's approved CadetNet M365
          location — not a personal Microsoft account, not a personal OneDrive.
        </div>
        <p class="modal__body">
          Until a record is uploaded, that member's equipment cannot be traced to
          them: the issue number on the PDF is the only remaining link.
        </p>
        <p class="modal__body">
          These are Commonwealth records. Failure to manage them per the Defence
          Youth Manual (S1 Ch2 para 67) may expose you to criminal penalties
          under the <em>Archives Act 1983</em>.
        </p>
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">Understood</button>
        </div>
      `,
    });
  }
}

/** Step 2 — remove what is left. Irreversible, and gated on the data itself. */
/**
 * Step 2 — remove what is left. Irreversible.
 *
 * Reported from a walkthrough as "the Remove legacy data button appears to do
 * nothing". It was not dead: it used showToast() for the refusal and prompt()
 * for the confirmation. A toast is missable, and prompt() is a native dialog a
 * browser can suppress outright — including via "prevent this page from creating
 * additional dialogs", which the export flow's own confirm() can trigger. Either
 * way the button looks broken.
 *
 * For the most consequential, least reversible action in the app that is not
 * good enough. It now uses the same in-app typed-confirmation modal that
 * _doImportData already used for OVERWRITE — which I should have matched from
 * the start. A modal always renders, and it can say WHY it is refusing instead
 * of flashing it for three seconds.
 */
async function _doLegacyPurge() {
  let sum;
  try {
    sum = await Storage.legacy.summary();
  } catch (err) {
    // Never fail silently. A dead-looking button is what got this reported.
    openModal({
      titleHtml: 'Could not read legacy data',
      size: 'sm',
      bodyHtml: `<p class="modal__body">${esc(err.message || String(err))}</p>
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">Close</button>
        </div>`,
    });
    return;
  }

  if (sum.total === 0) {
    openModal({
      titleHtml: 'Nothing to remove',
      size: 'sm',
      bodyHtml: `<p class="modal__body">There is no legacy cadet data in this database.</p>
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">Close</button>
        </div>`,
    });
    return;
  }

  // Refusal gets a modal, not a toast — and it says which members are missing
  // rather than just a count, so the operator can act on it.
  if (sum.loans > 0) {
    openModal({
      titleHtml: 'Export the remaining members first',
      size: 'sm',
      bodyHtml: `
        <div class="modal__warn">
          <strong>Refused.</strong> ${sum.loans} loan(s) still name a borrower,
          which means those members have not had a Q record exported.
        </div>
        <p class="modal__body">
          Removing their records now would destroy a Commonwealth record before it
          reaches CEA. Run <strong>1. Export Q records</strong> first — it will
          skip anyone already done.
        </p>
        <div class="form__actions">
          <button type="button" class="btn btn--primary" data-action="modal-close">Close</button>
        </div>
      `,
    });
    return;
  }

  openModal({
    titleHtml: 'Remove legacy cadet data — confirm',
    size: 'sm',
    persistent: true,
    bodyHtml: `
      <div class="modal__warn">
        <strong>This permanently removes ${sum.cadets} cadet record(s) and
        ${sum.requests} equipment request(s). It cannot be undone.</strong>
      </div>
      <p class="modal__body">
        Only proceed if <strong>every Q record has been uploaded</strong> to the
        members' CEA documents, in the unit's approved CadetNet M365 location —
        not a personal Microsoft account or personal OneDrive.
      </p>
      <p class="modal__body">
        These are Commonwealth records. Removing them before they are in CEA may
        expose you to criminal penalties under the <em>Archives Act 1983</em>
        (Defence Youth Manual, Section 1, Chapter 2, para 67).
      </p>
      <p class="modal__body">Equipment records are kept, linked to their issue documents.</p>
      <p>Type <strong>REMOVE</strong> to confirm.</p>
      <form class="form" data-form="confirm-purge">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="REMOVE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Remove legacy data</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-purge"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';
        if (String(new FormData(form).get('confirm') || '').trim() !== 'REMOVE') {
          errEl.textContent = 'Type REMOVE in capitals to confirm.';
          return;
        }
        try {
          const res = await Storage.legacy.purge({ confirmedUploadedToCEA: true });
          close();
          await _render();
          showToast(`Removed ${res.cadets} cadet record(s) and ${res.requests} request(s). `
            + 'Equipment records retained and linked to their issue documents.', 'success', 6000);
        } catch (err) {
          // The storage layer refuses on the data, not on this dialog. Surface
          // that refusal here rather than letting it vanish.
          errEl.textContent = err.message || String(err);
        }
      });
    },
  });
}

async function _doResetSyncEncryption() {
  const ok = confirm(
    'Reset cloud sync encryption?\n\n'
    + 'This device will generate a NEW passphrase and recovery code. The '
    + 'existing cloud copy stays sealed under the OLD keys and this device will '
    + 'no longer be able to read it until it is overwritten by a fresh sync.\n\n'
    + 'Other devices will need the new passphrase.\n\nContinue?'
  );
  if (!ok) return;
  Keyring.clear();
  const sess = AUTH.getSession();
  await Storage.audit.append({
    action: 'sync_encryption_reset',
    user:   sess?.name || 'unknown',
    desc:   'Cloud sync encryption keyring cleared; re-key required before next sync.',
  });
  await _render();
  showToast('Sync encryption reset — set a new passphrase to re-enable syncing.', 'info');
}

/**
 * Prompt for the passphrase or recovery code when loading a sealed blob onto a
 * device that has no keyring (a second device, or one that has been reset).
 * Resolves to the secret string, or null if the user cancels.
 */
function _promptSyncSecret() {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      titleHtml: 'Cloud backup is encrypted',
      size:      'sm',
      bodyHtml:  `
        <p class="modal__body">
          This device does not hold the key for this unit's cloud backup. Enter
          the sync passphrase, or the recovery code if the passphrase is lost.
        </p>
        <form class="form" data-form="sync-unlock" autocomplete="off">
          <label class="form__field">
            <span class="form__label">Passphrase or recovery code</span>
            <input type="password" name="secret" required autocomplete="off">
          </label>
          <div class="form__actions">
            <button type="submit" class="btn btn--primary">Unlock</button>
          </div>
        </form>
      `,
      onMount(panel, close) {
        const form = $('form[data-form="sync-unlock"]', panel);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const v = form.elements.secret.value;
          if (!v) return;
          settled = true;
          close();
          resolve(v);
        });
      },
      onClose() { if (!settled) resolve(null); },
    });
  });
}

// Local copy of the recovery-display modal — settings.js can't import from
// shell.js without a circular dependency (shell.js mounts pages including
// settings). The modal content is similar but the framing text differs:
// settings-initiated regeneration emphasises the off-device storage rule
// and the fact that the previous code is now invalid.
function _openRecoveryFromSettings(formattedCode, wasRotation) {
  const headline = wasRotation
    ? 'New recovery code generated'
    : 'Your recovery code';
  const intro = wasRotation
    ? 'Your previous recovery code is no longer valid. Replace any printed copy with this new one.'
    : 'Write this down and store it OFF this device. You will not see it again — generating another code from this page invalidates this one.';

  openModal({
    titleHtml: esc(headline),
    size:      'sm',
    bodyHtml:  `
      <p class="modal__body">${esc(intro)}</p>
      <div class="recovery-code__display" role="textbox" aria-readonly="true"
           aria-label="Recovery code">${esc(formattedCode)}</div>
      <div class="modal__warn">
        <strong>Store this code OFF this device.</strong> A printed copy in a
        sealed envelope in the unit safe is appropriate. Anyone with this
        code can reset the OC PIN and gain administrative access.
      </div>
      <form class="form" data-form="ack-recovery-settings">
        <label class="form__field">
          <input type="checkbox" name="ack" required>
          I have stored this code somewhere safe.
        </label>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary" disabled
                  data-action="ack-submit">Done</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form = $('form[data-form="ack-recovery-settings"]', panel);
      const cb   = $('input[name="ack"]', panel);
      const btn  = $('button[data-action="ack-submit"]', panel);
      cb.addEventListener('change', () => { btn.disabled = !cb.checked; });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (cb.checked) close();
      });
    },
  });
}

// =============================================================================
// Unit logo upload / remove
// =============================================================================
// The logo is stored as a PNG data URL in the settings store under key
// 'unitLogo'. Storing as a data URL means it's included in backup exports
// without any extra serialisation logic, and it renders inline in the <img>
// without an object-URL lifecycle to manage.
//
// Size budget: we cap input at 5 MB and resize to fit 400×160 px before
// encoding as PNG. A typical unit badge at that size is 20–80 KB as a
// data URL — well within the settings store's practical limits.
//
// PNG is used (not JPEG) to preserve transparency, which most unit logos need.

async function _onLogoFileChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';  // allow re-selecting the same file later
  if (!file) return;

  const errEl = $('[data-target="logo-error"]', _root);
  if (errEl) errEl.textContent = '';

  if (!file.type.startsWith('image/')) {
    if (errEl) errEl.textContent = 'File must be an image (PNG, JPEG, SVG, etc.).';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    if (errEl) errEl.textContent = `Image is ${mb} MB — maximum is 5 MB.`;
    return;
  }

  try {
    const dataUrl = await _processLogo(file);
    await Storage.settings.set('unitLogo', dataUrl);
    // Mirror to localStorage so the logo survives an HTML file upgrade at the
    // same origin/path (GitHub Pages updates, same-path file replacement).
    try { localStorage.setItem('qstore2_logo', dataUrl); } catch (_) {}
    _softUpdateHeaderLogo(dataUrl);
    await _render();
    _flashSuccess('Logo updated.');
  } catch (err) {
    if (errEl) errEl.textContent = err.message || 'Failed to process logo.';
  }
}

async function _doRemoveLogo() {
  await Storage.settings.set('unitLogo', null);
  // Clear the localStorage mirror as well.
  try { localStorage.removeItem('qstore2_logo'); } catch (_) {}
  _softUpdateHeaderLogo(null);
  await _render();
  _flashSuccess('Logo removed.');
}

async function _doDownloadUnitCopy() {
  // Generates a version of this HTML file with the unit logo (and unit name/code)
  // embedded as window.__UNIT_CONFIG__. When this file is opened on any device,
  // the logo shows on the splash screen immediately — before IDB is populated.
  try {
    const s = await Storage.settings.getAll();
    const logo = s.unitLogo || null;
    if (!logo) {
      showToast('Upload a logo first.', 'error');
      return;
    }
    const config = { logo, unitName: s.unitName || '', unitCode: s.unitCode || '' };
    // Inject config as first script in <head> so it runs before the app bundle.
    const configScript = `<script>window.__UNIT_CONFIG__=${JSON.stringify(config)};<\/script>`;
    const html = document.documentElement.outerHTML;
    const injected = html.includes('</head>')
      ? html.replace('</head>', configScript + '</head>')
      : configScript + html;
    const slug = (s.unitCode || s.unitName || 'unit')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unit';
    const filename = `qstore-${slug}-unit-copy.html`;
    const blob = new Blob([injected], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    _flashSuccess(`Saved as ${filename}. Share this file — logo is embedded.`);
  } catch (err) {
    showToast('Download failed: ' + (err.message || err), 'error');
  }
}

async function _processLogo(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Could not decode image. Try a different file or format.');
  }

  try {
    // Fit inside 1024×1024 — large enough for the splash screen at any display
    // size while staying lossless (PNG). The old 160px cap caused pixelation
    // when the logo was displayed at splash size (60vmin ≈ 460px+).
    // Images smaller than 1024px are stored at their natural size (no upscale).
    const MAX = 1024;
    const scale = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width  * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled  = true;
    ctx.imageSmoothingQuality  = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

function _softUpdateHeaderLogo(logoDataUrl) {
  const brand = document.querySelector('.shell__brand');
  if (!brand) return;
  let logoImg = brand.querySelector('.shell__brand-logo');
  if (logoDataUrl) {
    if (!logoImg) {
      logoImg = document.createElement('img');
      logoImg.className = 'shell__brand-logo';
      logoImg.alt = '';
      brand.insertBefore(logoImg, brand.firstChild);
    }
    logoImg.src = logoDataUrl;
  } else {
    if (logoImg) logoImg.remove();
  }
}

// =============================================================================
// v1 backup file import
// =============================================================================
// Distinct from _doImportData (the v2-to-v2 restore). v1 import takes a
// QStore v1 export file, wipes the v2 db, and runs schema migration. The
// wipe is irrevocable; the confirmation gate is intentionally explicit.
//
// FLOW
//   1. Confirmation modal (typed OVERWRITE — matches v2 restore)
//   2. File picker (hidden input data-target="import-v1-file")
//   3. _performV1Import: read file → JSON.parse → Migration.runFromObject
//   4. Final modal showing what came through
//
// AUDIT
//   Migration.runFromObject appends 'v1_import' to the v2 audit log on
//   success. We don't append a second entry from the UI.

async function _doImportV1(btn) {
  openModal({
    titleHtml: 'Import v1 backup — confirm',
    size:      'sm',
    bodyHtml: `
      <div class="modal__warn">
        <strong>This will replace ALL local data</strong> with the contents of
        the v1 backup file you select. This cannot be undone. Use this only
        when transitioning a unit from QStore v1 to v2 for the first time.
      </div>
      <p>
        The v1 backup's user accounts will replace the current ones &mdash;
        make sure you know the PINs from your v1 install before continuing,
        or you will lock yourself out.
      </p>
      <p>
        Your v1 OneDrive sync configuration will <strong>not</strong> be
        carried over (v1 stored it in a separate place that's not in the
        backup file). You'll re-enter cloud sync settings in v2 if you want
        to use them.
      </p>
      <p>Type the word <strong>OVERWRITE</strong> to confirm.</p>
      <form class="form" data-form="confirm-v1">
        <label class="form__field">
          <input type="text" name="confirm" autocomplete="off" placeholder="OVERWRITE">
        </label>
        <div class="form__error" role="alert"></div>
        <div class="form__actions">
          <button type="button" class="btn btn--ghost" data-action="modal-close">Cancel</button>
          <button type="submit" class="btn btn--danger">Choose v1 file&hellip;</button>
        </div>
      </form>
    `,
    onMount(panel, close) {
      const form  = $('form[data-form="confirm-v1"]', panel);
      const errEl = $('.form__error', panel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        errEl.textContent = '';
        const value = String(new FormData(form).get('confirm') || '').trim();
        if (value !== 'OVERWRITE') {
          errEl.textContent = 'Type OVERWRITE in capitals to confirm.';
          return;
        }
        close();
        const fileInput = $('input[data-target="import-v1-file"]', _root);
        if (!fileInput) {
          showToast('Internal error: v1 file input missing.', 'error');
          return;
        }
        const onChange = async () => {
          fileInput.removeEventListener('change', onChange);
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = '';
          if (!file) return;
          await _performV1Import(file, btn);
        };
        fileInput.addEventListener('change', onChange);
        fileInput.click();
      });
    },
  });
}

async function _performV1Import(file, btn) {
  if (btn) btn.disabled = true;

  // Read + parse first, before opening the progress modal — if the file
  // is malformed we'd rather show the error inline than open a "0%
  // Migrating…" modal then immediately abort.
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    showToast('Could not read the v1 file: ' + (err.message || err) + ' — The file may be corrupted or not a valid JSON export.', 'error');
    if (btn) btn.disabled = false;
    return;
  }

  // Open a progress modal. The migration itself reports progress via
  // onProgress(msg, pct); we update the modal's body in place.
  let progressClose = null;
  let progressBody  = null;
  openModal({
    titleHtml: 'Importing v1 data…',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body" data-target="v1-progress-msg">Starting…</p>
      <div class="settings__progress" aria-live="polite">
        <div class="settings__progress-bar" data-target="v1-progress-bar"
             style="width: 0%"></div>
      </div>
      <p class="modal__body modal__body--small">
        Do not close this tab until the import completes.
      </p>
    `,
    onMount(panel, close) {
      progressClose = close;
      progressBody  = panel;
    },
  });

  const onProgress = (msg, pct) => {
    if (!progressBody) return;
    const m = $('[data-target="v1-progress-msg"]', progressBody);
    const b = $('[data-target="v1-progress-bar"]', progressBody);
    if (m) m.textContent = msg;
    if (b) b.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  };

  let result;
  try {
    result = await Migration.runFromObject(parsed, { wipeFirst: true, onProgress });
  } catch (err) {
    if (progressClose) progressClose();
    showToast('v1 import failed: ' + (err.message || err) + ' — Database may be partially migrated. Restore from a v2 backup or re-run the import.', 'error', 8000);
    if (btn) btn.disabled = false;
    return;
  }

  if (progressClose) progressClose();

  // Summary modal — shows the counts the migration reports back. The user
  // can use these to spot-check that nothing was silently dropped.
  const c = result.counts || {};
  openModal({
    titleHtml: 'v1 import complete',
    size:      'sm',
    bodyHtml: `
      <p class="modal__body">
        v1 backup imported successfully. Reload the page or navigate to a
        page (Inventory, Cadets, Loans) to see the migrated data.
      </p>
      <ul class="settings__import-summary">
        <li>${esc(String(c.items     || 0))} inventory items</li>
        <li>${esc(String(c.cadets    || 0))} cadets / staff</li>
        <li>${esc(String(c.loans     || 0))} loan records</li>
        <li>${esc(String(c.users     || 0))} user accounts</li>
        <li>${esc(String(c.auditEntries || 0))} audit entries (re-chained, marked imported)</li>
      </ul>
      <p class="modal__body modal__body--small">
        Cloud sync settings were not carried over. If you want OneDrive
        sync, configure it in the Cloud sync section above. The v1 import
        action has been audited.
      </p>
      <div class="form__actions">
        <button type="button" class="btn btn--primary" data-action="modal-close">OK</button>
      </div>
    `,
  });

  // Re-render so the data section's "last import" timestamp updates.
  await _render();
  if (btn) btn.disabled = false;
}

// -----------------------------------------------------------------------------
// About section
// -----------------------------------------------------------------------------
// Subscription section
// -----------------------------------------------------------------------------

// The Defence build is licensed by construction and free of charge. It says so,
// rather than rendering a green "Active" chip that implies a paid subscription
// somebody bought. A reviewer reading this screen should see what is actually
// true: no licence key, no expiry, no charge, no activation flow.
const _subscriptionSectionHtml = (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
  ? function _subscriptionSectionDefence() {
      return `
        <section class="settings__section" data-section="subscription">
          <header class="settings__section-header">
            <h2 class="settings__section-title">Licence</h2>
          </header>
          <div class="settings__status-block settings__status-block--ok">
            <span class="badge badge--success">No charge</span>
            This build is provided to the Australian Army Cadets free of charge.
            There is no subscription, no licence key to enter, and no expiry.
          </div>
          <p class="settings__section-hint">
            Provided for ADF Cadets use. It is not the commercial product and is
            not licensed for resale or redistribution.
          </p>
        </section>
      `;
    }
  : function _subscriptionSectionHtmlImpl(ls) {
  const STATE_LABELS = {
    TRIAL:      'Free Trial',
    ACTIVE:     'Active',
    GRACE:      'Expired (Grace Period)',
    RESTRICTED: 'Expired — Read-Only',
    INVALID:    'Invalid Key',
  };
  const STATE_DOT = {
    TRIAL:      'trial',
    ACTIVE:     'active',
    GRACE:      'grace',
    RESTRICTED: 'restricted',
    INVALID:    'invalid',
  };

  const stateLabel = STATE_LABELS[ls.state] ?? ls.state;
  const dotClass   = `sub__status-dot sub__status-dot--${STATE_DOT[ls.state] ?? 'invalid'}`;

  let detailHtml = '';
  if (ls.state === 'TRIAL') {
    const days = ls.trialDaysLeft ?? 0;
    detailHtml = `
      <div class="sub__detail-row">
        <span class="sub__detail-label">Trial days remaining</span>
        <span class="sub__detail-value">${days} day${days === 1 ? '' : 's'}</span>
      </div>`;
  } else if (ls.state === 'ACTIVE' || ls.state === 'GRACE') {
    if (ls.payload?.unit) {
      detailHtml += `
        <div class="sub__detail-row">
          <span class="sub__detail-label">Licensed unit</span>
          <span class="sub__detail-value">${esc(ls.payload.unit)}</span>
        </div>`;
    }
    if (ls.expiresAt) {
      detailHtml += `
        <div class="sub__detail-row">
          <span class="sub__detail-label">Key expiry</span>
          <span class="sub__detail-value">${esc(ls.expiresAt)}</span>
        </div>`;
    }
    if (ls.state === 'ACTIVE' && ls.daysRemaining !== null) {
      detailHtml += `
        <div class="sub__detail-row">
          <span class="sub__detail-label">Days remaining</span>
          <span class="sub__detail-value">${ls.daysRemaining} day${ls.daysRemaining === 1 ? '' : 's'}</span>
        </div>`;
    }
    if (ls.state === 'GRACE' && ls.graceDaysLeft !== null) {
      detailHtml += `
        <div class="sub__detail-row">
          <span class="sub__detail-label">Grace period ends</span>
          <span class="sub__detail-value">in ${ls.graceDaysLeft} day${ls.graceDaysLeft === 1 ? '' : 's'}</span>
        </div>`;
    }
  } else if (ls.state === 'RESTRICTED' && ls.payload?.unit) {
    detailHtml = `
      <div class="sub__detail-row">
        <span class="sub__detail-label">Last licensed unit</span>
        <span class="sub__detail-value">${esc(ls.payload.unit)}</span>
      </div>`;
  }

  const showRenew = ls.state === 'GRACE' || ls.state === 'RESTRICTED';
  const renewHtml = showRenew
    ? `<a href="https://qstore.seanscales.com.au/renew" target="_blank" rel="noopener"
          class="btn btn--ghost sub__renew-btn">Renew online ↗</a>`
    : '';

  return `
    <section class="settings__section" data-section="subscription">
      <header class="settings__section-header">
        <h2 class="settings__section-title">Subscription</h2>
      </header>
      <div class="sub__status-row">
        <span class="${dotClass}" aria-hidden="true"></span>
        <span class="sub__status-label">${esc(stateLabel)}</span>
        ${renewHtml}
      </div>
      ${detailHtml ? `<div class="sub__details">${detailHtml}</div>` : ''}
      <form class="form sub__key-form" data-form="activate-key" autocomplete="off">
        <label class="form__field">
          <span class="form__label">Subscription key</span>
          <input type="text" name="licenseKey" class="form__input sub__key-input"
                 placeholder="QSTRE-XXXXX-XXXXX-XXXXX-XXXXX or paste raw key"
                 spellcheck="false" autocorrect="off" autocapitalize="characters">
        </label>
        <div class="form__error sub__key-error" role="alert"></div>
        <div class="form__actions">
          <button type="submit" class="btn btn--primary">Activate key</button>
        </div>
      </form>
    </section>
  `;
};

async function _onActivateKey(e) {
  e.preventDefault();
  const form  = e.currentTarget;
  const errEl = $('.sub__key-error', _root);
  const input = $('input[name="licenseKey"]', form);
  const btn   = $('button[type="submit"]', form);
  if (!errEl || !input || !btn) return;

  errEl.textContent = '';
  const raw = (input.value || '').trim();
  if (!raw) { errEl.textContent = 'Enter a subscription key.'; return; }

  btn.disabled = true;
  btn.textContent = 'Activating…';
  try {
    const result = activateKey(raw);
    if (!result.ok) {
      const msgs = {
        bad_signature:    'Key signature is invalid. Check the key and try again.',
        expired:          'Key has expired. Contact support to renew.',
        malformed:        'Key format not recognised. Paste the full key as provided.',
        malformed_payload:'Key format not recognised.',
        missing_exp:      'Key is missing expiry information. Contact support.',
        verify_error:     'Could not verify the key. Contact support.',
        empty_key:        'No key entered.',
      };
      errEl.textContent = msgs[result.error] ?? `Activation failed (${result.error || 'unknown'}).`;
      return;
    }

    // Register this device with Platform Core (enforces per-licence device limit)
    btn.textContent = 'Registering device…';
    const deviceResult = await deviceActivate();
    if (deviceResult && !deviceResult.success && deviceResult.errorCode === 'MAX_DEVICES_REACHED') {
      errEl.textContent = `Device limit reached — this key is active on ${deviceResult.activeDevices} of ${deviceResult.maxDevices} allowed devices. Remove a device in Settings → Subscription to continue, or purchase an additional device seat.`;
      localStorage.removeItem('qstore_v2_license');
      return;
    }

    input.value = '';
    showToast(
      result.state === 'ACTIVE'
        ? `Subscription activated for ${result.payload?.unit ?? 'your unit'}.`
        : `Key accepted (${result.state}).`,
      'success'
    );
    await _render();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Activate key'; }
  }
}

// -----------------------------------------------------------------------------

function _aboutSectionHtml() {
  return `
    <section class="settings__section" data-section="about">
      <header class="settings__section-header">
        <h2 class="settings__section-title">About QStore IMS</h2>
      </header>

      <div class="about__block">
        <div class="about__app-name">QStore IMS <span class="about__version">v2.3</span></div>
        <p class="about__tagline">Inventory Management System for Australian Army Cadet Q-Stores</p>
        <p class="about__powered">Powered by <strong>ITEMORA</strong> &mdash; <a href="https://itemora.com.au" target="_blank" rel="noopener" class="about__link">itemora.com.au</a></p>
      </div>

      <div class="about__credits">
        <div class="about__credit-row">
          <span class="about__credit-label">Primary Author</span>
          <span class="about__credit-value">Sean Scales</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">AI Development Partner</span>
          <span class="about__credit-value">Claude Sonnet 4.6 — Anthropic</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">Copyright</span>
          <span class="about__credit-value">&copy; ${new Date().getFullYear()} Sean Scales. All rights reserved.</span>
        </div>
        <div class="about__credit-row">
          <span class="about__credit-label">Licensing enquiries</span>
          <span class="about__credit-value"><a href="mailto:admin@seanscales.com.au" class="about__link">admin@seanscales.com.au</a></span>
        </div>
      </div>

      <details class="about__license">
        <summary class="about__license-summary">Proprietary Software Licence</summary>
        <div class="about__license-body">
          <p><strong>QStore IMS — Proprietary Software Licence</strong></p>
          <p>Copyright &copy; ${new Date().getFullYear()} Sean Scales (&ldquo;the Author&rdquo;). All rights reserved.</p>

          <p><strong>OWNERSHIP</strong><br>
          This software, QStore IMS (the &ldquo;Software&rdquo;), including all associated source code, compiled
          outputs, documentation, and assets, is the exclusive intellectual property of the Author.
          All rights not expressly granted herein are reserved by the Author.</p>

          <p><strong>PERMITTED USE</strong><br>
          Authorised end users may use the Software solely for its intended purpose of inventory
          management operations. This permission is granted at the Author&rsquo;s sole discretion and
          may be withdrawn at any time.</p>

          <p><strong>RESTRICTIONS</strong><br>
          Without the express prior written consent of the Author, you may <strong>not</strong>:</p>
          <ol class="about__license-list">
            <li>Distribute, sublicense, sell, lease, rent, lend, or otherwise transfer the Software
                or any copy thereof to any third party;</li>
            <li>Modify, adapt, translate, reverse-engineer, decompile, disassemble, or create
                derivative works based on the Software;</li>
            <li>Remove, alter, or obscure any copyright, trademark, or proprietary notices
                contained in or accompanying the Software;</li>
            <li>Use the Software, in whole or in part, for any commercial purpose or incorporate
                it into any commercial product or service without a separate written licence
                agreement with the Author;</li>
            <li>Publicly display, publicly perform, or otherwise make the Software available to
                any person not expressly authorised by the Author.</li>
          </ol>

          <p><strong>INTELLECTUAL PROPERTY</strong><br>
          The Software incorporates AI-assisted development tooling provided by Anthropic
          (Claude Sonnet 4.6). All output generated through such tooling in the creation of this
          Software is attributed to and owned by the Author in accordance with Anthropic&rsquo;s
          terms of service.</p>

          <p><strong>DISCLAIMER OF WARRANTIES</strong><br>
          THE SOFTWARE IS PROVIDED &ldquo;AS IS&rdquo;, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
          INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT. THE AUTHOR DOES NOT WARRANT THAT THE
          SOFTWARE WILL BE ERROR-FREE OR UNINTERRUPTED.</p>

          <p><strong>LIMITATION OF LIABILITY</strong><br>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE AUTHOR SHALL NOT BE LIABLE
          FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
          (INCLUDING LOSS OF DATA, LOSS OF PROFITS, OR BUSINESS INTERRUPTION) ARISING OUT OF
          OR IN CONNECTION WITH THE USE OR INABILITY TO USE THE SOFTWARE.</p>

          <p><strong>GOVERNING LAW</strong><br>
          This licence is governed by the laws of Queensland, Australia. Any dispute arising
          under or in connection with this licence shall be subject to the exclusive jurisdiction
          of the courts of Queensland, Australia.</p>

          <p><strong>LICENSING ENQUIRIES</strong><br>
          To enquire about commercial licensing, distribution rights, or any permissions beyond
          the scope of this licence, contact the Author at
          <a href="mailto:admin@seanscales.com.au" class="about__link">admin@seanscales.com.au</a>.</p>
        </div>
      </details>
    </section>
  `;
}
