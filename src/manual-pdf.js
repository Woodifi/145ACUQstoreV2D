// =============================================================================
// QStore IMS v2 — Full User Manual PDF generator
// =============================================================================
// Produces a multi-page A4 PDF of the complete user manual using jsPDF
// (already bundled). Called from the Help page via "Download Manual PDF".
//
// Layout: cover page → table of contents → 19 sections, each starting
// on a new page with a green header band. Running header and page number
// on every content page. Callout boxes for notes, tips, and warnings.
// =============================================================================

import { jsPDF }    from 'jspdf';

// NOTE: deliberately NOT a shared `const IS_DEFENCE_BUILD`.
//
// esbuild only reliably inlines a const used ONCE. This module referenced such a
// const six times, so it was never folded and BOTH branches of every ternary
// survived into the artefact — the Defence build shipped "Cloud Sync (OneDrive)"
// and the Azure setup strings it is supposed to prove it does not contain.
//
// That went unnoticed because this module was never bundled at all (see help.js:
// it had no importer until 2026-07-17). The gate had never once been exercised.
// Referencing __QSTORE_DEFENCE__ directly at each site is what actually folds.
import * as Storage from './storage.js';

// ─── Page geometry (mm) ─────────────────────────────────────────────────────
const PG = { W: 210, H: 297, L: 18, R: 18, T: 28, B: 22 };
PG.CW = PG.W - PG.L - PG.R;   // 174 mm usable width

// ─── Colour palette ─────────────────────────────────────────────────────────
const C = {
  green:   [59,  74,  47],
  tan:     [196, 169, 107],
  dark:    [30,  30,  30],
  muted:   [110, 105, 90],
  rowEven: [247, 245, 241],
  border:  [205, 200, 188],
  hdrBand: [232, 228, 218],
  noteBg:  [242, 248, 255],
  noteL:   [80,  130, 200],
  tipBg:   [242, 252, 245],
  tipL:    [50,  155, 75],
  warnBg:  [255, 250, 235],
  warnL:   [210, 140, 30],
  white:   [255, 255, 255],
};

// =============================================================================
// DocBuilder — tracks Y position, handles page breaks, and exposes a clean
// content API (headings, body text, bullets, numbered steps, tables, callouts)
// =============================================================================
class DB {
  constructor(doc) {
    this.d       = doc;
    this.y       = PG.T;
    this.pageNum = 1;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /** Add a new page and draw the running header / footer. */
  _np() {
    this.d.addPage();
    this.pageNum++;
    this.y = PG.T;
    this._chrome();
  }

  /** Running header line + page number; footer line + copyright. */
  _chrome() {
    const d = this.d;
    // Header
    d.setDrawColor(...C.tan);
    d.setLineWidth(0.4);
    d.line(PG.L, PG.T - 4, PG.W - PG.R, PG.T - 4);
    d.setFont('helvetica', 'normal');
    d.setFontSize(7.5);
    d.setTextColor(...C.muted);
    d.text('QStore IMS — User Manual  v2.3.0', PG.L, PG.T - 6.5);
    d.text(String(this.pageNum), PG.W - PG.R, PG.T - 6.5, { align: 'right' });
    // Footer
    d.setDrawColor(...C.border);
    d.setLineWidth(0.25);
    d.line(PG.L, PG.H - PG.B + 3, PG.W - PG.R, PG.H - PG.B + 3);
    d.setFontSize(7);
    d.text('© 2026 Sean Scales — Proprietary software', PG.L, PG.H - PG.B + 7);
    d.text(`Page ${this.pageNum}`, PG.W - PG.R, PG.H - PG.B + 7, { align: 'right' });
    d.setTextColor(...C.dark);
  }

  /** Ensure `mm` of vertical space remains; start a new page if not. */
  _need(mm) {
    if (this.y + mm > PG.H - PG.B - 5) { this._np(); return true; }
    return false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  gap(mm = 4) { this.y += mm; }

  // Section heading — always starts on its own page.
  h1(num, title) {
    this._np();
    const d = this.d;
    d.setFillColor(...C.green);
    d.rect(PG.L, this.y, PG.CW, 10.5, 'F');
    d.setFillColor(...C.tan);
    d.rect(PG.L, this.y + 10.5, PG.CW, 1.5, 'F');
    d.setFont('helvetica', 'bold');
    d.setFontSize(13);
    d.setTextColor(...C.white);
    d.text(`${num}.  ${title}`, PG.L + 5, this.y + 7.5);
    d.setTextColor(...C.dark);
    this.y += 16;
  }

  // Sub-heading with a light band.
  h2(text) {
    this._need(16);
    const d = this.d;
    d.setFillColor(...C.hdrBand);
    d.rect(PG.L, this.y, PG.CW, 7.5, 'F');
    d.setFont('helvetica', 'bold');
    d.setFontSize(10.5);
    d.setTextColor(...C.green);
    d.text(text, PG.L + 4, this.y + 5.4);
    d.setTextColor(...C.dark);
    this.y += 11;
  }

  // Minor heading with a tan underline.
  h3(text) {
    this._need(10);
    const d = this.d;
    d.setFont('helvetica', 'bold');
    d.setFontSize(9.5);
    d.setTextColor(90, 70, 20);
    d.text(text, PG.L, this.y);
    d.setDrawColor(...C.tan);
    d.setLineWidth(0.4);
    const tw = Math.min(d.getTextWidth(text) + 4, PG.CW);
    d.line(PG.L, this.y + 1.8, PG.L + tw, this.y + 1.8);
    d.setTextColor(...C.dark);
    this.y += 7;
  }

  // Body paragraph — wraps automatically; respects indent, bold, italic.
  p(text, { indent = 0, bold = false, italic = false, size = 9, color } = {}) {
    const d  = this.d;
    d.setFont('helvetica', bold ? 'bold' : italic ? 'italic' : 'normal');
    d.setFontSize(size);
    d.setTextColor(...(color || C.dark));
    const lines = d.splitTextToSize(text, PG.CW - indent);
    for (const ln of lines) {
      this._need(5);
      d.text(ln, PG.L + indent, this.y);
      this.y += 4.5;
    }
    d.setFont('helvetica', 'normal');
    d.setTextColor(...C.dark);
    this.y += 1.5;
  }

  // Bulleted list.
  bullets(items, { indent = 6 } = {}) {
    const d = this.d;
    d.setFont('helvetica', 'normal');
    d.setFontSize(9);
    for (const item of items) {
      const lines = d.splitTextToSize(item, PG.CW - indent - 5);
      this._need(5.5);
      d.setTextColor(...C.tan);
      d.text('•', PG.L + indent - 4, this.y);
      d.setTextColor(...C.dark);
      d.text(lines[0], PG.L + indent, this.y);
      this.y += 4.5;
      for (let i = 1; i < lines.length; i++) {
        this._need(5);
        d.text(lines[i], PG.L + indent, this.y);
        this.y += 4.5;
      }
    }
    this.y += 1.5;
  }

  // Numbered step list.
  steps(items) {
    const d = this.d;
    d.setFontSize(9);
    for (let i = 0; i < items.length; i++) {
      const lines = d.splitTextToSize(items[i], PG.CW - 12);
      this._need(6);
      d.setFont('helvetica', 'bold');
      d.setTextColor(...C.green);
      d.text(`${i + 1}.`, PG.L + 2, this.y);
      d.setFont('helvetica', 'normal');
      d.setTextColor(...C.dark);
      d.text(lines[0], PG.L + 10, this.y);
      this.y += 4.5;
      for (let j = 1; j < lines.length; j++) {
        this._need(5);
        d.text(lines[j], PG.L + 10, this.y);
        this.y += 4.5;
      }
    }
    this.y += 2;
  }

  // Coloured callout box — type: 'note' | 'tip' | 'warning'
  callout(text, type = 'note') {
    const MAP = {
      note:    { bg: C.noteBg, lb: C.noteL,  label: 'NOTE' },
      tip:     { bg: C.tipBg,  lb: C.tipL,   label: 'TIP'  },
      warning: { bg: C.warnBg, lb: C.warnL,  label: 'IMPORTANT' },
    };
    const cfg = MAP[type] || MAP.note;
    const d   = this.d;
    d.setFont('helvetica', 'normal');
    d.setFontSize(8.5);
    const lines = d.splitTextToSize(text, PG.CW - 14);
    const boxH  = 5.5 + lines.length * 4.2 + 3;
    this._need(boxH + 3);
    d.setFillColor(...cfg.bg);
    d.rect(PG.L, this.y, PG.CW, boxH, 'F');
    d.setFillColor(...cfg.lb);
    d.rect(PG.L, this.y, 3, boxH, 'F');
    d.setFont('helvetica', 'bold');
    d.setFontSize(7.5);
    d.setTextColor(...cfg.lb);
    d.text(cfg.label, PG.L + 6, this.y + 4.5);
    d.setFont('helvetica', 'normal');
    d.setFontSize(8.5);
    d.setTextColor(...C.dark);
    lines.forEach((ln, i) => {
      d.text(ln, PG.L + 6, this.y + 4.5 + 4.2 + i * 4.2);
    });
    this.y += boxH + 4;
  }

  // Data table. colW = array of column widths (must sum to PG.CW = 174).
  table(headers, rows, colW) {
    const d = this.d;
    const w = colW || headers.map(() => PG.CW / headers.length);

    // Header row
    this._need(8 + 7);
    d.setFillColor(...C.green);
    d.rect(PG.L, this.y, PG.CW, 8, 'F');
    d.setFont('helvetica', 'bold');
    d.setFontSize(8);
    d.setTextColor(...C.white);
    let cx = PG.L + 2.5;
    headers.forEach((h, i) => {
      d.text(String(h), cx, this.y + 5.4);
      cx += w[i];
    });
    this.y += 8;

    // Data rows
    rows.forEach((row, ri) => {
      d.setFont('helvetica', 'normal');
      d.setFontSize(8);
      const cells  = row.map((cell, ci) => d.splitTextToSize(String(cell ?? ''), w[ci] - 5));
      const maxLns = Math.max(...cells.map(c => c.length));
      const cellH  = Math.max(7, maxLns * 4.2 + 3.5);
      this._need(cellH);
      if (ri % 2 === 1) {
        d.setFillColor(...C.rowEven);
        d.rect(PG.L, this.y, PG.CW, cellH, 'F');
      }
      d.setDrawColor(...C.border);
      d.setLineWidth(0.2);
      d.line(PG.L, this.y + cellH, PG.L + PG.CW, this.y + cellH);
      d.setTextColor(...C.dark);
      cx = PG.L + 2.5;
      cells.forEach((lns, ci) => {
        lns.forEach((ln, li) => d.text(ln, cx, this.y + 4.5 + li * 4.2));
        cx += w[ci];
      });
      this.y += cellH;
    });
    this.y += 5;
  }
}

// =============================================================================
// Cover page — page 1, no running chrome
// =============================================================================
function _cover(doc, unitName, dateStr) {
  const d  = doc;
  const cx = PG.W / 2;

  // Army-green header panel
  d.setFillColor(...C.green);
  d.rect(0, 0, PG.W, 82, 'F');
  d.setFillColor(...C.tan);
  d.rect(0, 82, PG.W, 2.5, 'F');

  // App name
  d.setFont('helvetica', 'bold');
  d.setFontSize(32);
  d.setTextColor(...C.white);
  d.text('QStore IMS', cx, 38, { align: 'center' });

  // Subtitle
  d.setFont('helvetica', 'normal');
  d.setFontSize(17);
  d.text('User Manual', cx, 54, { align: 'center' });

  // Version
  d.setFontSize(10);
  d.setTextColor(...C.tan);
  d.text('Version 2.3.0', cx, 68, { align: 'center' });

  // Unit name
  if (unitName) {
    d.setFont('helvetica', 'bold');
    d.setFontSize(13);
    d.setTextColor(...C.green);
    d.text(unitName, cx, 104, { align: 'center' });
  }

  // Divider
  d.setDrawColor(...C.tan);
  d.setLineWidth(0.8);
  d.line(40, unitName ? 111 : 104, PG.W - 40, unitName ? 111 : 104);

  // Description
  const byLine = unitName ? 119 : 112;
  d.setFont('helvetica', 'normal');
  d.setFontSize(10);
  d.setTextColor(...C.muted);
  const descLines = [
    'This manual covers everything you need to manage your Q-Store:',
    'inventory, loans, stocktaking, orders, and more.',
    '',
    'Written for all users — no technical knowledge required.',
  ];
  descLines.forEach((ln, i) => d.text(ln, cx, byLine + i * 7.5, { align: 'center' }));

  // Contents preview box
  const bx = 30, by = 168, bw = PG.W - 60, bh = 78;
  d.setFillColor(245, 243, 238);
  d.rect(bx, by, bw, bh, 'F');
  d.setDrawColor(...C.border);
  d.setLineWidth(0.4);
  d.rect(bx, by, bw, bh, 'S');
  d.setFont('helvetica', 'bold');
  d.setFontSize(8.5);
  d.setTextColor(...C.green);
  d.text('This manual covers:', bx + 5, by + 7);
  d.setFont('helvetica', 'normal');
  d.setFontSize(8);
  d.setTextColor(...C.dark);
  const topics = [
    '1. Introduction              8.  Stocktake',
    '2. Getting Started           9.  AAC QStore Orders',
    '3. User Roles & Permissions  10. Audit Log',
    '4. Inventory                 11. Settings',
    '5. Loans & Returning         12. ' + ((typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__) ? 'Backups' : 'Cloud Sync (OneDrive)'),
    '6. Equipment Requests (Paper) 13. Backup & Restore',
    '7. Issue Destinations        14-15. PIN Security & Recovery',
    '                             16-19. Kits, QR Codes, Troubleshooting',
  ];
  topics.forEach((t, i) => d.text(t, bx + 5, by + 14 + i * 7.5));

  // Footer
  d.setFontSize(8);
  d.setTextColor(...C.muted);
  d.text(`Generated: ${dateStr}`, cx, 262, { align: 'center' });
  d.text('© 2026 Sean Scales — Proprietary Software — admin@seanscales.com.au', cx, 270, { align: 'center' });
}

// =============================================================================
// Table of contents — page 2
// =============================================================================
function _toc(doc, db) {
  doc.addPage();
  db.pageNum++;
  db.y = PG.T;
  db._chrome();

  const d = doc;

  // TOC heading
  d.setFillColor(...C.green);
  d.rect(PG.L, db.y, PG.CW, 10.5, 'F');
  d.setFillColor(...C.tan);
  d.rect(PG.L, db.y + 10.5, PG.CW, 1.5, 'F');
  d.setFont('helvetica', 'bold');
  d.setFontSize(13);
  d.setTextColor(...C.white);
  d.text('Table of Contents', PG.L + 5, db.y + 7.5);
  d.setTextColor(...C.dark);
  db.y += 20;

  const sections = [
    [1,  'Introduction'],
    [2,  'Getting Started'],
    [3,  'User Roles and Permissions'],
    [4,  'Inventory'],
    [5,  'Loans — Issuing and Returning Equipment'],
    [6,  'Equipment Requests (Paper)'],
    [7,  'Issue Destinations and Issue Numbers'],
    [8,  'Stocktake'],
    [9,  'AAC QStore Orders'],
    [10, 'Audit Log'],
    [11, 'Settings'],
    [12, (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__) ? 'Backups' : 'Cloud Sync (OneDrive)'],
    [13, 'Backup and Restore'],
    [14, 'PIN Security and Auto-Lock'],
    [15, 'OC PIN Recovery'],
    [16, 'Issue Kits'],
    [17, 'QR Code Labels'],
    [18, 'Troubleshooting'],
    [19, 'Uniform Sizing Reference'],
  ];

  sections.forEach(([num, title], idx) => {
    if (idx % 2 === 0) {
      d.setFillColor(...C.rowEven);
      d.rect(PG.L, db.y - 2, PG.CW, 8, 'F');
    }
    d.setFont('helvetica', 'bold');
    d.setFontSize(9.5);
    d.setTextColor(...C.green);
    d.text(`${num}.`, PG.L + 3, db.y + 4);
    d.setFont('helvetica', 'normal');
    d.setTextColor(...C.dark);
    d.text(title, PG.L + 14, db.y + 4);
    db.y += 8;
  });

  db.y += 6;
  d.setFont('helvetica', 'italic');
  d.setFontSize(8.5);
  d.setTextColor(...C.muted);
  d.text('Each section starts on a new page with a green header band showing the section number and title.', PG.L, db.y);
}

// =============================================================================
// Section content builders
// =============================================================================

function _s1(b) {
  b.h1(1, 'Introduction');
  b.p('QStore IMS is a complete inventory management system for Australian Army Cadet Q-Stores. Everything runs in your web browser and is stored on your device — no internet connection is needed for day-to-day use.');
  b.gap();
  b.h3('What QStore IMS lets you do');
  b.bullets([
    'Track all Q-Store equipment with photos, quantities, and condition details',
    'Issue and return equipment with automatic stock updates',
    'Print blank AB189 request forms for members to complete by hand',
    'Track where equipment is without holding any personal information',
    'Run stocktakes with detailed condition recording for every item',
    'Import supply orders from the AAC QStore system and receive them into inventory',
    'Print loan vouchers, AB189 forms, stock reports, and QR code labels',
    ...((typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__) ? [] : ['Optionally back up everything automatically to Microsoft OneDrive']),
    'Keep a complete, tamper-evident record of every action in the system',
  ]);
  b.gap();
  b.h3('Who uses it and how they log in');
  b.p('QStore IMS has four roles: Commanding Officer (OC), Quartermaster (QM), Staff, and Read-Only. Each role has a different level of access. Every user logs in with a 4-digit PIN. Only the OC can create user accounts and manage PINs. There is no cadet role — this build holds no cadet records and has nothing for a cadet account to see.');
  b.gap();
  b.h3('Where your data is kept');
  b.p((typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
    ? 'All data is stored inside your web browser on the device running the app. This build has no cloud sync — nothing is ever transmitted off this device. Always keep backup copies stored off the device so data is safe if the browser or device is lost.'
    : 'All data is stored inside your web browser on the device running the app. Nothing is sent anywhere unless you set up OneDrive cloud sync. Always keep backup copies stored off the device so data is safe if the browser or device is lost.');
  b.callout('QStore IMS is a single self-contained HTML file. Open it in Chrome, Edge, Firefox, or Safari. No installation is required.', 'tip');
}

function _s2(b) {
  b.h1(2, 'Getting Started');

  b.h2('Opening the app for the first time');
  b.p('Double-click the QStore file (qstore.html) to open it in your browser. A splash screen counts down from 5, then the login screen appears.');

  b.h3('Logging in for the first time');
  b.steps([
    'Select Administrator from the user list.',
    'Enter PIN: 0000',
    'You will immediately be prompted to set a new PIN. Do this before anything else.',
  ]);
  b.callout('The default PIN 0000 must be changed on first login before any other action is possible.', 'warning');
  b.gap();

  b.h2('Setting up your unit (OC)');
  b.p('After logging in, the Dashboard shows a three-step setup checklist. Complete all three steps before using the system for live data.');

  b.h3('Step 1 — Enter unit details');
  b.steps([
    'Click Settings in the top navigation bar (OC only).',
    'Under Unit Details, fill in: unit name, unit code, state, OC/QM name and rank.',
    'Upload your unit logo if you have one.',
    'Click Save unit details.',
  ]);

  b.h3('Step 2 — Add inventory items');
  b.p('See Section 4 — Inventory for step-by-step instructions. Start with the most frequently issued items.');

  b.h3('Step 3 — Set up issue destinations');
  b.p('See Section 7 — Issue Destinations and Issue Numbers. Destinations are the activities and places you issue equipment to; the OC maintains the list in Settings.');

  b.h2('Recording equipment already on loan when you start');
  b.p('If equipment was already out before QStore was installed, record those loans against the correct destination — or against Individual with an issue number written onto the existing paperwork — so the system matches reality from day one.');
  b.p('On the Loans → Issue tab, tick "Record existing issue (no stock deduction)" on any item line. This records the loan and increases the On Loan count, but does NOT reduce On Hand — because the item was already out before QStore started tracking it. When the item is eventually returned, On Hand will automatically increase to reflect the stock coming back.');
  b.callout('Always use the "Record existing issue" option for pre-existing loans. Do not manually edit stock numbers.', 'tip');

  b.h2('The Dashboard');
  b.p('The Dashboard is your home screen. It shows at a glance:');
  b.bullets([
    'Setup checklist — disappears once the three setup steps are complete',
    'Stat tiles — total items, items on loan, overdue loans, unserviceable items',
    'Stocktake status — when the last stocktake was completed',
    'Quick action shortcuts — one click to key pages',
    'Recent audit entries — the last five actions taken in the system',
  ]);
  b.callout('Click the ? button in the top-right corner of the header to open the help panel at any time.', 'tip');

  b.h2('Adding user accounts (OC only)');
  b.steps([
    'Go to the Users page (top navigation bar).',
    'Click + Add User.',
    'Enter the full name, a short unique username, the role, service number, and a 4-digit PIN.',
    'Click Add User. The PIN is displayed once — note it down immediately and give it to the user verbally.',
  ]);
  b.callout('Users cannot change their own PINs. Only the OC manages PINs. See Section 14 for full PIN security details.', 'note');
}

function _s3(b) {
  b.h1(3, 'User Roles and Permissions');
  b.p('Every user account has a role that determines what they can see and do. Assign the most appropriate role — do not give users more access than they need.');
  b.gap();
  b.table(
    ['Role', 'Description'],
    [
      ['OC\n(Commanding Officer)', 'Full access to everything: inventory, loans, stocktake, orders, settings, users, and PIN management. Assign to the CO only. There should normally be only one OC account.'],
      ['QM\n(Quartermaster)', 'Full operational access: inventory, loans, stocktake, orders, and the audit log. Cannot access Settings or manage user accounts.'],
      ['Staff', 'Can view pages and reports. Cannot add or edit inventory, or issue or return loans.'],
      ['Read-Only (RO)', 'View-only access to inventory and loan records. No actions can be taken.'],
    ],
    [30, 144],
  );
  b.gap();

  b.h2('Full Permissions Reference');
  b.table(
    ['Action', 'OC', 'QM', 'Staff', 'RO'],
    [
      ['View inventory and loans', '✓', '✓', '✓', '✓'],
      ['Submit equipment requests', '✓', '✓', '✓', '—'],
      ['Issue and return loans', '✓', '✓', '—', '—'],
      ['Approve or deny requests', '✓', '✓', '—', '—'],
      ['Add and edit inventory items', '✓', '✓', '—', '—'],
      ['Delete inventory items', '✓', '—', '—', '—'],
      ['Manage staff', '✓', '✓', '—', '—'],
      ['Run stocktake', '✓', '✓', '—', '—'],
      ['Import and manage orders', '✓', '✓', '—', '—'],
      ['View audit log', '✓', '✓', '—', '—'],
      ['Print reports and QR codes', '✓', '✓', '—', '—'],
      ['Manage user accounts', '✓', '—', '—', '—'],
      ['Access Settings', '✓', '—', '—', '—'],
    ],
    [82, 18, 18, 18, 20, 18],
  );
  b.gap();

  b.h2('Managing User Accounts (OC only)');
  b.h3('Adding a user');
  b.steps([
    'Go to the Users page.',
    'Click + Add User.',
    'Enter the full name (as it will appear on the login screen and in the audit log), a short unique username, the role, service number, and a 4-digit initial PIN.',
    'Click Add User.',
    'The new PIN is shown once in a confirmation screen. Write it down and tell the user verbally.',
  ]);
  b.h3('Editing a user');
  b.p('Click Edit on any user row to update their name, username, role, or service number. To change their PIN, use the Reset PIN button instead — PIN is not changed through the Edit form.');
  b.h3('Resetting a PIN');
  b.p('Click Reset PIN on any user row. Enter a new 4-digit PIN twice to confirm, then click Reset PIN. The new PIN is shown once — note it down and give it to the user verbally.');
  b.h3('Deleting a user');
  b.p('Click Delete on any user row and confirm. You cannot delete your own account, and you cannot delete the last OC account (assign another OC first). Deleting a user removes their login access only — all their loan history and audit entries are kept.');
}

function _s4(b) {
  b.h1(4, 'Inventory');
  b.p('The Inventory page lists all items in your Q-Store. Use the search box to find items by name, NSN (stock number), or category. Use the category dropdown to filter to one type of item at a time.');

  b.h2('Understanding the item list');
  b.p('Each row shows: NSN, photo, item name, category, authorised quantity, on hand, on loan, unserviceable count, condition status, and storage location. "Available" is calculated automatically as On Hand minus On Loan — this is the quantity that can be issued right now.');

  b.h3('The five condition states');
  b.p('Every item tracks its condition using five categories:');
  b.table(
    ['Condition', 'Short form', 'What it means'],
    [
      ['Serviceable',      'Svc',  'Ready to issue — in good working order'],
      ['Unserviceable',    'U/S',  'Damaged or not working — needs assessment or repair'],
      ['In Repair',        'Repr', 'Currently with a repairer — temporarily unavailable'],
      ['Calibration Due',  'Cal',  'Must be calibrated before it can be used or issued'],
      ['Written Off',      'W/O',  'Beyond repair — requires formal Board of Survey action'],
    ],
    [42, 24, 108],
  );

  b.h2('Adding an item (OC / QM)');
  b.steps([
    'Click + Add item.',
    'Enter the NSN (National Stock Number) in 4-2-3-4 format, e.g. 8470-66-001-0001. Non-standard numbers are accepted with a warning.',
    'Enter the item name and select a category.',
    'Enter the Authorised Qty (the establishment amount) and the current On Hand quantity.',
    'Fill in the condition breakdown — enter a number for each condition state that applies. The total must equal On Hand. The Serviceable field adjusts automatically to keep the total consistent.',
    'Enter the storage location if known (e.g. Shelf 3A, Bin 12).',
    'Click Save item.',
  ]);
  b.callout('For brand-new items in perfect condition, just set On Hand — the Serviceable field fills in automatically.', 'tip');

  b.h2('Editing an item (OC / QM)');
  b.p('Click Edit on any row to change any field. All changes are recorded in the audit log. The condition breakdown fields are pre-filled with the current values so you can make targeted adjustments.');

  b.h2('Viewing loan history for an item');
  b.p('Click History on any item row to see the complete loan record for that item: who borrowed it, when, when it was returned, and the return condition.');

  b.h2('Deleting an item (OC only)');
  b.p('Click Delete on any item row. You must type a reason for the deletion. Deletions are permanent and recorded in the audit log.');

  b.h2('Item photos');
  b.p('Click the camera icon on any item row to upload a photo. Supported formats: JPEG, PNG, WebP. Photos appear in reports and on screen. They are resized automatically and stored locally on the device.');

  b.h2('Printing reports and labels');
  b.bullets([
    '⊙ Print stock — generates a PDF of the currently-visible items, respecting any search and category filter. Includes a condition column in compact form, e.g. 5S/2U/1R means 5 Serviceable, 2 Unserviceable, 1 In Repair.',
    '⊙ QR codes — generates a page of printable QR labels for all visible items. Scan with the ⌖ Scan button on the Inventory page to quickly look up any item.',
  ]);
}

function _s5(b) {
  b.h1(5, 'Loans — Issuing and Returning Equipment');
  b.p('The Loans page has three tabs: Issue, Return, and All Loans. When loans are overdue, a red number badge appears on the Loans navigation item as a reminder.');

  b.h2('Issuing equipment (OC / QM)');
  b.steps([
    'Go to Loans → Issue tab.',
    'Choose the destination from the list. For equipment going to a person, choose "Individual (see issue document)" — the system allocates an issue number to write on the paperwork. See Section 7.',
    'Select the purpose from the dropdown.',
    'Set the due date, or tick "Long-term loan" for equipment with no fixed return date.',
    'Add item lines — click + Add another item for each item. Search by name or NSN. The available quantity is shown next to each item.',
    'Add any notes or remarks.',
    'Click Issue.',
  ]);
  b.p('A loan reference number (LN-XXXX) is created automatically. Stock counts update immediately.');
  b.callout('Load a pre-defined kit with ⊞ Load kit to fill all item lines with one click. See Section 16 — Issue Kits.', 'tip');

  b.h3('Initial Issue (special purpose)');
  b.p('"Initial Issue" is the purpose for permanently issuing uniform and equipment to a member for their full enlistment period. Choose the destination "Individual" and record the issue number on the document.');
  b.bullets([
    'The due date is automatically set to 6 years from today and cannot be changed',
    'The Long-term loan toggle is disabled when Initial Issue is selected',
    'Initial Issue is always available and cannot be removed from the purpose list',
  ]);

  b.h3('Recording loans for equipment already out');
  b.p('If equipment was on loan before QStore was set up, record those loans without changing your stock count. Here is how:');
  b.steps([
    'On the Issue tab, search for and select the inventory item as normal.',
    'Tick "Record existing issue (no stock deduction)" — this checkbox appears below the Non-stock item checkbox on each item line.',
    'An amber badge reading "↕ Existing issue — stock not deducted" confirms the mode.',
    'Complete the rest of the issue form and click Issue.',
  ]);
  b.p('The On Loan count increases (so accountability is maintained), but On Hand is not reduced (because the item was already counted as out when you set up QStore). When the item is returned, On Hand increases automatically.');
  b.callout('Use this for all equipment that was already out before your unit started using QStore. It keeps stock figures accurate without double-counting.', 'note');

  b.h3('Non-stock items (not in your inventory)');
  b.p('For items not recorded in your inventory at all (e.g. equipment borrowed from another unit or currently on order), tick "Non-stock item" and type a description. These loans are tracked but do not affect inventory counts. If you supply an NSN and it matches an inventory item when returned, QStore will offer to add the item to inventory at that point.');

  b.h2('Returning equipment (OC / QM)');
  b.steps([
    'Go to Loans → Return tab.',
    'Select the issue number or destination — only those with active loans appear in the list. Check the issue document to confirm the person returning matches.',
    'Tick the items being returned.',
    'Set the condition on return: Serviceable, Unserviceable (needs repair), or Write-off (beyond repair).',
    'Add return remarks if needed, for example a description of any damage.',
    'Click Return selected.',
  ]);
  b.p('Stock counts update automatically. Unserviceable returns increase the item\'s unserviceable count. Write-offs also flag the item condition for follow-up Board of Survey action.');
  b.callout('When an existing-loan item is returned, you will see a confirmation message: "On Hand restored in inventory."', 'tip');

  b.h2('Viewing all loans');
  b.p('The All Loans tab shows every loan record. Filter using the buttons:');
  b.bullets([
    'Active — currently outstanding loans',
    'Overdue — active loans past their due date',
    'Returned — completed loan history',
    'All — the full loan history',
  ]);
  b.p('Filter by issue number or destination using the control at the top. Click any row to expand it and see full details. Use ⊙ Voucher or ⊙ AB189 to print documents for any loan — recipient fields print blank for hand completion.');

  b.gap(2);
  b.h3('Loan status badges explained');
  b.table(
    ['Badge', 'What it means'],
    [
      ['Active',           'Loan is current — equipment is out'],
      ['Overdue',          'Past the due date and not yet returned'],
      ['Long-term',        'No fixed due date — issued indefinitely'],
      ['Returned',         'Equipment has been returned and the loan is closed'],
      ['Discharged ⚠', 'Cadet has left the unit but this equipment has not been returned'],
      ['NS (Non-stock)',   'Item is not in the IMS inventory'],
      ['Unit',             'Issued to a unit activity, not an individual'],
      ['Exist',            'Recorded as an existing issue — stock not deducted at issue time'],
    ],
    [42, 132],
  );
}

function _s6(b) {
  b.h1(6, 'Equipment Requests (Paper)');
  b.p('Equipment requests are paper in this build. There is no Requests page: a request records who wants what, and this system does not store people.');

  b.h2('How it works');
  b.steps([
    'Go to Loans → Issue and click "Blank AB189".',
    'Give the printed form to the member. They complete their own details by hand.',
    'Process the request from the paper as a normal issue.',
    'Scan or save the completed AB189 and upload it to that member\'s CEA documents.',
  ]);
  b.callout('The CEA document is the record of who requested and received the equipment. This system records only that the items went out, against an issue number.', 'note');
}

function _s7(b) {
  b.h1(7, 'Issue Destinations and Issue Numbers');
  b.p('This build holds no personal information. It does not know who has an item — only that the item went out, and where to.');

  b.h2('Destinations');
  b.p('Every issue is recorded against a destination chosen from a list the OC maintains in Settings. Destinations are activities and places: "Field exercise", "Range practice", "Maintenance / repair".');
  b.p('It is a fixed list rather than a text box on purpose. A box next to the word "issue" collects names, and a name is exactly what this system must not hold.');

  b.h2('Issuing to a person');
  b.p('Choose the destination "Individual (see issue document)". The system allocates an issue number — ISS-1042, for example — and shows it on screen.');
  b.steps([
    'Write the issue number on the printed issue document (voucher or AB189).',
    'The member completes their details on the paper and signs for the items.',
    'Scan or save the completed document and upload it to that member\'s CEA documents.',
  ]);
  b.callout('The issue number is the ONLY link between the equipment and the person holding it, and that link lives on the document in CEA. If the document is lost, the link is lost. This is the design, not a fault.', 'warn');

  b.h2('What this means day to day');
  b.bullets([
    'Overdue items can be identified, but not who has them — check the issue documents in CEA',
    'There is no automatic recall of a departing member\'s kit',
    'Kit checklists and nominal rolls are not produced by this system',
    'Every issue is recorded twice: once here, once in CEA',
  ]);
}

function _s8(b) {
  b.h1(8, 'Stocktake');
  b.p('The Stocktake page guides you through a physical count of every item in the Q-Store. Completing a stocktake updates all inventory quantities and condition records to match physical reality.');

  b.h2('Printing the blank worksheet first');
  b.p('Before starting, click ⊙ Worksheet to print a blank count sheet. This lists every inventory item with empty columns for each condition state. Use it to record your physical counts on the floor before entering the numbers into QStore.');

  b.h2('Completing a stocktake (OC / QM)');
  b.steps([
    'Go to the Stocktake page.',
    'For each item, count how many units are in each condition and enter the number in each column.',
    'The Total column automatically adds up all five condition columns. The Variance column shows the difference from the system quantity.',
    'Add a note for any item if needed.',
    'Use the category filter to work through the Q-Store one section at a time.',
    'Your progress saves automatically — you can leave the page and come back without losing anything.',
    'When all items are counted, click Finalise stocktake.',
    'Review the discrepancy summary carefully and click Confirm.',
  ]);

  b.h3('The five condition columns');
  b.table(
    ['Column', 'Short', 'Count items that are…'],
    [
      ['Serviceable',     'Svc',  'In good working order and ready to issue'],
      ['Unserviceable',   'U/S',  'Damaged or not working — need repair or assessment'],
      ['In Repair',       'Repr', 'Currently with a repairer and temporarily unavailable'],
      ['Calibration Due', 'Cal',  'Due for calibration before they can be issued'],
      ['Written Off',     'W/O',  'Beyond repair — require formal Board of Survey action (AB174)'],
    ],
    [38, 18, 118],
  );
  b.callout('You only need to fill in the columns that apply. Leave others blank or at zero. The In Repair and Calibration Due columns turn amber when filled, as a visual reminder.', 'tip');

  b.h2('What finalising does to inventory');
  b.bullets([
    'On Hand is updated to the total count (all five columns added together)',
    'The full condition breakdown is saved for every item — the Inventory page immediately shows the exact post-stocktake state',
    'Every discrepancy is recorded in the audit log',
    'Written-off items get a separate audit entry to flag them for Board of Survey action',
    'A stocktake report PDF is available showing all five condition columns per item',
  ]);
  b.callout('Finalising a stocktake cannot be undone. Check all counts before clicking Confirm. Written-off items must be formally struck off charge via a Board of Survey (AB174) — QStore flags them but does not process the Board of Survey automatically.', 'warning');
}

function _s9(b) {
  b.h1(9, 'AAC QStore Orders');
  b.p('The Orders page tracks supply orders from the AAC QStore system. It reads PDFs downloaded from the AAC QStore website and uses them to update your local inventory when ordered items arrive. It does not connect to or modify the AAC QStore system directly.');
  b.p('Access is limited to OC and QM.');

  b.h2('Importing an order PDF (OC / QM)');
  b.steps([
    'Download the order PDF directly from the AAC QStore website. Save it as a PDF file — do not use "Print to PDF" from a browser, as that strips the table data.',
    'Go to Orders and click Import PDF Order.',
    'Select the PDF. The system automatically reads the order number, items, quantities, NSNs, and requestor details.',
    'Review the editable import screen. Click any cell to correct errors. The IMS column shows whether each item was matched to your inventory.',
    'Click Save Order.',
  ]);

  b.h3('IMS match status on import');
  b.table(
    ['Badge', 'What it means'],
    [
      ['✓ IMS', 'NSN found in your inventory — stock will update when you receive the order'],
      ['New',       'NSN not in inventory — a new item will be created when you receive the order'],
      ['No NSN',    'No stock number on this line — cannot be matched or received automatically'],
    ],
    [22, 152],
  );

  b.h2('Receiving an order into inventory (OC / QM)');
  b.p('When the physical items arrive from AAC QStore:');
  b.steps([
    'Open the saved order and click Approve & Receive into IMS.',
    'Adjust quantities if the delivery differed from the order. Set any line to 0 to skip it (for items that are back-ordered or not received).',
    'Select a category for any brand-new items being created.',
    'Add optional notes, then click Confirm & Update IMS.',
  ]);
  b.p('Matched items have their On Hand count increased. New items are created in inventory. The order status changes to Received and an audit entry is written.');
  b.callout('Receiving an order into IMS cannot be reversed from the Orders page. If a mistake is made, correct the affected items manually in Inventory and add a note in the Audit log.', 'warning');

  b.h2('Exporting an order as CSV');
  b.p('Click Export CSV on any order to download the order details as a spreadsheet file. The download includes order metadata, all item rows, quantities, and IMS match status.');

  b.h2('Deleting an order record');
  b.p('Click Delete on the order detail screen to remove the import record. This does not reverse any inventory changes that have already been applied.');
}

function _s10(b) {
  b.h1(10, 'Audit Log');
  b.p('The Audit Log is an automatic, tamper-evident record of everything that happens in QStore. Every action — issuing a loan, editing an item, logging in, changing a PIN, running a stocktake — is recorded automatically. Audit entries cannot be manually edited or deleted.');

  b.h2('Viewing the log (OC / QM)');
  b.p('Go to the Audit page. Entries are shown newest first. Each entry shows a sequence number, timestamp, action type, the user who took the action, and a plain-English description of what happened.');
  b.p('Use the search box to find specific entries. Use the action type filter to show only one category (e.g. only issue events, or only login events).');

  b.h2('Exporting the audit log (OC / QM)');
  b.bullets([
    '⬇ Export CSV — downloads a spreadsheet file compatible with Excel and other programs',
    '⬇ Export JSON — downloads a raw data file for archiving or programmatic use',
  ]);
  b.p('Both exports respect the active filters. Filter first, then export if you want a subset of the full log.');

  b.h2('Key audit action types');
  b.table(
    ['Action', 'What was recorded'],
    [
      ['add / adjust',                  'Inventory item added, edited, or deleted'],
      ['issue',                         'Equipment issued (including existing-loan and non-stock issues)'],
      ['return',                        'Equipment returned from an issue or destination'],
      ['cadet_add / update / delete',   'Person record created, changed, or removed'],
      ['cadet_discharge',               'Cadet deactivated — active loans recalled automatically'],
      ['request_submitted',             'Equipment request submitted by a user'],
      ['request_approved',              'Equipment request approved (and optionally auto-issued)'],
      ['request_denied',                'Equipment request denied; QM reason recorded'],
      ['request_withdrawn',             'Equipment request cancelled by the requestor'],
      ['user_add / update / delete',    'User account created, changed, or deleted'],
      ['pin_change',                    'A PIN was set or reset by the OC'],
      ['recovery_set / recovery_reset', 'OC recovery code generated or used'],
      ['login / login_failed / logout', 'Login and logout events'],
      ['session_unlock',                'Auto-locked screen unlocked by PIN entry'],
      ['stocktake',                     'Stocktake finalised and inventory updated'],
      ['stocktake_writeoff',            'Written-off items flagged during stocktake'],
      ['order-import / received',       'Supply order imported or received into IMS'],
      ['data_export / data_imported',   'Backup file exported or imported'],
    ],
    [70, 104],
  );

  b.h2('Checking audit chain integrity');
  b.p('Each audit entry is cryptographically linked to the one before it. If any entry is changed or deleted outside QStore, the chain breaks. Click Verify chain to run an integrity check. A broken chain means the log may have been tampered with and the backup should be reviewed.');
}

function _s11(b) {
  b.h1(11, 'Settings');
  b.p('Settings is accessible to the OC only. It covers unit details, unit sub-structure, item categories, user accounts, cloud sync, data backup, OC PIN recovery, security settings, and app information.');

  b.h2('Unit Details');
  b.p('These details appear in the app header, on the login screen, and on all generated PDF documents.');
  b.table(
    ['Field', 'What to enter'],
    [
      ['Unit name',    'Full unit name, e.g. 145 ACU Moranbah Community'],
      ['Unit code',    'Short code, e.g. 145ACU — used in downloaded file names'],
      ['State',        'State or territory — appears on AB189 forms'],
      ['OC/QM name',   'Appears on signature blocks in all PDF documents'],
      ['OC/QM email',  'Contact email for the unit'],
      ['QM rank',      'QM\'s rank for signature blocks on PDFs'],
      ['Unit logo',    'Displayed in the header and on the launch splash screen. Upload the highest quality version available.'],
    ],
    [36, 138],
  );

  b.h2('Categories');
  b.p('Manage the item categories used in Inventory and Stocktake. Default categories: Uniform, Equipment, Safety, Training Aids, Field Stores, Medical, ICT.');
  b.bullets([
    'Drag the ⠇ handle to reorder categories',
    'Click ↑ / ↓ to move items up or down one position. Hold Shift while clicking to jump to the top or bottom of the list',
    'Type a new name and press Enter or click Add to create a new category',
    'Click ✕ on any chip to remove that category',
    'Click Save categories to apply. Click Reset to defaults to restore the original list.',
  ]);
  b.callout('Removing a category does not affect existing inventory items — they keep their stored category name. Update individual items if you rename or remove a category.', 'note');

  b.h2('Unit Sub-Structure');
  b.p('Configure the company / platoon / section hierarchy for your unit. Click Configure structure, add companies, platoons, and sections, then click Save structure. The hierarchy is retained for unit administration; this build does not use it to group people, because it holds no person records.');

  b.h2('OC PIN Recovery');
  b.p('Generate a one-use recovery code for the OC account in case the OC forgets their PIN. See Section 15 for full instructions.');

  b.h2('Security (Auto-lock)');
  b.p('Set how long the app waits before locking itself when there is no activity: Disabled, 5, 10, 15, or 30 minutes, or 1 hour. See Section 14 for full details.');

  b.h2('Data Backup and Restore');
  b.p('Export and import full data backups. See Section 13 for full instructions.');

  if (!(typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)) {
    b.h2('Cloud Sync');
    b.p('Configure automatic OneDrive backup. See Section 12 for setup instructions.');
  }

  b.h2('About');
  b.p('Shows the app version number, authorship, and licence information.');
}

// Section 12 has two forms. The Defence build has no cloud sync compiled in, so
// documenting the setup would be both wrong and misleading — and it would leave
// the Azure/OneDrive setup strings in an artefact whose whole claim is that it
// contains no cloud code. A constant ternary lets esbuild drop the unused body.
// Section numbering and the table of contents are shared, so the section stays
// at 12 either way.
const _s12 = (typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)
  ? _s12Defence : _s12Standard;

function _s12Defence(b) {
  b.h1(12, 'Backups');
  b.p('This build does not include cloud sync. All data is held in this browser\'s storage on this device and is never transmitted to third-party cloud storage.');

  b.h2('Keeping a backup');
  b.p('Because there is no automatic off-device copy, taking regular manual backups matters. Use Settings → Export data to write an encrypted backup file, and store it somewhere the unit controls.');
  b.callout('Personal information is encrypted at rest on this device. Export files should be treated as sensitive documents and stored accordingly.', 'note');
}

function _s12Standard(b) {
  b.h1(12, 'Cloud Sync (OneDrive)');
  b.p('Cloud sync is completely optional. When set up, it automatically backs up all QStore data to a folder in Microsoft OneDrive. This protects against device loss and allows the same data to be accessed from more than one device.');

  b.h2('What you need before setting up');
  b.bullets([
    'A Microsoft account (personal, work, or school)',
    'An Azure App Registration with a redirect URI that matches the URL your QStore file is served from',
    'The app must be served over HTTPS — cloud sync does not work when the file is opened directly as a file:// URL',
  ]);

  b.h2('Setting up cloud sync (OC)');
  b.steps([
    'Go to Settings → Cloud sync.',
    'Copy the Redirect URI shown — you must register this exact address in your Azure App Registration.',
    'Enter your Azure Application (Client) ID.',
    'Set the OneDrive folder name (default: QStore) and file name (default: qstore_data.json).',
    'Click Save, then click Sign in and complete the Microsoft login prompt.',
  ]);
  b.callout('After the first successful sync, the Azure Client ID is hidden for security. Click and hold the "Hold to reveal" button to temporarily view it.', 'note');

  b.h2('Sync options');
  b.bullets([
    'Auto-sync (on by default) — syncs automatically when changes are made in QStore',
    'Sync now — manually push your current data to OneDrive at any time',
    'Load from cloud — download and replace your local data with the OneDrive copy. The system asks for confirmation before proceeding, as this action replaces all local data.',
  ]);
  b.callout('Cloud sync uses a last-write-wins approach. If data is changed on two devices at the same time, the last one to sync will overwrite the other. For best results, edit data on only one device at a time.', 'note');
}

function _s13(b) {
  b.h1(13, 'Backup and Restore');
  b.p('Regular backups are essential. QStore data is stored inside your web browser — if the browser is reset, the device is lost, or the browser profile is cleared, the data is gone. Always keep at least one backup stored off the device.');

  b.h2('Exporting a backup (OC)');
  b.steps([
    'Go to Settings → Data backup and restore.',
    'Click Export backup.',
    'A JSON file is downloaded with a name like qstore-backup-145acu-2026-05-20.json.',
    'Store this file somewhere safe and off the device — email it to yourself, save it to OneDrive, or copy it to a USB drive.',
  ]);
  b.p('The backup contains everything: inventory, photos, loans, users, settings, supply orders, and the full audit log chain.');

  b.h2('Importing a backup (OC)');
  b.steps([
    'Go to Settings → Data backup and restore.',
    'Click Import backup.',
    'Select the .json backup file.',
    'Confirm. All current data is replaced with the contents of the backup file.',
  ]);
  b.callout('Importing a backup permanently replaces all existing data. There is no undo. Make absolutely sure you are selecting the correct file.', 'warning');

  b.h2('Bulk CSV import — inventory items');
  b.p('To add many inventory items at once from a spreadsheet:');
  b.steps([
    'Go to Settings → Data backup and restore → Import CSV.',
    'Download the template file if you need the correct column format.',
    'Fill in your spreadsheet: NSN, name, category, authorised quantity, on hand, location.',
    'Upload the file, review the preview for any highlighted errors, then click Confirm import.',
  ]);

  b.h2('How often to back up');
  b.bullets([
    'After any major change: new stocktake, large loan batch, bulk import',
    'At the end of each parade night or training activity',
    'At least weekly during active use of the system',
    'Always before and after importing data or updating the app to a new version',
  ]);
}

function _s14(b) {
  b.h1(14, 'PIN Security and Auto-Lock');

  b.h2('How PINs work');
  b.p('Every user account has a 4-digit PIN for logging in. PINs are stored using strong encryption (Argon2id) — the actual PIN is never stored anywhere and cannot be recovered, even by the OC.');

  b.h2('PIN management rules');
  b.bullets([
    'Only the OC can set or reset PINs — no user can change their own PIN',
    'When any PIN is set or reset, it is displayed once on screen for the OC to write down',
    'Once that screen is closed, the PIN cannot be seen again by anyone, including the OC',
    'If a user forgets their PIN, they must ask the OC to reset it via Users → Reset PIN',
  ]);

  b.h2('Lockout after too many wrong attempts');
  b.p('Entering the wrong PIN too many times triggers a temporary lockout. This applies to both the login screen and the auto-lock screen. Other user accounts are not affected.');
  b.table(
    ['Number of wrong attempts', 'Waiting time'],
    [
      ['5',         '30 seconds'],
      ['10',        '5 minutes'],
      ['15 or more','30 minutes'],
    ],
    [70, 104],
  );

  b.h2('Auto-lock (idle timeout)');
  b.p('The OC can configure QStore to lock itself automatically after a set period without any keyboard, mouse, or touch activity. Set this in Settings → Security → Auto-lock after idle. Options: Disabled, 5, 10, 15, or 30 minutes, or 1 hour.');
  b.gap(2);
  b.h3('How it works');
  b.bullets([
    'Any mouse movement, key press, or touch resets the idle timer',
    'When the timer runs out, a lock screen appears over whatever page you were on',
    'Enter your PIN to resume — everything is exactly where you left it',
    'Click "Sign out / switch user" on the lock screen to log out completely instead',
    'Failed unlock attempts follow the same lockout table as login',
    'Successful unlocks are recorded in the audit log as session_unlock',
  ]);
  b.callout('Enable auto-lock on any shared or unattended device — parade-night computers, duty tablets, or any computer used by multiple people. 15 minutes is a sensible default.', 'tip');
}

function _s15(b) {
  b.h1(15, 'OC PIN Recovery');
  b.p('The OC account has a special recovery option that allows the OC PIN to be reset using a one-time recovery code, without needing to contact anyone. Set this up as part of your initial QStore configuration — before you ever need it.');

  b.h2('Generating a recovery code (OC)');
  b.steps([
    'Go to Settings → OC PIN recovery.',
    'Click Generate new code.',
    'A 12-character recovery code is displayed. Write it down immediately.',
    'Close the screen. The code is not shown again.',
  ]);
  b.p('Store the code somewhere secure and off the device:');
  b.bullets([
    'Printed and kept in the unit safe',
    'Written in the unit diary or key register',
    'Stored in a password manager on a separate device',
  ]);
  b.callout('Treat the recovery code like the combination to your safe. Anyone who has it can reset the OC PIN and gain full administrator access to QStore. If you think a code may have been seen by the wrong person, generate a new one immediately.', 'warning');

  b.h2('Using a recovery code (if the OC forgets their PIN)');
  b.steps([
    'On the login screen, select the OC account.',
    'Click Forgot PIN?',
    'Enter the 12-character recovery code.',
    'Enter a new PIN and confirm it.',
  ]);
  b.p('The recovery code is consumed after use. Generate a new one immediately from Settings → OC PIN recovery.');

  b.h2('If the recovery code is also lost');
  b.p('There is no way to bypass a lost OC PIN without a recovery code. Your options are:');
  b.bullets([
    'Import a recent backup file — this restores all data, but the PIN problem remains. Contact support for next steps.',
    'Email admin@seanscales.com.au for assistance.',
  ]);
  b.callout('Set up a recovery code and store it securely as part of initial setup. There is no other way to recover a lost OC PIN without it.', 'warning');
}

function _s16(b) {
  b.h1(16, 'Issue Kits');
  b.p('Issue kits are pre-defined bundles of items that fill all the item lines on the loan issue form with one click. They save time when issuing standard sets of equipment such as an initial issue kit or an annual camp set.');

  b.h2('Creating a kit (OC / QM)');
  b.steps([
    'Go to Inventory.',
    'Click ⊞ Kits in the toolbar.',
    'Click + New kit.',
    'Enter a name for the kit (required) and a description (optional).',
    'Add item lines — search for each item by name or NSN and set the quantity.',
    'Click Create kit.',
  ]);
  b.bullets([
    'Clicking outside the kit form does NOT close it — your work is preserved until you explicitly save or cancel',
    'Long item lists scroll automatically as you add more lines',
    'Clicking Cancel shows a confirmation prompt before discarding any unsaved changes',
    'If an item is renamed in inventory, kits that include that item update automatically',
  ]);

  b.h2('Using a kit when issuing equipment');
  b.steps([
    'Go to Loans → Issue tab.',
    'Click ⊞ Load kit.',
    'Select the kit from the list — all item lines are pre-filled instantly.',
    'Adjust individual quantities if needed (e.g. different sizes for uniform items).',
    'Continue filling in the destination, purpose, and due date, then click Issue.',
  ]);
  b.bullets([
    'Kit items with no stock on hand are still added to the issue list and recorded as On Loan — a warning message lists the affected items so you can note or investigate them',
    'Kits are templates only — they do not affect stock counts until the loan is actually issued',
  ]);
}

function _s17(b) {
  b.h1(17, 'QR Code Labels');
  b.p('QR code labels let you identify any inventory item instantly by scanning it with a phone or tablet camera, instead of searching through a list manually.');

  b.h2('Printing labels (OC / QM)');
  b.steps([
    'Go to the Inventory page.',
    'If you only want labels for certain items, filter the list first (by name, NSN, or category).',
    'Click ⊙ QR codes.',
    'A PDF is generated with one label per item, showing the NSN, item name, and a scannable QR code.',
    'Print the labels and attach them to the corresponding items or their storage locations.',
  ]);

  b.h2('Scanning a label');
  b.steps([
    'Go to the Inventory page.',
    'Click ⌖ Scan.',
    'Allow camera access if your browser asks for permission.',
    'Point the camera at any QR code label.',
    'The matching item is highlighted in the inventory list automatically.',
  ]);
  b.callout('Most modern smartphones and tablets can scan QR codes directly with their built-in camera app — a separate scanning app is not needed.', 'tip');
}

function _s18(b) {
  b.h1(18, 'Troubleshooting');
  b.p('Most issues have straightforward solutions. Work through the steps below before contacting support.');

  b.h2('The app shows a blank screen or will not load');
  b.bullets([
    'Check that JavaScript is enabled in the browser settings',
    'Try a hard refresh: hold Ctrl+Shift+R on Windows, or hold Cmd+Shift+R on Mac',
    'Try a different browser (Chrome or Edge are recommended)',
    'Press F12 to open the browser console and look for any red error messages',
  ]);

  b.h2('A user has forgotten their PIN');
  b.p('Users cannot reset their own PINs. The OC must do it:');
  b.steps([
    'Go to the Users page.',
    'Click Reset PIN next to the user\'s name.',
    'Enter a new 4-digit PIN and confirm it, then click Reset PIN.',
    'The new PIN is shown once — note it down and give it to the user verbally.',
  ]);

  b.h2('The OC has forgotten their PIN');
  b.p('If a recovery code was set up: on the login screen, select the OC account, click Forgot PIN?, enter the recovery code, and set a new PIN. Generate a new recovery code immediately afterwards in Settings.');
  b.p('If no recovery code is available: there is no way to bypass the PIN. Import a recent backup if you have one, or email admin@seanscales.com.au for assistance. This is why setting up a recovery code as part of initial setup is so important.');

  b.h2('Data appears to be missing');
  b.p('QStore data is stored in the browser on your specific device. Opening QStore on a different device or in a different browser will show no data — that is normal behaviour.');
  b.p('If data has disappeared on the same device and browser, the browser profile may have been cleared or reset. Import from your most recent backup. Always keep backups stored off the device.');

  b.h2('Stock counts look wrong');
  b.steps([
    'Check the All Loans tab — are there active loans reducing the available count?',
    'Check the Audit log for any unexpected adjustments.',
    'Run a stocktake to reconcile the physical count with the system records.',
  ]);

  if (!(typeof __QSTORE_DEFENCE__ !== 'undefined' && __QSTORE_DEFENCE__)) {
    b.h2('Cloud sync is not connecting');
    b.bullets([
      'Check that the app is being served over HTTPS (not opened as a file:// URL)',
      'Confirm the Redirect URI in your Azure App Registration exactly matches what Settings shows — even one wrong character will cause it to fail',
      'Try signing out of cloud sync and signing back in',
      'Confirm the Azure App has the required permissions: Files.ReadWrite, offline_access, openid, profile',
    ]);
  }

  b.h2('Order PDF import — items or quantities look wrong');
  b.bullets([
    'Click any cell in the editable review screen to correct the description, NSN, or quantity before saving',
    'If no items were extracted at all, the PDF was likely printed to PDF from a browser rather than downloaded directly from AAC QStore — try downloading it again',
    'For password-protected PDFs, remove the password in a PDF reader before importing into QStore',
  ]);

  b.h2('Audit chain verification fails');
  b.p('This means data may have been changed outside of QStore, for example through browser developer tools or a corrupted import. Import from your most recent confirmed-good backup and investigate what changed between that backup and now.');

  b.h2('Approve & Issue only processed some of the items');
  b.p('If the automatic issue failed for some lines, the request is marked Approved (not Issued) and the error appears on the request card. Issue the remaining items manually from Loans → Issue. Reference the request number in the remarks field.');

  b.h2('Contact and support');
  b.p('For any issue not covered in this manual: admin@seanscales.com.au');
}

function _s19(b) {
  b.h1(19, 'Uniform Sizing Reference');
  b.p('The Reference page inside QStore (available from the main navigation bar to all logged-in users) has complete ADF sizing tables with measurement guides. The tables below are a summary. Open the Reference page in the app for all intermediate and half sizes.');

  b.h2('Shirts and Jackets (AMCU)');
  b.p('ADF shirts and field jackets use a chest measurement plus a height band code, for example 102/R. Measure chest in centimetres: tape around the fullest part of the chest, under the armpits, keeping the tape horizontal and snug.');
  b.p('Height bands: S = under 170 cm, R = 170–183 cm, L = over 183 cm.');
  b.table(
    ['Chest (cm)', 'General size', 'US chest', 'NATO codes'],
    [
      ['87',  'XS',  '34"', '87/S • 87/R • 87/L'],
      ['92',  'S',   '36"', '92/S • 92/R • 92/L'],
      ['97',  'M',   '38"', '97/S • 97/R • 97/L'],
      ['102', 'L',   '40"', '102/S • 102/R • 102/L'],
      ['107', 'XL',  '42"', '107/S • 107/R • 107/L'],
      ['112', '2XL', '44"', '112/S • 112/R • 112/L'],
      ['117', '3XL', '46"', '117/S • 117/R • 117/L'],
    ],
    [30, 32, 30, 82],
  );
  b.callout('If between sizes, select the larger size. For items worn over body armour or thick insulation, go one size up.', 'tip');

  b.h2('Trousers (AMCU)');
  b.p('ADF trousers use a waist measurement plus a leg band code, for example 90/R. Measure waist in centimetres around the natural waist, about 2.5 cm above the navel. Measure inside leg from the crotch seam straight down to the ankle bone, standing upright.');
  b.p('Leg bands: S = inside leg 76 cm or shorter, R = 77–84 cm, L = 85 cm or longer.');
  b.table(
    ['Waist (cm)', 'General size', 'US waist'],
    [
      ['75',  'XS',  '29"'],
      ['80',  'S',   '31"'],
      ['85',  'M',   '33"'],
      ['90',  'L',   '35"'],
      ['95',  'XL',  '37"'],
      ['100', '2XL', '39"'],
      ['105', '3XL', '41"'],
      ['110', '4XL', '43"'],
    ],
    [40, 40, 94],
  );

  b.h2('Boots');
  b.p('AU and UK boot sizes use the same scale. Measure foot length from heel to the tip of the longest toe on a flat hard surface. Measure both feet and use the larger measurement. Add half a size when wearing thick military socks — boots should feel snug with the issued sock, not bare foot.');
  b.table(
    ['AU / UK size', 'US Men\'s', 'US Women\'s', 'Foot length (cm)'],
    [
      ['5',  '6',  '7.5',  '23.5'],
      ['6',  '7',  '8.5',  '24.5'],
      ['7',  '8',  '9.5',  '25.5'],
      ['8',  '9',  '10.5', '26.5'],
      ['9',  '10', '11.5', '27.5'],
      ['10', '11', '12.5', '28.5'],
      ['11', '12', '13.5', '29.5'],
      ['12', '13', '14.5', '30.5'],
    ],
    [38, 30, 36, 70],
  );

  b.h2('Hats and Berets');
  b.p('Sized by head circumference. Wrap the measuring tape around the head approximately 2 cm above the eyebrows and across the widest part at the back. Keep the tape level and parallel to the floor all the way around. Round up if you are between sizes.');
  b.table(
    ['Head circ. (cm)', 'Head circ. (in)', 'General size', 'UK / US hat size'],
    [
      ['54', '21¼"',  'XS',  '6¾'],
      ['56', '22"',        'S',   '7'],
      ['57', '22½"',  'S',   '7⅛'],
      ['58', '22⅞"',  'M',   '7¼'],
      ['59', '23¼"',  'M',   '7⅜'],
      ['60', '23⅝"',  'L',   '7½'],
      ['61', '24"',        'L',   '7⅝'],
      ['62', '24⅜"',  'XL',  '7¾'],
      ['64', '25¼"',  '2XL', '8'],
    ],
    [42, 38, 36, 58],
  );
  b.callout('Full tables including all half sizes are available on the Reference page inside the app.', 'tip');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate the full user manual as a PDF.
 * @param {Object} [opts]
 * @param {string} [opts.unitName]  Override the unit name on the cover page.
 * @returns {Promise<{filename: string, blob: Blob, bytes: number}>}
 */
export async function generateUserManual(opts = {}) {
  // Try to read the unit name from settings if not supplied.
  let unitName = opts.unitName || '';
  if (!unitName) {
    try {
      const s = await Storage.settings.getAll();
      unitName = (s && s.unitName) ? s.unitName : '';
    } catch (_) { /* settings may be unavailable in test environments */ }
  }

  const dateStr = new Date().toLocaleDateString('en-AU', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const db  = new DB(doc);

  // Page 1: cover (no running chrome)
  _cover(doc, unitName, dateStr);

  // Page 2: table of contents
  _toc(doc, db);

  // Pages 3+: sections (each h1() forces a new page)
  _s1(db);
  _s2(db);
  _s3(db);
  _s4(db);
  _s5(db);
  _s6(db);
  _s7(db);
  _s8(db);
  _s9(db);
  _s10(db);
  _s11(db);
  _s12(db);
  _s13(db);
  _s14(db);
  _s15(db);
  _s16(db);
  _s17(db);
  _s18(db);
  _s19(db);

  const safe     = (unitName || 'QStoreIMS').replace(/[^a-zA-Z0-9_-]/g, '_');
  const today    = new Date().toISOString().slice(0, 10);
  const filename = `QStoreIMS_UserManual_${safe}_${today}.pdf`;
  const buf      = doc.output('arraybuffer');
  const blob     = new Blob([buf], { type: 'application/pdf' });
  return { filename, blob, bytes: buf.byteLength };
}

/**
 * Trigger a browser download of a generated manual PDF.
 * @param {{ filename: string, blob: Blob }} result  Return value of generateUserManual().
 */
export function downloadUserManual(result) {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(result.blob);
  a.download = result.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}
