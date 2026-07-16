// =============================================================================
// QStore IMS v2 — Toast notifications
// =============================================================================
// Lightweight non-blocking notifications to replace alert(). Toasts appear
// bottom-right, stack upward, auto-dismiss after `duration` ms, and can be
// dismissed early by clicking.
//
// Usage:
//   import { showToast } from './toast.js';
//   showToast('Backup restored.');                    // info (default)
//   showToast('Item saved.', 'success');
//   showToast('Restore failed: ' + err.message, 'error');
//   showToast('Cloud sync skipped.', 'warn');
//
// Types: 'info' | 'success' | 'error' | 'warn'
//
// Accessibility: the container uses aria-live="polite" so screen readers
// announce toasts without interrupting ongoing speech. Error toasts use
// role="alert" (assertive) so they interrupt immediately.
// =============================================================================

let _container = null;

function _ensureContainer() {
  if (_container && document.contains(_container)) return _container;
  _container = document.createElement('div');
  _container.className = 'toast-container';
  _container.setAttribute('aria-live', 'polite');
  _container.setAttribute('aria-atomic', 'false');
  document.body.appendChild(_container);
  return _container;
}

/**
 * Show a toast notification.
 *
 * @param {string} message   Text to display.
 * @param {'info'|'success'|'error'|'warn'} [type='info']
 * @param {number} [duration=4500]  Auto-dismiss delay in ms.
 * @returns {Function}  Call to dismiss early.
 */
export function showToast(message, type = 'info', duration = 4500) {
  const container = _ensureContainer();

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  container.appendChild(el);

  // Trigger CSS transition on next frame.
  requestAnimationFrame(() => el.classList.add('toast--visible'));

  const dismiss = () => {
    if (!el.parentNode) return;
    el.classList.remove('toast--visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback if transitionend never fires (hidden tab, reduced-motion).
    setTimeout(() => el.remove(), 400);
  };

  const timer = setTimeout(dismiss, duration);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });

  return dismiss;
}
