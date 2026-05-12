// =============================================================================
// QStore IMS v2 — PDF generation
// =============================================================================
// Single entry point: generateIssueVoucher(loans, options).
//
// "Voucher" rather than "AB189" because AB189 in v1 was the Equipment
// Request form (cadet asks → QM/CO sign), filled BEFORE issue. What we're
// printing here is the post-issue artefact: proof of what was issued, to
// whom, on what date, with signature blocks for both parties to sign at
// hand-over. The cadet-self-service request workflow (and a proper AB189
// form to go with it) lands in v2.2 when the requestIssue flow is built.
//
// BATCH-AWARE
//   When the QM issues 3 items in one transaction, the loans page creates
//   3 loan records sharing the same borrower + issueDate. The voucher
//   generator takes a list of loan records (typically all loans in such
//   a batch) and prints one A4 page with all items in a table. Single-
//   item issue produces a single-row table — same code path.
//
// LAYOUT CHOICES
//   The layout is adapted from v1's AB189 PDF — same army-green header,
//   tan/gold accent line, mini-table for items, signature boxes at the
//   bottom. Adjustments for the voucher use case: removed the "approval
//   status" section (a voucher is by definition already issued — there's
//   no pending state to surface), changed signature block to "Issued by"
//   and "Received by" rather than "QM approval" / "CO authority".
//
// jsPDF
//   We use the modern ESM import. jsPDF's text API is the smallest viable
//   surface — autoTable would be nicer for the items grid but adds another
//   ~80KB and we have <10 lines per voucher so the manual table is fine.
//
// FILENAME
//   IssueVoucher_<svcNo>_<issueDate>.pdf
//   No spaces, no special chars — works across mail attachments and Windows
//   filenames without sanitisation.
// =============================================================================

import { jsPDF } from 'jspdf';

// Page geometry — all in millimetres (jsPDF's default unit).
const PAGE = {
  W: 210, H: 297,
  MARGIN: 20,
};
PAGE.CW = PAGE.W - PAGE.MARGIN * 2;     // content width

// Colour palette mirrors the app's UI tokens for visual continuity.
// jsPDF takes RGB as separate args, so each colour is a [r, g, b] triple.
const COL = {
  armyGreen:    [59,  74,  47 ],   // header bar
  tan:          [196, 169, 107],   // accent lines, body gold
  txtDark:      [30,  30,  30 ],
  txtMuted:     [100, 100, 80 ],
  txtSub:       [140, 140, 120],
  txtLabel:     [80,  80,  60 ],
  bandFill:     [232, 228, 220],   // section header band
  rowFillEven:  [245, 243, 238],   // alternating table row
  borderLight:  [160, 160, 140],
  borderDim:    [200, 200, 190],
  prefillGrey:  [120, 120, 100],
  white:        [255, 255, 255],
};

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Generate an Issue Voucher PDF and trigger a browser download.
 *
 * @param {Array} loans   One or more loan records (must share the same
 *                        borrowerSvc + issueDate; we enforce this and throw
 *                        if they don't).
 * @param {Object} opts
 * @param {Object} opts.unit          Unit branding settings:
 *                                    { unitName, unitCode, state, qmName,
 *                                      qmRank, coName }.
 * @param {string} [opts.issuedByName] Name of the staff member running the
 *                                    issue. Defaults to the QM name from
 *                                    settings.
 * @returns {Promise<{filename: string, blob: Blob, bytes: number}>}
 *   Caller is responsible for triggering the download (e.g. via a hidden
 *   anchor + click). Keeps pdf.js DOM-free so it's testable in Node.
 */
export async function generateIssueVoucher(loans, opts = {}) {
  if (!Array.isArray(loans) || loans.length === 0) {
    throw new Error('generateIssueVoucher requires at least one loan record.');
  }
  // Sanity: all loans must share borrower + issueDate. The loans page
  // groups by these before calling us; we enforce it as a precondition
  // so misuse is loud rather than producing a confusing voucher.
  const first = loans[0];
  for (const l of loans) {
    if (l.borrowerSvc !== first.borrowerSvc) {
      throw new Error(
        `All loans on a voucher must share the same borrower. ` +
        `Got ${l.borrowerSvc} and ${first.borrowerSvc}.`);
    }
    if (l.issueDate !== first.issueDate) {
      throw new Error(
        `All loans on a voucher must share the same issueDate. ` +
        `Got ${l.issueDate} and ${first.issueDate}.`);
    }
  }

  const unit = opts.unit || {};
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let y = PAGE.MARGIN;
  y = _drawHeader(doc, y, unit);
  y = _drawReferenceBlock(doc, y, first, unit);
  y = _drawBorrowerSection(doc, y, first);
  y = _drawItemsSection(doc, y, loans);
  y = _drawDetailsSection(doc, y, first);
  y = _drawRemarksSection(doc, y, loans);
  _drawSignatureBlocks(doc, y, unit, opts.issuedByName);
  _drawFooter(doc);

  // Build filename. Sanitise borrowerSvc just in case (shouldn't have
  // spaces but defensive against future schema looseness).
  const safeSvc = String(first.borrowerSvc || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `IssueVoucher_${safeSvc}_${first.issueDate || 'undated'}.pdf`;

  // Get the bytes once; reuse the buffer for both the size report and
  // the Blob construction so we don't serialise twice.
  const buf = doc.output('arraybuffer');
  const blob = new Blob([buf], { type: 'application/pdf' });
  return { filename, blob, bytes: buf.byteLength };
}

/**
 * Convenience: trigger a browser download of a generated voucher. Uses
 * the standard hidden-anchor + click pattern. Caller passes the result
 * of generateIssueVoucher() directly.
 *
 * Lives here rather than in the loans page so future PDF types (reports,
 * roll, etc.) share the same delivery mechanism. Not used by the smoke
 * test — the test inspects the blob directly.
 */
export function downloadPdf({ filename, blob }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so Safari/older browsers have time to start the
  // download. 100ms is more than enough.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// -----------------------------------------------------------------------------
// Drawing helpers — each takes (doc, y, ...) and returns the new y cursor.
// -----------------------------------------------------------------------------

function _drawHeader(doc, y, unit) {
  // Army-green header bar with the document title in tan, subtitle below.
  doc.setFillColor(...COL.armyGreen);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 16, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COL.tan);
  doc.text('ISSUE VOUCHER', PAGE.MARGIN + 4, y + 7);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(220, 220, 200);
  // Use unit name in the subtitle if we have one; otherwise the generic
  // "AAC Unit Quartermaster" label.
  const subtitle = unit.unitName
    ? `${unit.unitName} — Q-Store`
    : 'Australian Army Cadets — Unit Quartermaster';
  doc.text(subtitle, PAGE.MARGIN + 4, y + 13);
  return y + 20;
}

function _drawReferenceBlock(doc, y, loan, unit) {
  // Reference / unit / date row + horizontal rule.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COL.txtMuted);

  // Left column: Voucher ref (the loan ref, or batch indicator if multiple)
  doc.text(`Voucher reference: ${loan.ref}`, PAGE.MARGIN, y);
  // Right column: unit code if set, else just unit name from header
  const unitLine = unit.unitCode ? `Unit code: ${unit.unitCode}` : '';
  if (unitLine) doc.text(unitLine, PAGE.MARGIN + 90, y);

  doc.text(`Issue date: ${_fmtDateAU(loan.issueDate)}`, PAGE.MARGIN, y + 5);
  doc.text(`Generated: ${_nowFmt()}`, PAGE.MARGIN + 90, y + 5);

  // Tan accent line.
  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.5);
  doc.line(PAGE.MARGIN, y + 8, PAGE.MARGIN + PAGE.CW, y + 8);
  return y + 14;
}

function _drawBorrowerSection(doc, y, loan) {
  y = _drawSectionBand(doc, y, 'Borrower');
  y = _drawLabelValueRow(doc, y, 'Name / Rank',  loan.borrowerName || '—');
  y = _drawLabelValueRow(doc, y, 'Service No.',  loan.borrowerSvc || '—');
  return y + 2;
}

function _drawItemsSection(doc, y, loans) {
  y = _drawSectionBand(doc, y, 'Items issued');

  // Mini-table. Columns: # | NSN | Nomenclature | Qty | Condition.
  // We always render the table header even for single-item vouchers so the
  // layout looks consistent and the cadet has a clear "this is what you've
  // received" grid to scan.
  const COLS = [
    { x: PAGE.MARGIN + 2,   label: '#',           w: 8  },
    { x: PAGE.MARGIN + 12,  label: 'NSN',         w: 42 },
    { x: PAGE.MARGIN + 56,  label: 'Nomenclature', w: 78 },
    { x: PAGE.MARGIN + 136, label: 'Qty',         w: 14 },
    { x: PAGE.MARGIN + 152, label: 'Condition',   w: 18 },
  ];

  // Header band.
  doc.setFillColor(180, 175, 165);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(50, 50, 40);
  for (const c of COLS) doc.text(c.label, c.x, y + 4.5);
  y += 7;

  // Rows.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  for (let i = 0; i < loans.length; i++) {
    const l = loans[i];
    if (i % 2 === 1) {
      doc.setFillColor(...COL.rowFillEven);
      doc.rect(PAGE.MARGIN, y - 1, PAGE.CW, 6, 'F');
    }
    doc.setTextColor(...COL.txtDark);
    doc.text(String(i + 1),                                     COLS[0].x, y + 3.5);
    doc.text(_fitText(doc, l.nsn || '—',     COLS[1].w),        COLS[1].x, y + 3.5);
    doc.text(_fitText(doc, l.itemName || '—', COLS[2].w),       COLS[2].x, y + 3.5);
    doc.text(String(l.qty),                                     COLS[3].x, y + 3.5);
    doc.text(_fitText(doc, l.condition || '—', COLS[4].w),      COLS[4].x, y + 3.5);
    y += 6;
  }

  // Total line — always shown so a single-item voucher and a 5-item
  // voucher have the same visual footer to the table.
  const totalQty = loans.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COL.armyGreen);
  doc.text(
    `Total: ${loans.length} ${loans.length === 1 ? 'item' : 'items'}, ${totalQty} ${totalQty === 1 ? 'unit' : 'units'}`,
    PAGE.MARGIN + PAGE.CW - 2, y + 3,
    { align: 'right' });
  return y + 8;
}

function _drawDetailsSection(doc, y, loan) {
  y = _drawSectionBand(doc, y, 'Issue details');
  y = _drawLabelValueRow(doc, y, 'Purpose',       loan.purpose || '—');
  y = _drawLabelValueRow(doc, y, 'Due back',      _fmtDateAU(loan.dueDate));
  if (loan.issuedBy) {
    y = _drawLabelValueRow(doc, y, 'Issued by (system)', loan.issuedBy);
  }
  return y + 2;
}

function _drawRemarksSection(doc, y, loans) {
  y = _drawSectionBand(doc, y, 'Remarks');
  // Use the first loan's remarks; in practice a batch shares them since
  // they're set once at the issue form. If they ever diverge we'd need
  // per-row remarks, which would mean the items-table grows a column.
  const remarks = (loans[0].remarks || '').trim();
  if (remarks) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COL.txtDark);
    const lines = doc.splitTextToSize(remarks, PAGE.CW - 4);
    doc.text(lines, PAGE.MARGIN + 2, y);
    y += lines.length * 5.5 + 2;
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...COL.txtSub);
    doc.text('(none)', PAGE.MARGIN + 2, y);
    y += 7;
  }
  return y + 4;
}

function _drawSignatureBlocks(doc, y, unit, issuedByName) {
  // Two side-by-side signature boxes: "Issued by" and "Received by".
  // If the page is too full we add a new page first — the signatures must
  // never be cut off because they're the legally meaningful part.
  const SIG_ROW_H = 28;
  const FOOTER_RESERVE = 15;
  if (y + SIG_ROW_H + FOOTER_RESERVE > PAGE.H - PAGE.MARGIN) {
    doc.addPage();
    y = PAGE.MARGIN;
  }

  const col1 = PAGE.MARGIN;
  const col2 = PAGE.MARGIN + PAGE.CW / 2 + 5;
  const sigW = PAGE.CW / 2 - 5;

  // Default issued-by prefill: explicit name override, else the QM from
  // settings. Empty string is fine — the user just leaves it blank.
  const issuedPrefill = issuedByName
    || (unit.qmRank && unit.qmName ? `${unit.qmRank} ${unit.qmName}` : (unit.qmName || ''));

  _sigBox(doc, col1, y + 4, sigW, 'ISSUED BY (Q-Store staff)', issuedPrefill);
  _sigBox(doc, col2, y + 4, sigW, 'RECEIVED BY (Borrower)',    '');
}

function _sigBox(doc, x, y, w, label, prefill) {
  // Top label.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COL.txtLabel);
  doc.text(label, x, y);

  // Pre-filled name (grey, smaller).
  if (prefill) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COL.prefillGrey);
    const lines = doc.splitTextToSize(prefill, w - 2);
    doc.text(lines, x, y + 5);
  }

  // Empty white box for the wet signature.
  doc.setDrawColor(...COL.borderLight);
  doc.setLineWidth(0.2);
  doc.setFillColor(...COL.white);
  doc.rect(x, y + 9, w, 12, 'FD');

  // Captions inside the box.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...COL.txtSub);
  doc.text('Signature', x + 1, y + 14);
  doc.text('Date:',     x + w - 20, y + 14);

  // Vertical divider between sig and date.
  doc.setDrawColor(...COL.borderDim);
  doc.line(x + w - 22, y + 9, x + w - 22, y + 21);
}

function _drawFooter(doc) {
  // Footer is always at the bottom of the LAST page. If we were forced
  // onto a second page by overflow, this draws on page 2; otherwise it's
  // page 1. Either way the user sees it after the signature blocks.
  const footerY = PAGE.H - 12;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(...COL.borderLight);
  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.3);
  doc.line(PAGE.MARGIN, footerY - 3, PAGE.MARGIN + PAGE.CW, footerY - 3);
  doc.text(
    `Generated by QStore IMS · ${_nowFmt()} · Retain in unit Q-Store records`,
    PAGE.MARGIN, footerY);
  doc.text('UNCLASSIFIED — FOR TRAINING USE ONLY',
    PAGE.MARGIN + PAGE.CW, footerY, { align: 'right' });
}

// -----------------------------------------------------------------------------
// Common drawing utilities
// -----------------------------------------------------------------------------

function _drawSectionBand(doc, y, title) {
  doc.setFillColor(...COL.bandFill);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COL.armyGreen);
  doc.text(title.toUpperCase(), PAGE.MARGIN + 2, y + 4.5);
  return y + 8;
}

function _drawLabelValueRow(doc, y, label, value) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COL.txtMuted);
  doc.text(label + ':', PAGE.MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COL.txtDark);
  const maxW = PAGE.CW - 55;
  const lines = doc.splitTextToSize(String(value || '—'), maxW);
  doc.text(lines, PAGE.MARGIN + 55, y);
  return y + lines.length * 5.5;
}

/**
 * Truncate `text` to fit width `maxMm` using jsPDF's text-measurement API.
 * Returns the original text if it fits, or a truncated version with an
 * ellipsis. Avoids the cell-overflow problem in v1's table where long
 * NSNs ran into the next column.
 */
function _fitText(doc, text, maxMm) {
  const s = String(text);
  if (doc.getTextWidth(s) <= maxMm) return s;
  // Binary trim — faster than incremental trimming for long strings, but
  // for our typical NSN/name lengths a simple loop is plenty.
  let trimmed = s;
  while (trimmed.length > 1 && doc.getTextWidth(trimmed + '…') > maxMm) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed + '…';
}

function _fmtDateAU(iso) {
  if (!iso) return '—';
  // Inputs are 'YYYY-MM-DD'. Parse manually to avoid timezone shenanigans
  // that new Date('YYYY-MM-DD') triggers (UTC midnight, can flip a day in
  // local time east of GMT).
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [_, y, mo, d] = m;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[Number(mo) - 1]} ${y}`;
}

function _fmtDateTimeAU(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return iso;
  }
}

function _nowFmt() {
  return new Date().toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// =============================================================================
// REPORTS — printable reference printouts
// =============================================================================
// Three reports below: Nominal Roll, Stock-on-Hand, Outstanding Loans.
//
// Reports differ from the voucher in tone — no signatures, no per-document
// reference number, no "retain in records" framing. They're convenience
// printouts: snapshot of state at a moment in time, intended to be marked
// up on paper or referred to during parade-night activities. The header
// is therefore visually lighter than the voucher's army-green bar.
//
// MULTI-PAGE
// Each report uses a row-layout pattern that paginates: when the y cursor
// reaches PAGE.H - PAGE.MARGIN - FOOTER_RESERVE, a new page is started
// with the same header and column row. Page number ("Page N of M") is
// printed in the footer. We compute total pages by pre-measuring the row
// count, since jsPDF doesn't have a "total pages" callback.
//
// CALLER RESPONSIBILITY
// The page (cadets.js, inventory.js, loans.js) is responsible for filtering
// and sorting the input list before calling the generator. The generator
// just lays out what it's given — no filter parameters, no sort options.
// Keeps coupling clean and means "what you see is what you print".
// =============================================================================

const REPORT_FOOTER_RESERVE = 18;   // mm at bottom of every page

/**
 * Generate a Nominal Roll PDF — list of cadets with rank, name, svcNo, plt.
 *
 * @param {Array} cadets — pre-filtered, pre-sorted list (caller controls).
 * @param {Object} opts
 * @param {Object} opts.unit          Unit branding from Storage.settings.
 * @param {string} [opts.subtitle]    Extra context line in the header
 *                                    (e.g. "Active only" / "Plt 1 only").
 * @returns {{filename, blob, bytes}}
 */
export async function generateNominalRoll(cadets, opts = {}) {
  const unit = opts.unit || {};
  const subtitle = opts.subtitle || '';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Layout: 5 columns. Widths sum to PAGE.CW.
  const COLS = [
    { x: PAGE.MARGIN + 2,   w: 28,  label: 'Rank',        get: (c) => c.rank || '' },
    { x: PAGE.MARGIN + 32,  w: 50,  label: 'Surname',     get: (c) => c.surname || '' },
    { x: PAGE.MARGIN + 84,  w: 50,  label: 'Given names', get: (c) => c.given || '' },
    { x: PAGE.MARGIN + 136, w: 24,  label: 'Service No.', get: (c) => c.svcNo || '' },
    { x: PAGE.MARGIN + 162, w: 12,  label: 'Plt',         get: (c) => c.plt || '' },
  ];

  const meta = `${cadets.length} ${cadets.length === 1 ? 'person' : 'people'}` +
               (subtitle ? ` · ${subtitle}` : '');
  _renderTabularReport(doc, {
    title:    'NOMINAL ROLL',
    subtitle: meta,
    unit,
    columns:  COLS,
    rows:     cadets,
    rowDecorate(c) {
      // Inactive rows are shown in muted grey so paper-mark-up can use
      // them as a "still on books but not active" reference.
      return c.active === false
        ? { textColor: COL.txtSub, fontStyle: 'italic' }
        : null;
    },
  });

  const filename = `NominalRoll_${_unitSlug(unit)}_${_todayIsoDate()}.pdf`;
  return _packageResult(doc, filename);
}

/**
 * Generate a Stock-on-Hand PDF — inventory with onHand / onLoan / unsvc /
 * authQty per item. Useful for stocktake reconciliation.
 */
export async function generateStockReport(items, opts = {}) {
  const unit = opts.unit || {};
  const subtitle = opts.subtitle || '';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Compute "available" inline so the column shows what the QM cares about.
  const COLS = [
    { x: PAGE.MARGIN + 2,   w: 30, label: 'NSN',       get: (i) => i.nsn || '' },
    { x: PAGE.MARGIN + 34,  w: 46, label: 'Item',      get: (i) => i.name || '' },
    { x: PAGE.MARGIN + 82,  w: 24, label: 'Cat.',      get: (i) => i.cat || '' },
    { x: PAGE.MARGIN + 108, w: 14, label: 'On hand',   get: (i) => String(i.onHand || 0), align: 'right' },
    { x: PAGE.MARGIN + 124, w: 14, label: 'On loan',   get: (i) => String(i.onLoan || 0), align: 'right' },
    { x: PAGE.MARGIN + 140, w: 14, label: 'Unsvc',     get: (i) => String(i.unsvc  || 0), align: 'right' },
    { x: PAGE.MARGIN + 156, w: 14, label: 'Avail.',    get: (i) => String(Math.max(0, (Number(i.onHand)||0) - (Number(i.onLoan)||0))), align: 'right' },
  ];

  const totalOnHand = items.reduce((s, i) => s + (Number(i.onHand) || 0), 0);
  const totalOnLoan = items.reduce((s, i) => s + (Number(i.onLoan) || 0), 0);
  const meta = `${items.length} ${items.length === 1 ? 'line' : 'lines'} · ` +
               `${totalOnHand} units on hand, ${totalOnLoan} on loan` +
               (subtitle ? ` · ${subtitle}` : '');

  _renderTabularReport(doc, {
    title:    'STOCK-ON-HAND REPORT',
    subtitle: meta,
    unit,
    columns:  COLS,
    rows:     items,
    rowDecorate(i) {
      // Highlight items that are entirely or substantially unserviceable
      // for visual scan during a stocktake.
      const onHand = Number(i.onHand) || 0;
      const unsvc  = Number(i.unsvc)  || 0;
      if (onHand > 0 && unsvc / onHand >= 0.5) {
        return { textColor: [180, 30, 30], rowFill: [255, 230, 230], fontStyle: 'bold' };
      }
      return null;
    },
  });

  const filename = `StockReport_${_unitSlug(unit)}_${_todayIsoDate()}.pdf`;
  return _packageResult(doc, filename);
}

/**
 * Generate an Outstanding Loans PDF — active loans only. Sorted by due
 * date ascending so the most overdue float to the top. Overdue rows are
 * visually marked with a red bar in the leftmost column.
 */
export async function generateOutstandingLoansReport(loans, opts = {}) {
  const unit = opts.unit || {};
  const subtitle = opts.subtitle || '';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const todayIso = _todayIsoDate();

  const COLS = [
    { x: PAGE.MARGIN + 2,   w: 22, label: 'Ref',        get: (l) => l.ref || '' },
    { x: PAGE.MARGIN + 26,  w: 26, label: 'Issued',     get: (l) => l.issueDate || '' },
    { x: PAGE.MARGIN + 54,  w: 24, label: 'Due',        get: (l) => l.dueDate   || '' },
    { x: PAGE.MARGIN + 80,  w: 50, label: 'Item',       get: (l) => l.itemName  || '' },
    { x: PAGE.MARGIN + 132, w: 10, label: 'Qty',        get: (l) => String(l.qty || 0), align: 'right' },
    { x: PAGE.MARGIN + 144, w: 26, label: 'Borrower',   get: (l) => l.borrowerName || '' },
  ];

  const overdueCount = loans.filter((l) =>
    l.dueDate && l.dueDate < todayIso).length;
  const meta = `${loans.length} active ${loans.length === 1 ? 'loan' : 'loans'}` +
               (overdueCount > 0 ? ` · ${overdueCount} OVERDUE` : '') +
               (subtitle ? ` · ${subtitle}` : '');

  _renderTabularReport(doc, {
    title:    'OUTSTANDING LOANS',
    subtitle: meta,
    unit,
    columns:  COLS,
    rows:     loans,
    rowDecorate(l) {
      const overdue = l.dueDate && l.dueDate < todayIso;
      return overdue
        ? { rowFill: [255, 230, 230], textColor: [180, 30, 30], fontStyle: 'bold' }
        : null;
    },
  });

  const filename = `OutstandingLoans_${_unitSlug(unit)}_${_todayIsoDate()}.pdf`;
  return _packageResult(doc, filename);
}

/**
 * Generate a Stocktake report PDF. Called by the stocktake page after
 * finalisation. Includes count vs system, variance (highlighted by
 * direction), per-row notes, and signature blocks for QM and CO.
 *
 * @param {Object} session
 *   { finalisedAt, finalisedBy,
 *     rows: [{ item, stk, variance }],
 *     counts: { total, match, over, short } }
 */
export async function generateStocktakeReport(session, opts = {}) {
  const unit = opts.unit || {};
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const { rows, counts, finalisedAt, finalisedBy } = session;

  const COLS = [
    { x: PAGE.MARGIN + 2,   w: 28, label: 'NSN',      get: (r) => r.item.nsn || '' },
    { x: PAGE.MARGIN + 32,  w: 56, label: 'Item',     get: (r) => r.item.name || '' },
    { x: PAGE.MARGIN + 90,  w: 14, label: 'System',   get: (r) => String(r.item.onHand || 0), align: 'right' },
    { x: PAGE.MARGIN + 106, w: 14, label: 'Counted',  get: (r) => String(r.stk.counted),       align: 'right' },
    { x: PAGE.MARGIN + 122, w: 14, label: 'Var.',     get: (r) => (r.variance >= 0 ? '+' : '') + r.variance, align: 'right' },
    { x: PAGE.MARGIN + 138, w: 32, label: 'Notes',    get: (r) => r.stk.notes || '' },
  ];

  const subtitle = `${counts.total} counted · ${counts.match} match, ${counts.over} over, ${counts.short} short` +
                   ` · finalised ${_fmtDateTimeAU(finalisedAt)} by ${finalisedBy}`;

  _renderTabularReport(doc, {
    title:    'STOCKTAKE REPORT',
    subtitle,
    unit,
    columns:  COLS,
    rows,
    rowDecorate(r) {
      // Highlight rows with variance — short = red, over = amber. Matches
      // are unhighlighted (the bulk of any normal stocktake).
      if (r.variance < 0) {
        return { rowFill: [255, 230, 230], textColor: [180, 30, 30], fontStyle: 'bold' };
      }
      if (r.variance > 0) {
        return { rowFill: [255, 245, 220], textColor: [180, 130, 30], fontStyle: 'bold' };
      }
      return null;
    },
  });

  // Signature block — QM (verifier) and CO (authoriser). The stocktake
  // report's audit purpose makes signed approval meaningful, unlike the
  // other reports where it's just a printout.
  // We need the y cursor after the table — the shared renderer doesn't
  // expose one, so we approximate by adding to the last page.
  const lastPage = doc.internal.getNumberOfPages();
  doc.setPage(lastPage);

  const sigY = PAGE.H - PAGE.MARGIN - 35;
  // Only draw signatures if there's room above the footer; otherwise
  // start a new page. The shared report footer reserves 18mm; we want
  // ~30mm for signatures. If the last row sits in that zone, force a
  // new page.
  // Conservative approach: always add a fresh signature page. Better to
  // have a clean signature page than to crowd the table footer.
  doc.addPage();
  _drawReportHeader(doc, PAGE.MARGIN, 'STOCKTAKE REPORT — SIGNATURES', subtitle, unit);

  let y = PAGE.MARGIN + 24;
  _sigBox(doc, PAGE.MARGIN,                 y, PAGE.CW / 2 - 5,
    'COUNTED BY (QM)',  finalisedBy);
  _sigBox(doc, PAGE.MARGIN + PAGE.CW / 2 + 5, y, PAGE.CW / 2 - 5,
    'AUTHORISED BY (CO)', unit.coName || '');

  // Footer — same shape as the rest of the report.
  // We need to fix up the page count footer for this last page too.
  // _renderTabularReport already wrote footers for pages 1..N (the table
  // pages); we just added one more page so it has no footer yet. The
  // simple fix: write a "signed page" footer that doesn't fight with
  // the page-of-page counter.
  const footerY = PAGE.H - 10;
  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.3);
  doc.line(PAGE.MARGIN, footerY - 4, PAGE.MARGIN + PAGE.CW, footerY - 4);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(...COL.borderLight);
  doc.text('Generated by QStore IMS', PAGE.MARGIN, footerY);
  doc.text('Signature page', PAGE.MARGIN + PAGE.CW / 2, footerY, { align: 'center' });
  doc.text('UNCLASSIFIED — FOR TRAINING USE ONLY',
    PAGE.MARGIN + PAGE.CW, footerY, { align: 'right' });

  const filename = `Stocktake_${_unitSlug(unit)}_${_todayIsoDate()}.pdf`;
  return _packageResult(doc, filename);
}

// =============================================================================
// AB189 — EQUIPMENT REQUEST FORM
// =============================================================================
// Pre-issue request form: cadet fills it, QM and OC/CO sign before issue.
// Because the self-service request flow (pendingRequests) is v2.2, in
// practice this form is generated from an existing loan record which captures
// the same data. The form's "request date" maps to the loan's issueDate;
// "required by" maps to dueDate.
//
// Structural differences from the Issue Voucher:
//   - Items table: # | NSN | Nomenclature | Qty (no Condition — requesting,
//     not recording receipt state)
//   - Requestor section: includes platoon + given names when cadet record is
//     available
//   - Signature blocks: QM APPROVAL (left) + OC AUTHORITY (right)
//   - No "Issued by (system)" field — this is a paper artefact
//   - Same-borrower precondition enforced; same-date NOT required (you can
//     batch loans across dates for an omnibus request if needed)
// =============================================================================

/**
 * Generate an AB189 Equipment Request Form PDF.
 *
 * @param {Array} loans   One or more loan records. Must share the same
 *                        borrowerSvc; throws otherwise.
 * @param {Object} opts
 * @param {Object} opts.unit    Unit branding settings.
 * @param {Object} [opts.cadet] Full cadet record (for platoon, given names).
 *                              If omitted, falls back to loan denormalised fields.
 * @returns {Promise<{filename: string, blob: Blob, bytes: number}>}
 */
export async function generateAB189(loans, opts = {}) {
  if (!Array.isArray(loans) || loans.length === 0) {
    throw new Error('generateAB189 requires at least one loan record.');
  }
  const first = loans[0];
  for (const l of loans) {
    if (l.borrowerSvc !== first.borrowerSvc) {
      throw new Error(
        `All loans on an AB189 must share the same borrower. ` +
        `Got ${l.borrowerSvc} and ${first.borrowerSvc}.`);
    }
  }

  const unit  = opts.unit  || {};
  const cadet = opts.cadet || null;
  const doc   = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let y = PAGE.MARGIN;
  y = _drawAB189Header(doc, y, unit);
  y = _drawAB189RequestBlock(doc, y, first, unit);
  y = _drawAB189RequestorSection(doc, y, first, cadet);
  y = _drawAB189ItemsSection(doc, y, loans);
  y = _drawAB189PurposeSection(doc, y, first, loans);
  _drawAB189ApprovalBlocks(doc, y, unit);
  _drawFooter(doc);

  const safeSvc  = String(first.borrowerSvc || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dateStr  = first.issueDate || _todayIsoDate();
  const filename = `AB189_${safeSvc}_${dateStr}.pdf`;
  return _packageResult(doc, filename);
}

// AB189 drawing helpers -------------------------------------------------------

function _drawAB189Header(doc, y, unit) {
  // Same army-green bar as the Issue Voucher; "AB 189" right-aligned in bar.
  doc.setFillColor(...COL.armyGreen);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 16, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COL.tan);
  doc.text('EQUIPMENT REQUEST', PAGE.MARGIN + 4, y + 7);

  doc.setFontSize(11);
  doc.text('AB 189', PAGE.MARGIN + PAGE.CW - 4, y + 7, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(220, 220, 200);
  const subtitle = unit.unitName
    ? `${unit.unitName} — Q-Store`
    : 'Australian Army Cadets — Unit Quartermaster';
  doc.text(subtitle, PAGE.MARGIN + 4, y + 13);
  return y + 20;
}

function _drawAB189RequestBlock(doc, y, loan, unit) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COL.txtMuted);

  doc.text(`Request date: ${_fmtDateAU(loan.issueDate)}`, PAGE.MARGIN, y);
  const unitLine = unit.unitCode ? `Unit code: ${unit.unitCode}` : '';
  if (unitLine) doc.text(unitLine, PAGE.MARGIN + 90, y);

  // Show the loan ref at smaller size so the paper form can be cross-referenced
  // to the system record. Omitted when the AB189 is generated before issue
  // (v2.2 self-service flow — at that point loan.ref won't exist yet).
  if (loan.ref) {
    doc.setFontSize(8);
    doc.setTextColor(...COL.txtSub);
    doc.text(`Loan ref: ${loan.ref}`, PAGE.MARGIN, y + 5);
  }
  doc.setFontSize(8);
  doc.setTextColor(...COL.txtSub);
  doc.text(`Generated: ${_nowFmt()}`, PAGE.MARGIN + 90, y + 5);

  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.5);
  doc.line(PAGE.MARGIN, y + 8, PAGE.MARGIN + PAGE.CW, y + 8);
  return y + 14;
}

function _drawAB189RequestorSection(doc, y, loan, cadet) {
  y = _drawSectionBand(doc, y, 'Requesting member');
  y = _drawLabelValueRow(doc, y, 'Rank / Name',  loan.borrowerName || '—');
  if (cadet?.given) {
    y = _drawLabelValueRow(doc, y, 'Given names', cadet.given);
  }
  y = _drawLabelValueRow(doc, y, 'Service No.',  loan.borrowerSvc || '—');
  if (cadet?.plt) {
    y = _drawLabelValueRow(doc, y, 'Platoon',     cadet.plt);
  }
  return y + 2;
}

function _drawAB189ItemsSection(doc, y, loans) {
  y = _drawSectionBand(doc, y, 'Equipment requested');

  // Four columns: # | NSN | Nomenclature | Qty.
  // No Condition column (we're requesting, not recording receipt state).
  const COLS = [
    { x: PAGE.MARGIN + 2,   label: '#',            w: 8,  align: 'left'  },
    { x: PAGE.MARGIN + 12,  label: 'NSN',          w: 42, align: 'left'  },
    { x: PAGE.MARGIN + 56,  label: 'Nomenclature', w: 96, align: 'left'  },
    { x: PAGE.MARGIN + 154, label: 'Qty',          w: 14, align: 'right' },
  ];

  doc.setFillColor(180, 175, 165);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(50, 50, 40);
  for (const c of COLS) {
    const tx = c.align === 'right' ? c.x + c.w - 1 : c.x;
    doc.text(c.label, tx, y + 4.5, c.align === 'right' ? { align: 'right' } : undefined);
  }
  y += 7;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  for (let i = 0; i < loans.length; i++) {
    const l = loans[i];
    if (i % 2 === 1) {
      doc.setFillColor(...COL.rowFillEven);
      doc.rect(PAGE.MARGIN, y - 1, PAGE.CW, 6, 'F');
    }
    doc.setTextColor(...COL.txtDark);
    doc.text(String(i + 1),                                  COLS[0].x, y + 3.5);
    doc.text(_fitText(doc, l.nsn || '—',     COLS[1].w),    COLS[1].x, y + 3.5);
    doc.text(_fitText(doc, l.itemName || '—', COLS[2].w),   COLS[2].x, y + 3.5);
    doc.text(String(l.qty), COLS[3].x + COLS[3].w - 1, y + 3.5, { align: 'right' });
    y += 6;
  }

  const totalQty = loans.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COL.armyGreen);
  doc.text(
    `Total: ${loans.length} ${loans.length === 1 ? 'line' : 'lines'}, ${totalQty} ${totalQty === 1 ? 'unit' : 'units'}`,
    PAGE.MARGIN + PAGE.CW - 2, y + 3, { align: 'right' });
  return y + 8;
}

function _drawAB189PurposeSection(doc, y, first, loans) {
  y = _drawSectionBand(doc, y, 'Purpose and details');
  y = _drawLabelValueRow(doc, y, 'Purpose',     first.purpose || '—');
  y = _drawLabelValueRow(doc, y, 'Required by', _fmtDateAU(first.dueDate));
  const remarks = (loans[0].remarks || '').trim();
  if (remarks) {
    y = _drawLabelValueRow(doc, y, 'Remarks', remarks);
  }
  return y + 4;
}

function _drawAB189ApprovalBlocks(doc, y, unit) {
  const SIG_ROW_H = 28;
  const FOOTER_RESERVE = 15;
  if (y + SIG_ROW_H + FOOTER_RESERVE > PAGE.H - PAGE.MARGIN) {
    doc.addPage();
    y = PAGE.MARGIN;
  }

  const col1 = PAGE.MARGIN;
  const col2 = PAGE.MARGIN + PAGE.CW / 2 + 5;
  const sigW  = PAGE.CW / 2 - 5;

  const qmPrefill = unit.qmRank && unit.qmName
    ? `${unit.qmRank} ${unit.qmName}`
    : (unit.qmName || '');

  _sigBox(doc, col1, y + 4, sigW, 'QM APPROVAL',  qmPrefill);
  _sigBox(doc, col2, y + 4, sigW, 'OC AUTHORITY', unit.coName || '');
}

// -----------------------------------------------------------------------------
// Shared report renderer — header, paginated table body, footer.
// -----------------------------------------------------------------------------
// Takes a normalised spec: { title, subtitle, unit, columns, rows,
// rowDecorate? }. Each column has { x, w, label, get(row), align? }.
// rowDecorate, if present, is called per row and may return
// { rowFill, textColor, fontStyle } overrides for that row.
//
// Pagination logic: maintain a running y cursor; when adding a row would
// push y past the bottom margin (less the footer reserve), call addPage,
// reset y to top, redraw header + column row.

function _renderTabularReport(doc, spec) {
  const { title, subtitle, unit, columns, rows, rowDecorate } = spec;

  // First page header.
  let y = _drawReportHeader(doc, PAGE.MARGIN, title, subtitle, unit);
  y = _drawColumnHeader(doc, y, columns);

  const ROW_H = 6;  // mm per row — must match what _drawRow uses
  const usableBottom = PAGE.H - PAGE.MARGIN - REPORT_FOOTER_RESERVE;

  let pageNum = 1;
  for (let i = 0; i < rows.length; i++) {
    if (y + ROW_H > usableBottom) {
      // Footer for this page first (before paging) — we'll fix up the
      // total page count at the end via a second pass.
      _drawReportFooter(doc, pageNum, null);
      doc.addPage();
      pageNum++;
      y = _drawReportHeader(doc, PAGE.MARGIN, title, subtitle, unit);
      y = _drawColumnHeader(doc, y, columns);
    }
    const decoration = rowDecorate ? rowDecorate(rows[i]) : null;
    _drawRow(doc, y, columns, rows[i], i, decoration);
    y += ROW_H;
  }

  // Footer for the final page.
  _drawReportFooter(doc, pageNum, null);

  // Second pass: now we know the total page count; rewrite each page's
  // footer with "Page N of M". jsPDF's setPage() makes this clean.
  const totalPages = pageNum;
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    // Erase the previous footer area with a white rect (cheap clear), then
    // redraw with the proper count.
    doc.setFillColor(255, 255, 255);
    doc.rect(PAGE.MARGIN, PAGE.H - REPORT_FOOTER_RESERVE,
             PAGE.CW, REPORT_FOOTER_RESERVE - 2, 'F');
    _drawReportFooter(doc, p, totalPages);
  }
}

function _drawReportHeader(doc, y, title, subtitle, unit) {
  // Lighter than the voucher header — a thin gold rule + heading text.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...COL.armyGreen);
  doc.text(title, PAGE.MARGIN, y + 4);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COL.txtMuted);
  // Right-aligned unit identifier in the header line.
  const unitId = [unit.unitName, unit.unitCode].filter(Boolean).join(' · ') || '—';
  doc.text(unitId, PAGE.MARGIN + PAGE.CW, y + 4, { align: 'right' });

  // Subtitle row (count, filters, etc.) and generation timestamp.
  if (subtitle) {
    doc.setFontSize(8);
    doc.setTextColor(...COL.txtSub);
    doc.text(subtitle, PAGE.MARGIN, y + 9);
  }
  doc.setFontSize(8);
  doc.setTextColor(...COL.txtSub);
  doc.text(`Generated: ${_nowFmt()}`,
    PAGE.MARGIN + PAGE.CW, y + 9, { align: 'right' });

  // Tan rule.
  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.5);
  doc.line(PAGE.MARGIN, y + 12, PAGE.MARGIN + PAGE.CW, y + 12);

  return y + 16;
}

function _drawColumnHeader(doc, y, columns) {
  // Grey band with column labels.
  doc.setFillColor(...COL.bandFill);
  doc.rect(PAGE.MARGIN, y, PAGE.CW, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COL.armyGreen);
  for (const c of columns) {
    const tx = c.align === 'right' ? c.x + c.w - 1 : c.x;
    doc.text(c.label, tx, y + 4.5, c.align === 'right' ? { align: 'right' } : undefined);
  }
  return y + 7;
}

function _drawRow(doc, y, columns, row, index, decoration) {
  // Alternating row stripe for readability.
  if (decoration?.rowFill) {
    doc.setFillColor(...decoration.rowFill);
    doc.rect(PAGE.MARGIN, y - 1, PAGE.CW, 6, 'F');
  } else if (index % 2 === 1) {
    doc.setFillColor(...COL.rowFillEven);
    doc.rect(PAGE.MARGIN, y - 1, PAGE.CW, 6, 'F');
  }

  const fontStyle = decoration?.fontStyle || 'normal';
  const textColor = decoration?.textColor || COL.txtDark;

  doc.setFont('helvetica', fontStyle);
  doc.setFontSize(8);
  doc.setTextColor(...textColor);

  for (const c of columns) {
    const raw = c.get(row);
    const text = _fitText(doc, raw, c.w - 1);
    const tx = c.align === 'right' ? c.x + c.w - 1 : c.x;
    doc.text(text, tx, y + 3.5, c.align === 'right' ? { align: 'right' } : undefined);
  }
}

function _drawReportFooter(doc, pageNum, totalPages) {
  const footerY = PAGE.H - 10;
  doc.setDrawColor(...COL.tan);
  doc.setLineWidth(0.3);
  doc.line(PAGE.MARGIN, footerY - 4, PAGE.MARGIN + PAGE.CW, footerY - 4);

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7);
  doc.setTextColor(...COL.borderLight);

  doc.text('Generated by QStore IMS', PAGE.MARGIN, footerY);

  // Centre: page number.
  const pageStr = totalPages != null
    ? `Page ${pageNum} of ${totalPages}`
    : `Page ${pageNum}`;
  doc.text(pageStr, PAGE.MARGIN + PAGE.CW / 2, footerY, { align: 'center' });

  // Right: classification reminder, same as voucher.
  doc.text('UNCLASSIFIED — FOR TRAINING USE ONLY',
    PAGE.MARGIN + PAGE.CW, footerY, { align: 'right' });
}

// -----------------------------------------------------------------------------
// Result packaging — common to all generators.
// -----------------------------------------------------------------------------

function _packageResult(doc, filename) {
  const buf = doc.output('arraybuffer');
  const blob = new Blob([buf], { type: 'application/pdf' });
  return { filename, blob, bytes: buf.byteLength };
}

function _todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _unitSlug(unit) {
  // Filename-safe slug derived from unit code or name. Lowercased, all
  // non-alphanumerics become underscores, multiple underscores collapsed.
  const raw = unit.unitCode || unit.unitName || 'unit';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unit';
}
