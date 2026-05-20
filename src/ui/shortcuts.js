// =============================================================================
// QStore IMS v2 — Keyboard Shortcuts
// =============================================================================
// Global keyboard shortcuts for power users. Only fires when no modal is open,
// no input/select/textarea is focused, and no modifier keys (Ctrl/Meta/Alt)
// are held (to avoid colliding with browser shortcuts).
//
// Shortcuts:
//   /        — focus the search / filter input on the current page
//   n        — trigger the primary "add / new" action on the current page
//   ?        — show this shortcuts help overlay
//   ← →      — switch tabs on tabbed pages (Loans)
//   1-6      — jump to nav pages: Home, Inventory, Loans, Cadets, Audit, Settings
// =============================================================================

import { openModal } from './modal.js';
import { esc }       from './util.js';

let _unmount = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start listening for global keyboard shortcuts.
 * Call once per shell session; call the returned function to stop.
 */
export function mount() {
  if (_unmount) _unmount();  // clean up any previous listener

  const handler = (e) => _onKeydown(e);
  document.addEventListener('keydown', handler);
  _unmount = () => document.removeEventListener('keydown', handler);
  return _unmount;
}

export function unmount() {
  if (_unmount) { _unmount(); _unmount = null; }
}

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

function _onKeydown(e) {
  // Skip if modifier keys held (Ctrl/Meta/Alt) — those are browser shortcuts.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Skip if a modal is open — modal handles its own keyboard nav.
  if (document.querySelector('.modal.is-open, .modal[aria-modal="true"]')) return;

  // Skip if the user is typing in an input/select/textarea/contenteditable.
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.target?.isContentEditable) return;

  const key = e.key;

  switch (key) {
    case '/': {
      // Focus search input on current page.
      const search = _findSearch();
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
      break;
    }

    case 'n':
    case 'N': {
      // Trigger primary add/new action on current page.
      const btn = _findPrimaryAction();
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
      break;
    }

    case '?': {
      // Show shortcuts help overlay.
      e.preventDefault();
      _showHelp();
      break;
    }

    case 'ArrowLeft': {
      // Previous tab on tabbed pages.
      const tabs = _findTabs();
      if (tabs.length > 1) {
        e.preventDefault();
        _navigateTabs(tabs, -1);
      }
      break;
    }

    case 'ArrowRight': {
      // Next tab on tabbed pages.
      const tabs = _findTabs();
      if (tabs.length > 1) {
        e.preventDefault();
        _navigateTabs(tabs, +1);
      }
      break;
    }

    // Number keys 1-6 navigate between top-level pages.
    case '1': _clickNav('dashboard');  break;
    case '2': _clickNav('inventory');  break;
    case '3': _clickNav('loans');      break;
    case '4': _clickNav('cadets');     break;
    case '5': _clickNav('audit');      break;
    case '6': _clickNav('settings');   break;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the search/filter input on the current visible page. */
function _findSearch() {
  return (
    document.querySelector('.inv__search') ||
    document.querySelector('.cad__search') ||
    document.querySelector('.aud__search') ||
    document.querySelector('.ord__search') ||
    document.querySelector('.req__search') ||
    document.querySelector('[data-shortcut="search"]')
  );
}

/** Find the primary action button (Add / Issue / New) on the current page. */
function _findPrimaryAction() {
  // Each page has a btn--primary that represents its main action.
  // We look inside the current page's toolbar first, then fall back to any.
  const toolbar = document.querySelector(
    '.inv__toolbar, .cad__toolbar, .aud__toolbar, .ord__toolbar, .req__toolbar, [data-shortcut="toolbar"]'
  );
  if (toolbar) {
    const btn = toolbar.querySelector('[data-action="add"], [data-action="add-cadet"], .btn--primary');
    if (btn) return btn;
  }
  // Loans page: the active tab's primary button (issue-submit is inside the form,
  // so target the issue tab activation button instead).
  const issueTab = document.querySelector('[data-action="tab"][data-tab="issue"]');
  if (issueTab) return issueTab;   // switches to issue tab — good enough as "new loan"
  return document.querySelector('[data-action="add"]');
}

/** Find the tab buttons on the current page. */
function _findTabs() {
  return Array.from(document.querySelectorAll('[data-action="tab"]'));
}

/** Move to the adjacent tab (delta = ±1). */
function _navigateTabs(tabs, delta) {
  const active = tabs.find((t) => t.classList.contains('is-active') || t.getAttribute('aria-selected') === 'true');
  if (!active) return;
  const idx  = tabs.indexOf(active);
  const next = tabs[((idx + delta) + tabs.length) % tabs.length];
  if (next) next.click();
}

/** Click a nav link by page key. */
function _clickNav(page) {
  // Shell nav uses data-page attribute on nav buttons.
  const link = document.querySelector(`[data-page="${esc(page)}"], [data-nav="${esc(page)}"]`);
  if (link) link.click();
}

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

const SHORTCUT_TABLE = [
  ['/',          'Focus search / filter'],
  ['n',          'New item / add (current page)'],
  ['← →',        'Switch tabs (Loans)'],
  ['1 – 6',      'Jump to page: Home / Inventory / Loans / Cadets / Audit / Settings'],
  ['?',          'Show this keyboard shortcuts guide'],
  ['Esc',        'Close modal or dismiss overlay'],
];

function _showHelp() {
  const rows = SHORTCUT_TABLE.map(([k, d]) => `
    <tr>
      <td class="scut__key"><kbd>${esc(k)}</kbd></td>
      <td class="scut__desc">${esc(d)}</td>
    </tr>
  `).join('');

  openModal(`
    <div class="modal__header">
      <h2 class="modal__title">Keyboard shortcuts</h2>
      <button type="button" class="modal__close" data-action="modal-close" aria-label="Close">✕</button>
    </div>
    <div class="modal__body">
      <table class="scut__table">
        <thead>
          <tr><th>Key</th><th>Action</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="scut__hint">Shortcuts are disabled while typing in any input field.</p>
    </div>
    <div class="modal__footer">
      <button type="button" class="btn btn--primary" data-action="modal-close">Close</button>
    </div>
  `, { title: 'Keyboard shortcuts' });
}
