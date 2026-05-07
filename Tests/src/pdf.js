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

function _nowFmt() {
  return new Date().toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
