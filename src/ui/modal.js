// =============================================================================
// QStore IMS v2 — Modal helper
// =============================================================================
// Reusable modal pattern. Usage:
//
//   import { openModal } from './modal.js';
//
//   const handle = openModal({
//     titleHtml: 'Add item',
//     bodyHtml:  `<form>…</form>`,
//     onMount(panel, closeFn) {
//       const form = panel.querySelector('form');
//       form.addEventListener('submit', async (e) => {
//         e.preventDefault();
//         await doStuff();
//         closeFn();
//       });
//     },
//   });
//
//   // Programmatic close from outside:
//   handle.close();
//
// Behaviour:
//   - Backdrop click closes (unless opts.persistent === true)
//   - Escape closes (unless opts.persistent === true)
//   - First focusable element in panel gets focus on open
//   - Focus trapped inside panel while open (Tab cycles, Shift-Tab cycles back)
//   - On close, focus returns to whatever element opened the modal
//   - Multiple modals stack (each new one captures focus and Esc handling)
// =============================================================================

import { esc, $$ } from './util.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const _stack = [];

/**
 * Open a modal. Returns a handle with:
 *   - close(): Function — close the modal programmatically
 *   - element: HTMLElement — the modal root (rarely needed)
 *
 * @param {object} opts
 * @param {string} opts.titleHtml    Title HTML (already escaped if needed)
 * @param {string} opts.bodyHtml     Body HTML (caller is responsible for escaping)
 * @param {string} [opts.size]       'sm' | 'md' | 'lg' (default 'md')
 * @param {boolean} [opts.persistent]  If true, backdrop/Escape don't close
 * @param {Function} [opts.onMount]  Called with (panel, closeFn) after mount
 * @param {Function} [opts.onClose]  Called when modal is being closed
 */
export function openModal({
  titleHtml = '',
  bodyHtml  = '',
  size      = 'md',
  persistent = false,
  onMount,
  onClose,
} = {}) {
  const previouslyFocused = document.activeElement;

  const root = document.createElement('div');
  root.className = 'modal';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = `
    <div class="modal__backdrop" data-action="modal-close-backdrop"></div>
    <div class="modal__panel modal__panel--${esc(size)}">
      ${titleHtml ? `<h2 class="modal__title">${titleHtml}</h2>` : ''}
      <div class="modal__content">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(root);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (typeof onClose === 'function') {
      try { onClose(); } catch (e) { console.error('modal onClose error:', e); }
    }
    root.removeEventListener('keydown', _onKeydown);
    root.removeEventListener('click',   _onClick);
    root.remove();
    _stack.pop();
    // Restore focus to whatever opened us.
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };

  function _onClick(e) {
    if (persistent) return;
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'modal-close-backdrop' || action === 'modal-close') close();
  }
  function _onKeydown(e) {
    if (e.key === 'Escape' && !persistent) {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      _trapFocus(root, e);
    }
  }

  root.addEventListener('click', _onClick);
  root.addEventListener('keydown', _onKeydown);

  const panel = root.querySelector('.modal__panel');
  if (typeof onMount === 'function') {
    try { onMount(panel, close); }
    catch (e) {
      console.error('modal onMount error:', e);
      close();
      throw e;
    }
  }

  // Focus first focusable element in panel after mount, fall back to panel.
  setTimeout(() => {
    const first = $$(FOCUSABLE, panel)[0];
    if (first) first.focus();
    else panel.setAttribute('tabindex', '-1'), panel.focus();
  }, 30);

  _stack.push(close);
  return { close, element: root };
}

/** Close the topmost open modal, if any. Useful for "close all" cleanup. */
export function closeTopModal() {
  const top = _stack[_stack.length - 1];
  if (top) top();
}

function _trapFocus(root, e) {
  const focusable = $$(FOCUSABLE, root).filter((el) => el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}
