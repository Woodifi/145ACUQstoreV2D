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
