// =============================================================================
// QStore IMS v2 — Theme management
// =============================================================================
// Applies the ui.theme setting ('dark' | 'light' | 'system') to
// document.documentElement.dataset.theme. The CSS uses [data-theme="light"]
// and [data-theme="system"] selectors for overrides; the default :root is dark.
//
// localStorage key 'qstore2_theme' mirrors the setting so it can be applied
// synchronously on the next boot (before IndexedDB is ready) to avoid flash.
// =============================================================================

const LS_KEY = 'qstore2_theme';

/**
 * Apply a theme value immediately.
 * @param {'dark'|'light'|'system'} theme
 */
export function applyTheme(theme) {
  const t = theme === 'light' || theme === 'system' ? theme : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(LS_KEY, t); } catch (_) { /* non-fatal */ }
}

/**
 * Apply theme on startup — reads localStorage first (fast, sync), then falls
 * back to 'dark' if no preference is stored.
 */
export function applyStoredTheme() {
  try {
    const stored = localStorage.getItem(LS_KEY) || 'dark';
    applyTheme(stored);
  } catch (_) {
    applyTheme('dark');
  }
}
