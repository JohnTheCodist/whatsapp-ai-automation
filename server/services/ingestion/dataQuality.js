/**
 * Data Quality Engine — Phase 6: Two-phase Validation Architecture.
 *
 * Phase 1 — Structural Validation:  "Can this value be understood?"
 * Phase 2 — Business Validation:    "Does this value make business sense?"
 *
 * Preset configurations support different pharmacy types without
 * changing core code.
 *
 * Principles:
 *   1. Structural problems ≠ business problems — never mix them
 *   2. Original values are always preserved
 *   3. Every field gets a confidence score
 *   4. Row status: valid | structurally-invalid | business-invalid
 *   5. Excluded rows stay in the audit log
 *   6. Adaptive dedup: prefers transaction ID → invoice → composite key
 */

// ---- configuration with pharmacy-type presets ----------------------------

const PRESETS = {
  retail: {
    maxQuantityPerTransaction: 500,
    warningQuantityThreshold: 250,
    excludeQuantityThreshold: 1000,
    maxRevenuePerTransaction: 5000000,
    maxSellingPrice: 1000000,
  },
  wholesale: {
    maxQuantityPerTransaction: 50000,
    warningQuantityThreshold: 10000,
    excludeQuantityThreshold: 100000,
    maxRevenuePerTransaction: 50000000,
    maxSellingPrice: 10000000,
  },
};

const validationConfig = {
  // Chosen preset — can be overridden per-upload
  preset: 'retail',

  // Quantity
  maxQuantityPerTransaction: 500,
  warningQuantityThreshold: 250,
  excludeQuantityThreshold: 1000,

  // Revenue / monetary
  maxRevenuePerTransaction: 5000000,
  warningRevenueThreshold: 2000000,
  maxSellingPrice: 1000000,
  minSellingPrice: 0,

  // Dates
  minYear: 2010,
  warningFutureYears: 1,
  rejectFutureYears: 2,

  // Product
  allowUnknownProducts: true,

  // Payment
  neverInferPaymentMethod: true,

  // Confidence scoring
  enableConfidenceScoring: true,
};

function configure(overrides = {}) {
  if (overrides.preset && PRESETS[overrides.preset]) {
    Object.assign(validationConfig, PRESETS[overrides.preset]);
  }
  Object.assign(validationConfig, overrides);
}

// ---- thresholds (derived from config) -----------------------------------

function getConfig() { return validationConfig; }

// ---- helpers -----------------------------------------------------------

const num = (val) => {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

const CONFIDENCE = {
  VALID: 1.0,
  CORRECTED: 0.8,
  SUSPICIOUS: 0.5,
  INVALID: 0.0,
};

function confidenceTier(score) {
  if (score >= 1.0) return 'Valid (100%)';
  if (score >= 0.8) return 'Corrected (80%)';
  if (score >= 0.5) return 'Suspicious (50%)';
  return 'Invalid (0%)';
}

// ---- date helpers -------------------------------------------------------

function looksLikeInvalidDate(val) {
  if (val == null || val === '') return true;
  const s = String(val).trim();
  if (s === '') return true;
  // Use enterprise parser — if it can parse, the date is structurally valid
  const { parseDateString } = require('./dataCleaner');
  const parsed = parseDateString(s);
  if (parsed) return false;
  // Quick heuristic: plain text (no digits) that's short is invalid
  if (/^[a-zA-Z\s]+$/.test(s) && s.length < 10) return true;
  // Check for impossible day/month values
  const dd = s.match(/(\d{1,2})[\/\-\.\\_\s](\d{1,2})[\/\-\.\\_\s](\d{2,4})/);
  if (dd) {
    const m = Number(dd[1]), d = Number(dd[2]);
    if (m > 12 && d > 12) return true;
  }
  return false;
}

function parseDate(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  if (s === '') return null;

  // ISO format (already normalized) — fast path
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(y, m - 1, d);
  }

  // Use enterprise parser for any non-ISO format (should be rare at this pipeline stage)
  const { parseDateString } = require('./dataCleaner');
  const normalized = parseDateString(s);
  if (normalized) {
    const [y, m, d] = normalized.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  return null;
}

// ---- product classification ---------------------------------------------

function classifyProduct(val) {
  if (val == null || val === '') return 'Missing';
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return 'Unknown Product';
  if (s.length < 2) return 'Unknown Product';
  if (/[a-zA-Z]/.test(s)) {
    if (s.length <= 3 || /^[a-zA-Z]+\d{1,3}$/.test(s)) return 'Possible Typo';
    return 'Recognized';
  }
  return 'Unknown Product';
}

// ---- field specifications ------------------------------------------------

const FIELD_SPECS = {
  product_name:        { type: 'text',     label: 'Product Name',        maxLen: 150 },
  quantity:            { type: 'integer',  label: 'Quantity' },
  revenue:             { type: 'currency', label: 'Revenue' },
  cost_price:          { type: 'currency', label: 'Cost Price' },
  selling_price:       { type: 'currency', label: 'Selling Price' },
  transaction_date:    { type: 'date',     label: 'Transaction Date' },
  payment_method:      { type: 'payment',  label: 'Payment Method' },
  supplier:            { type: 'text',     label: 'Supplier',           maxLen: 200 },
  manufacturer:        { type: 'text',     label: 'Manufacturer',       maxLen: 200 },
  brand:               { type: 'text',     label: 'Brand',              maxLen: 150 },
  generic_name:        { type: 'text',     label: 'Generic Name',       maxLen: 200 },
  category:            { type: 'text',     label: 'Category',           maxLen: 100 },
  subcategory:         { type: 'text',     label: 'Subcategory',        maxLen: 100 },
  batch_number:        { type: 'text',     label: 'Batch Number',       maxLen: 30 },
  expiry_date:         { type: 'date',     label: 'Expiry Date' },
  branch:              { type: 'text',     label: 'Branch',             maxLen: 150 },
  warehouse:           { type: 'text',     label: 'Warehouse',          maxLen: 150 },
  sales_channel:       { type: 'text',     label: 'Sales Channel',      maxLen: 100 },
  customer:            { type: 'text',     label: 'Customer',           maxLen: 200 },
  sales_representative:{ type: 'text',     label: 'Sales Rep',          maxLen: 200 },
  invoice_number:      { type: 'id',       label: 'Invoice Number',     maxLen: 40 },
  discount:            { type: 'currency', label: 'Discount' },
  tax:                 { type: 'currency', label: 'Tax' },
  profit:              { type: 'currency', label: 'Profit' },
  margin:              { type: 'percentage', label: 'Margin' },
};

// ---- repair helpers ------------------------------------------------------

/**
 * Attempt to repair a numeric string with obvious typos.
 * E.g., "12O0" (letter O) → 1200, "₦1,500" → 1500.
 * Returns { value, confidence } where confidence < 1.0 means repaired.
 */
function repairNumeric(val) {
  if (val == null) return { value: null, confidence: CONFIDENCE.VALID };
  const s = String(val).trim();
  if (s === '') return { value: null, confidence: CONFIDENCE.VALID };

  let repaired = s;

  // Common OCR / typo issues
  const letterOtoZero = /[OＯ]/g;  // letter O → zero
  if (letterOtoZero.test(repaired)) {
    repaired = repaired.replace(letterOtoZero, '0');
  }

  // Currency symbols
  repaired = repaired.replace(/[₦$€£¥]/g, '');

  // Thousand separators
  repaired = repaired.replace(/,/g, '');

  // Trailing percent
  repaired = repaired.replace(/%$/, '');

  // Whitespace inside number
  repaired = repaired.replace(/\s/g, '');

  const result = Number(repaired);
  if (Number.isFinite(result)) {
    const wasRepaired = repaired !== s.replace(/\s/g, '');
    return {
      value: result,
      confidence: wasRepaired ? CONFIDENCE.CORRECTED : CONFIDENCE.VALID,
    };
  }

  return { value: null, confidence: CONFIDENCE.INVALID };
}

// ===================================================================
// PHASE 1 — STRUCTURAL VALIDATION
// ===================================================================

/**
 * Can this value be understood? Not whether it's correct.
 * Returns { parsed, confidence, issue }.
 */
function validateStructurally(field, rawValue) {
  const spec = FIELD_SPECS[field];
  if (!spec) return { parsed: rawValue, confidence: CONFIDENCE.VALID, issue: null };
  const val = rawValue;

  switch (spec.type) {
    // ---- numeric types (integer, currency, percentage) ----
    case 'integer':
    case 'currency':
    case 'percentage': {
      if (val == null || val === '') return { parsed: null, confidence: CONFIDENCE.VALID, issue: null };
      const repaired = repairNumeric(val);
      if (repaired.value == null) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} "${val}" cannot be parsed as a number` };
      }
      if (spec.type === 'integer' && !Number.isInteger(repaired.value)) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} "${val}" is not a whole number` };
      }
      // Percentages (margin) and some currency fields (discount, tax, profit)
      // can legitimately be zero or negative.
      const allowsNonPositive = spec.type === 'percentage' || ['discount', 'tax', 'profit'].includes(field);
      if (repaired.value < 0 && !allowsNonPositive) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} ${repaired.value} is negative` };
      }
      if (repaired.value === 0 && !allowsNonPositive) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} ${repaired.value} is not positive` };
      }
      return {
        parsed: repaired.value,
        confidence: repaired.confidence,
        issue: repaired.confidence < 1.0 ? `${spec.label} "${val}" was automatically corrected` : null,
      };
    }

    // ---- date ----
    case 'date': {
      if (val == null || val === '') return { parsed: null, confidence: CONFIDENCE.VALID, issue: null };
      if (looksLikeInvalidDate(val)) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} "${val}" is not a valid date` };
      }
      const parsed = parseDate(val);
      if (parsed == null) {
        return { parsed: null, confidence: CONFIDENCE.INVALID,
          issue: `${spec.label} "${val}" could not be parsed as a date` };
      }
      const iso = parsed.toISOString().slice(0, 10);
      return { parsed: iso, confidence: CONFIDENCE.VALID, issue: null };
    }

    // ---- text ----
    case 'text': {
      if (val == null || val === '') return { parsed: null, confidence: CONFIDENCE.VALID, issue: null };
      const s = String(val).trim();
      if (s.length < 1) return { parsed: null, confidence: CONFIDENCE.INVALID, issue: `${spec.label} is empty` };
      return { parsed: s, confidence: CONFIDENCE.VALID, issue: null };
    }

    // ---- id (text + structural but used for dedup) ----
    case 'id': {
      if (val == null || val === '') return { parsed: null, confidence: CONFIDENCE.VALID, issue: null };
      const s = String(val).trim();
      return { parsed: s, confidence: CONFIDENCE.VALID, issue: null };
    }

    // ---- payment method ----
    case 'payment': {
      if (val == null || val === '') return { parsed: null, confidence: CONFIDENCE.VALID, issue: null };
      const s = String(val).trim();
      const nonPayment = /^(walk.?in|insurance|clinic|cash\s+customer|patient|in.?patient|hmo|nhis)$/i;
      if (nonPayment.test(s)) {
        return { parsed: null, confidence: CONFIDENCE.CORRECTED, issue: `"${s}" is not a payment method — set to unavailable` };
      }
      return { parsed: s, confidence: CONFIDENCE.VALID, issue: null };
    }

    default:
      return { parsed: val, confidence: CONFIDENCE.VALID, issue: null };
  }
}

function structuralValidate(records) {
  if (!records || records.length === 0) {
    return { records: [], report: emptyReport(), structurallyValid: [] };
  }

  const structuralIssues = {};
  const fieldConfidence = {};
  const statuses = { valid: 0, requiresReview: 0, unparseable: 0 };

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const fieldResults = {};
    const rowIssues = [];
    const structFieldStatus = {};  // per-field structural status

    for (const [field, spec] of Object.entries(FIELD_SPECS)) {
      const val = rec[field];
      const result = validateStructurally(field, val);

      // Apply structural correction
      if (result.confidence === CONFIDENCE.CORRECTED && result.parsed != null) {
        rec[field] = result.parsed;
      }

      // Track per-field structural validity
      const isStructurallyInvalid = result.confidence === CONFIDENCE.INVALID;
      structFieldStatus[field] = {
        valid: !isStructurallyInvalid,
        confidence: result.confidence,
        corrected: result.confidence === CONFIDENCE.CORRECTED,
      };

      fieldResults[field] = {
        confidence: result.confidence,
        parsed: result.parsed,
        original: val,
        issue: result.issue,
      };

      if (result.issue) {
        rowIssues.push({ field, issue: result.issue, isStructural: true });
        structuralIssues[result.issue] = (structuralIssues[result.issue] || 0) + 1;
      }

      if (!fieldConfidence[field]) fieldConfidence[field] = { sum: 0, count: 0 };
      fieldConfidence[field].sum += result.confidence;
      fieldConfidence[field].count++;
    }

    // Row classification:
    //   valid          — all core fields parseable
    //   requiresReview — at least one core field structurally invalid
    //   unparseable    — ALL core fields (product+quantity+revenue+date) are invalid
    const coreFields = ['product_name','quantity','revenue','transaction_date'];
    const coreValid = coreFields.filter((f) => structFieldStatus[f]?.valid !== false);
    const allCoreBad = coreValid.length === 0;

    const rowStatus = allCoreBad ? 'unparseable'
      : coreValid.length < 4 ? 'requires-review'
      : 'valid';

    statuses[rowStatus]++;

    rec._structural = {
      status: rowStatus,
      valid: rowStatus !== 'unparseable', // legacy: only truly unparseable rows are "invalid"
      fieldResults,
      fieldStatus: structFieldStatus,
      issues: rowIssues,
    };
  }

  const structurallyValid = records.filter((r) => r._structural.status !== 'unparseable');
  const structurallyInvalid = records.filter((r) => r._structural.status === 'unparseable');

  const fieldAvgConfidence = {};
  for (const [f, d] of Object.entries(fieldConfidence)) {
    fieldAvgConfidence[f] = Math.round((d.sum / d.count) * 100);
  }

  // Categorize structural issues for reporting
  const categorizedStructural = {};
  for (const [reason, count] of Object.entries(structuralIssues)) {
    const r = reason.toLowerCase();
    let cat = 'Other Structural';
    if (r.includes('cannot be parsed') || r.includes('not a number') || r.includes('not a whole number')) cat = 'Invalid Numbers';
    else if (r.includes('not a valid date') || r.includes('could not be parsed as a date')) cat = 'Invalid Dates';
    else if (r.includes('empty') || r.includes('missing')) cat = 'Missing Values';
    else if (r.includes('automatically corrected') || r.includes('autocorrected')) cat = 'Auto-Corrected Values';
    else if (r.includes('payment method')) cat = 'Payment Method Issues';
    else if (r.includes('not a whole number') || r.includes('not positive')) cat = 'Invalid Format';
    categorizedStructural[cat] = (categorizedStructural[cat] || 0) + count;
  }

  return {
    records,
    structurallyValid,
    structurallyInvalid,
    structuralReport: {
      totalRows: records.length,
      structurallyValid: structurallyValid.length,
      structurallyInvalid: structurallyInvalid.length,
      issueSummary: categorizedStructural,
      totalIssues: Object.values(structuralIssues).reduce((s, v) => s + v, 0),
      fieldConfidence: fieldAvgConfidence,
    },
  };
}

// ===================================================================
// PHASE 2 — BUSINESS VALIDATION
// ===================================================================

const BUSINESS_RULES = [
  {
    id: 'revenue_consistency',
    category: 'Revenue vs SP×Qty Mismatch',
    check: (rec) => {
      const rev = num(rec.revenue), sp = num(rec.selling_price), qty = num(rec.quantity);
      if (rev == null || sp == null || qty == null || sp === 0 || qty === 0) return null;
      const expected = sp * qty;
      const pct = expected > 0 ? Math.abs(rev - expected) / expected * 100 : 0;
      if (pct > 30) return { severity: 'warning', message: `Revenue (${rev}) deviates ${Math.round(pct)}% from SP×Qty (${Math.round(expected)})` };
      if (pct > 10) return { severity: 'info', message: `Revenue slightly off from SP×Qty (${Math.round(pct)}%)` };
      return null;
    },
  },
  {
    id: 'cost_exceeds_price',
    category: 'Cost Exceeds Price',
    check: (rec) => {
      const sp = num(rec.selling_price), cp = num(rec.cost_price);
      if (sp == null || cp == null) return null;
      // When revenue is explicitly a total (not per-unit), cost_price is also a total.
      // Compare total cost to total selling price (SP × qty) instead of unit-to-unit.
      if (rec.revenue != null) {
        const qty = num(rec.quantity) || 1;
        if (cp > sp * qty) return { severity: 'warning', message: `Cost price (${cp}) exceeds selling price × qty (${sp * qty}) — negative margin` };
        return null;
      }
      if (cp > sp) return { severity: 'warning', message: `Cost price (${cp}) exceeds selling price (${sp}) — negative margin` };
      return null;
    },
  },
  {
    id: 'date_future',
    category: 'Future Dates',
    check: (rec) => {
      const d = rec.transaction_date; if (d == null || d === '') return null;
      const parsed = parseDate(d); if (parsed == null) return null;
      const now = new Date();
      if (parsed > now) return { severity: 'info', message: `Transaction date (${d}) is in the future` };
      return null;
    },
  },
];

function validateBusiness(rules, field, val, spec) {
  if (val == null) return null;

  switch (spec.type) {
    case 'integer': {
      const n = num(val);
      if (n == null) return null;
      if (n > validationConfig.excludeQuantityThreshold) {
        return { severity: 'excluded', message: `Quantity ${n.toLocaleString()} exceeds business limit (${validationConfig.excludeQuantityThreshold.toLocaleString()}) — excluded from KPIs` };
      }
      if (n > validationConfig.warningQuantityThreshold) {
        return { severity: 'warning', message: `Quantity ${n.toLocaleString()} is unusually large` };
      }
      return null;
    }
    case 'currency': {
      const n = num(val);
      if (n == null) return null;
      const max = spec.type === 'currency' ? validationConfig.maxRevenuePerTransaction : validationConfig.maxSellingPrice;
      // Profit and margin can legitimately be negative (losses)
      const allowNegative = ['profit', 'margin'].includes(field);
      if (n < 0 && !allowNegative) return { severity: 'excluded', message: `${spec.label} ${n} is negative — excluded` };
      if (n > validationConfig.maxRevenuePerTransaction) {
        return { severity: 'excluded', message: `${spec.label} ${n.toLocaleString()} exceeds business limit` };
      }
      if (field === 'revenue' && n > validationConfig.warningRevenueThreshold) {
        return { severity: 'warning', message: `Revenue ${n.toLocaleString()} is unusually large` };
      }
      return null;
    }
    case 'date': {
      const d = parseDate(val);
      if (d == null) return null;
      const year = d.getFullYear();
      const now = new Date();
      const future2y = new Date(now.getFullYear() + validationConfig.rejectFutureYears, now.getMonth(), now.getDate());
      const future1y = new Date(now.getFullYear() + validationConfig.warningFutureYears, now.getMonth(), now.getDate());
      if (year < validationConfig.minYear) {
        return { severity: 'warning', message: `Date ${val} is before ${validationConfig.minYear}` };
      }
      if (d > future2y) {
        return { severity: 'excluded', message: `Date ${val} is ${validationConfig.rejectFutureYears}+ years in the future — excluded` };
      }
      if (d > future1y) {
        return { severity: 'warning', message: `Date ${val} is ${validationConfig.warningFutureYears}+ year in the future` };
      }
      return null;
    }
    default:
      return null;
  }
}

function businessValidate(records) {
  if (!records || records.length === 0) {
    return { records: [], report: { businessValid: 0, businessInvalid: 0, issueSummary: {} }, businessValid: [] };
  }

  const businessIssues = {};
  const statuses = { valid: 0, 'valid-with-warnings': 0, 'requires-review': 0, excluded: 0 };

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const rowIssues = rec._quality?.issues || [];
    const excludedMetrics = new Set();
    let productClass = 'Missing';
    const structFieldStatus = rec._structural?.fieldStatus || {};

    // Only truly unparseable rows (all core fields broken) get fully excluded
    const allCoreInvalid = rec._structural?.status === 'unparseable';

    if (!allCoreInvalid) {
      // ---- field-level business rules ----
      for (const [field, spec] of Object.entries(FIELD_SPECS)) {
        const val = rec[field];
        const issue = validateBusiness(null, field, val, spec);
        if (issue) {
          rowIssues.push({ field, type: 'business-rule', severity: issue.severity, reason: issue.message, isBusiness: true });
          businessIssues[issue.message] = (businessIssues[issue.message] || 0) + 1;
          // Mark which metrics are affected
          excludedMetrics.add(getAffectedMetric(field, issue.severity));
        }
      }

      // ---- null required core fields → exclude affected analytics ----
      // Only flag fields that are essential for core analysis (date, quantity, revenue).
      // Optional fields (cost, profit, margin, expiry) are null by default and
      // should never trigger metric exclusions when legitimately absent.
      const NULL_CHECK_FIELDS = ['transaction_date','quantity','revenue'];
      for (const field of NULL_CHECK_FIELDS) {
        if (rec[field] == null) {
          const sev = structFieldStatus[field] && !structFieldStatus[field].valid ? 'invalid' : 'missing';
          excludedMetrics.add(getAffectedMetric(field, sev));
        }
      }

      // ---- cross-field business rules ----
      for (const rule of BUSINESS_RULES) {
        const result = rule.check(rec);
        if (result) {
          rowIssues.push({ field: 'cross-field', type: 'business-rule', severity: result.severity, reason: result.message, isBusiness: true });
          businessIssues[result.message] = (businessIssues[result.message] || 0) + 1;
          if (result.severity === 'warning') excludedMetrics.add('consistency_check');
        }
      }

      // ---- product classification ----
      productClass = classifyProduct(rec.product_name);
      const productConfidence = productClass === 'Recognized' ? CONFIDENCE.VALID
        : productClass === 'Possible Typo' ? CONFIDENCE.CORRECTED
        : CONFIDENCE.SUSPICIOUS;
      if (productClass !== 'Recognized' && productClass !== 'Missing') {
        rowIssues.push({ field: 'product_name', type: 'product', confidence: productConfidence, reason: productClass, isBusiness: true });
        businessIssues[productClass] = (businessIssues[productClass] || 0) + 1;
        if (productClass === 'Unknown Product') excludedMetrics.add('product_breakdown');
      }
    }

    // ---- per-field metric exclusions from structural issues ----
    for (const [field, fStatus] of Object.entries(structFieldStatus)) {
      if (!fStatus.valid) {
        excludedMetrics.add(getAffectedMetric(field, 'invalid'));
      }
    }

    // ---- row status: only truly excluded if all-core-invalid ----
    const hasWarnings = rowIssues.some((i) => i.isBusiness || i.isStructural);
    const hasReviews = rowIssues.some((i) =>
      i.isBusiness && (i.severity === 'excluded' || i.severity === 'warning'));

    let rowStatus;
    if (allCoreInvalid) {
      rowStatus = 'excluded';
    } else if (hasReviews) {
      rowStatus = 'requires-review';
    } else if (hasWarnings) {
      rowStatus = 'valid-with-warnings';
    } else {
      rowStatus = 'valid';
    }

    statuses[rowStatus]++;

    // Compute quality score: base 1.0, deduct for each affected metric
    const maxMetrics = 6; // trends, revenue, quantity, product, payment, profitability
    const deductions = excludedMetrics.size > 0 ? excludedMetrics.size / maxMetrics : 0;
    const fieldScore = computeFieldAverage(structFieldStatus);
    const qualityScore = Math.round(Math.max(0.1, fieldScore - deductions) * 10000) / 10000;

    rec._quality = {
      score: qualityScore,
      confidenceTier: confidenceTier(qualityScore),
      status: rowStatus,
      structurallyValid: rec._structural?.status !== 'unparseable',
      businessValid: rowStatus !== 'excluded',
      productClassification: productClass || 'N/A',
      excludedMetrics: [...excludedMetrics],
      issues: rowIssues,
    };
  }

  // "businessValid" = any row not excluded (vast majority)
  const businessValid = records.filter((r) => r._quality?.status !== 'excluded');
  const businessInvalid = records.filter((r) => r._quality?.status === 'excluded');

  // Categorize business issues (case-insensitive matching)
  const categorizedBusiness = {};
  for (const [reason, count] of Object.entries(businessIssues)) {
    const r = reason.toLowerCase();
    let cat = 'Other Business';
    if (reason === 'Unknown Product') cat = 'Unknown Products';
    else if (reason === 'Possible Typo') cat = 'Possible Typos';
    else if (reason === 'Missing') { continue; }
    else if (r.includes('quantity')) cat = 'Impossible Quantities';
    else if (r.includes('deviates')) cat = 'Revenue Inconsistencies';
    else if (r.includes('exceeds selling') || r.includes('cost price') && r.includes('exceeds')) cat = 'Cost Exceeds Price';
    else if (r.includes('future')) cat = 'Future Dates';
    else if (r.includes('before ' + validationConfig.minYear)) cat = 'Historical Dates';
    else if (r.includes('negative')) cat = 'Negative Values';
    else if (r.includes('exceeds business limit')) cat = 'Excluded Values';
    else if (r.includes('unusually large')) cat = 'Suspicious Values';
    else if (reason === 'cost_exceeds_price' || reason === 'revenue_consistency' || reason === 'date_future') {
      const rule = BUSINESS_RULES.find((r) => r.id === reason);
      cat = rule?.category || 'Business Rule Violation';
    }
    categorizedBusiness[cat] = (categorizedBusiness[cat] || 0) + count;
  }

  return {
    records,
    businessValid,
    businessInvalid,
    businessReport: {
      totalRows: records.length,
      businessValid: businessValid.length,
      businessInvalid: businessInvalid.length,
      issueSummary: categorizedBusiness,
      totalIssues: Object.values(businessIssues).reduce((s, v) => s + v, 0),
    },
  };
}

// ===================================================================
// ADAPTIVE DUPLICATE DETECTION
// ===================================================================

/**
 * Build a dedup key preferring transaction-level identifiers.
 * Falls back to progressively weaker composite keys, each with
 * a confidence score indicating how reliable the dedup is.
 *
 * Priority:
 *   1. invoice_number                       (confidence: 0.95)
 *   2. product + date + revenue + customer   (confidence: 0.60)
 *   3. product + date + quantity             (confidence: 0.40)
 */
function buildDedupKey(rec) {
  // Tier 1: transaction ID
  if (rec.invoice_number) {
    return { key: 'TXN|' + rec.invoice_number, confidence: 0.95 };
  }

  // Tier 2: receipt-like combo
  if (rec.product_name && rec.transaction_date && rec.revenue != null) {
    return {
      key: `REC|${rec.product_name}|${rec.transaction_date}|${rec.revenue}|${rec.customer || ''}`,
      confidence: 0.60,
    };
  }

  // Tier 3: weaker composite
  if (rec.product_name && rec.transaction_date) {
    return {
      key: `WEAK|${rec.product_name}|${rec.transaction_date}|${rec.quantity || ''}|${rec.selling_price || ''}`,
      confidence: 0.40,
    };
  }

  return null;
}

function deduplicateAdaptive(records) {
  if (!records || records.length === 0) return { records, duplicatesRemoved: 0 };

  const seen = new Map(); // key → index (first occurrence)
  const deduped = [];
  let duplicatesRemoved = 0;

  for (const rec of records) {
    const dk = buildDedupKey(rec);
    if (!dk) {
      deduped.push(rec);
      continue;
    }

    if (seen.has(dk.key)) {
      duplicatesRemoved++;
      // Mark duplicate
      if (!rec._quality) rec._quality = {};
      rec._quality.duplicate = true;
      rec._quality.duplicateOf = seen.get(dk.key);
      rec._quality.dedupConfidence = dk.confidence;
    } else {
      seen.set(dk.key, deduped.length);
      deduped.push(rec);
    }
  }

  return { records: deduped, duplicatesRemoved };
}

// ---- helpers for metric-level exclusion ----------------------------

/**
 * Map a problematic field to the analytics metric it affects.
 * A bad date → exclude from trends; bad quantity → exclude from quantity KPIs.
 * This enables per-metric exclusion instead of row-level exclusion.
 */
function getAffectedMetric(field, severity) {
  const isBad = severity === 'excluded' || severity === 'invalid';
  const map = {
    date:        isBad ? 'trends' : 'trends_warning',
    expiry_date: isBad ? 'trends' : 'trends_warning',
    quantity:    isBad ? 'quantity_metrics' : 'quantity_warning',
    revenue:     isBad ? 'revenue_metrics' : 'revenue_warning',
    selling_price: isBad ? 'revenue_metrics' : 'revenue_warning',
    cost_price:  isBad ? 'profitability' : 'profitability_warning',
    profit:      isBad ? 'profitability' : 'profitability_warning',
    margin:      isBad ? 'profitability' : 'profitability_warning',
    discount:    isBad ? 'profitability' : 'profitability_warning',
    tax:         isBad ? 'profitability' : 'profitability_warning',
    product_name: isBad ? 'product_breakdown' : 'product_breakdown',
    payment_method: 'payment_breakdown',
  };
  return map[field] || 'other';
}

function computeFieldAverage(fieldStatus) {
  if (!fieldStatus) return 1.0;
  const vals = Object.values(fieldStatus);
  if (vals.length === 0) return 1.0;
  return vals.reduce((s, st) => s + (typeof st === 'object' ? (st.confidence || 1) : 1), 0) / vals.length;
}

// ===================================================================
// COMBINED VALIDATOR (BACKWARD COMPATIBLE)
// ===================================================================

/**
 * Legacy wrapper — runs structural + business validation + adaptive dedup.
 * Returns the same shape as before so no downstream code breaks.
 */
function validateRecords(records) {
  if (!records || records.length === 0) {
    return { records: [], validRecords: [], excludedRecords: [], report: emptyReport() };
  }

  // Phase 1: Structural validation
  const struct = structuralValidate(records);

  // Phase 2: Business validation (on structurally valid records)
  const biz = businessValidate(records);

  // Adaptive dedup
  const dedupResult = deduplicateAdaptive(records);

  const totalUploaded = records.length;
  const structurallyValid = struct.structurallyValid.length;
  const businessValid = biz.businessValid.length;

  return {
    records,
    validRecords: biz.businessValid,
    excludedRecords: biz.businessInvalid,
    report: {
      rowsUploaded: totalUploaded,
      rowsParsed: totalUploaded,
      rowsStructurallyValid: structurallyValid,
      rowsBusinessValid: businessValid,
      rowsUsedForAnalytics: businessValid,
      rowsExcluded: totalUploaded - businessValid,
      overallQualityScore: totalUploaded > 0 ? Math.round((businessValid / totalUploaded) * 100) : 0,
      duplicatesRemoved: dedupResult.duplicatesRemoved,
      structuralIssues: struct.structuralReport.issueSummary,
      structuralTotal: struct.structuralReport.totalIssues,
      businessIssues: biz.businessReport.issueSummary,
      businessTotal: biz.businessReport.totalIssues,
      fieldConfidence: struct.structuralReport.fieldConfidence || {},
      structuralValid: structurallyValid,
      businessValid,
    },
  };
}

function emptyReport() {
  return {
    rowsUploaded: 0, rowsParsed: 0,
    rowsStructurallyValid: 0, rowsBusinessValid: 0,
    rowsUsedForAnalytics: 0, rowsExcluded: 0,
    overallQualityScore: 0,
    structuralIssues: {}, businessIssues: {},
    structuralTotal: 0, businessTotal: 0,
    fieldConfidence: {},
    structuralValid: 0, businessValid: 0,
  };
}

const FIELD_VALIDATORS = FIELD_SPECS; // legacy alias

module.exports = {
  configure, getConfig, PRESETS,
  structuralValidate, businessValidate, validateRecords,
  deduplicateAdaptive, buildDedupKey,
  classifyProduct, confidenceTier, CONFIDENCE,
  getAffectedMetric, computeFieldAverage,
  FIELD_VALIDATORS, FIELD_SPECS, BUSINESS_RULES,
};
