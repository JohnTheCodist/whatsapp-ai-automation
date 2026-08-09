/**
 * DataCleaner — Phase 3: Formal cleaning engine with full audit trail.
 *
 * Principles:
 *   1. Never silently modify data — every transformation is logged.
 *   2. Every issue is detected, classified by severity, and reported.
 *   3. The CleaningReport is the single source of truth for what changed.
 *
 * Detection categories:
 *   - missing_values    — null or empty cells
 *   - duplicate_rows    — exact row duplicates
 *   - invalid_dates     — unparseable date values
 *   - invalid_prices    — non-numeric or negative prices
 *   - negative_quantity — qty < 0
 *   - currency_symbols  — values containing ₦, $, €, £, ¥
 *   - mixed_date_format — rows with inconsistent date formats
 *   - empty_columns     — columns with 100% null/empty values
 *   - whitespace        — leading/trailing whitespace
 *   - capitalization    — inconsistent casing in text fields
 *   - duplicate_headers — rows that repeat column header names
 *   - empty_rows        — rows where every cell is null/empty
 *
 * Severity levels:
 *   - info     — whitespace, capitalization (cosmetic)
 *   - warning  — missing values, currency symbols (needs attention)
 *   - error    — invalid dates, negative quantities, duplicate rows (data integrity)
 *   - critical — unrecoverable corruption
 */

// ---- CleaningReport class -----------------------------------------------

class CleaningReport {
  constructor(sourceFileName) {
    this.sourceFileName = sourceFileName || 'unknown';
    this.generatedAt = new Date().toISOString();
    this.summary = {
      totalRowsInput: 0,
      totalRowsOutput: 0,
      totalColumns: 0,
      emptyColumns: [],
      issuesByCategory: {},
      issuesBySeverity: { info: 0, warning: 0, error: 0, critical: 0 },
      transformations: {},   // { category: count }
      rowsModified: new Set(),
    };
    this.issues = [];           // [{ row, column, category, severity, originalValue, transformedValue, message }]
    this.transformations = [];  // [{ row, column, action, before, after, reason }]
    this.columnStats = {};      // { columnName: { nullCount, totalCount, uniqueValues, sampleValues } }
  }

  addIssue(row, column, category, severity, originalValue, transformedValue, message) {
    this.issues.push({
      row: row != null ? row : 'global',
      column: column || 'unknown',
      category,
      severity,
      originalValue: this._serialize(originalValue),
      transformedValue: this._serialize(transformedValue),
      message,
    });
    this.summary.issuesByCategory[category] = (this.summary.issuesByCategory[category] || 0) + 1;
    this.summary.issuesBySeverity[severity] = (this.summary.issuesBySeverity[severity] || 0) + 1;
  }

  addTransformation(row, column, action, before, after, reason) {
    this.transformations.push({
      row, column, action,
      before: this._serialize(before),
      after: this._serialize(after),
      reason,
    });
    if (!this.summary.transformations[action]) {
      this.summary.transformations[action] = 0;
    }
    this.summary.transformations[action]++;
    if (row != null) this.summary.rowsModified.add(row);
  }

  setInputStats(rowCount, columnCount) {
    this.summary.totalRowsInput = rowCount;
    this.summary.totalColumns = columnCount;
    this.summary.totalRowsOutput = rowCount;
  }

  setOutputRows(count) {
    this.summary.totalRowsOutput = count;
  }

  setEmptyColumns(cols) {
    this.summary.emptyColumns = cols;
  }

  finalize() {
    this.summary.totalIssues = this.issues.length;
    this.summary.totalTransformations = this.transformations.length;
    this.summary.rowsAffectedCount = this.summary.rowsModified.size;
    this.summary.rowsModified = undefined; // don't serialize Set

    // Compute per-column null stats from issues
    const colNulls = {};
    for (const issue of this.issues) {
      if (issue.category === 'missing_values') {
        colNulls[issue.column] = (colNulls[issue.column] || 0) + 1;
      }
    }
    this.summary.columnNullCounts = colNulls;
  }

  _serialize(val) {
    if (val === undefined) return '<undefined>';
    if (val === null) return '<null>';
    if (val === '') return '<empty>';
    if (typeof val === 'number' && !Number.isFinite(val)) return '<NaN/Infinity>';
    const s = String(val);
    return s.length > 200 ? s.substring(0, 197) + '...' : s;
  }

  toJSON() {
    // Auto-finalize if not done yet
    if (this.summary.rowsModified instanceof Set) {
      this.finalize();
    }
    return {
      sourceFileName: this.sourceFileName,
      generatedAt: this.generatedAt,
      summary: this.summary,
      issueCount: this.issues.length,
      transformationCount: this.transformations.length,
      issues: this.issues,
      transformations: this.transformations,
    };
  }
}

// ---- helpers -----------------------------------------------------------

function serialToDate(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  if (serial < 1 || serial > 100000) return null;
  // Excel serial date epoch: Dec 30, 1899.
  // Serial 1 = Jan 1, 1900.
  // Excel has a bug: it treats 1900 as a leap year (serial 60 = Feb 29, 1900).
  // For serial >= 61, we subtract 1 to account for the non-existent Feb 29, 1900.
  const excelEpoch = Date.UTC(1899, 11, 30); // Dec 30, 1899 00:00 UTC
  const msPerDay = 86400000;
  const days = Math.floor(serial);
  // Excel's 1900 leap-year bug, corrected ONCE.
  //
  // Excel counts a Feb 29 1900 that never existed, so from serial 61 onward its
  // numbering runs a day ahead of reality. Choosing Dec 30 1899 as the epoch --
  // rather than Dec 31 -- is exactly how that is absorbed, which is why this is
  // the conventional constant.
  //
  // This then subtracted another day for serial >= 61, correcting a bug the
  // epoch had already handled, so every real-world date came out one day early:
  // serial 45658 read as 2024-12-31 instead of 2025-01-01. Totals stayed right
  // and the monthly chart did not, because sales on the 1st of a month moved
  // into the previous one -- and a January upload grew a December.
  //
  // Serials below 60 predate the phantom day, so those need the day added back
  // instead. Serial 60 itself is Excel's fiction and lands on Feb 28.
  const adjustedDays = days < 60 ? days + 1 : days;
  const d = new Date(excelEpoch + adjustedDays * msPerDay);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Enterprise Date Parser — recognizes all common date formats.
 *
 * Priority order:
 *   1. ISO-8601 (YYYY-MM-DD, timestamps, timezone)
 *   2. DD/MM/YYYY (Nigeria default — slash, dash, dot, space, backslash, underscore)
 *   3. YYYY/MM/DD
 *   4. MM/DD/YYYY (US fallback)
 *   5. Month-name formats (20 May 2024, May 20, 2024, May 20 2024)
 *   6. Compact numeric (20240520, 20052024, 240520)
 *   7. Fuzzy (ordinal suffixes, normalized separators)
 *   8. Intelligent inference (swap day/month when one interpretation is impossible)
 *
 * Returns YYYY-MM-DD string or null.
 */

const MONTH_NAMES_MAP = {
  jan:1, january:1,
  feb:2, february:2,
  mar:3, march:3,
  apr:4, april:4,
  may:5,
  jun:6, june:6,
  jul:7, july:7,
  aug:8, august:8,
  sep:9, sept:9, september:9,
  oct:10, october:10,
  nov:11, november:11,
  dec:12, december:12,
};

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

/** Normalize separators: replace ./\_ and spaces with dashes, collapse whitespace */
function normalizeSeparators(s) {
  return s.replace(/[./\\_\s]+/g, '-').trim();
}

/** Remove ordinal suffixes (1st, 2nd, 3rd, 4th, ...) */
function stripOrdinal(s) {
  return s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, '$1');
}

/** Parse date+time strings — strip time portion, keep date */
function stripTime(s) {
  // ISO-8601 with time: 2024-05-20T14:32:21, 2024-05-20T14:32:21Z, 2024-05-20T14:32:21+01:00, 2024-05-20T14:32:21.000Z
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
  if (isoMatch) {
    const y = +isoMatch[1], m = +isoMatch[2], d = +isoMatch[3];
    if (isValidDate(y, m, d)) return fmt(y, m, d);
  }
  // "DD/MM/YYYY HH:MM" or "MM/DD/YYYY HH:MM"
  const slashTime = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s+/);
  if (slashTime) {
    const a = +slashTime[1], b = +slashTime[2], c = +slashTime[3];
    const year = c < 100 ? c + 2000 : c;
    // Nigerian priority: try DD/MM first
    if (isValidDate(year, b, a)) return fmt(year, b, a);
    // US fallback: try MM/DD
    if (a > 12 && b <= 12 && isValidDate(year, a, b)) return fmt(year, a, b);
    if (a <= 12 && isValidDate(year, a, b)) return fmt(year, a, b);
  }
  // "YYYY/MM/DD HH:MM" or "YYYY-MM-DD HH:MM"
  const ymdTime = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+/);
  if (ymdTime) {
    const y = +ymdTime[1], m = +ymdTime[2], d = +ymdTime[3];
    if (isValidDate(y, m, d)) return fmt(y, m, d);
  }
  // "May 20 2024 9:45 PM" or "20 May 2024 14:32"
  return null;
}

/** Parse compact 6- or 8-digit strings: 20240520, 20052024, 240520 */
function parseCompact(s) {
  if (!/^\d{6,8}$/.test(s)) return null;
  if (s.length === 8) {
    // 20240520 = YYYYMMDD
    const y = +s.substring(0, 4), m = +s.substring(4, 6), d = +s.substring(6, 8);
    if (isValidDate(y, m, d)) return fmt(y, m, d);
    // 20052024 = DDMMYYYY
    const d2 = +s.substring(0, 2), m2 = +s.substring(2, 4), y2 = +s.substring(4, 8);
    if (isValidDate(y2, m2, d2)) return fmt(y2, m2, d2);
    return null;
  }
  if (s.length === 6) {
    // 240520 = YYMMDD (not DDMMYY — Nigeria uses DDMMYY but compact 6-digit is YYMMDD per spec)
    let y = +s.substring(0, 2), m = +s.substring(2, 4), d = +s.substring(4, 6);
    y = y < 50 ? y + 2000 : y + 1900;
    if (isValidDate(y, m, d)) return fmt(y, m, d);
    return null;
  }
  return null;
}

/** Parse month-name formats: "20 May 2024", "May 20, 2024", "May 20 2024", "20-May-2024", "May-20-2024" */
function parseMonthName(s) {
  const cleaned = stripOrdinal(normalizeSeparators(s));
  // "DD Mon YYYY" or "DD Mon YY" — e.g., "20 May 2024", "20-May-2024", "20 MAY 2024", "20th May 2024"
  let m = cleaned.match(/^(\d{1,2})[-\s]+([a-zA-Z]{3,9})[-\s]+(\d{2,4})$/);
  if (m) {
    const d = +m[1], monthName = m[2].toLowerCase(), yRaw = +m[3];
    const mon = MONTH_NAMES_MAP[monthName];
    const y = yRaw < 100 ? (yRaw < 50 ? yRaw + 2000 : yRaw + 1900) : yRaw;
    if (mon && isValidDate(y, mon, d)) return fmt(y, mon, d);
  }
  // "Mon DD, YYYY" or "Mon DD YYYY" — e.g., "May 20, 2024", "May 20 2024", "May-20-2024"
  m = cleaned.match(/^([a-zA-Z]{3,9})[-\s]+(\d{1,2})(?:,)?[-\s]+(\d{2,4})$/);
  if (m) {
    const monthName = m[1].toLowerCase(), d = +m[2], yRaw = +m[3];
    const mon = MONTH_NAMES_MAP[monthName];
    const y = yRaw < 100 ? (yRaw < 50 ? yRaw + 2000 : yRaw + 1900) : yRaw;
    if (mon && isValidDate(y, mon, d)) return fmt(y, mon, d);
  }
  return null;
}

function parseDateString(val) {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (!s) return null;

  // ---- Strategy 1: ISO-8601 and timestamps ----
  // Full ISO: YYYY-MM-DD (already canonical)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    if (isValidDate(y, m, d)) return s;
  }
  // YYYY-MM (month-only)
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number);
    if (m >= 1 && m <= 12) return fmt(y, m, 1);
  }
  // Date+time or timezone
  const timed = stripTime(s);
  if (timed) return timed;

  // ---- Strategy 2: DD/MM/YYYY with various separators (Nigeria default) ----
  const normSep = normalizeSeparators(s);
  let m = normSep.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y = y < 50 ? y + 2000 : y + 1900;
    // Nigerian priority: assume DD/MM/YYYY
    if (isValidDate(y, b, a)) return fmt(y, b, a);
    // Intelligent inference: if day part > 12, it can't be a month, so swap
    if (a > 12 && b <= 12 && isValidDate(y, a, b)) return fmt(y, a, b);
    // US fallback: if first part could be a month
    if (a <= 12 && isValidDate(y, a, b)) return fmt(y, a, b);
    return null;
  }

  // ---- Strategy 3: YYYY/MM/DD ----
  m = normSep.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidDate(y, mo, d)) return fmt(y, mo, d);
    // 2024/20/05 → 20 cannot be month, so DD = 05, MM = 20? No, 20 > 12
    // If second part > 12, treat as DD and third as MM
    if (mo > 12 && d <= 12 && isValidDate(y, d, mo)) return fmt(y, d, mo);
    return null;
  }

  // ---- Strategy 4: Month-name formats ----
  const monthResult = parseMonthName(s);
  if (monthResult) return monthResult;

  // ---- Strategy 5: Compact numeric (without separators) ----
  const compact = parseCompact(s);
  if (compact) return compact;

  // ---- Strategy 6: Fuzzy — re-attempt after stripping ordinals and re-normalizing ----
  const fuzzy = stripOrdinal(normalizeSeparators(s));
  if (fuzzy !== normalizeSeparators(s)) {
    return parseDateString(fuzzy);
  }

  return null;
}

function parseYYYYMMDD(val) {
  // Handle numeric compact dates: 20240101
  if (typeof val === 'number' && Number.isFinite(val) && val === Math.floor(val)) {
    const s = String(val);
    if (s.length !== 8) return null;
    const year = parseInt(s.substring(0, 4), 10);
    const month = parseInt(s.substring(4, 6), 10);
    const day = parseInt(s.substring(6, 8), 10);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function parseCurrency(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/[₦$€£¥,\s]/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const PAYMENT_METHODS = {
  cash: 'Cash', 'cash payment': 'Cash',
  transfer: 'Transfer', trf: 'Transfer', 'bank transfer': 'Transfer', 'wire transfer': 'Transfer',
  pos: 'POS', 'pos terminal': 'POS', card: 'POS', 'card payment': 'POS', 'debit card': 'POS',
  insurance: 'Insurance', nhis: 'Insurance', hmo: 'Insurance', 'health insurance': 'Insurance',
  credit: 'Credit', 'on credit': 'Credit', 'account': 'Credit',
};

function normalizePaymentMethod(val) {
  if (val == null || val === '') return null;
  const key = String(val).toLowerCase().trim();
  return PAYMENT_METHODS[key] || null;
}

// ---- main cleaning pipeline ---------------------------------------------

/**
 * @param {object[]} rows — raw spreadsheet rows
 * @param {string[]} headers — column header names
 * @param {object} [options]
 * @param {string} [options.fileName] — for the report
 * @returns {{ records: object[], stats: object, report: CleaningReport }}
 */
function cleanData(rows, headers, options = {}) {
  const report = new CleaningReport(options.fileName || 'upload.xlsx');
  const colCount = headers ? headers.length : (rows[0] ? Object.keys(rows[0]).length : 0);
  report.setInputStats(rows.length, colCount);

  if (!Array.isArray(rows) || rows.length === 0) {
    report.setOutputRows(0);
    report.finalize();
    return { records: [], stats: { inputRows: 0, outputRows: 0, emptyRemoved: 0, headersRemoved: 0 }, report };
  }

  let records = [...rows];

  // Step 1: Detect entirely empty columns
  _detectEmptyColumns(records, headers, report);

  // Step 2: Detect whitespace & capitalization issues
  _detectTextIssues(records, headers, report);

  // Step 3: Remove empty rows
  records = _removeEmptyRows(records, headers, report);

  // Step 4: Remove duplicate header rows
  records = _removeHeaderRows(records, headers, report);

  // Step 5: Trim whitespace
  records = _trimAll(records, headers, report);

  // Step 6: Detect and clean currency symbols
  records = _cleanCurrencySymbols(records, headers, report);

  // Step 7: Detect invalid dates
  _detectInvalidDates(records, headers, report);

  // Step 8: Detect invalid/negative prices
  _detectInvalidPrices(records, headers, report);

  // Step 9: Detect negative quantities
  _detectNegativeQuantities(records, headers, report);

  // Step 10: Remove duplicate rows
  const dedupResult = _deduplicateRows(records, headers, report);

  report.setOutputRows(dedupResult.length);
  // Note: do NOT call report.finalize() here — the caller (normalize) may add more
  // transformations (e.g., product name normalization). Caller must call report.toJSON()
  // which will finalize if needed.

  const stats = {
    inputRows: rows.length,
    outputRows: dedupResult.length,
    emptyRemoved: rows.length - records.length,
    headersRemoved: report.summary.transformations['remove_header_row'] || 0,
    duplicatesRemoved: report.summary.transformations['remove_duplicate'] || 0,
    currencyCleaned: report.summary.transformations['clean_currency'] || 0,
    whitespaceTrimmed: report.summary.transformations['trim_whitespace'] || 0,
    emptyColumns: report.summary.emptyColumns,
    totalIssues: report.issues.length,
  };

  return { records: dedupResult, stats, report };
}

// ---- private detection/cleaning functions -------------------------------

function _detectEmptyColumns(records, headers, report) {
  if (!headers || headers.length === 0) return;
  const emptyCols = [];

  for (const col of headers) {
    const allEmpty = records.every((row, i) => {
      const val = row[col];
      return val == null || String(val).trim() === '';
    });
    if (allEmpty) {
      emptyCols.push(col);
      report.addIssue(null, col, 'empty_columns', 'warning', null, null,
        `Column "${col}" is entirely empty (${records.length} rows)`);
    }
  }
  report.setEmptyColumns(emptyCols);
}

function _detectTextIssues(records, headers, report) {
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    for (const col of headers || Object.keys(row)) {
      const val = row[col];
      if (typeof val !== 'string') continue;

      // Whitespace detection
      if (val !== val.trim()) {
        report.addIssue(i, col, 'whitespace', 'info', val, val.trim(),
          `Row ${i + 1}: leading/trailing whitespace in "${col}"`);
      }

      // Inconsistent capitalization (all-caps vs proper case)
      if (/[a-zA-Z]/.test(val) && val === val.toUpperCase() && val.length > 2) {
        report.addIssue(i, col, 'capitalization', 'info', val, null,
          `Row ${i + 1}: all-caps text in "${col}"`);
      }
    }
  }
}

function _removeEmptyRows(records, headers, report) {
  const kept = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const allEmpty = (headers || Object.keys(row)).every((col) => {
      const val = row[col];
      return val == null || String(val).trim() === '';
    });
    if (allEmpty) {
      report.addIssue(i, null, 'empty_rows', 'error', null, null,
        `Row ${i + 1}: completely empty, removed`);
      report.addTransformation(i, null, 'remove_empty_row', '[empty row]', '<removed>',
        'Row had no data in any column');
    } else {
      kept.push(row);
    }
  }
  return kept;
}

function _removeHeaderRows(records, headers, report) {
  if (!headers || headers.length === 0) return records;
  const headerSet = new Set(headers.map((h) => String(h).toLowerCase().trim()));
  const kept = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const values = headers.map((h) => String(row[h] || '').toLowerCase().trim());
    const matchCount = values.filter((v) => headerSet.has(v)).length;

    if (matchCount >= headers.length * 0.6) {
      report.addIssue(i, null, 'duplicate_headers', 'error', values.join(', '), null,
        `Row ${i + 1}: appears to repeat column headers (${matchCount}/${headers.length} match), removed`);
      report.addTransformation(i, null, 'remove_header_row', values.join(', '), '<removed>',
        'Matched column headers — likely a repeated header row');
    } else {
      kept.push(row);
    }
  }
  return kept;
}

function _trimAll(records, headers, report) {
  return records.map((row, i) => {
    const trimmed = { ...row };
    for (const col of headers || Object.keys(row)) {
      const val = row[col];
      if (typeof val === 'string' && val !== val.trim()) {
        trimmed[col] = val.trim();
        report.addTransformation(i, col, 'trim_whitespace', val, trimmed[col],
          `Trimmed whitespace in "${col}"`);
      }
    }
    return trimmed;
  });
}

function _cleanCurrencySymbols(records, headers, report) {
  return records.map((row, i) => {
    const cleaned = { ...row };
    for (const col of headers || Object.keys(row)) {
      const val = row[col];
      if (typeof val === 'string' && /[₦$€£¥]/.test(val)) {
        report.addIssue(i, col, 'currency_symbols', 'warning', val, null,
          `Row ${i + 1}: currency symbol in "${col}" — parsed as number`);

        const parsed = parseCurrency(val);
        if (parsed != null) {
          cleaned[col] = parsed;
          report.addTransformation(i, col, 'clean_currency', val, parsed,
            `Parsed currency value`);
        }
      }
    }
    return cleaned;
  });
}

function _detectInvalidDates(records, headers, report) {
  // Identify date-like columns by header name
  const dateCols = headers.filter((h) => {
    const lower = String(h).toLowerCase();
    return /date|period|day|month|expir/i.test(lower);
  });

  for (const col of dateCols) {
    const formats = new Set();
    for (let i = 0; i < records.length; i++) {
      const val = records[i][col];
      if (val == null || String(val).trim() === '') continue;

      let parsed = null;

      if (typeof val === 'number') {
        // Excel serial date (reasonable range: 1 to ~100000, covers 1900-2173)
        if (val >= 1 && val <= 100000) {
          const serial = serialToDate(val);
          if (serial) {
            const year = parseInt(serial.substring(0, 4), 10);
            if (year >= 2010 && year <= 2099) {
              formats.add('excel_serial');
              parsed = serial;
            }
          }
        }
        // YYYYMMDD integer
        if (!parsed) {
          parsed = parseYYYYMMDD(val);
          if (parsed) formats.add('yyyymmdd_numeric');
        }
      } else if (typeof val === 'string') {
        parsed = parseDateString(val);
        if (parsed) {
          const s = val.trim();
          // Classify the format for mixed-format detection
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) formats.add('iso');
          else if (/^\d{4}-\d{2}$/.test(s)) formats.add('iso_month');
          else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) formats.add('iso_datetime');
          else if (/^[a-zA-Z]/.test(s)) formats.add('month_name');
          else if (/^\d{8}$/.test(s)) formats.add('compact_8');
          else if (/^\d{6}$/.test(s)) formats.add('compact_6');
          else if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/.test(s)) {
            // Determine if DD/MM or MM/DD based on value ranges
            const parts = s.split(/[\/\-.]/);
            if (+parts[0] > 12) formats.add('dmy');
            else if (+parts[1] > 12) formats.add('mdy');
            else formats.add('dmy'); // assume Nigerian
          } else if (/^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(s)) {
            formats.add('ymd');
          } else {
            formats.add('other');
          }
        } else {
          formats.add('unknown');
          report.addIssue(i, col, 'invalid_dates', 'error', val, null,
            `Row ${i + 1}: unparseable date "${val}" in column "${col}"`);
        }
      }
    }
    // Report mixed formats only if there are meaningful format differences (≥ 2 distinct)
    const distinct = [...formats].filter(f => f !== 'unknown');
    if (distinct.length > 1) {
      report.addIssue(null, col, 'mixed_date_format', 'warning', distinct.join(', '), null,
        `Column "${col}" has mixed date formats: ${distinct.join(', ')}`);
    }
  }
}

function _detectInvalidPrices(records, headers, report) {
  // Identify price-like columns
  const priceCols = headers.filter((h) => {
    const lower = String(h).toLowerCase();
    return /price|amount|cost|revenue|sales|total|rate/i.test(lower);
  });

  for (const col of priceCols) {
    for (let i = 0; i < records.length; i++) {
      const val = records[i][col];
      if (val == null || val === '') continue;

      const parsed = parseCurrency(val);
      if (parsed === null && typeof val === 'string' && val.trim() !== '') {
        report.addIssue(i, col, 'invalid_prices', 'error', val, null,
          `Row ${i + 1}: non-numeric price "${val}" in column "${col}"`);
      } else if (parsed !== null && parsed < 0) {
        report.addIssue(i, col, 'invalid_prices', 'error', val, null,
          `Row ${i + 1}: negative price ${parsed} in column "${col}"`);
      }
    }
  }
}

function _detectNegativeQuantities(records, headers, report) {
  const qtyCols = headers.filter((h) => {
    const lower = String(h).toLowerCase();
    return /qty|quantity|volume|units|count|pieces/i.test(lower);
  });

  for (const col of qtyCols) {
    for (let i = 0; i < records.length; i++) {
      const val = records[i][col];
      if (val == null || val === '') continue;

      const num = typeof val === 'number' ? val : Number(String(val).replace(/[,\s]/g, ''));
      if (Number.isFinite(num) && num < 0) {
        report.addIssue(i, col, 'negative_quantity', 'error', val, null,
          `Row ${i + 1}: negative quantity ${num} in column "${col}"`);
      }
    }
  }
}

function _deduplicateRows(records, headers, report) {
  const seen = new Set();
  const deduped = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const key = (headers || Object.keys(row)).map((col) => {
      const v = row[col];
      return v == null ? '<null>' : String(v).trim();
    }).join('|');

    if (seen.has(key)) {
      report.addIssue(i, null, 'duplicate_rows', 'error',
        `Row identical to earlier row`, null,
        `Row ${i + 1}: exact duplicate of an earlier row, removed`);
      report.addTransformation(i, null, 'remove_duplicate', '<duplicate row>', '<removed>',
        'Exact duplicate of prior row');
    } else {
      seen.add(key);
      deduped.push(row);
    }
  }

  return deduped;
}

// ---- legacy compatibility functions -------------------------------------

function deduplicateTransactions(records) {
  if (!records || records.length === 0) return { records: [], duplicatesRemoved: 0 };
  const deduped = _deduplicateRows(records, Object.keys(records[0] || {}), new CleaningReport());
  return { records: deduped, duplicatesRemoved: records.length - deduped.length };
}

function fillMissingValues(records) {
  return records.map((rec) => ({
    ...rec,
    product: rec.product || rec.product_name || 'Unknown',
    quantity: rec.quantity != null ? rec.quantity : 1,
  }));
}

module.exports = {
  cleanData,
  CleaningReport,
  parseCurrency,
  serialToDate,
  parseDateString,
  parseYYYYMMDD,
  normalizePaymentMethod,
  deduplicateTransactions,
  fillMissingValues,
};
