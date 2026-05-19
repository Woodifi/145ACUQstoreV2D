// =============================================================================
// QStore IMS v2 — AAC QStore Order PDF Parser
// =============================================================================
// Parses AAC QStore supply order PDFs.
//
// Uses pdfjs-dist in FakeWorker (main-thread) mode for single-file bundle
// compatibility. The worker is bundled alongside the main script and exposed
// via globalThis.pdfjsWorker so pdfjs detects it and never spawns a real
// Web Worker.
//
// Exported API:
//   parseOrderPdf(arrayBuffer) → Promise<ParsedOrder>
//
// ParsedOrder schema:
//   {
//     orderId:        string   "21922"
//     orderCategory:  string   "uniform" | "equipment" | "general"
//     docType:        string   "request" | "issue"
//     orderStatus:    string   raw status from PDF
//     date:           string   ISO "2026-04-05" (from Last modified footer)
//     dateRaw:        string   "05 Apr 2026 12:17:01"
//     requestorName:  string   "Scales, Sean"
//     requestorRank:  string   "LT(AAC)"
//     requestorSvcNo: string   "2444075"
//     unit:           string   "145 ACU Moranbah Community"
//     items:          Array    [{nsn, description, qtyRequired, qtyRequisitioned, qtyReceived}]
//     rawText:        string   full extracted text (for debugging)
//   }
// =============================================================================

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// Expose the worker handler in the main thread.
// pdfjs checks globalThis.pdfjsWorker?.WorkerMessageHandler and, if present,
// skips spawning a real Worker and uses it directly (FakeWorker mode).
// This makes pdfjs safe in a single-file bundle where there is no separate
// worker script URL.
if (!globalThis.pdfjsWorker) {
  globalThis.pdfjsWorker = { WorkerMessageHandler };
}
// Set workerSrc to a non-empty string — the static getter throws if it is
// empty. The value is never actually used because FakeWorker takes effect
// before any URL is fetched.
pdfjsLib.GlobalWorkerOptions.workerSrc = '_pdfjs_fakeworker_';

// -----------------------------------------------------------------------------
// Month map for parsing "05 Apr 2026 12:17:01"
// -----------------------------------------------------------------------------

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function _parseDateRaw(raw) {
  // "05 Apr 2026 12:17:01"
  const m = raw.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return '';
  const [, dd, mon, yyyy] = m;
  const mm = MONTH_MAP[mon.toLowerCase()] || '01';
  return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
}

// -----------------------------------------------------------------------------
// PDF text extraction
// -----------------------------------------------------------------------------

async function _extractTextItems(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const allItems = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page     = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content  = await page.getTextContent();

    const pageHeight = viewport.height;

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = item.transform;
      // tx[4] = x, tx[5] = y (from bottom-left in PDF coords)
      // Convert to top-down: y_top = pageHeight - y_pdf
      const x    = Math.round(tx[4]);
      const yPdf = Math.round(tx[5]);
      const y    = Math.round(pageHeight - yPdf);
      allItems.push({ str: item.str.trim(), x, y, page: p });
    }
  }

  return allItems;
}

// -----------------------------------------------------------------------------
// Row grouping: cluster text items into rows by Y coordinate
// -----------------------------------------------------------------------------

function _groupIntoRows(items, yTolerance = 5) {
  // Sort by page then y then x
  const sorted = [...items].sort((a, b) =>
    a.page !== b.page ? a.page - b.page : a.y !== b.y ? a.y - b.y : a.x - b.x
  );

  const rows = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= yTolerance) {
      last.items.push(item);
      last.y = Math.round((last.y * last.items.length + item.y) / (last.items.length + 1));
    } else {
      rows.push({ y: item.y, page: item.page, items: [item] });
    }
  }

  // Sort items within each row by x
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.text = row.items.map(i => i.str).join(' ');
  }

  return rows;
}

// -----------------------------------------------------------------------------
// Column assignment using detected header positions
// -----------------------------------------------------------------------------

// Column header patterns — ordered from most-specific to least-specific so
// the correct key wins when a single header item is tested against all patterns.
// "Qty Received"      → qtyReceived   (contains "rec")
// "Qty Req'd" / "Qty Requisitioned" → qtyRequisitioned  (has 'd/'d/uisitioned suffix)
// "Qty Required" / "QtyReq"          → qtyRequired       (ends at "req" or "required")
const HEADER_PATTERNS = [
  { key: 'nsn',               re: /^NSN$/i },
  { key: 'description',       re: /^Description$/i },
  { key: 'qtyReceived',       re: /qty.*rec/i },
  { key: 'qtyRequisitioned',  re: /qty.*req(?:uisitioned|'?d|d)\b/i },
  { key: 'qtyRequired',       re: /qty.*req(?:uired)?\.?\s*$/i },
];

function _detectColumnBoundaries(headerRow) {
  const cols = {};
  // Process in reverse pattern order so the most-specific match for each item wins.
  for (const { key, re } of [...HEADER_PATTERNS].reverse()) {
    for (const item of headerRow.items) {
      if (re.test(item.str)) {
        cols[key] = { x: item.x };
      }
    }
  }
  return cols;
}

// Unused but kept for potential future use
function _assignToColumn(item, cols) {
  const colKeys = Object.keys(cols);
  if (colKeys.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const key of colKeys) {
    const dist = Math.abs(item.x - cols[key].x);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

// -----------------------------------------------------------------------------
// NSN helpers
// -----------------------------------------------------------------------------

const NSN_RE = /^\d{4}-\d{2}-\d{3}-\d{4}$/;
function _isNsn(str) { return NSN_RE.test(str.trim()); }

/**
 * Attempt to normalise common OCR / copy-paste artefacts in NSN strings:
 *   en/em-dashes → hyphen, internal spaces removed, doubled dashes collapsed.
 *   Capital-O → zero when that produces a valid NSN.
 * Returns the cleaned string; falls back to the raw input if still invalid.
 */
function _normalizeNsn(raw) {
  if (!raw) return raw;
  let s = raw.trim()
    .replace(/[–—]/g, '-')   // en/em-dash → ASCII hyphen
    .replace(/\s+/g, '')      // remove spaces within the NSN
    .replace(/-{2,}/g, '-');  // collapse doubled dashes
  if (!NSN_RE.test(s)) {
    const swapped = s.replace(/O/g, '0').replace(/l/g, '1');
    if (NSN_RE.test(swapped)) return swapped;
  }
  return s;
}

/**
 * Return true if str is a valid quantity cell: pure integer digits, or a
 * dash placeholder (--  -  –  —).  Returns true for empty/null (= no value).
 * Returns FALSE for mixed strings like "10R", "SIZE 10", "S/M" so those
 * stay in the description column instead of being misread as quantities.
 */
function _isPlainQty(str) {
  if (!str) return true;
  const s = str.trim();
  return /^\d+$/.test(s) || /^[-–—]+$/.test(s);
}

// -----------------------------------------------------------------------------
// Main parser
// -----------------------------------------------------------------------------

/**
 * Parse an AAC QStore order PDF.
 *
 * @param {ArrayBuffer} arrayBuffer  — The PDF file data.
 * @returns {Promise<ParsedOrder>}
 */
export async function parseOrderPdf(arrayBuffer) {
  const items = await _extractTextItems(arrayBuffer);
  const rows  = _groupIntoRows(items);
  const rawText = rows.map(r => r.text).join('\n');

  const result = {
    orderId:        '',
    orderCategory:  'general',
    docType:        'request',
    orderStatus:    '',
    date:           '',
    dateRaw:        '',
    requestorName:  '',
    requestorRank:  '',
    requestorSvcNo: '',
    unit:           '',
    items:          [],
    rawText,
  };

  // ── Metadata extraction (regex on full text) ─────────────────────────────

  // Order category from title (first non-empty row or "Uniform order" style)
  const titleRow = rows.find(r => /order$/i.test(r.text.trim()));
  if (titleRow) {
    const titleText = titleRow.text.trim().toLowerCase();
    if (titleText.includes('uniform'))   result.orderCategory = 'uniform';
    else if (titleText.includes('equip')) result.orderCategory = 'equipment';
    else                                  result.orderCategory = 'general';
  }

  // Order Id
  const orderIdMatch = rawText.match(/Order\s+Id[:\s]+(\d+)/i);
  if (orderIdMatch) result.orderId = orderIdMatch[1].trim();

  // Order status → docType
  const statusMatch = rawText.match(/Order\s+status[:\s]+([^\n]+)/i);
  if (statusMatch) {
    result.orderStatus = statusMatch[1].trim();
    const st = result.orderStatus.toLowerCase();
    if (st.includes('dispatch') || st.includes('issued') || st.includes('complete')) {
      result.docType = 'issue';
    } else {
      result.docType = 'request';
    }
  }

  // Created by / requestor — "Scales, Sean LT(AAC)" or "LT(AAC) Sean Scales"
  const createdByMatch = rawText.match(/Created\s+by[:\s]+([^\n]+)/i);
  if (createdByMatch) {
    const raw = createdByMatch[1].trim();
    // Pattern 1: "Surname, Given RANK" e.g. "Scales, Sean LT(AAC)"
    const p1 = raw.match(/^([^,]+,\s*[^A-Z(]+?)\s+([A-Z]+(?:\([A-Z]+\))?)\s*$/);
    // Pattern 2: "RANK Given Surname" e.g. "LT(AAC) Sean Scales"
    const p2 = raw.match(/^([A-Z]+(?:\([A-Z]+\))?)\s+(.+)$/);
    if (p1) {
      result.requestorName = p1[1].trim();
      result.requestorRank = p1[2].trim();
    } else if (p2) {
      result.requestorRank = p2[1].trim();
      result.requestorName = p2[2].trim();
    } else {
      result.requestorName = raw;
    }
  }

  // Unit
  const unitMatch = rawText.match(/Unit[:\s]+([^\n]+)/i);
  if (unitMatch) result.unit = unitMatch[1].trim();

  // Last modified date + service number from footer
  // "Last modified on 05 Apr 2026 12:17:01 by LT(AAC) Sean Scales - 2444075"
  const footerMatch = rawText.match(
    /Last\s+modified\s+on\s+([\d]{1,2}\s+[A-Za-z]{3}\s+\d{4}[^\n]*?)(?:\s+by\s+([^\n-]+?)(?:\s*-\s*(\d{5,}))?)?$/im
  );
  if (footerMatch) {
    result.dateRaw = footerMatch[1].trim();
    result.date    = _parseDateRaw(result.dateRaw);
    if (footerMatch[3]) result.requestorSvcNo = footerMatch[3].trim();
    // If requestorName not yet set, parse from footer "by" field
    if (!result.requestorName && footerMatch[2]) {
      const byPart = footerMatch[2].trim();
      const p2 = byPart.match(/^([A-Z]+(?:\([A-Z]+\))?)\s+(.+)$/);
      if (p2) {
        result.requestorRank = p2[1].trim();
        result.requestorName = p2[2].trim();
      } else {
        result.requestorName = byPart;
      }
    }
  }

  // ── Table parsing ─────────────────────────────────────────────────────────

  // Find header row by scanning for a row that contains "NSN" and "Description"
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].text;
    if (/\bNSN\b/i.test(t) && /Description/i.test(t)) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx >= 0) {
    const headerRow = rows[headerRowIdx];
    const cols      = _detectColumnBoundaries(headerRow);

    // Collect column x-positions to build simple bucket assignment
    // Strategy: sort header items by x, assign bucket ranges
    const headerItems = headerRow.items.slice().sort((a, b) => a.x - b.x);
    // Map header item index → column key
    const colKeys = ['nsn', 'description', 'qtyRequired', 'qtyRequisitioned', 'qtyReceived'];
    // x midpoints for each detected column
    const xMids = headerItems
      .filter(it => /NSN|Description|Qty/i.test(it.str))
      .map(it => it.x);

    // Process data rows after the header
    let currentItem = null;
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const rowItems = row.items.sort((a, b) => a.x - b.x);

      // Stop at totals / signature blocks / footer-like content
      if (/last\s+modified|total|signature|approved/i.test(row.text)) break;
      if (!row.text.trim()) continue;

      // Check if this row starts a new item: first cell matches NSN pattern
      const firstStr = rowItems[0]?.str || '';
      if (_isNsn(firstStr)) {
        if (currentItem) result.items.push(currentItem);

        // Parse the whole row by NSN x-position buckets
        currentItem = _parseItemRow(rowItems, headerItems);
      } else if (currentItem && !_isNsn(firstStr)) {
        // Continuation row: append to description only if the row content
        // looks like a text fragment (not a qty or a totals line).
        // Rows that are purely numeric, purely dashes, or very short (1–2
        // characters) are skipped — they are likely qty cells that bled onto
        // an extra row or totals/spacer lines.
        const looksLikeText = rowItems.length >= 1
          && !/^\d{1,4}$/.test(firstStr)   // not a bare number ≤ 9999
          && !/^[-–—]+$/.test(firstStr)    // not a dash placeholder
          && firstStr.length > 2;          // at least 3 chars of content
        if (looksLikeText) {
          currentItem.description += ' ' + row.text.trim();
        }
      }
    }
    if (currentItem) result.items.push(currentItem);
  }

  // Fallback: if coordinate parsing found nothing, try regex scan for NSNs.
  // Qty is capped at 4 digits (max 9999) so we don't accidentally capture a
  // size code like "10" when the real qty is elsewhere. The description is
  // captured lazily up to the point where a standalone 1–4-digit number
  // appears — any trailing size descriptors (e.g. "SIZE 10R") must not
  // bleed into the qty capture.
  if (result.items.length === 0) {
    const nsnLineRe = /(\d{4}-\d{2}-\d{3}-\d{4})\s+(.*?)\s+\b(\d{1,4})\b\s*(?:[-–—]+\s*){0,2}/g;
    let m;
    while ((m = nsnLineRe.exec(rawText)) !== null) {
      const qtyCandidate = parseInt(m[3], 10);
      result.items.push({
        nsn:              _normalizeNsn(m[1].trim()),
        description:      m[2].trim(),
        qtyRequired:      isNaN(qtyCandidate) ? 0 : qtyCandidate,
        qtyRequisitioned: null,
        qtyReceived:      null,
      });
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Parse a single item row from sorted text items
// -----------------------------------------------------------------------------

function _parseItemRow(rowItems, headerItems) {
  // Build sorted list of column x-positions from the header row.
  // Only include items whose text looks like a column header keyword.
  const hx = headerItems
    .filter(it => /NSN|Description|Qty/i.test(it.str))
    .map(it => it.x)
    .sort((a, b) => a - b);

  const item = {
    nsn:              '',
    description:      '',
    qtyRequired:      0,
    qtyRequisitioned: null,
    qtyReceived:      null,
  };

  for (const ri of rowItems) {
    const s   = ri.str.trim();
    const col = _colIdx(ri.x, hx);
    switch (col) {
      case 0:
        // NSN column — normalise OCR artefacts (O→0, en-dash, spaces).
        item.nsn = _normalizeNsn(s);
        break;
      case 1:
        item.description += (item.description ? ' ' : '') + s;
        break;
      case 2:
        // Qty Required must be a plain integer or a dash placeholder.
        // Size descriptors such as "10R", "SIZE 10", "S/M" contain letters
        // and must NOT be treated as a quantity — move them to description.
        if (_isPlainQty(s)) {
          item.qtyRequired = _parseQty(s);
        } else {
          item.description += (item.description ? ' ' : '') + s;
        }
        break;
      case 3:
        if (_isPlainQty(s)) item.qtyRequisitioned = _parseQty(s);
        break;
      case 4:
        if (_isPlainQty(s)) item.qtyReceived = _parseQty(s);
        break;
    }
  }

  return item;
}

function _colIdx(x, colXs) {
  // Find which column bucket this x falls into.
  // Bucket i: from midpoint(i-1, i) to midpoint(i, i+1)
  if (colXs.length === 0) return 0;
  for (let i = colXs.length - 1; i >= 0; i--) {
    if (i === 0 || x >= (colXs[i - 1] + colXs[i]) / 2) return i;
  }
  return 0;
}

function _parseQty(str) {
  if (!str) return null;
  const s = str.trim();
  // Dash placeholders mean "not applicable", not zero.
  if (/^[-–—]+$/.test(s)) return null;
  // Reject anything that isn't a pure integer (e.g. "10R", "SIZE 10").
  // Callers that need permissive parsing should pre-validate with _isPlainQty.
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return isNaN(n) || n < 0 ? null : n;
}

// -----------------------------------------------------------------------------
// CSV export
// -----------------------------------------------------------------------------

/**
 * Convert a parsed order to CSV suitable for record-keeping.
 * Columns: NSN, Description, Qty Required, Qty Requisitioned, Qty Received, IMS Status
 *
 * @param {ParsedOrder}  order
 * @param {Array}        [imsItems]  — IMS inventory items for match annotation
 * @returns {string}  CSV text
 */
export function orderToCsv(order, imsItems = []) {
  const nsnMap = new Map(imsItems.map(i => [i.nsn, i]));

  const headers = [
    'NSN', 'Description', 'Qty Required', 'Qty Requisitioned', 'Qty Received', 'IMS Status',
  ];

  const rows = order.items.map(item => {
    const imsMatch = item.nsn ? nsnMap.get(item.nsn) : null;
    const imsStatus = !item.nsn ? 'No NSN' : imsMatch ? 'In IMS' : 'New Item';
    return [
      item.nsn || '',
      item.description || '',
      item.qtyRequired  ?? '',
      item.qtyRequisitioned != null ? item.qtyRequisitioned : '--',
      item.qtyReceived      != null ? item.qtyReceived      : '--',
      imsStatus,
    ].map(_csvCell);
  });

  // Header block
  const meta = [
    ['Order Id',    order.orderId],
    ['Category',    order.orderCategory],
    ['Type',        order.docType],
    ['Status',      order.orderStatus],
    ['Date',        order.dateRaw],
    ['Requestor',   `${order.requestorRank} ${order.requestorName}`.trim()],
    ['Unit',        order.unit],
  ].map(r => r.map(_csvCell).join(','));

  return [
    ...meta, '',
    headers.map(_csvCell).join(','),
    ...rows.map(r => r.join(',')),
  ].join('\r\n');
}

function _csvCell(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
