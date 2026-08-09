/**
 * SchemaDetector — detects column semantics from headers and sample values.
 *
 * Phase 2: Integrates LLM-powered mapping alongside rule-based detection.
 * For each column in the uploaded spreadsheet:
 *   1. Normalizes the header name.
 *   2. Scores header similarity against the dictionary (rule-based).
 *   3. Inspects sample values (type detection, pattern matching).
 *   4. Optionally augments with LLM semantic mapping.
 *   5. Combines header + value + LLM evidence into confidence scores.
 *   6. Falls back to token-based best-guess when no strong match exists.
 *   7. Cross-column disambiguation for similar columns.
 *
 * Returns an array of { rawHeader, normalizedHeader, detections[] }
 * where each detection is { category, confidence, source }.
 */

const { DICTIONARY, canonicalize, FIELD_METADATA, isIgnoredColumn } = require('./dictionary');

// ---- common abbreviation / acronym expansions ---------------------------

const SMART_HINTS = {
  rep: 'representative',
  reps: 'representative',
  no: 'number',
  num: 'number',
  id: 'identifier',
  code: 'identifier',
  ref: 'reference',
  qty: 'quantity',
  amt: 'amount',
  desc: 'description',
  addr: 'address',
  loc: 'location',
  wh: 'warehouse',
  mfr: 'manufacturer',
  mfg: 'manufacturer',
  cat: 'category',
  subcat: 'subcategory',
  chnl: 'channel',
  cust: 'customer',
  client: 'customer',
  rep_name: 'representative name',
  rep_name_staff: 'representative',
  staff_name: 'representative',
  salesperson: 'representative',
  salesman: 'representative',
  attendant: 'representative',
  pharmacist: 'representative',
  cashier: 'representative',
  dispenser: 'representative',
  agent: 'representative',
  seller: 'representative',
  teller: 'representative',
  employee: 'representative',
  whatsapp: 'channel',
  online: 'channel',
  web: 'channel',
  digital: 'channel',
  retail: 'channel',
  wholesale: 'channel',
  pos: 'channel',
  hospital: 'channel',
  hmo: 'customer',
  patient: 'customer',
  buyer: 'customer',
  purchaser: 'customer',
  vendor: 'supplier',
  suppliername: 'supplier',
  vendorname: 'supplier',
  batchno: 'batch',
  lotno: 'batch',
  batchnumber: 'batch',
  lotnumber: 'batch',
  serialno: 'batch',
  invno: 'invoice',
  invnumber: 'invoice',
  receiptno: 'invoice',
  billno: 'invoice',
  orderno: 'invoice',
  txnid: 'invoice',
  orderid: 'invoice',
  expdate: 'expiry',
  expirydate: 'expiry',
  shelflife: 'expiry',
  bestbefore: 'expiry',
  useby: 'expiry',
  branchname: 'branch',
  branchcode: 'branch',
  storename: 'branch',
  storecode: 'branch',
  outletname: 'branch',
  outletcode: 'branch',
  pharmacyname: 'branch',
  pharmacycode: 'branch',
  location: 'branch',
  site: 'branch',
  shop: 'branch',
  warehousename: 'warehouse',
  warehousecode: 'warehouse',
  storeroom: 'warehouse',
  stockroom: 'warehouse',
  depot: 'warehouse',
  storagelocation: 'warehouse',
  discountamount: 'discount',
  discountvalue: 'discount',
  discountpct: 'discount',
  discountpercent: 'discount',
  taxamount: 'tax',
  taxvalue: 'tax',
  vatamount: 'tax',
  taxpct: 'tax',
  taxpercent: 'tax',
  profitamount: 'profit',
  profitvalue: 'profit',
  marginpct: 'margin',
  marginpercent: 'margin',
  marginvalue: 'margin',
  // Phase 1 — dosage form & strength hints
  tab: 'tablet',
  tabs: 'tablet',
  cap: 'capsule',
  caps: 'capsule',
  susp: 'suspension',
  inj: 'injection',
  syr: 'syrup',
  crm: 'cream',
  oint: 'ointment',
  dro: 'drops',
  drop: 'drops',
  soln: 'solution',
  pwd: 'powder',
  gran: 'granules',
  supp: 'suppository',
  pess: 'pessary',
  inh: 'inhaler',
  neb: 'nebuliser',
  amp: 'ampoule',
  vial: 'vial',
  sach: 'sachet',
  lotn: 'lotion',
  gel: 'gel',
  spray: 'spray',
  patch: 'patch',
  strip: 'strip',
  blister: 'blister',
  form: 'dosage form',
  dosage: 'strength',
  dose: 'strength',
  conc: 'concentration',
  potency: 'strength',
  pack: 'pack size',
  package: 'pack size',
  packaging: 'pack size',
};

// ---- helpers -----------------------------------------------------------

/**
 * Normalize a raw column header:
 *   lowercased, punctuation removed, currency symbols removed,
 *   underscores/hyphens → spaces, whitespace collapsed.
 */
function normalizeHeader(raw) {
  if (raw == null || raw === '') return '';
  return String(raw)
    // Split camelCase and PascalCase BEFORE lowercasing, while the boundaries
    // are still visible. Without this, "TotalAmount_NGN" became the single
    // token "totalamount", which the matcher could only score by containment --
    // and "totalamount" contains "amount", a synonym of tax, just as readily as
    // it contains "total". Tax won, so a pharmacy's revenue column was read as
    // a tax column. Split, it is ["total","amount","ngn"], which matches
    // revenue's "total amount" on two exact tokens and settles it.
    //
    // Two patterns: "aB" for the ordinary boundary, and "ABCd" for an acronym
    // running into a word, so "NGNTotal" parts as "NGN Total" rather than
    // "NGNTota l".
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[₦$€£¥]/g, '')               // currency symbols
    .replace(/[^a-z0-9\s]/g, ' ')           // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

/**
 * Normalized similarity — 0 to 1.
 */
function textSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ---- token-based matching -----------------------------------------------

/**
 * Split a string into meaningful tokens:
 *   - CamelCase / PascalCase boundaries: "SupplierName" → ["supplier", "name"]
 *   - Underscores / hyphens → split boundaries
 *   - Spaces → split boundaries
 *   - Digits at token boundaries are kept with their context
 */
function tokenize(str) {
  if (!str || str === '') return [];
  const s = str.toLowerCase().trim();

  // Split on camelCase boundaries: "supplierName" → "supplier Name"
  const withSpaces = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Split on underscores, hyphens, spaces
  const tokens = withSpaces
    .split(/[\s_\-]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);

  return tokens;
}

/**
 * Compute token-overlap score between a column header and a dictionary synonym.
 * Weighted Jaccard-like: matching tokens contribute more than non-matching ones.
 */
function tokenOverlapScore(headerTokens, synonymTokens) {
  if (headerTokens.length === 0 || synonymTokens.length === 0) return 0;

  let matchCount = 0;
  let partialCount = 0;

  for (const ht of headerTokens) {
    // Ignore very short noise tokens (< 2 chars) unless they're meaningful
    if (ht.length < 2 && !/^[a-z]{1}$/i.test(ht)) continue;

    for (const st of synonymTokens) {
      if (ht === st) {
        matchCount++;
        break;
      }
      // Partial: one contains the other (e.g., "supplier" in "suppliername")
      if (ht.length >= 3 && st.length >= 3 && (ht.includes(st) || st.includes(ht))) {
        partialCount += 0.5;
        break;
      }
      // Fuzzy: close Levenshtein on individual tokens
      if (textSimilarity(ht, st) > 0.75) {
        partialCount += 0.4;
        break;
      }
    }
  }

  // Weight: exact token matches > partial matches
  const weighted = matchCount + partialCount * 0.6;
  return Math.min(1, weighted / Math.max(headerTokens.length, 1) * 1.2);
}

/**
 * Expand common abbreviations and short forms using SMART_HINTS.
 * E.g., "rep" → "representative", "no" → "number"
 */
function expandHint(token) {
  const clean = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SMART_HINTS[clean] || null;
}

/**
 * Build a canonical token list for a header, applying hint expansions
 * to help match abbreviated column names.
 */
function canonicalTokens(header) {
  const raw = tokenize(header);
  const expanded = [];
  for (const token of raw) {
    expanded.push(token);
    const hint = expandHint(token);
    if (hint) {
      // Add expanded form tokens as bonus matches
      for (const ht of tokenize(hint)) {
        if (!expanded.includes(ht)) expanded.push(ht);
      }
    }
  }
  return expanded;
}

// ---- value-pattern detection -------------------------------------------

function isExcelSerialDate(val) {
  if (typeof val !== 'number') return false;
  // Excel serial dates range from 1 (Jan 1, 1900) to ~100000 (mid 2173)
  return val >= 1 && val <= 100000 && Number.isFinite(val) && val === Math.floor(val);
}

function isDateString(val) {
  if (typeof val !== 'string') return false;
  const s = val.trim();
  if (!s) return false;
  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  // ISO datetime: YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return true;
  // DD/MM/YYYY or MM/DD/YYYY (slash, dash, dot, backslash, underscore, space)
  if (/^\d{1,2}[\/\-\.\\_\s]\d{1,2}[\/\-\.\\_\s]\d{2,4}$/.test(s)) return true;
  // YYYY/MM/DD
  if (/^\d{4}[\/\-\.\\_\s]\d{1,2}[\/\-\.\\_\s]\d{1,2}$/.test(s)) return true;
  // Month name formats: "20 May 2024" or "May 20, 2024"
  if (/^[a-zA-Z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}$/.test(s)) return true;
  if (/^\d{1,2}(?:st|nd|rd|th)?\s+[a-zA-Z]{3,9}\s+\d{2,4}$/.test(s)) return true;
  // DD-Mon-YYYY or DD/Mon/YYYY (hyphen/slash-separated month name): "25-Dec-2024"
  if (/^\d{1,2}[\/\-\.]\s*[a-zA-Z]{3,9}\s*[\/\-\.]\d{2,4}$/.test(s)) return true;
  // Compact: YYYYMMDD or DDMMYYYY (8 digits) or DDMMYY (6 digits)
  if (/^\d{8}$/.test(s)) return true;
  if (/^\d{6}$/.test(s)) return true;
  // YYYY-MM (month only)
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

const CURRENCY_RE = /^[₦$€£¥]?\s*-?[\d,]+(\.\d{1,2})?\s*$/;

function isCurrencyValue(val) {
  if (typeof val === 'number') return Number.isFinite(val);
  if (typeof val !== 'string') return false;
  return CURRENCY_RE.test(val.trim());
}

function looksLikeProduct(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  if (!/[a-zA-Z]/.test(s)) return false;
  if (isCurrencyValue(s)) return false;
  if (isDateString(s)) return false;
  if (s.length < 2 || s.length > 120) return false;
  return true;
}

function looksLikeText(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  if (s.length < 1 || s.length > 200) return false;
  return /[a-zA-Z]/.test(s);
}

function looksLikeBatchNumber(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  // Batch/lot numbers: alphanumeric codes, often with hyphens or slashes
  return /^[a-zA-Z0-9][a-zA-Z0-9\-\/\.\_]{2,30}$/.test(s) &&
         /[a-zA-Z]/.test(s) && // must have at least one letter (not just a number)
         !isDateString(s);
}

function looksLikeInvoiceNumber(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  // Invoice/receipt numbers: alphanumeric reference codes
  return /^[a-zA-Z0-9][a-zA-Z0-9\-\/\.\_\#]{1,40}$/.test(s) &&
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

function looksLikePercentage(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  const hasPercent = s.endsWith('%');
  const n = Number(s.replace(/[,\s%]/g, ''));
  if (Number.isFinite(n)) {
    // Percentage values typically 0-100 (or 0-1 in decimal form)
    if (hasPercent) return n >= 0 && n <= 100;
    // Check if value is likely a percentage (0-100) vs currency (larger values)
    return n >= 0 && n <= 100;
  }
  return false;
}

function looksLikeQuantity(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 && val === Math.floor(val) && val < 100000;
  }
  if (typeof val === 'string') {
    const n = Number(val.replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 && n === Math.floor(n) && n < 100000;
  }
  return false;
}

/**
 * Revenue vs selling_price disambiguation:
 *   - "Amount" / "Total" columns = revenue
 *   - "Price" / "Rate" columns = selling_price
 *   - Values in thousands = likely revenue
 *   - Values in hundreds = likely selling_price
 */
function looksLikeRevenue(header, sampleValues) {
  const h = normalizeHeader(header);
  // Header signals for revenue
  if (/\btotal\b|\bamount\b|\bsum\b|\bgross\b|\bturnover\b|\binvoice\b/i.test(h)) {
    return 0.8;
  }
  // Check value magnitudes
  const nums = sampleValues
    .filter((v) => v != null && v !== '')
    .map((v) => typeof v === 'number' ? v : Number(String(v).replace(/[₦$€£¥,]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (nums.length > 0) {
    const avg = nums.reduce((s, n) => s + n, 0) / nums.length;
    // Values > 5000 are more likely revenue (total) than unit price
    if (avg > 5000) return 0.7;
    if (avg > 1000) return 0.5;
  }
  return 0;
}

function looksLikeSellingPrice(header, sampleValues) {
  const h = normalizeHeader(header);
  // Margin/markup columns are neither selling_price nor cost_price
  if (/margin|markup/i.test(h)) return 0;
  // Match "selling" and "retail" without word boundaries so compound words
  // like "SellingCost" and "RetailCost" are correctly detected.
  if (/\bprice\b|\brate\b|\bsp\b|\bmrp\b|\bsrp\b|selling|retail|\bunit/i.test(h)) {
    return 0.8;
  }
  const nums = sampleValues
    .filter((v) => v != null && v !== '')
    .map((v) => typeof v === 'number' ? v : Number(String(v).replace(/[₦$€£¥,]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (nums.length > 0) {
    const avg = nums.reduce((s, n) => s + n, 0) / nums.length;
    if (avg <= 1000) return 0.6;
  }
  return 0;
}

/**
 * Cost-per-unit vs cost-total disambiguation.
 *   - Header keywords "total cost", "cost amount" → likely a total
 *   - Values in the same magnitude as revenue → likely a total
 *   - Values in the same magnitude as selling_price → likely per-unit
 */
function looksLikeCostTotal(header, sampleValues, revenueAvg) {
  const h = normalizeHeader(header);
  // Header signals for total cost
  if (/\btotal\b.*\bcost\b|\bcost\b.*\btotal\b|\bcost\b.*\bamount\b/i.test(h)) {
    return 0.8;
  }
  const nums = sampleValues
    .filter((v) => v != null && v !== '')
    .map((v) => typeof v === 'number' ? v : Number(String(v).replace(/[₦$€£¥,]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (nums.length === 0) return 0;

  const avg = nums.reduce((s, n) => s + n, 0) / nums.length;

  // Magnitude check: if values are large, more likely totals
  let score = 0;
  if (avg > 5000) score = 0.6;
  else if (avg > 1000) score = 0.35;

  // Cross-reference with revenue: if cost avg is within 2x of revenue avg,
  // strong signal that cost is a total (per-unit costs are typically much smaller).
  if (revenueAvg != null && revenueAvg > 0) {
    const ratio = avg / revenueAvg;
    if (ratio >= 0.3 && ratio <= 3.0) score = Math.max(score, 0.7);
    else if (ratio >= 0.15 && ratio <= 5.0) score = Math.max(score, 0.5);
  }

  return score;
}

// ---- Phase 1: new field type detectors ----------------------------------

/**
 * Detect dosage strength values like "500mg", "10mg/ml", "5%", "50mcg".
 */
function looksLikeStrength(val) {
  if (val == null || val === '') return false;
  const s = String(val).trim();
  // Numeric + unit: 500mg, 10mg/ml, 50mcg, 5g, 1000IU, 5%
  if (/^\d+(\.\d+)?\s*(mg|g|mcg|μg|iu|ml|l|%|w\/v|w\/w|v\/v)\b/i.test(s)) return true;
  // Just numeric: small numbers (e.g., 500, 250, 100 — strength in mg)
  const n = Number(s.replace(/[,\s]/g, ''));
  if (Number.isFinite(n) && n > 0 && n <= 2000 && n === Math.floor(n)) return true;
  // Compound: "500mg/5ml", "250mg+50mg"
  if (/^\d+(\.\d+)?\s*(mg|g|mcg|μg|iu|ml|l)%?\s*[\+\/]\s*\d+(\.\d+)?\s*(mg|g|mcg|μg|iu|ml|l)%?/i.test(s)) return true;
  return false;
}

/**
 * Detect dosage form values like "Tablet", "Capsule", "Syrup", "Injection".
 */
const KNOWN_DOSAGE_FORMS = new Set([
  'tablet', 'tablets', 'caplet', 'caplets',
  'capsule', 'capsules',
  'syrup', 'syrups',
  'suspension', 'suspensions',
  'injection', 'injections', 'injectable',
  'cream', 'creams',
  'ointment', 'ointments',
  'drops', 'drop',
  'solution', 'solutions',
  'powder', 'powders',
  'granules', 'granule',
  'suppository', 'suppositories',
  'pessary', 'pessaries',
  'inhaler', 'inhalers',
  'nebuliser', 'nebuliser solution',
  'ampoule', 'ampoules',
  'vial', 'vials',
  'sachet', 'sachets',
  'lotion', 'lotions',
  'gel', 'gels',
  'spray', 'sprays',
  'patch', 'patches',
  'lozenge', 'lozenges',
  'pastille', 'pastilles',
  'gargle', 'gargles',
  'mouthwash',
  'effervescent', 'effervescent tablet',
  'chewable', 'chewable tablet',
  'dispersible', 'dispersible tablet',
  'sublingual', 'sublingual tablet',
  'sustained release', 'sustained release tablet',
  'extended release', 'extended release capsule',
  'film coated', 'film coated tablet',
  'sugar coated', 'sugar coated tablet',
  'enteric coated', 'enteric coated tablet',
  'orally disintegrating',
  'oral', 'topical', 'ophthalmic', 'otic', 'nasal',
]);

function looksLikeDosageForm(val) {
  if (val == null || val === '') return false;
  const s = String(val).toLowerCase().trim();
  return KNOWN_DOSAGE_FORMS.has(s) || KNOWN_DOSAGE_FORMS.has(s.replace(/s$/, ''));
}

/**
 * Detect pack size values: small integers typically 1–1000.
 */
function looksLikePackSize(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 1 && val <= 1000 && val === Math.floor(val);
  }
  if (typeof val === 'string') {
    const s = val.trim();
    // Pack size descriptions: "10 tablets", "28 capsules", "100ml"
    if (/^\d+\s*(tablets|capsules|sachets|vials|ampoules|ml|g|units|pcs|pieces?)?$/i.test(s)) {
      return true;
    }
    const n = Number(s.replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n >= 1 && n <= 1000 && n === Math.floor(n);
  }
  return false;
}

// ---- main detection logic -----------------------------------------------

function detectColumn(normalizedHeader, collapsedHeader, rawHeader, sampleValues, allColumnsContext) {
  const detections = [];
  const cleanValues = sampleValues.filter((v) => v != null && v !== '');
  const hTokens = canonicalTokens(normalizedHeader);

  for (const [category, synonyms] of Object.entries(DICTIONARY)) {
    let headerScore = 0;
    let headerSource = '';
    let tokenScore = 0;
    let tokenSource = '';

    for (const synonym of synonyms) {
      const sClean = synonym.toLowerCase().trim();
      const sCollapsed = sClean.replace(/\s/g, '');

      // 1) Exact match
      if (normalizedHeader === sClean || collapsedHeader === sCollapsed) {
        headerScore = 1.0;
        headerSource = `exact match: "${synonym}"`;
        break;
      }

      // 2) Levenshtein fuzzy match
      const sim1 = textSimilarity(normalizedHeader, sClean);
      const sim2 = textSimilarity(collapsedHeader, sCollapsed);
      const sim = Math.max(sim1, sim2);
      if (sim > headerScore && sim > 0.5) {
        headerScore = sim;
        headerSource = `fuzzy match (${Math.round(sim * 100)}%): "${synonym}"`;
      }

      // 3) Substring match
      if (collapsedHeader.length >= 2 && sCollapsed.length >= 2) {
        if (collapsedHeader.includes(sCollapsed) || sCollapsed.includes(collapsedHeader)) {
          const subScore = Math.min(collapsedHeader.length, sCollapsed.length) /
                            Math.max(collapsedHeader.length, sCollapsed.length);
          if (subScore > headerScore && subScore >= 0.5) {
            headerScore = subScore;
            headerSource = `substring match: "${synonym}"`;
          }
        }
      }

      // 4) Token-level match — split both into words and compare
      const sTokens = tokenize(sClean);
      if (hTokens.length >= 2 || sTokens.length >= 2) {
        const tScore = tokenOverlapScore(hTokens, sTokens);
        if (tScore > tokenScore && tScore >= 0.4) {
          tokenScore = tScore;
          tokenSource = `token match (${Math.round(tokenScore * 100)}%) with "${synonym}"`;
        }
      }
    }

    // Boost header score with token score for compound names
    if (tokenScore > headerScore && tokenScore >= 0.5) {
      headerScore = Math.max(headerScore, tokenScore * 0.9);
      if (!headerSource) headerSource = tokenSource;
    }

    // Margin/markup columns are neither selling_price nor cost_price —
    // penalise selling_price headerScore so they aren't falsely matched
    // by fuzzy similarity (e.g. "margincost" ≈ "sellingcost").
    if (category === 'selling_price' && /margin|markup/i.test(normalizedHeader)) {
      headerScore *= 0.3;
    }

    // Value-pattern score
    let valueScore = 0;
    let valueSource = '';

    if (cleanValues.length > 0) {
      switch (category) {
        case 'date':              // legacy canonical
        case 'transaction_date': {
          const dateCount = cleanValues.filter(
            (v) => isDateString(String(v)) || isExcelSerialDate(v) || isYYYYMMDD(v)
          ).length;
          valueScore = dateCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are dates`;
          break;
        }

        case 'revenue': {
          const currencyCount = cleanValues.filter((v) => isCurrencyValue(String(v))).length;
          const revHeuristic = looksLikeRevenue(rawHeader, cleanValues);
          valueScore = (currencyCount / cleanValues.length) * 0.5 + revHeuristic * 0.5;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% monetary + revenue pattern`;
          break;
        }

        case 'selling_price': {
          const currencyCount = cleanValues.filter((v) => isCurrencyValue(String(v))).length;
          const spHeuristic = looksLikeSellingPrice(rawHeader, cleanValues);
          valueScore = (currencyCount / cleanValues.length) * 0.5 + spHeuristic * 0.5;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% monetary + unit-price pattern`;
          break;
        }

        case 'cost_price': {
          const currencyCount = cleanValues.filter((v) => isCurrencyValue(String(v))).length;
          // Cross-reference with revenue column to inform per-unit vs total heuristic
          let revenueAvg = null;
          if (allColumnsContext) {
            for (const [otherHeader, ctx] of allColumnsContext) {
              const otherDets = Array.isArray(ctx.detections) ? ctx.detections : ctx;
              if (otherDets.some((d) => d.category === 'revenue')) {
                revenueAvg = averageNumeric(ctx.values);
                break;
              }
            }
          }
          const ctHeuristic = looksLikeCostTotal(rawHeader, cleanValues, revenueAvg);
          valueScore = (currencyCount / cleanValues.length) * 0.7 + ctHeuristic * 0.3;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% monetary + cost pattern`;
          break;
        }

        case 'quantity': {
          const qtyCount = cleanValues.filter((v) => looksLikeQuantity(v)).length;
          valueScore = qtyCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are integers`;
          break;
        }

        case 'product_name': {
          const productCount = cleanValues.filter((v) => looksLikeProduct(v)).length;
          const nonNumeric = cleanValues.filter(
            (v) => typeof v === 'string' && /[a-zA-Z]/.test(v) && !isCurrencyValue(v) && !isDateString(v)
          ).length;
          valueScore = (productCount / cleanValues.length) * 0.7 +
                        (nonNumeric / cleanValues.length) * 0.3;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are text names`;
          break;
        }

        case 'payment_method': {
          const pmCount = cleanValues.filter(
            (v) => /cash|transfer|pos|card|insurance|credit/i.test(String(v))
          ).length;
          valueScore = pmCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are payment types`;
          break;
        }

        // ---- product detail fields ----

        case 'supplier':
        case 'manufacturer':
        case 'branch':
        case 'warehouse':
        case 'customer':
        case 'sales_representative': {
          const textCount = cleanValues.filter((v) => looksLikeText(String(v))).length;
          valueScore = textCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are text/names`;
          break;
        }

        // ---- Phase 1: new product identity field types ----

        case 'strength': {
          const strengthCount = cleanValues.filter((v) => looksLikeStrength(v)).length;
          valueScore = strengthCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are dosage strengths (mg/g/%)`;
          break;
        }

        case 'dosage_form': {
          const formCount = cleanValues.filter((v) => looksLikeDosageForm(v)).length;
          valueScore = formCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are dosage forms (tablet/capsule/syrup)`;
          break;
        }

        case 'pack_size': {
          const packCount = cleanValues.filter((v) => looksLikePackSize(v)).length;
          valueScore = packCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are pack sizes`;
          break;
        }

        case 'current_stock':
        case 'opening_stock': {
          const numCount = cleanValues.filter((v) => looksLikeQuantity(v)).length;
          valueScore = numCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are stock quantities`;
          break;
        }

        case 'brand':
        case 'generic_name': {
          const textCount = cleanValues.filter((v) => looksLikeProduct(v)).length;
          valueScore = textCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are product-like text`;
          break;
        }

        case 'category':
        case 'subcategory': {
          const textCount = cleanValues.filter((v) => looksLikeText(String(v))).length;
          valueScore = textCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are classification text`;
          break;
        }

        case 'batch_number': {
          const batchCount = cleanValues.filter((v) => looksLikeBatchNumber(String(v))).length;
          valueScore = batchCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are batch/lot codes`;
          break;
        }

        case 'expiry_date': {
          const dateCount = cleanValues.filter(
            (v) => isDateString(String(v)) || isExcelSerialDate(v) || isYYYYMMDD(v)
          ).length;
          valueScore = dateCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are dates`;
          break;
        }

        case 'sales_channel': {
          const textCount = cleanValues.filter((v) => looksLikeText(String(v))).length;
          valueScore = textCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are channel names`;
          break;
        }

        case 'invoice_number': {
          const invCount = cleanValues.filter((v) => looksLikeInvoiceNumber(String(v))).length;
          valueScore = invCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are invoice/reference codes`;
          break;
        }

        // ---- financial detail fields ----

        case 'discount':
        case 'tax': {
          const numericCount = cleanValues.filter((v) => looksLikeNumeric(v)).length;
          valueScore = numericCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are numeric`;
          break;
        }

        case 'profit': {
          const numericCount = cleanValues.filter((v) => looksLikeNumeric(v)).length;
          valueScore = numericCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are monetary/profit`;
          break;
        }

        case 'margin': {
          const pctCount = cleanValues.filter((v) => looksLikePercentage(v)).length;
          valueScore = pctCount / cleanValues.length;
          if (valueScore > 0) valueSource = `${Math.round(valueScore * 100)}% of values are percentages`;
          break;
        }
      }
    }

    const headerWeight = headerScore > 0.7 ? 0.6 : headerScore > 0 ? 0.5 : 0;
    const valueWeight = headerScore > 0 ? 1 - headerWeight : 0.25;
    const combined = headerScore > 0
      ? headerScore * headerWeight + valueScore * valueWeight
      : valueScore * valueWeight;

    // Only include when there's a real header match OR strong domain-specific value evidence
    const hasRealHeaderMatch = headerScore >= 0.45;
    const hasStrongDomainValues = valueScore >= 0.75 && isDomainSpecificCategory(category);

    if (combined > 0.25 && (hasRealHeaderMatch || hasStrongDomainValues)) {
      detections.push({
        category,
        confidence: Math.round(combined * 100) / 100,
        headerScore: Math.round(headerScore * 100) / 100,
        valueScore: Math.round(valueScore * 100) / 100,
        source: [headerSource, valueSource].filter(Boolean).join('; '),
      });
    }
  }

  detections.sort((a, b) => b.confidence - a.confidence);

  // If no detections found, attempt a token-based best-guess
  if (detections.length === 0) {
    const bestGuess = findBestGuess(normalizedHeader, collapsedHeader, cleanValues, allColumnsContext);
    if (bestGuess) {
      detections.push(bestGuess);
    }
  }

  // Cross-column disambiguation: when two columns both score high for
  // the same category, check value context to decide which is correct.
  if (allColumnsContext && allColumnsContext.size > 0) {
    applyCrossColumnDisambiguation(detections, rawHeader, normalizedHeader, cleanValues, allColumnsContext);
  }

  return detections;
}

// ---- best-guess fallback ------------------------------------------------

/**
 * When the column header doesn't match ANY dictionary entry (no detections),
 * use token-level matching across all categories + value pattern analysis
 * to find the most likely business concept.
 *
 * Returns a single detection with confidence, or null if nothing fits.
 */
function findBestGuess(normalizedHeader, collapsedHeader, cleanValues, allColumnsContext) {
  const hTokens = canonicalTokens(normalizedHeader);
  let bestCategory = null;
  let bestScore = 0;
  let bestSource = '';

  for (const [category, synonyms] of Object.entries(DICTIONARY)) {
    // Calculate token overlap against all synonyms
    let maxTokenSim = 0;
    let matchedSyn = '';

    for (const syn of synonyms) {
      const sTokens = tokenize(syn.toLowerCase().trim());
      const tScore = tokenOverlapScore(hTokens, sTokens);
      if (tScore > maxTokenSim) {
        maxTokenSim = tScore;
        matchedSyn = syn;
      }
    }

    // Check against SMART_HINTS expansions
    let hintScore = 0;
    for (const token of hTokens) {
      const hint = expandHint(token);
      if (hint) {
        // Does the hint match this category?
        const hintTokens = tokenize(hint);
        for (const syn of synonyms) {
          const sTokens = tokenize(syn.toLowerCase().trim());
          const hs = tokenOverlapScore(hintTokens, sTokens);
          if (hs > hintScore) hintScore = hs;
        }
      }
    }

    const tokenSim = Math.max(maxTokenSim, hintScore * 1.1); // hint expansions get slight boost

    // Check value patterns for this category
    let valScore = 0;
    if (cleanValues.length > 0) {
      valScore = scoreValuesForCategory(category, cleanValues, normalizedHeader);
    }

    // Combined: token similarity (primary) + value evidence (secondary)
    const combined = tokenSim > 0 ? tokenSim * 0.7 + valScore * 0.3 : valScore * 0.5;

    if (combined > bestScore && combined > 0.12) {
      bestScore = combined;
      bestCategory = category;
      if (tokenSim > 0) {
        bestSource = `best guess — token match (${Math.round(tokenSim * 100)}%) with "${matchedSyn}"`;
      } else {
        bestSource = `best guess — value pattern (${Math.round(valScore * 100)}%)`;
      }
    }
  }

  if (!bestCategory) return null;

  return {
    category: bestCategory,
    confidence: Math.round(Math.min(bestScore, 0.55) * 100) / 100, // cap at 0.55 — low confidence
    headerScore: 0,
    valueScore: 0,
    source: bestSource + '; low confidence — please review',
  };
}

/**
 * Value-pattern scoring for a single category (used by findBestGuess).
 * Simplified version — just enough to rank category candidates by value fit.
 */
function scoreValuesForCategory(category, cleanValues, header) {
  if (cleanValues.length === 0) return 0;

  switch (category) {
    case 'date':              // legacy canonical
    case 'transaction_date':
    case 'expiry_date': {
      const dateCount = cleanValues.filter(
        (v) => isDateString(String(v)) || isExcelSerialDate(v) || isYYYYMMDD(v)
      ).length;
      return dateCount / cleanValues.length;
    }
    case 'revenue':
    case 'selling_price':
    case 'cost_price':
    case 'discount':
    case 'tax':
    case 'profit': {
      const numCount = cleanValues.filter((v) => {
        if (typeof v === 'number') return Number.isFinite(v);
        const n = Number(String(v).replace(/[,\s₦$€£¥%]/g, ''));
        return Number.isFinite(n);
      }).length;
      return numCount / cleanValues.length;
    }
    case 'quantity': {
      const qtyCount = cleanValues.filter((v) => looksLikeQuantity(v)).length;
      return qtyCount / cleanValues.length;
    }
    case 'margin': {
      const pctCount = cleanValues.filter((v) => looksLikePercentage(v)).length;
      return pctCount / cleanValues.length;
    }
    case 'strength': {
      const strCount = cleanValues.filter((v) => looksLikeStrength(v)).length;
      return strCount / cleanValues.length;
    }
    case 'dosage_form': {
      const formCount = cleanValues.filter((v) => looksLikeDosageForm(v)).length;
      return formCount / cleanValues.length;
    }
    case 'pack_size': {
      const packCount = cleanValues.filter((v) => looksLikePackSize(v)).length;
      return packCount / cleanValues.length;
    }
    case 'current_stock':
    case 'opening_stock': {
      const qtyCount = cleanValues.filter((v) => looksLikeQuantity(v)).length;
      return qtyCount / cleanValues.length;
    }
    case 'batch_number': {
      const batchCount = cleanValues.filter((v) => looksLikeBatchNumber(String(v))).length;
      return batchCount / cleanValues.length;
    }
    case 'invoice_number': {
      const invCount = cleanValues.filter((v) => looksLikeInvoiceNumber(String(v))).length;
      return invCount / cleanValues.length;
    }
    case 'payment_method': {
      const pmCount = cleanValues.filter(
        (v) => /cash|transfer|pos|card|insurance|credit/i.test(String(v))
      ).length;
      return pmCount / cleanValues.length;
    }
    default: {
      // Text-based categories: supplier, manufacturer, brand, branch, etc.
      const textCount = cleanValues.filter((v) => looksLikeText(String(v))).length;
      return textCount / cleanValues.length;
    }
  }
}

// ---- cross-column disambiguation ----------------------------------------

/**
 * When two columns have similar names (e.g., "Amount" vs "Unit Price"),
 * compare their value ranges to distinguish revenue from selling_price,
 * or cost_price from selling_price.
 *
 * Called per-column after detection, with the full set of column detections
 * available as context.
 */
function applyCrossColumnDisambiguation(detections, rawHeader, normalizedHeader, cleanValues, allColumnsContext) {
  if (!allColumnsContext) return;

  const priceCategories = new Set(['revenue', 'selling_price', 'cost_price']);

  for (const det of detections) {
    if (!priceCategories.has(det.category)) continue;

    for (const [otherHeader, ctx] of allColumnsContext) {
      if (otherHeader === rawHeader) continue;

      const otherDetections = Array.isArray(ctx.detections) ? ctx.detections : ctx;
      const otherHasSame = otherDetections.some((d) => d.category === det.category);
      if (!otherHasSame) continue;

      const otherValues = ctx.values;
      if (!otherValues || otherValues.length === 0) continue;

      const myAvg = averageNumeric(cleanValues);
      const otherAvg = averageNumeric(otherValues);

      if (myAvg === null || otherAvg === null) continue;

      // Column with larger values → revenue; smaller values → unit price
      if (det.category === 'revenue' && myAvg < otherAvg * 0.5) {
        det.confidence = Math.round(det.confidence * 0.4 * 100) / 100;
        det.source = `${det.source}; downgraded — values too small vs similar column "${otherHeader}"`;
      }

      if (det.category === 'selling_price' && myAvg > otherAvg * 2) {
        det.confidence = Math.round(det.confidence * 0.4 * 100) / 100;
        det.source = `${det.source}; downgraded — values too large vs similar column "${otherHeader}"`;
      }
    }
  }
}

function averageNumeric(values) {
  if (!values || values.length === 0) return null;
  const nums = values
    .map((v) => typeof v === 'number' ? v : Number(String(v).replace(/[,\s₦$€£¥%]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/**
 * Categories whose value patterns are distinctive enough to match on
 * values alone (dates, numbers, payment types, batch codes, etc.)
 * as opposed to generic text categories (names, locations).
 */
function isDomainSpecificCategory(category) {
  return category === 'date' || category === 'transaction_date' ||
         category === 'quantity' ||
         category === 'revenue' ||
         category === 'selling_price' ||
         category === 'cost_price' ||
         category === 'payment_method' ||
         category === 'batch_number' ||
         category === 'invoice_number' ||
         category === 'expiry_date' ||
         category === 'discount' ||
         category === 'tax' ||
         category === 'margin' ||
         category === 'profit' ||
         category === 'strength' ||
         category === 'dosage_form' ||
         category === 'pack_size';
}

// ---- public API ---------------------------------------------------------

/**
 * @param {object[]} rows — raw parsed rows from the spreadsheet
 * @param {number} [sampleSize=50] — how many rows to sample for value analysis
 * @returns {object[]} schema — array of column analysis objects
 */
function detectSchema(rows, sampleSize = 50) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const rawHeaders = Object.keys(rows[0]);
  const sample = rows.slice(0, sampleSize);

  // Collect sample values per column (for cross-column disambiguation)
  const columnValues = new Map();
  for (const rawHeader of rawHeaders) {
    columnValues.set(rawHeader, sample.map((row) => row[rawHeader]));
  }

  // First pass: detect each column individually
  const columns = rawHeaders.map((rawHeader) => {
    const normalizedHeader = normalizeHeader(rawHeader);
    const collapsedHeader = normalizedHeader.replace(/\s/g, '');
    const sampleValues = columnValues.get(rawHeader);

    const detections = detectColumn(
      normalizedHeader, collapsedHeader, rawHeader, sampleValues, null // context built in second pass
    );

    return { rawHeader, normalizedHeader, detections, _sampleValues: sampleValues };
  });

  // Second pass: build cross-column context and re-detect with context
  const contextMap = new Map();
  for (const col of columns) {
    contextMap.set(col.rawHeader, { detections: col.detections, values: col._sampleValues });
  }

  return columns.map((col) => {
    // Re-run with cross-column context for disambiguation
    const reDetected = detectColumn(
      col.normalizedHeader,
      col.normalizedHeader.replace(/\s/g, ''),
      col.rawHeader,
      col._sampleValues,
      contextMap
    );

    // Keep the _sampleValues for downstream use
    delete col._sampleValues;

    // Check if this column matches IGNORED_PATTERNS
    const ignored = isIgnoredColumn(col.normalizedHeader);

    return {
      rawHeader: col.rawHeader,
      normalizedHeader: col.normalizedHeader,
      detections: reDetected,
      ignored,  // Phase 1: flagged for UI / column classification
    };
  });
}

/**
 * Merge LLM mapping results into the rule-based schema detections.
 *
 * The LLM sees every column at once and can occasionally misclassify one
 * (e.g. confusing a transaction date with an expiry date when both exist
 * in the same file) even when the rule-based detector already had a
 * stronger, correct answer for that specific column. Rather than trusting
 * the LLM's guess unconditionally, reconcile same-category detections by
 * keeping whichever confidence is actually higher, then re-sort by
 * confidence — so the strongest signal wins the top slot regardless of
 * which source produced it.
 */
// Confidence is earned by CORROBORATION, not claimed. These constants encode
// what it is worth when two independent methods land on the same answer, and
// what it costs when they don't. They are read against the tiers in
// columnMapper.js: >= 0.95 auto-applies, >= 0.70 asks the user to review,
// below that the pipeline says it is unsure.
const AGREE_FLOOR = 0.85;   // agreement is worth at least this on its own
const AGREE_BONUS = 0.12;   // ...plus this, so a decent rule score clears 0.95
const AGREE_CEIL = 0.99;    // never certain; a file can always be strange
const RANKING_DISPUTE = 0.78; // both found it, they rank it differently -> review
const CONFLICT = 0.72;      // they name different fields -> a human decides
const CONFLICT_PENALTY = 0.8; // ...and the rule's own pick loses standing too

/**
 * Fold the LLM's answer into the rule-based detections.
 *
 * The previous version took whichever of the two claimed the higher number.
 * That treats a self-reported score as if it were measured, which is the one
 * thing an LLM's confidence is not — it is a predicted token, so a fluent
 * wrong answer scores just as high as a right one and auto-applied.
 *
 * What IS informative is whether two methods that work in completely different
 * ways — string/value heuristics on one side, semantic knowledge on the other —
 * independently reach the same field. So the number is computed here, from
 * their relationship:
 *
 *   agree on the top pick   -> high; clears the auto bar even if neither
 *                              method was individually certain
 *   agree it is a candidate,
 *   but rank it differently -> review; both saw it, they disagree on primacy
 *   name different fields   -> review, and the rule's pick is demoted too;
 *                              a genuine disagreement is exactly the case a
 *                              person should look at, so neither side gets to
 *                              auto-apply by outshouting the other
 *
 * Corroboration is only claimed for a genuinely independent source. The local
 * heuristic fallback in llmMapper.js arrives through this same path but marks
 * its detections as scored rather than `unverified`; being another header/value
 * heuristic, it shares failure modes with the rule detector and its agreement
 * would be self-congratulation. Those keep the old take-the-higher behaviour.
 */
function mergeLlmResults(schemaColumns, llmColumns) {
  if (!llmColumns || llmColumns.length === 0) return schemaColumns;

  const llmMap = new Map(llmColumns.map((c) => [c.rawHeader, c]));

  return schemaColumns.map((col) => {
    const llmCol = llmMap.get(col.rawHeader);
    if (!llmCol || !llmCol.mappedTo) return col;

    const primary = (llmCol.detections || []).find(
      (d) => d.category === llmCol.mappedTo && !/second choice/i.test(d.source || ''),
    );
    const independent = primary ? primary.unverified === true : false;
    const why = primary && primary.why ? primary.why : null;

    const ruleDetections = col.detections || [];
    const ruleTop = ruleDetections[0] || null;
    const ruleMatch = ruleDetections.find((d) => d.category === llmCol.mappedTo) || null;

    // Not independent evidence — preserve the original take-the-higher merge.
    if (!independent) {
      const llmDet = { category: llmCol.mappedTo, confidence: llmCol.confidence, source: 'LLM semantic mapping' };
      const merged = [];
      let seen = false;
      for (const d of ruleDetections) {
        if (d.category === llmDet.category) { merged.push(d.confidence >= llmDet.confidence ? d : llmDet); seen = true; }
        else merged.push(d);
      }
      if (!seen) merged.push(llmDet);
      merged.sort((a, b) => b.confidence - a.confidence);
      return { ...col, detections: merged };
    }

    const round = (n) => Math.round(Math.min(n, AGREE_CEIL) * 100) / 100;
    let agreement;
    let confidence;

    if (ruleTop && ruleTop.category === llmCol.mappedTo) {
      agreement = 'corroborated';
      confidence = round(Math.max(ruleTop.confidence, AGREE_FLOOR) + AGREE_BONUS);
    } else if (ruleMatch) {
      agreement = 'ranking-dispute';
      confidence = round(Math.max(ruleMatch.confidence, RANKING_DISPUTE));
    } else if (ruleTop) {
      agreement = 'conflict';
      confidence = CONFLICT;
    } else {
      agreement = 'llm-only';
      confidence = CONFLICT;
    }

    const llmDet = {
      category: llmCol.mappedTo,
      confidence,
      source: agreement === 'corroborated'
        ? 'rule detector and semantic mapping agree'
        : 'LLM semantic mapping',
      agreement,
      ...(why ? { why } : {}),
    };

    const merged = [];
    let replaced = false;
    for (const d of ruleDetections) {
      if (d.category === llmDet.category) { merged.push(llmDet); replaced = true; continue; }
      // On a genuine conflict the rule's own top pick is no longer trustworthy
      // enough to auto-apply either — demote it so the column reaches a human
      // instead of one side winning by default.
      if (agreement === 'conflict' && d === ruleTop) {
        merged.push({ ...d, confidence: Math.round(d.confidence * CONFLICT_PENALTY * 100) / 100, agreement: 'conflict' });
        continue;
      }
      merged.push(d);
    }
    if (!replaced) merged.push(llmDet);

    // The model's runner-up is kept as a visible alternative so the review UI
    // can offer it, but never at a confidence that could win on its own.
    for (const d of llmCol.detections || []) {
      if (!/second choice/i.test(d.source || '')) continue;
      if (merged.some((m) => m.category === d.category)) continue;
      merged.push({ ...d });
    }

    merged.sort((a, b) => b.confidence - a.confidence);
    return { ...col, detections: merged, agreement };
  });
}

// ---- set-level coherence ------------------------------------------------

const COHERENCE_SAMPLE = 300;   // rows read per check; enough to be decisive
const MIN_COMPARABLE = 8;       // below this a "most rows" verdict is noise
const CONFIRMED = 0.95;         // arithmetic agreement earns the auto tier
const DEMOTE_HARD = 0.5;        // the column contradicts what it was mapped to
const DEMOTE_SOFT = 0.6;        // two columns are coherent only if swapped

/**
 * Check a resolved mapping against the data it claims to describe.
 *
 * Every check up to this point reasons about ONE column — its header, its
 * values, its own plausibility. But several fields are only meaningful in
 * relation to each other, and those relationships are where mapping mistakes
 * actually show up: cost and selling price swapped reads perfectly at the
 * column level and is obviously wrong the moment you compare them row by row.
 *
 * So this runs after a mapping is resolved and asks whether the set holds
 * together arithmetically. It never rewrites a mapping — a wrong guess here
 * would be worse than the one it replaced. It only moves confidence, which
 * moves the column between the auto / review / unsure tiers:
 *
 *   - an identity that holds (revenue = quantity x selling price) is strong
 *     corroboration across three columns at once, and lifts all three to auto
 *   - a relationship that holds only inverted (cost above selling on most
 *     rows) demotes both, because the likeliest reading is that they are
 *     swapped and a person should confirm which is which
 *   - a column whose values won't parse as what it was mapped to is demoted
 *     on its own evidence
 *
 * @returns {{columns, checks}} columns with adjusted confidences, and a
 *          human-readable record of what was checked and what it found.
 */
function checkMappingCoherence(schemaColumns, mapping, rows) {
  const checks = [];
  if (!rows || rows.length === 0 || !mapping) return { columns: schemaColumns, checks };

  const sample = rows.slice(0, COHERENCE_SAMPLE);
  const headerFor = (cat) => (mapping[cat] && mapping[cat].rawHeader) || null;
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const valuesOf = (cat) => {
    const h = headerFor(cat);
    return h ? sample.map((r) => r[h]) : null;
  };

  // Confidence adjustments, collected then applied once so a column touched by
  // two checks takes the harshest verdict rather than a compounding product.
  const adjust = new Map(); // category -> { factor?, floor? }
  const demote = (cat, factor, reason) => {
    if (!headerFor(cat)) return;
    const prev = adjust.get(cat) || {};
    adjust.set(cat, { ...prev, factor: Math.min(prev.factor ?? 1, factor), reason });
  };
  const confirm = (cat, floor, reason) => {
    if (!headerFor(cat)) return;
    const prev = adjust.get(cat) || {};
    adjust.set(cat, { ...prev, floor: Math.max(prev.floor ?? 0, floor), reason });
  };

  // --- cost vs selling price -------------------------------------------
  const costs = valuesOf('cost_price');
  const sells = valuesOf('selling_price');
  if (costs && sells) {
    let inverted = 0, comparable = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = num(costs[i]), s = num(sells[i]);
      if (c == null || s == null || c <= 0 || s <= 0) continue;
      comparable++;
      if (c > s) inverted++;
    }
    if (comparable >= MIN_COMPARABLE) {
      const pct = inverted / comparable;
      if (pct > 0.5) {
        demote('cost_price', DEMOTE_SOFT, 'cost above selling price on most rows');
        demote('selling_price', DEMOTE_SOFT, 'cost above selling price on most rows');
        checks.push({
          check: 'cost_vs_selling', passed: false, severity: 'high',
          message: `Cost is higher than selling price on ${Math.round(pct * 100)}% of rows — these two columns may be swapped.`,
        });
      } else {
        checks.push({ check: 'cost_vs_selling', passed: true, message: 'Cost sits below selling price, as expected.' });
      }
    }
  }

  // --- revenue = quantity x selling price -------------------------------
  const revs = valuesOf('revenue');
  const qtys = valuesOf('quantity');
  if (revs && qtys && sells) {
    let holds = 0, comparable = 0;
    for (let i = 0; i < sample.length; i++) {
      const r = num(revs[i]), q = num(qtys[i]), s = num(sells[i]);
      if (r == null || q == null || s == null || r <= 0 || q <= 0 || s <= 0) continue;
      comparable++;
      // 2% tolerance absorbs rounding and per-line discounts.
      if (Math.abs(r - q * s) / r <= 0.02) holds++;
    }
    if (comparable >= MIN_COMPARABLE) {
      const pct = holds / comparable;
      if (pct >= 0.8) {
        for (const cat of ['revenue', 'quantity', 'selling_price']) {
          confirm(cat, CONFIRMED, 'revenue equals quantity x selling price');
        }
        checks.push({
          check: 'revenue_identity', passed: true, severity: 'info',
          message: `Revenue equals quantity x selling price on ${Math.round(pct * 100)}% of rows — three columns confirm each other.`,
        });
      } else if (pct < 0.2) {
        checks.push({
          check: 'revenue_identity', passed: false, severity: 'medium',
          message: `Revenue does not equal quantity x selling price on ${Math.round((1 - pct) * 100)}% of rows — one of the three may be mapped to the wrong column.`,
        });
      }
    }
  }

  // --- the date column has to read as dates -----------------------------
  for (const cat of ['transaction_date', 'date', 'expiry_date']) {
    const vals = valuesOf(cat);
    if (!vals) continue;
    let parsed = 0, present = 0;
    for (const v of vals) {
      if (v == null || v === '') continue;
      present++;
      if (isDateString(v) || isExcelSerialDate(v) || isYYYYMMDD(v)) parsed++;
    }
    if (present >= MIN_COMPARABLE) {
      const pct = parsed / present;
      if (pct < 0.9) {
        demote(cat, DEMOTE_HARD, 'values do not read as dates');
        checks.push({
          check: `${cat}_parses`, passed: false, severity: 'high',
          message: `Only ${Math.round(pct * 100)}% of values in the ${cat.replace(/_/g, ' ')} column read as dates.`,
        });
      } else {
        checks.push({ check: `${cat}_parses`, passed: true, message: `Values in the ${cat.replace(/_/g, ' ')} column read as dates.` });
      }
    }
  }

  // --- quantity has to be a count ---------------------------------------
  if (qtys) {
    let ok = 0, present = 0;
    for (const v of qtys) {
      if (v == null || v === '') continue;
      present++;
      const n = num(v);
      if (n != null && n > 0) ok++;
    }
    if (present >= MIN_COMPARABLE && ok / present < 0.9) {
      demote('quantity', DEMOTE_SOFT, 'values are not positive counts');
      checks.push({
        check: 'quantity_is_count', passed: false, severity: 'medium',
        message: `Only ${Math.round((ok / present) * 100)}% of quantity values are positive numbers.`,
      });
    }
  }

  if (adjust.size === 0) return { columns: schemaColumns, checks };

  // Apply to the detections of the specific column each category resolved to,
  // so an adjustment can never spill onto a column that was not being judged.
  const byHeader = new Map();
  for (const [cat, a] of adjust) {
    const h = headerFor(cat);
    if (h) byHeader.set(h, { ...a, category: cat });
  }

  const columns = schemaColumns.map((col) => {
    const a = byHeader.get(col.rawHeader);
    if (!a) return col;
    const detections = (col.detections || []).map((d) => {
      if (d.category !== a.category) return d;
      let c = d.confidence;
      if (a.factor != null) c = c * a.factor;
      if (a.floor != null) c = Math.max(c, a.floor);
      return { ...d, confidence: Math.round(Math.min(c, AGREE_CEIL) * 100) / 100, coherence: a.reason };
    });
    detections.sort((x, y) => y.confidence - x.confidence);
    return { ...col, detections };
  });

  return { columns, checks };
}

module.exports = {
  detectSchema,
  mergeLlmResults,
  checkMappingCoherence,
  normalizeHeader,
  textSimilarity,
  isExcelSerialDate,
  isDateString,
  isYYYYMMDD,
  isCurrencyValue,
};
