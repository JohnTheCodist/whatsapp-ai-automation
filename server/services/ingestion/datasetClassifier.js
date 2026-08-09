/**
 * Dataset Capability Analyzer — evolves the old Dataset Classifier into a
 * multi-capability detection engine.
 *
 * Instead of returning a single dataset type, it returns a capabilities map:
 *
 *   {
 *     primary_type: "sales_transaction",
 *     confidence: 91,
 *     capabilities: { sales: true, inventory: true, expiry: true, supplier: false, customer: false },
 *     recommended_dashboards: ["sales", "inventory"],
 *     dataset_type: "sales_transaction",  // backward-compatible
 *     reasons: [...]
 *   }
 *
 * Each capability is independently scored. A capability is "true" when its
 * confidence crosses 50%. recommended_dashboards mirrors the capabilities
 * object (keys where value is true).
 *
 * This module is isolated from the sales mapping pipeline. It runs BEFORE
 * any column mapping, normalization, or metric calculations.
 */

// ---- header normalisation -------------------------------------------------

function normalizeHeader(raw) {
  if (raw == null || raw === '') return '';
  return String(raw)
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // split camelCase: RevenueEUR → Revenue EUR
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // split acronym+word: EURPrice → EUR Price
    .toLowerCase()
    .replace(/[₦$€£¥%]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- value-pattern helpers ------------------------------------------------

function isExcelSerialDate(val) {
  if (typeof val !== 'number') return false;
  return val >= 1 && val <= 100000 && Number.isFinite(val) && val === Math.floor(val);
}

function isDateString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return true;
  if (/^\d{1,2}[\/\-\.\\_\s]\d{1,2}[\/\-\.\\_\s]\d{2,4}$/.test(s)) return true;
  if (/^\d{4}[\/\-\.\\_\s]\d{1,2}[\/\-\.\\_\s]\d{1,2}$/.test(s)) return true;
  if (/^[a-zA-Z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}$/.test(s)) return true;
  if (/^\d{1,2}(?:st|nd|rd|th)?\s+[a-zA-Z]{3,9}\s+\d{2,4}$/.test(s)) return true;
  if (/^\d{8}$/.test(s)) return true;
  if (/^\d{6}$/.test(s)) return true;
  if (/^\d{4}-\d{2}$/.test(s)) return true;
  return false;
}

function isYYYYMMDD(val) {
  if (typeof val === 'number' && Number.isFinite(val) && val === Math.floor(val)) {
    const s = String(val);
    if (s.length !== 8) return false;
    const year = parseInt(s.substring(0, 4), 10);
    const month = parseInt(s.substring(4, 6), 10);
    const day = parseInt(s.substring(6, 8), 10);
    return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  return false;
}

function looksLikeDate(val) {
  return isDateString(String(val)) || isExcelSerialDate(val) || isYYYYMMDD(val);
}

function looksLikeCurrency(val) {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return false;
    if (val !== Math.floor(val)) return Math.abs(val) >= 5;
    return Math.abs(val) > 1000;
  }
  if (typeof val !== 'string') return false;
  return /^[₦$€£¥]\s*-?[\d,]+(\.\d{1,2})?\s*$/.test(val.trim());
}

function looksLikePaymentMethod(val) {
  if (val == null || val === '') return false;
  return /cash|transfer|pos|card|insurance|credit|mobile|bank|ussd/i.test(String(val));
}

function looksLikeBatchNumber(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  if (isDateString(s)) return false;
  if (/^(LOT|BATCH|BN|BL)\s*[-_\/.]?\s*\d/i.test(s)) return true;
  if (/^B[-_\/.]\d{3,}$/i.test(s) && !/^(INV|REC|TXN|SALE|ORD|REF|BILL|DOC)/i.test(s)) return true;
  if (/^(BN|LOT|BATCH)\d{2,4}[-_\/.]?\d{1,}[A-Z]?$/i.test(s)) return true;
  if (/^\d{4}[-_\/.][A-Z]{2,4}$/i.test(s)) return true;
  return false;
}

function looksLikeInvoiceNumber(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  if (looksLikeBatchNumber(s)) return false;
  if (/^(INV|REC|TXN|TRANS|SALE|SALES|ORD|ORDER|REF|BILL|DOC)[-_\/.]?\s*\d/i.test(s)) return true;
  return /^[A-Z0-9\-_\.\/\#]{4,}$/i.test(s) &&
         /[A-Z].*\d/.test(s) &&
         s.length >= 5 &&
         !isDateString(s);
}

function looksLikeNumeric(val) {
  if (typeof val === 'number') return Number.isFinite(val);
  if (typeof val === 'string') {
    const n = Number(val.replace(/[,\s₦$€£¥%]/g, ''));
    return Number.isFinite(n);
  }
  return false;
}

function looksLikeText(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  return s.length >= 1 && s.length <= 200 && /[a-zA-Z]/.test(s);
}

function looksLikeExpiredDate(val) {
  if (!looksLikeDate(val)) return false;
  try {
    const d = new Date(val);
    return !isNaN(d.getTime());
  } catch { return false; }
}

function looksLikeSupplier(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  return s.length >= 3 && /[a-zA-Z]/.test(s) && !looksLikeDate(s);
}

function looksLikeCustomer(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  return /[a-zA-Z]/.test(s) && s.length >= 3 && s.length <= 100 && !looksLikeDate(s);
}

// ---- capability signal definitions ----------------------------------------

// Each capability has:
//   headerSignals: [ [pattern, label], ... ]
//   valueSignals:  { columnCountVar → weight }  (detected during value scan)
//   shapeSignals:  criteria for data shape scoring

const CAPABILITIES = {
  sales: {
    headerSignals: [
      [/\binvoice\b|\breceipt\b|\bbill(?:ing)?\b|\btransaction\b|\btxn\b|\bsale\b|\bsales\b|\bselling\b/i, 'Transaction reference'],
      [/\bpayment\b|\btender\b|\bcash\b|\btransfer\b|\bpos\b|\bcard\b|\bmode\s*of\s*payment/i, 'Payment method'],
      [/\bcashier\b|\battendant\b|\bsales\s*(rep|person|man|representative)\b|\bdispenser\b|\bstaff\b|\bpharmacist\b|\bteller\b|\bagent\b|\bseller\b|\bserved\s*by\b/i, 'Sales staff'],
      [/\bdiscount\b|\bdeduction\b|\brebate\b|\bmarkdown\b|\bconcession\b/i, 'Discount'],
      [/\btax\b|\bvat\b|\bgst\b|\blevy\b/i, 'Tax/VAT'],
      [/\brevenue\b|\bamount\b|\btotal\b|\bgross\b|\bturnover\b|\bsum\b/i, 'Revenue/amount'],
      [/\bprofit\b|\bearnings?\b|\bgain\b|\bincome\b/i, 'Profit'],
      [/\bmargin\b|\bmarkup\b/i, 'Margin'],
      [/\bchannel\b|\bplatform\b|\bmarketplace\b/i, 'Sales channel'],
      [/\bbranch\b|\bstore\b|\bshop\b|\boutlet\b|\bpharmacy\b|\blocation\b|\bsite\b/i, 'Branch/location'],
    ],
    valueWeights: { currencyColumnCount: 3, dateColumnCount: 2, paymentMethodColumnCount: 2, invoiceColumnCount: 2 },
    shapeScore: (ctx) => {
      let s = 0;
      const { productRepeatRate, numRows } = ctx;
      if (productRepeatRate >= 5) s += 0.25;
      else if (productRepeatRate >= 3) s += 0.20;
      else if (productRepeatRate >= 2) s += 0.12;
      if (numRows >= 500) s += 0.10;
      else if (numRows >= 100) s += 0.06;
      else if (numRows >= 20) s += 0.03;
      return s;
    },
  },

  inventory: {
    headerSignals: [
      [/\bstock\b|\binventory\b/i, 'Stock/inventory'],
      [/\bopening\b|\bclosing\b|\bbeginning\b|\bending\b/i, 'Opening/closing stock'],
      [/\breorder\b|\bre.?order\b|\bminimum\b|\bmaximum\b|\bmin\b|\bmax\b/i, 'Reorder/min-max levels'],
      [/\bbatch\b|\blot\b/i, 'Batch/lot number'],
      [/\bpack.?size\b|\bdosage.?form\b|\bstrength\b|\bformulation\b/i, 'Product attributes'],
      [/\bwarehouse\b|\bdepot\b|\bstoreroom\b|\bstore.?room\b|\bstorage\b/i, 'Warehouse'],
    ],
    valueWeights: { batchColumnCount: 3, textColumnCount: 2 },
    shapeScore: (ctx) => {
      let s = 0;
      const { productRepeatRate, numRows } = ctx;
      if (productRepeatRate <= 1.1 && productRepeatRate > 0) s += 0.25;
      else if (productRepeatRate <= 1.5 && productRepeatRate > 0) s += 0.15;
      if (numRows <= 50) s += 0.10;
      else if (numRows <= 200) s += 0.05;
      return s;
    },
  },

  expiry: {
    headerSignals: [
      [/\bexpir(?:y|ation|e)\b|\bexp\b|\bbest.?before\b|\buse.?by\b|\bshelf.?life\b/i, 'Expiry date'],
      [/\bexpir(?:y|ation)\s*date\b/i, 'Expiry date'],
    ],
    valueWeights: { dateColumnCount: 2, textColumnCount: 1 },
    shapeScore: () => 0, // expiry is purely header/value driven
  },

  supplier: {
    headerSignals: [
      [/\bsupplier\b|\bvendor\b|\bsource\b/i, 'Supplier'],
      [/\bmanufacturer\b|\bmade.?by\b|\bproducer\b|\bmfr\b|\bcompany\b/i, 'Manufacturer'],
    ],
    valueWeights: { textColumnCount: 2 },
    shapeScore: () => 0,
  },

  customer: {
    headerSignals: [
      [/\bcustomer\b|\bpatient\b|\bclient\b|\bbuyer\b|\bpurchaser\b/i, 'Customer/patient'],
      [/\bcustomer\s*name\b|\bpatient\s*name\b|\bcustomer\s*id\b|\bpatient\s*id\b/i, 'Customer identifier'],
      [/\bage\b|\bgender\b|\bsex\b/i, 'Demographics'],
    ],
    valueWeights: { textColumnCount: 2 },
    shapeScore: () => 0,
  },
};

// ---- main analysis function -----------------------------------------------

/**
 * @param {object[]} rows — raw parsed rows from the spreadsheet
 * @param {number} [sampleSize=50]
 * @returns {object} capabilities analysis
 */
function classifyDataset(rows, sampleSize = 50) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      primary_type: 'unknown',
      confidence: 0,
      capabilities: { sales: false, inventory: false, expiry: false, supplier: false, customer: false },
      recommended_dashboards: [],
      dataset_type: 'unknown',
      reasons: ['No data rows found in the file.'],
    };
  }

  const rawHeaders = Object.keys(rows[0]);
  const sample = rows.slice(0, sampleSize);
  const numRows = rows.length;

  // Collect sample values per column
  const columnValues = new Map();
  for (const h of rawHeaders) {
    columnValues.set(h, sample.map((r) => r[h]));
  }

  // ---- 1. Value-pattern scan (run once, used by all capabilities) ---------

  let dateColumnCount = 0;
  let currencyColumnCount = 0;
  let paymentMethodColumnCount = 0;
  let invoiceColumnCount = 0;
  let batchColumnCount = 0;
  let textColumnCount = 0;

  for (const rawHeader of rawHeaders) {
    const vals = columnValues.get(rawHeader);
    const cleanVals = vals.filter((v) => v != null && v !== '');

    const dateCount = cleanVals.filter((v) => looksLikeDate(v)).length;
    if (dateCount / cleanVals.length >= 0.5) dateColumnCount++;

    const currencyCount = cleanVals.filter((v) => looksLikeCurrency(v)).length;
    if (currencyCount / cleanVals.length >= 0.5) currencyColumnCount++;

    const pmCount = cleanVals.filter((v) => looksLikePaymentMethod(v)).length;
    if (pmCount / cleanVals.length >= 0.3) paymentMethodColumnCount++;

    const invCount = cleanVals.filter((v) => looksLikeInvoiceNumber(String(v))).length;
    if (invCount / cleanVals.length >= 0.5) invoiceColumnCount++;

    const batchCount = cleanVals.filter((v) => looksLikeBatchNumber(String(v))).length;
    if (batchCount / cleanVals.length >= 0.5) batchColumnCount++;

    const textCount = cleanVals.filter((v) => looksLikeText(String(v))).length;
    if (textCount / cleanVals.length >= 0.5) textColumnCount++;
  }

  // ---- 2. Product repetition analysis (shared) ----------------------------

  const productCandidateHeaders = rawHeaders.filter((h) => {
    // Use ALL rows for product detection (not just sample) to correctly
    // identify columns with moderate uniqueness in large datasets.
    const vals = rows.map((r) => r[h]).filter((v) => v != null && v !== '');
    if (vals.length === 0) return false;
    const textRate = vals.filter((v) => looksLikeText(String(v))).length / vals.length;
    const numericRate = vals.filter((v) => looksLikeNumeric(v)).length / vals.length;
    if (textRate >= 0.5) return true;
    if (numericRate >= 0.8) {
      const uniqueVals = new Set(vals);
      const uniqueness = uniqueVals.size / vals.length;
      // Allow higher uniqueness for large datasets (more rows → more likely to see repeats)
      const maxUnique = numRows > 5000 ? 0.95 : 0.80;
      if (uniqueness >= 0.02 && uniqueness <= maxUnique) return true;
    }
    return false;
  });

  const PRODUCT_HEADER_PATTERN = /\b(product|drug|medicine|item|name|description)\b/i;
  let bestProductHeader = null;
  let bestProductScore = -1;

  for (const h of productCandidateHeaders) {
    const allVals = rows.map((r) => r[h]).filter((v) => v != null && v !== '');
    if (allVals.length === 0) continue;
    const uniqueVals = new Set(allVals);
    const repeatRatio = 1 - (uniqueVals.size / allVals.length);
    const uniqueness = uniqueVals.size / allVals.length;
    const headerMatch = PRODUCT_HEADER_PATTERN.test(normalizeHeader(h));
    const goodRange = uniqueness >= 0.02 && uniqueness <= 1.0;
    if (!goodRange) continue;

    let score = repeatRatio * 10;
    if (headerMatch) score += 20;
    if (uniqueness > 0.85) score -= 5;

    if (score > bestProductScore) {
      bestProductScore = score;
      bestProductHeader = h;
    }
  }

  let productRepeatRate = 0;
  let productCount = 0;

  if (bestProductHeader) {
    const allVals = rows.map((r) => r[bestProductHeader]).filter((v) => v != null && v !== '');
    productCount = new Set(allVals).size;
    productRepeatRate = productCount > 0 ? allVals.length / productCount : 0;
  }

  // ---- 3. Score each capability independently -----------------------------

  const valueColumns = { dateColumnCount, currencyColumnCount, paymentMethodColumnCount, invoiceColumnCount, batchColumnCount, textColumnCount };
  const shapeCtx = { productRepeatRate, numRows, productCount };
  const maxHeaders = Math.max(rawHeaders.length, 1);
  const scores = {};
  const allReasons = [];
  const headerDetections = {}; // for reasons

  // Sales is determined purely by hasTransactionCapability, not scored.
  for (const capKey of Object.keys(CAPABILITIES).filter((k) => k !== 'sales')) {
    const cap = CAPABILITIES[capKey];
    let headerHits = 0;
    const headerReasons = [];

    for (const rawHeader of rawHeaders) {
      const h = normalizeHeader(rawHeader);
      for (const [pattern, label] of cap.headerSignals) {
        if (pattern.test(h)) {
          headerHits++;
          headerReasons.push(`"${rawHeader}" → ${label}`);
          break;
        }
      }
    }

    if (headerReasons.length > 0) {
      allReasons.push(...headerReasons.map((r) => `${r} detected`));
    }

    // Header component (35% of score)
    const headerAware = headerHits > 0;
    const headerRatio = headerAware ? headerHits / maxHeaders : 0;
    let score = headerRatio * 0.35;

    // Value component (30% of score)
    if (cap.valueWeights && headerAware) {
      const totalWeight = Object.values(cap.valueWeights).reduce((a, b) => a + b, 0);
      let weightedSum = 0;
      for (const [colKey, weight] of Object.entries(cap.valueWeights)) {
        if (valueColumns[colKey] > 0) weightedSum += weight;
      }
      score += (weightedSum / totalWeight) * 0.30;
    }

    // Shape component (remaining 35%)
    score += cap.shapeScore(shapeCtx);

    scores[capKey] = score;
  }

  // ---- 4. Global suppression — only for truly empty datasets --------------

  // No currency, date, or text at all → no meaningful data
  if (currencyColumnCount === 0 && dateColumnCount === 0 && textColumnCount === 0) {
    for (const k of Object.keys(scores)) scores[k] *= 0.15;
  }

  // ---- 5. Convert scores to confidence — each capability normalised independently

  const confidences = {};
  const capabilities = {};
  const recommendedDashboards = [];

  // Each capability has a theoretical max based on its weights + shapeScore
  const maxPossible = {
    inventory: 0.35 + 0.30 + 0.25 + 0.10,
    expiry: 0.35 + 0.30,
    supplier: 0.35 + 0.30,
    customer: 0.35 + 0.30,
  };

  const ACTIVATION_THRESHOLD = 50; // percentage of max possible score

  for (const k of Object.keys(scores)) {
    const max = maxPossible[k];
    confidences[k] = max > 0 ? Math.round((scores[k] / max) * 100) : 0;
    if (confidences[k] > 100) confidences[k] = 100;
    capabilities[k] = confidences[k] >= ACTIVATION_THRESHOLD;
  }

  // ---- Sales capability: pure binary, no scoring. One gate for everything. ----
  {
    const { detectSchema } = require('./schemaDetector');
    const { resolveMapping, hasTransactionCapability } = require('./columnMapper');
    try {
      const schema = detectSchema(rows);
      if (schema && schema.length > 0) {
        const { mapping, tiers } = resolveMapping(schema);
        capabilities.sales = hasTransactionCapability(mapping, tiers);
        confidences.sales = capabilities.sales ? 100 : 0;
      }
    } catch (_) {
      capabilities.sales = false;
      confidences.sales = 0;
    }
  }

  recommendedDashboards.push(...Object.keys(capabilities).filter((k) => capabilities[k]));

  // ---- 6. Determine primary type ------------------------------------------

  let primaryType = 'unknown';
  let primaryConfidence = 0;
  for (const k of Object.keys(confidences)) {
    if (confidences[k] > primaryConfidence) {
      primaryConfidence = confidences[k];
      primaryType = k === 'expiry' || k === 'supplier' || k === 'customer'
        ? 'inventory_snapshot' // legacy type mapping
        : k === 'sales' ? 'sales_transaction' : 'inventory_snapshot';
    }
  }

  // If multiple capabilities are strong, label as mixed
  const strongCaps = Object.values(capabilities).filter(Boolean).length;
  if (strongCaps >= 3) primaryType = 'mixed';

  // ---- 7. Build reasons ---------------------------------------------------

  const finalReasons = [...new Set(allReasons)];

  // Add capability-specific summary signals
  if (capabilities.sales && productRepeatRate >= 3) {
    finalReasons.push('High product repetition — consistent with sales transactions');
  }
  if (capabilities.inventory && productRepeatRate <= 1.1 && productRepeatRate > 0) {
    finalReasons.push('One row per product — consistent with inventory records');
  }
  if (capabilities.expiry) {
    finalReasons.push('Expiry tracking fields present');
  }
  if (capabilities.supplier) {
    finalReasons.push('Supplier/manufacturer information detected');
  }
  if (capabilities.customer) {
    finalReasons.push('Customer/patient information detected');
  }
  if (numRows >= 500) finalReasons.push('Large dataset');
  if (numRows <= 30 && numRows > 0) finalReasons.push('Small dataset');
  if (strongCaps >= 3) finalReasons.push('Multi-purpose dataset — supports several analytical views');

  // Backward-compatible dataset_type
  let datasetType = 'unknown';
  if (capabilities.sales) {
    datasetType = 'sales_transaction';
  } else if (capabilities.inventory) {
    datasetType = 'inventory_snapshot';
  }

  return {
    primary_type: primaryType,
    confidence: primaryConfidence,
    capabilities,
    recommended_dashboards: recommendedDashboards,
    dataset_type: datasetType,
    reasons: finalReasons,
    _scores: process.env.NODE_ENV === 'development' ? confidences : undefined,
  };
}

module.exports = { classifyDataset };
