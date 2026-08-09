/**
 * Map a messy spreadsheet's headers onto catalogue fields.
 *
 * Pharmacy files look like all of these, and all of them are real shapes:
 *
 *   Product          | Price       | Stock
 *   Medicine Name    | Selling Price | Qty
 *   Item Description | Unit Cost   | Available Quantity
 *
 * Note the third one. "Unit Cost" is NOT the selling price, and a detector
 * that treats every money column the same will quote the pharmacy's own
 * purchase price to customers.
 *
 * HOW IT DECIDES, in order of trust:
 *   1. exact synonym match on the normalised header  — near certainty
 *   2. token overlap                                  — strong
 *   3. fuzzy string similarity                        — weak, needs support
 *   4. the SHAPE OF THE VALUES underneath             — the tiebreaker
 *
 * Step 4 is what makes this better than a synonym table. A column headed
 * "Amount" could be price or stock; if every value is 1,250.00 it is money,
 * and if every value is a small whole number it is a count.
 *
 * NOTHING HERE AUTO-APPLIES. It produces a proposal with confidences, and
 * the owner confirms it. Guessing silently is how a catalogue quietly becomes
 * wrong in a way nobody notices until a customer is quoted a bad price.
 *
 * Pure. No database, no file IO.
 */

const { normalizeHeader, textSimilarity } = require('../ingestion/schemaDetector');
const { parseCurrency } = require('../ingestion/dataCleaner');
const {
  CATALOGUE_FIELDS, SALES_EXPORT_SIGNALS, REQUIRED_FIELDS,
} = require('./catalogueFields');

const CONFIDENCE = {
  EXACT: 0.98,
  TOKENS: 0.8,
  FUZZY: 0.6,
  // Below this we propose nothing rather than propose badly. An unmapped
  // column the owner can assign beats a wrong one they must notice.
  FLOOR: 0.45,
};

function tokens(normalised) {
  return normalised.split(/\s+/).filter(Boolean);
}

/** Best score for one header against one field's synonyms. */
function scoreHeaderAgainstField(normalisedHeader, spec) {
  const headerTokens = tokens(normalisedHeader);
  let best = 0;
  let how = null;

  for (const synonym of spec.synonyms) {
    if (normalisedHeader === synonym) return { score: CONFIDENCE.EXACT, how: 'exact' };

    const synTokens = tokens(synonym);
    const shared = synTokens.filter((t) => headerTokens.includes(t));

    if (shared.length > 0) {
      // BOTH sides must be explained, and the score is their product.
      //
      // Synonym coverage alone credits a header for merely CONTAINING a
      // synonym: "Warehouse Bin Reference" fully covers the one-token synonym
      // "reference" and would claim `sku`, despite two thirds of the header
      // being about a warehouse shelf. This is the same shape as the bug
      // recorded in the ported schemaDetector, where "TotalAmount_NGN"
      // contained "amount" and a revenue column was read as tax.
      //
      // Multiplying by header coverage means unexplained tokens cost real
      // score, so a partial match has to be a good one to survive the floor.
      const synonymCoverage = shared.length / synTokens.length;
      const headerCoverage = shared.length / headerTokens.length;
      const score = CONFIDENCE.TOKENS * synonymCoverage * headerCoverage;
      if (score > best) { best = score; how = 'tokens'; }
    }

    const similarity = textSimilarity(normalisedHeader, synonym);
    if (similarity > 0.82) {
      const score = CONFIDENCE.FUZZY * similarity;
      if (score > best) { best = score; how = 'fuzzy'; }
    }
  }

  return { score: best, how };
}

// ---- value-shape evidence -------------------------------------------------

function sampleValues(rows, header, limit = 30) {
  const out = [];
  for (const row of rows || []) {
    const v = row?.[header];
    if (v !== null && v !== undefined && String(v).trim() !== '') out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function looksLikeMoney(values) {
  if (values.length === 0) return 0;
  let money = 0;
  for (const v of values) {
    const s = String(v);
    const n = parseCurrency(v);
    if (n === null) continue;
    // Decimals, thousands separators, a currency mark, or simply a value too
    // large to be a shelf count.
    if (/[₦$€£]/.test(s) || /[.,]\d{2}\b/.test(s) || n >= 100) money++;
  }
  return money / values.length;
}

function looksLikeCount(values) {
  if (values.length === 0) return 0;
  let counts = 0;
  for (const v of values) {
    const n = parseCurrency(v);
    if (n === null) continue;
    if (Number.isInteger(n) && n >= 0 && n < 100000 && !/[₦$€£]/.test(String(v))) counts++;
  }
  return counts / values.length;
}

function looksLikeDate(values) {
  if (values.length === 0) return 0;
  let dates = 0;
  for (const v of values) {
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)
        || /^\d{1,2}[/-]\d{4}$/.test(s) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) {
      dates++;
    } else if (typeof v === 'number' && v > 30000 && v < 60000) {
      dates++; // Excel serial date
    }
  }
  return dates / values.length;
}

/**
 * Adjust a header's field scores using what the column actually contains.
 * Evidence nudges rather than overrules — a clearly-named column should not
 * be overridden because its sample happened to look ambiguous.
 */
function applyValueEvidence(scores, values) {
  const money = looksLikeMoney(values);
  const count = looksLikeCount(values);
  const date = looksLikeDate(values);

  const bump = (field, amount) => {
    if (scores[field] === undefined) return;
    scores[field] = Math.min(0.97, scores[field] + amount);
  };
  const damp = (field, amount) => {
    if (scores[field] === undefined) return;
    scores[field] = Math.max(0, scores[field] - amount);
  };

  if (money > 0.7) {
    bump('price', 0.12); bump('cost_price', 0.12);
    damp('stock_qty', 0.25); damp('sku', 0.2); damp('barcode', 0.2);
  }
  if (count > 0.8 && money < 0.4) {
    bump('stock_qty', 0.12);
    damp('price', 0.2); damp('cost_price', 0.2);
  }
  if (date > 0.6) {
    bump('expiry_date', 0.2);
    damp('price', 0.3); damp('stock_qty', 0.3); damp('name', 0.3);
  }
  return scores;
}

// ---- main -----------------------------------------------------------------

/**
 * @param {string[]} headers
 * @param {object[]} [rows]  sample rows keyed by raw header
 * @returns {{
 *   mapping: Record<string,string>,
 *   proposals: Array<object>,
 *   unmapped: string[],
 *   missingRequired: string[],
 *   salesExportSignals: string[],
 *   looksLikeSalesExport: boolean
 * }}
 */
function detectCatalogueSchema(headers, rows = []) {
  const cleanHeaders = (headers || []).filter((h) => h !== null && h !== undefined && String(h).trim() !== '');

  // Score every header against every field.
  const scored = cleanHeaders.map((header) => {
    const normalised = normalizeHeader(header);
    const scores = {};
    const hows = {};

    for (const [field, spec] of Object.entries(CATALOGUE_FIELDS)) {
      const { score, how } = scoreHeaderAgainstField(normalised, spec);
      if (score > 0) { scores[field] = score; hows[field] = how; }
    }

    applyValueEvidence(scores, sampleValues(rows, header));

    const ranked = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([field, score]) => ({ field, score: Number(score.toFixed(3)), how: hows[field] || 'values' }));

    return { header, normalised, ranked };
  });

  // Assign greedily by confidence, one field per column and one column per
  // field. Greedy is right here: the strongest evidence in the file should
  // claim its field first, and everything else works around it. That is what
  // stops "Unit Cost" taking `price` when a clearer "Selling Price" exists.
  const mapping = {};
  const takenFields = new Set();
  const takenHeaders = new Set();

  const candidates = [];
  for (const { header, ranked } of scored) {
    for (const r of ranked) candidates.push({ header, ...r });
  }
  candidates.sort((a, b) => b.score - a.score);

  for (const c of candidates) {
    if (c.score < CONFIDENCE.FLOOR) break;
    if (takenHeaders.has(c.header) || takenFields.has(c.field)) continue;
    mapping[c.header] = c.field;
    takenHeaders.add(c.header);
    takenFields.add(c.field);
  }

  // Is this a sales export rather than a catalogue?
  const normalisedAll = cleanHeaders.map(normalizeHeader);
  const salesExportSignals = SALES_EXPORT_SIGNALS.filter((signal) =>
    normalisedAll.some((h) => h === signal || h.includes(signal))
  );

  const proposals = scored.map(({ header, ranked }) => ({
    header,
    suggested: mapping[header] || null,
    alternatives: ranked.slice(0, 3),
    // Surfaced so the confirmation UI can put the genuinely uncertain columns
    // in front of the owner instead of burying them in a list of thirty.
    confident: Boolean(mapping[header]) && (ranked[0]?.score ?? 0) >= 0.75,
  }));

  return {
    mapping,
    proposals,
    unmapped: cleanHeaders.filter((h) => !mapping[h]),
    missingRequired: REQUIRED_FIELDS.filter((f) => !takenFields.has(f)),
    salesExportSignals,
    // Two or more signals: one alone is too easy to hit by accident, since a
    // catalogue may legitimately carry a "discount" or "tax" column.
    looksLikeSalesExport: salesExportSignals.length >= 2,
  };
}

module.exports = { detectCatalogueSchema, CONFIDENCE };
