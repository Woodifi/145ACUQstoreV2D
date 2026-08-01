// =============================================================================
// QStore IMS v2 — Theme management
// =============================================================================
// Applies the ui.theme setting ('light' | 'dark' | 'system') to
// document.documentElement.dataset.theme.
//
// Light is the default surface, per the ITEMORA design guide. The stylesheet
// defines light on :root and overrides it under [data-theme="dark"], plus
// [data-theme="system"] inside a prefers-color-scheme query.
//
// Until the ITEMORA redesign this module wrote data-theme onto <html> and
// Settings reported "Theme set to light", but qstore.css contained no
// [data-theme] selector at all — so the control changed nothing on screen.
// The theme is only real because those blocks now exist; keep them in step
// with the values accepted here.
//
// localStorage key 'qstore2_theme' mirrors the setting so it can be applied
// synchronously on the next boot (before IndexedDB is ready) to avoid a flash
// of the wrong surface.
// =============================================================================

const LS_KEY = (typeof __V2L_THEME_KEY__ !== 'undefined') ? __V2L_THEME_KEY__ : 'qstore2_theme';

const THEMES = ['light', 'dark', 'system'];
const DEFAULT_THEME = 'light';

/**
 * Apply a theme value immediately. Anything unrecognised falls back to the
 * default rather than being written through to the DOM.
 * @param {'light'|'dark'|'system'} theme
 */
export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(LS_KEY, t); } catch (_) { /* non-fatal */ }
}

/**
 * Apply theme on startup — reads localStorage first (fast, sync), then falls
 * back to the default if no preference is stored.
 */
export function applyStoredTheme() {
  try {
    applyTheme(localStorage.getItem(LS_KEY) || DEFAULT_THEME);
  } catch (_) {
    applyTheme(DEFAULT_THEME);
  }
}
