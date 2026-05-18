// =============================================================================
// QStore IMS v2 — Reference page
// =============================================================================
// Static reference information for Q-Store staff. Currently contains ADF
// uniform and equipment sizing tables with conversions between AU/NATO (cm),
// US (inch / US sizes) and generalised sizes (XS–3XL), plus measurement guides.
//
// No storage access — the page is entirely static HTML rendered from data
// tables defined in this module.
// =============================================================================

import { render } from './util.js';

let _root = null;

// -----------------------------------------------------------------------------
// Mount / unmount
// -----------------------------------------------------------------------------

export async function mount(rootEl) {
  _root = rootEl;
  _render();
  return function unmount() { _root = null; };
}

// -----------------------------------------------------------------------------
// Sizing data
// -----------------------------------------------------------------------------

// Shirts & Jackets — NATO chest-height sizing (used on AMCU, DPCU jackets, etc.)
// NATO size = CHEST(cm)/HEIGHT(cm)  e.g. "87/170"
// Height bands: S < 170 cm  |  R 170–183 cm  |  L > 183 cm
const SHIRT_ROWS = [
  // [ natoCode, chestCm, genSize, usChestIn ]
  { nato: '87/S–R–L',  chest: 87,  gen: 'XS',  usIn: 34 },
  { nato: '92/S–R–L',  chest: 92,  gen: 'S',   usIn: 36 },
  { nato: '97/S–R–L',  chest: 97,  gen: 'M',   usIn: 38 },
  { nato: '102/S–R–L', chest: 102, gen: 'L',   usIn: 40 },
  { nato: '107/S–R–L', chest: 107, gen: 'XL',  usIn: 42 },
  { nato: '112/S–R–L', chest: 112, gen: '2XL', usIn: 44 },
  { nato: '117/S–R–L', chest: 117, gen: '3XL', usIn: 46 },
];

// Trousers — waist (cm) × leg length code
// Leg codes: S = inside leg ≤ 76 cm  |  R = 77–84 cm  |  L ≥ 85 cm
const TROUSER_ROWS = [
  // [ waistCm, genSize, usWaistIn ]
  { waist: 75,  gen: 'XS',  usIn: 29 },
  { waist: 80,  gen: 'S',   usIn: 31 },
  { waist: 85,  gen: 'M',   usIn: 33 },
  { waist: 90,  gen: 'L',   usIn: 35 },
  { waist: 95,  gen: 'XL',  usIn: 37 },
  { waist: 100, gen: '2XL', usIn: 39 },
  { waist: 105, gen: '3XL', usIn: 41 },
  { waist: 110, gen: '4XL', usIn: 43 },
];

// Boots — AU/UK shoe size (same scale), US Men's, US Women's, foot length
const BOOT_ROWS = [
  // [ auUk, usMens, usWomens, footCm ]
  { au:  4,   usMens: 5,   usWomens: 6.5, cm: 22.5 },
  { au:  4.5, usMens: 5.5, usWomens: 7,   cm: 23.0 },
  { au:  5,   usMens: 6,   usWomens: 7.5, cm: 23.5 },
  { au:  5.5, usMens: 6.5, usWomens: 8,   cm: 24.0 },
  { au:  6,   usMens: 7,   usWomens: 8.5, cm: 24.5 },
  { au:  6.5, usMens: 7.5, usWomens: 9,   cm: 25.0 },
  { au:  7,   usMens: 8,   usWomens: 9.5, cm: 25.5 },
  { au:  7.5, usMens: 8.5, usWomens: 10,  cm: 26.0 },
  { au:  8,   usMens: 9,   usWomens: 10.5,cm: 26.5 },
  { au:  8.5, usMens: 9.5, usWomens: 11,  cm: 27.0 },
  { au:  9,   usMens: 10,  usWomens: 11.5,cm: 27.5 },
  { au:  9.5, usMens: 10.5,usWomens: 12,  cm: 28.0 },
  { au: 10,   usMens: 11,  usWomens: 12.5,cm: 28.5 },
  { au: 10.5, usMens: 11.5,usWomens: 13,  cm: 29.0 },
  { au: 11,   usMens: 12,  usWomens: 13.5,cm: 29.5 },
  { au: 11.5, usMens: 12.5,usWomens: 14,  cm: 30.0 },
  { au: 12,   usMens: 13,  usWomens: 14.5,cm: 30.5 },
  { au: 13,   usMens: 14,  usWomens: 15.5,cm: 31.5 },
];

// Hats & Berets — head circumference in cm
const HAT_ROWS = [
  // [ circumCm, circumIn, gen, ukFrac ]
  { cm: 54, inFrac: '21¼', gen: 'XS',  ukFrac: '6¾'  },
  { cm: 55, inFrac: '21⅝', gen: 'XS',  ukFrac: '6⅞'  },
  { cm: 56, inFrac: '22',  gen: 'S',   ukFrac: '7'    },
  { cm: 57, inFrac: '22½', gen: 'S',   ukFrac: '7⅛'  },
  { cm: 58, inFrac: '22⅞', gen: 'M',   ukFrac: '7¼'  },
  { cm: 59, inFrac: '23¼', gen: 'M',   ukFrac: '7⅜'  },
  { cm: 60, inFrac: '23⅝', gen: 'L',   ukFrac: '7½'  },
  { cm: 61, inFrac: '24',  gen: 'L',   ukFrac: '7⅝'  },
  { cm: 62, inFrac: '24⅜', gen: 'XL',  ukFrac: '7¾'  },
  { cm: 63, inFrac: '24¾', gen: 'XL',  ukFrac: '7⅞'  },
  { cm: 64, inFrac: '25¼', gen: '2XL', ukFrac: '8'    },
  { cm: 65, inFrac: '25⅝', gen: '2XL', ukFrac: '8⅛'  },
];

// -----------------------------------------------------------------------------
// HTML builders
// -----------------------------------------------------------------------------

function _shirtTableHtml() {
  const rows = SHIRT_ROWS.map(r => `
    <tr>
      <td class="ref__td--center">${r.chest}</td>
      <td class="ref__td--center">${r.gen}</td>
      <td class="ref__td--center">${r.usIn}"</td>
      <td class="ref__td--small">
        ${r.chest}/S &nbsp;•&nbsp; ${r.chest}/R &nbsp;•&nbsp; ${r.chest}/L
      </td>
    </tr>`).join('');

  return `
    <div class="ref__measure-box">
      <strong>How to measure — chest</strong>
      <p>Wrap the tape around the fullest part of the chest, under the armpits and across the shoulder blades. Keep the tape horizontal and snug but not tight. Record in centimetres.</p>
      <strong>Height bands (torso code)</strong>
      <p><strong>S</strong> (Short) = height under 170 cm &nbsp;|&nbsp;
         <strong>R</strong> (Regular) = 170–183 cm &nbsp;|&nbsp;
         <strong>L</strong> (Long/Tall) = over 183 cm</p>
      <p class="ref__note">NATO size format: <em>CHEST / HEIGHT-BAND</em> e.g. <code>102/R</code> = 102 cm chest, Regular height.</p>
    </div>

    <div class="ref__table-wrap">
      <table class="ref__table">
        <thead>
          <tr>
            <th>Chest (cm)</th>
            <th>Gen. size</th>
            <th>US chest</th>
            <th>NATO codes (S / R / L)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="ref__note">* If between sizes, select the larger size. For layering (e.g. body armour carrier), go one size up.</p>
  `;
}

function _trouserTableHtml() {
  const rows = TROUSER_ROWS.map(r => `
    <tr>
      <td class="ref__td--center">${r.waist}</td>
      <td class="ref__td--center">${r.gen}</td>
      <td class="ref__td--center">${r.usIn}"</td>
      <td class="ref__td--small">
        ${r.waist}/S &nbsp;•&nbsp; ${r.waist}/R &nbsp;•&nbsp; ${r.waist}/L
      </td>
    </tr>`).join('');

  return `
    <div class="ref__measure-box">
      <strong>How to measure — waist</strong>
      <p>Measure around the natural waist (approximately 2.5 cm above the navel). Keep the tape horizontal and flat against the skin. Record in centimetres.</p>
      <strong>Leg length bands (inseam code)</strong>
      <p><strong>S</strong> (Short) = inside leg ≤ 76 cm &nbsp;|&nbsp;
         <strong>R</strong> (Regular) = 77–84 cm &nbsp;|&nbsp;
         <strong>L</strong> (Long) = ≥ 85 cm</p>
      <strong>How to measure — inside leg</strong>
      <p>Measure from the crotch seam down the inner leg to the ankle bone. Stand straight in bare feet on a hard floor.</p>
    </div>

    <div class="ref__table-wrap">
      <table class="ref__table">
        <thead>
          <tr>
            <th>Waist (cm)</th>
            <th>Gen. size</th>
            <th>US waist</th>
            <th>NATO codes (S / R / L)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="ref__note">* NATO trouser size format: <em>WAIST / LEG-BAND</em> e.g. <code>90/R</code> = 90 cm waist, Regular length.</p>
  `;
}

function _bootTableHtml() {
  const rows = BOOT_ROWS.map(r => `
    <tr>
      <td class="ref__td--center">${r.au}</td>
      <td class="ref__td--center">${r.usMens}</td>
      <td class="ref__td--center">${r.usWomens}</td>
      <td class="ref__td--center">${r.cm}</td>
      <td class="ref__td--center">${(r.cm / 2.54).toFixed(1)}"</td>
    </tr>`).join('');

  return `
    <div class="ref__measure-box">
      <strong>How to measure — foot length</strong>
      <p>Place foot flat on a sheet of paper. Mark the longest toe and the back of the heel. Measure the distance in centimetres. Measure both feet and use the larger measurement.</p>
      <p class="ref__note">AU/UK boot sizes use the same scale. Add ½ size when wearing thick military socks — boots should feel snug with the issued sock, not bare foot.</p>
    </div>

    <div class="ref__table-wrap">
      <table class="ref__table">
        <thead>
          <tr>
            <th>AU / UK</th>
            <th>US Men's</th>
            <th>US Women's</th>
            <th>Foot (cm)</th>
            <th>Foot (in)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="ref__note">* Half sizes are listed where commonly stocked. Where a half size is unavailable, round up to the next whole size.</p>
  `;
}

function _hatTableHtml() {
  const rows = HAT_ROWS.map(r => `
    <tr>
      <td class="ref__td--center">${r.cm}</td>
      <td class="ref__td--center">${r.inFrac}"</td>
      <td class="ref__td--center">${r.gen}</td>
      <td class="ref__td--center">${r.ukFrac}</td>
    </tr>`).join('');

  return `
    <div class="ref__measure-box">
      <strong>How to measure — head circumference</strong>
      <p>Wrap the tape around the head approximately 2 cm above the eyebrows and across the widest part at the back of the skull. Keep the tape level all the way around. Record in centimetres.</p>
      <p class="ref__note">UK/US hat sizes (fractions) are the same scale. Round up if between sizes — a slightly large hat can be adjusted with a sizing band; a too-small hat cannot.</p>
    </div>

    <div class="ref__table-wrap">
      <table class="ref__table">
        <thead>
          <tr>
            <th>Head circ. (cm)</th>
            <th>Head circ. (in)</th>
            <th>Gen. size</th>
            <th>UK / US hat size</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Tabs definition
// -----------------------------------------------------------------------------

const TABS = [
  {
    id:    'shirts',
    label: 'Shirts & Jackets',
    icon:  '👕',
    html:  _shirtTableHtml,
  },
  {
    id:    'trousers',
    label: 'Trousers',
    icon:  '👖',
    html:  _trouserTableHtml,
  },
  {
    id:    'boots',
    label: 'Boots',
    icon:  '🥾',
    html:  _bootTableHtml,
  },
  {
    id:    'hats',
    label: 'Hats & Berets',
    icon:  '🪖',
    html:  _hatTableHtml,
  },
];

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

function _render(activeTab = TABS[0].id) {
  const tabNav = TABS.map(t => `
    <button class="ref__tab-btn${t.id === activeTab ? ' ref__tab-btn--active' : ''}"
            data-tab="${t.id}" type="button" aria-selected="${t.id === activeTab}">
      <span class="ref__tab-icon" aria-hidden="true">${t.icon}</span>
      <span class="ref__tab-label">${t.label}</span>
    </button>
  `).join('');

  const activeTabDef = TABS.find(t => t.id === activeTab) || TABS[0];
  const content = activeTabDef.html();

  render(_root, `
    <section class="ref">
      <header class="ref__header">
        <h1 class="ref__title">Reference</h1>
        <p class="ref__subtitle">ADF uniform sizing tables and measurement guides. All sizes are approximate — when between sizes, select the larger.</p>
      </header>

      <nav class="ref__tabs" role="tablist" aria-label="Sizing categories">
        ${tabNav}
      </nav>

      <div class="ref__content" role="tabpanel">
        ${content}
      </div>
    </section>
  `);

  // Wire tab buttons.
  _root.querySelectorAll('.ref__tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _render(btn.dataset.tab);
    });
  });
}
