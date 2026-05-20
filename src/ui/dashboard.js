// =============================================================================
// QStore IMS v2 — Dashboard (home page)
// =============================================================================
// Post-login landing screen. Shows:
//   • Quick-stat tiles: total items, active loans, overdue loans
//   • Stocktake status: draft in progress, or date of last finalised stocktake
//   • Quick-action links for the most common workflows
//   • Recent audit activity (last 5 entries)
//
// Intentionally lightweight — all data comes from Storage in a single pass,
// no live polling. The user can refresh manually via the nav or by clicking
// "Refresh" in the tile bar.
// =============================================================================

import * as Storage from '../storage.js';
import * as AUTH    from '../auth.js';
import { esc, $, render } from './util.js';

let _root = null;

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  _root = rootEl;
  await _render();
  // Re-render on request — wired inside _render via the refresh button.
}

// No persistent listeners to tear down; root is replaced on unmount.
// Return a no-op unmount function for shell compatibility.

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

async function _render() {
  render(_root, '<div class="dash__loading">Loading…</div>');

  // Gather all data in parallel for speed.
  const [
    items,
    activeLoans,
    stkRows,
    settings,
    recentAudit,
  ] = await Promise.all([
    Storage.items.list(),
    Storage.loans.listActive(),
    Storage.stocktake.list(),
    Storage.settings.getAll(),
    Storage.audit.list({ limit: 5, order: 'desc' }),
  ]);

  const today     = new Date().toISOString().slice(0, 10);
  const overdue   = activeLoans.filter(l => l.dueDate && l.dueDate < today);
  const hasDraft  = stkRows.length > 0;

  // Last stocktake finalisation — look in the audit log.
  const lastStocktake = await Storage.audit.list({ action: 'stocktake_finalise', limit: 1, order: 'desc' });
  const lastStkEntry  = lastStocktake[0] || null;

  const totalItems  = items.length;
  const totalUnsvc  = items.reduce((n, i) => n + (i.unsvc || 0), 0);
  const totalOnLoan = activeLoans.length;
  const totalOverdue = overdue.length;

  const canEdit     = AUTH.can('editItem');
  const canAudit    = AUTH.can('audit');
  const isCO        = AUTH.isCO();
  const session     = AUTH.getSession();
  const unitName    = settings.unitName || 'QStore IMS';

  // Setup checklist: show for OC when any step is incomplete.
  const setupSteps = isCO ? [
    {
      done: !!(settings.unitName && settings.unitName.trim()),
      label: 'Set unit details (name, code, state)',
      nav: 'settings',
      hint: 'Settings → Unit Details',
    },
    {
      done: totalItems > 0,
      label: 'Add your first inventory item',
      nav: 'inventory',
      hint: 'Inventory → + Add item',
    },
    {
      done: (await Storage.cadets.list()).length > 0,
      label: 'Add cadets / nominal roll',
      nav: 'cadets',
      hint: 'Cadets → + Add cadet',
    },
  ] : [];
  const setupComplete   = setupSteps.every(s => s.done);
  const setupDismissed  = !!(await Storage.settings.get('ui.setupDismissed'));
  const showSetup       = isCO && !setupComplete && !setupDismissed;

  render(_root, `
    <section class="dash">
      <header class="dash__header">
        <h1 class="dash__title">${esc(unitName)}</h1>
        <div class="dash__meta">
          Logged in as <strong>${esc(session?.name || '—')}</strong>
          &middot; ${esc(session?.role || '')}
          <button type="button" class="btn btn--ghost btn--sm dash__refresh"
                  data-action="refresh" title="Refresh dashboard">↺</button>
        </div>
      </header>

      <!-- ── Setup wizard (new OC only, until all steps done) ── -->
      ${showSetup ? `
        <div class="dash__setup-card">
          <div class="dash__setup-header">
            <span class="dash__setup-icon">🚀</span>
            <div>
              <strong class="dash__setup-title">Welcome — let's get QStore set up</strong>
              <p class="dash__setup-sub">Complete these steps to get started.
                 You can dismiss this once finished.</p>
            </div>
            <button type="button" class="dash__setup-dismiss btn btn--ghost btn--sm"
                    data-action="dismiss-setup" title="Dismiss this card">✕</button>
          </div>
          <ol class="dash__setup-steps">
            ${setupSteps.map((s, i) => `
              <li class="dash__setup-step ${s.done ? 'dash__setup-step--done' : ''}">
                <span class="dash__setup-check">${s.done ? '✓' : String(i + 1)}</span>
                <span class="dash__setup-step-body">
                  <strong>${esc(s.label)}</strong>
                  ${!s.done ? `<span class="dash__setup-hint">${esc(s.hint)}</span>` : ''}
                </span>
                ${!s.done
                  ? `<button type="button" class="btn btn--primary btn--sm dash__setup-go"
                             data-nav="${esc(s.nav)}">Go →</button>`
                  : ''}
              </li>
            `).join('')}
          </ol>
        </div>
      ` : ''}

      <!-- ── Stat tiles ── -->
      <div class="dash__tiles">
        <div class="dash__tile">
          <span class="dash__tile-num">${esc(String(totalItems))}</span>
          <span class="dash__tile-lbl">Total items</span>
        </div>
        <div class="dash__tile ${totalUnsvc > 0 ? 'dash__tile--warn' : ''}">
          <span class="dash__tile-num">${esc(String(totalUnsvc))}</span>
          <span class="dash__tile-lbl">Unserviceable</span>
        </div>
        <div class="dash__tile ${totalOnLoan > 0 ? 'dash__tile--active' : ''}">
          <span class="dash__tile-num">${esc(String(totalOnLoan))}</span>
          <span class="dash__tile-lbl">On loan</span>
        </div>
        <div class="dash__tile ${totalOverdue > 0 ? 'dash__tile--danger' : ''}">
          <span class="dash__tile-num">${esc(String(totalOverdue))}</span>
          <span class="dash__tile-lbl">Overdue</span>
        </div>
      </div>

      <!-- ── Overdue loans detail (only when there are some) ── -->
      ${totalOverdue > 0 ? `
        <div class="dash__section dash__section--overdue">
          <h2 class="dash__section-title">
            Overdue loans
            <span class="dash__overdue-count">${totalOverdue}</span>
          </h2>
          <table class="dash__overdue-table">
            <thead>
              <tr>
                <th>Ref</th>
                <th>Borrower</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Due</th>
                <th>Days overdue</th>
              </tr>
            </thead>
            <tbody>
              ${overdue
                .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
                .map(l => {
                  const dueDt   = new Date(l.dueDate);
                  const todayDt = new Date(today);
                  const daysOver = Math.floor((todayDt - dueDt) / 86400000);
                  return `
                    <tr class="dash__overdue-row">
                      <td class="dash__overdue-ref">${esc(l.ref)}</td>
                      <td>${esc(l.borrowerName || '—')}</td>
                      <td>${esc(l.itemName || '—')}</td>
                      <td class="dash__overdue-qty">${l.qty}</td>
                      <td class="dash__overdue-date">${esc(l.dueDate)}</td>
                      <td class="dash__overdue-days">${daysOver}d</td>
                    </tr>`;
                }).join('')}
            </tbody>
          </table>
          <a href="#" class="dash__link dash__link--more" data-nav="loans">
            View all loans →
          </a>
        </div>
      ` : ''}

      <!-- ── Stocktake status ── -->
      <div class="dash__section">
        <h2 class="dash__section-title">Stocktake</h2>
        <div class="dash__stkstatus ${hasDraft ? 'dash__stkstatus--draft' : ''}">
          ${hasDraft
            ? `<span class="dash__stkstatus-badge dash__stkstatus-badge--draft">Draft in progress</span>
               <span class="dash__stkstatus-text">
                 ${stkRows.length} item${stkRows.length === 1 ? '' : 's'} counted so far.
                 ${canEdit
                  ? `<a href="#" class="dash__link" data-nav="stocktake">Continue counting →</a>`
                  : ''}
               </span>`
            : lastStkEntry
              ? `<span class="dash__stkstatus-badge dash__stkstatus-badge--ok">Up to date</span>
                 <span class="dash__stkstatus-text">
                   Last stocktake finalised ${esc(_fmtDateAU(lastStkEntry.ts))}
                   by ${esc(lastStkEntry.user || '—')}.
                 </span>`
              : `<span class="dash__stkstatus-badge dash__stkstatus-badge--none">No stocktake recorded</span>
                 <span class="dash__stkstatus-text">No finalised stocktake found in audit log.</span>`
          }
        </div>
      </div>

      <!-- ── Quick actions ── -->
      <div class="dash__section">
        <h2 class="dash__section-title">Quick actions</h2>
        <div class="dash__actions">
          <button type="button" class="dash__action-btn" data-nav="inventory">
            📦 Inventory
          </button>
          <button type="button" class="dash__action-btn" data-nav="loans">
            📋 Loans
          </button>
          <button type="button" class="dash__action-btn" data-nav="cadets">
            👥 Cadets
          </button>
          ${canEdit ? `
            <button type="button" class="dash__action-btn" data-nav="stocktake">
              📊 Stocktake
            </button>
          ` : ''}
          ${canAudit ? `
            <button type="button" class="dash__action-btn" data-nav="audit">
              🔍 Audit log
            </button>
          ` : ''}
          ${isCO ? `
            <button type="button" class="dash__action-btn" data-nav="settings">
              ⚙ Settings
            </button>
          ` : ''}
        </div>
      </div>

      <!-- ── Recent activity ── -->
      ${recentAudit.length > 0 ? `
        <div class="dash__section">
          <h2 class="dash__section-title">Recent activity</h2>
          <table class="dash__activity">
            <tbody>
              ${recentAudit.map(e => `
                <tr class="dash__activity-row">
                  <td class="dash__activity-ts">${esc(_fmtDateTimeAU(e.ts))}</td>
                  <td class="dash__activity-action">
                    <span class="dash__activity-badge">${esc(e.action)}</span>
                  </td>
                  <td class="dash__activity-user">${esc(e.user || '—')}</td>
                  <td class="dash__activity-desc">${esc(e.desc || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${canAudit
            ? `<a href="#" class="dash__link dash__link--more" data-nav="audit">View full audit log →</a>`
            : ''}
        </div>
      ` : ''}
    </section>
  `);

  // Wire events.
  $('[data-action="refresh"]', _root)?.addEventListener('click', () => _render());

  $('[data-action="dismiss-setup"]', _root)?.addEventListener('click', async () => {
    await Storage.settings.set('ui.setupDismissed', true);
    await _render();
  });

  _root.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const page = btn.dataset.nav;
      // Dispatch a custom event that shell.js can intercept to navigate.
      _root.dispatchEvent(new CustomEvent('dash:navigate', {
        bubbles: true,
        detail: { page },
      }));
    });
  });
}

// -----------------------------------------------------------------------------
// Format helpers (local — no shared dep to avoid circular imports)
// -----------------------------------------------------------------------------

function _fmtDateAU(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function _fmtDateTimeAU(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
