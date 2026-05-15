// =============================================================================
// QStore IMS v2 — Build fingerprint & copyright enforcement
// =============================================================================
// __QSTORE_BUILD_ID__ and __QSTORE_BUILD_TS__ are replaced at build time by
// esbuild's `define` option. In dev (unbundled) mode they fall back to 'dev'.
// The values are unique per build and can be used to trace the origin of any
// distributed copy back to a specific build event.
//
// OWNERSHIP: Copyright © 2025 Sean Scales. All rights reserved.
// Proprietary software — redistribution and modification prohibited without
// the express written consent of the author. See LICENSE.
// =============================================================================

/* eslint-disable no-undef */
export const BUILD_ID  = (typeof __QSTORE_BUILD_ID__ !== 'undefined')
  ? __QSTORE_BUILD_ID__ : 'dev';
export const BUILD_TS  = (typeof __QSTORE_BUILD_TS__ !== 'undefined')
  ? __QSTORE_BUILD_TS__ : 'dev';
/* eslint-enable no-undef */

export const AUTHOR    = 'Sean Scales';
export const CONTACT   = 'admin@seanscales.com.au';
export const COPYRIGHT = '© 2025 Sean Scales. All rights reserved.';
export const PRODUCT   = 'QStore IMS v2';

// Authorised deployment origins. A console warning is emitted if the app is
// loaded from any other origin — this catches unauthorised hosting without
// affecting legitimate local-file or GitHub Pages use.
const _AUTHORISED_ORIGINS = [
  'https://woodifi.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null',           // file:// — window.location.origin returns the string "null"
];

// ---------------------------------------------------------------------------
// Console banner — printed on every boot.
// Styled output means the copyright info is visible to any developer who
// opens DevTools on the app, making authorship immediately apparent.
// ---------------------------------------------------------------------------
export function logBanner() {
  const T = 'color:#c9a227;font-size:13px;font-weight:700;letter-spacing:0.05em;';
  const D = 'color:#8b98a8;font-size:11px;';
  const W = 'color:#e05252;font-size:11px;font-weight:600;';
  const V = 'color:#d0d8e4;font-size:11px;';

  console.groupCollapsed(
    '%c▶ QStore IMS%c  │  © Sean Scales  │  Build ' + BUILD_ID,
    T, D
  );
  console.log('%cProduct  %c' + PRODUCT,                  D, V);
  console.log('%cAuthor   %c' + AUTHOR,                   D, V);
  console.log('%cContact  %c' + CONTACT,                  D, V);
  console.log('%cBuild    %c' + BUILD_ID,                 D, V);
  console.log('%cBuilt    %c' + BUILD_TS,                 D, V);
  console.log('%cLicence  %cProprietary — All Rights Reserved', D, V);
  console.log(
    '%c⚠ Unauthorised copying, modification or redistribution of this ' +
    'software is prohibited and may result in legal action.',
    W
  );
  console.groupEnd();
}

// ---------------------------------------------------------------------------
// Origin check — warns if the app is running from an unrecognised host.
// This catches unauthorised redistribution via third-party web servers.
// ---------------------------------------------------------------------------
export function checkOrigin() {
  const origin = String(window.location.origin);
  const ok = _AUTHORISED_ORIGINS.some(o => origin === o || origin.startsWith(o + '/'));
  if (!ok) {
    console.warn(
      '[QStore IMS] ⚠ This application is running from an unrecognised origin: ' +
      origin + '.\n' +
      'QStore IMS is proprietary software owned by Sean Scales ' +
      '(admin@seanscales.com.au).\n' +
      'If you did not receive this copy directly from the author, ' +
      'you may be using an unauthorised distribution.\n' +
      'Build ID: ' + BUILD_ID + '  |  Built: ' + BUILD_TS
    );
  }
}

// ---------------------------------------------------------------------------
// Integrity sentinel — a set of expected strings baked into the bundle.
// If a redistributor strips copyright notices, these checks will fail and
// log a tamper warning. Not cryptographically strong, but raises the bar.
// ---------------------------------------------------------------------------
const _SENTINELS = [
  '© 2025 Sean Scales',       // copyright line in About section
  'admin@seanscales.com.au',       // contact in About section
  'Proprietary Software Licence',  // licence heading in About section
];

export function checkIntegrity() {
  const body = document.documentElement.innerHTML;
  const missing = _SENTINELS.filter(s => !body.includes(s));
  if (missing.length > 0) {
    console.error(
      '[QStore IMS] ⚠ Integrity check failed — ' + missing.length +
      ' copyright sentinel(s) are missing from the document.\n' +
      'This build may have been tampered with.\n' +
      'Build ID: ' + BUILD_ID + '  |  Contact: ' + CONTACT
    );
  }
}
