// =============================================================================
// QStore IMS v2 — UI utilities
// =============================================================================
// Small helpers shared across UI modules. Kept deliberately minimal: anything
// that grows beyond a few lines should move to its own module.
//
// HTML ESCAPING IS NOT OPTIONAL
//   Every string interpolated into an HTML template literal must go through
//   esc(). v1's UI had multiple places where user input was concatenated
//   directly into innerHTML, which is an injection vulnerability. We do not
//   replicate that.
// =============================================================================

/**
 * Escape a value for safe interpolation into HTML. Handles &, <, >, ", '.
 * Coerces null/undefined to empty string. Numbers and booleans are stringified.
 * For attribute contexts, this is sufficient because we always quote attrs.
 */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shorthand for document.querySelector with a typed return. */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** Shorthand for document.querySelectorAll, returns a real Array. */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Render an HTML string into a target element, replacing existing content.
 * Calls cleanupCallbacks first if provided, so previous-render side effects
 * (object URLs, event listeners on detached nodes) get a chance to clean up.
 */
export function render(target, html, cleanupCallbacks = []) {
  for (const fn of cleanupCallbacks) {
    try { fn(); } catch (e) { console.error('render cleanup error:', e); }
  }
  target.innerHTML = html;
}

/**
 * Format an ISO timestamp as a friendly local string. Returns '—' for
 * null/undefined/invalid input rather than 'Invalid Date'.
 */
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * Format an ISO timestamp as just a date (no time). Useful for "last login".
 */
export function fmtDateOnly(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'never';
  return d.toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/**
 * Sleep for ms milliseconds. Used for animations and forced delays
 * (e.g., "shake" duration before clearing PIN error state).
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Add a one-shot event listener that auto-removes itself after firing.
 * Returns an unbind function in case the caller wants to cancel before fire.
 */
export function once(target, event, handler) {
  const wrapped = (e) => {
    target.removeEventListener(event, wrapped);
    handler(e);
  };
  target.addEventListener(event, wrapped);
  return () => target.removeEventListener(event, wrapped);
}

/**
 * Tracks object URLs created during a render and provides a single revoke
 * method to release them all. Use one pool per render pass — replace it on
 * each render and call .revokeAll() on the previous pool.
 *
 *   const pool = new ObjectURLPool();
 *   const url = pool.create(blob);
 *   // … later, on next render or unmount:
 *   pool.revokeAll();
 */
export class ObjectURLPool {
  constructor() { this._urls = new Set(); }

  create(blob) {
    const url = URL.createObjectURL(blob);
    this._urls.add(url);
    return url;
  }

  /**
   * Track an object URL that was created elsewhere (e.g. by Storage.photos.getURL).
   * The URL will be revoked when revokeAll() is called.
   */
  register(url) {
    if (url) this._urls.add(url);
    return url;
  }

  revokeAll() {
    for (const url of this._urls) {
      try { URL.revokeObjectURL(url); }
      catch (e) { console.warn('revokeObjectURL failed:', e); }
    }
    this._urls.clear();
  }
}
