/**
 * Catalogue column mapping — a thin adapter over the ported RxNaija stack.
 *
 * WHY THIS IS AN ADAPTER AND NOT AN IMPLEMENTATION
 * The first version of this file scored headers itself. That was a mistake.
 * The ported cleanData -> detectSchema -> resolveMapping chain is hardened
 * against real pharmacy spreadsheets in ways a fresh synonym table is not:
 * it already separates selling_price from cost_price, reads value shapes,
 * assigns confidence TIERS (auto / review / confirm), and explains every
 * decision in words a pharmacy owner can read —
 *
 *     "exact match: \"unit cost\"; 81% monetary + cost pattern"
 *
 * Rewriting that would have meant relearning its bugs. So this file does
 * only the three things the ported stack genuinely does not do for a
 * CATALOGUE, and defers everything else.
 *
 *   1. Translate canonical field names to this product's columns.
 *   2. Resolve the `quantity` ambiguity. In a sales export "Qty" is how many
 *      were sold; in a catalogue it is how many are on the shelf. Same
 *      header, different meaning, and only the domain can decide.
 *   3. Claim `sku` and `barcode`, which the shared dictionary has no concept
 *      of because analytics never needed them.
 *
 * The sales-export guard also changed. It used to string-match headers;
 * it now asks the detector what it found. If a file maps to transaction
 * dates and revenue, the detector has already said what kind of file it is
 * far more reliably than a keyword list could.
 */

const { cleanData } = require('../ingestion/dataCleaner');
const { detectSchema } = require('../ingestion/schemaDetector');
const { resolveMapping } = require('../ingestion/columnMapper');
const { normalizeHeader } = require('../ingestion/schemaDetector');

/**
 * Canonical (shared dictionary) -> catalogue column.
 * Anything absent here is detected but not stored; batch_number and
 * manufacturer are recognised without a home yet, which is better than
 * silently discarding the header at detection time.
 */
const CANONICAL_TO_CATALOGUE = {
  product_name:  'name',
  generic_name:  'generic_name',
  brand:         'brand_name',
  category:      'category',
  dosage_form:   'form',
  strength:      'strength',
  pack_size:     'pack_size',
  selling_price: 'price',
  cost_price:    'cost_price',
  current_stock: 'stock_qty',
  expiry_date:   'expiry_date',
};

/**
 * Canonical fields that only exist in a SALES export.
 *
 * Their presence means the owner uploaded the wrong file. Importing it would
 * turn every transaction row into a product, duplicated once per sale.
 */
const SALES_ONLY_CANONICALS = [
  'transaction_date', 'revenue', 'payment_method', 'discount', 'tax',
  'profit', 'margin', 'invoice_number', 'sales_representative',
  'customer', 'sales_channel',
];

/** Fields without which the assistant cannot answer a customer. */
const CATALOGUE_REQUIRED = ['name', 'price'];

// The shared dictionary has no concept of these — analytics never needed a
// product code. Matched here rather than by editing the ported dictionary,
// so the two do not drift.
const SUPPLEMENTARY = {
  sku: ['sku', 'product code', 'item code', 'stock code', 'product id', 'item id', 'stock id'],
  barcode: ['barcode', 'bar code', 'ean', 'upc', 'gtin', 'scan code'],
};

function claimSupplementary(unmapped, alreadyTaken) {
  const claimed = {};
  for (const col of unmapped || []) {
    const raw = col.rawHeader ?? col;
    const normalised = normalizeHeader(raw);
    for (const [field, synonyms] of Object.entries(SUPPLEMENTARY)) {
      if (alreadyTaken.has(field) || claimed[field]) continue;
      if (synonyms.includes(normalised)) {
        claimed[field] = { rawHeader: raw, confidence: 0.95, tier: 'auto', source: `exact match: "${normalised}"` };
        break;
      }
    }
  }
  return claimed;
}

/**
 * @param {object[]} rows   parsed sheet rows, keyed by raw header
 * @param {object} [options]
 * @param {string} [options.fileName]
 * @returns {object} analysis for the confirmation step — never applied directly
 */
function analyseCatalogue(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      reason: 'empty_file',
      fields: {}, proposals: [], unmapped: [],
      missingRequired: CATALOGUE_REQUIRED,
      looksLikeSalesExport: false, salesFields: [],
      rowsIn: 0, rowsOut: 0,
    };
  }

  const headers = Object.keys(rows[0]);
  const { records, report } = cleanData(rows, headers, { fileName: options.fileName || 'catalogue.xlsx' });

  if (records.length === 0) {
    return {
      ok: false,
      reason: 'no_rows_after_cleaning',
      fields: {}, proposals: [], unmapped: [],
      missingRequired: CATALOGUE_REQUIRED,
      looksLikeSalesExport: false, salesFields: [],
      rowsIn: rows.length, rowsOut: 0,
      cleaningReport: report,
    };
  }

  const schema = detectSchema(records);
  const resolved = resolveMapping(schema);

  // --- ask the detector what kind of file this is -------------------------
  const salesFields = SALES_ONLY_CANONICALS.filter((f) => resolved.mapping[f]);

  // --- translate canonical -> catalogue -----------------------------------
  const fields = {};
  for (const [canonical, detail] of Object.entries(resolved.mapping)) {
    const field = CANONICAL_TO_CATALOGUE[canonical];
    if (!field) continue;
    fields[field] = {
      rawHeader: detail.rawHeader,
      confidence: detail.confidence,
      tier: resolved.tiers?.[canonical] || 'review',
      source: detail.source,
      canonical,
    };
  }

  // --- the `quantity` ambiguity -------------------------------------------
  // "Qty" in a sales export is how many were sold. In a catalogue it is how
  // many are on the shelf. The shared dictionary resolves it the sales way
  // because that is the product it was built for, so the domain has to
  // correct it here — and say so, because a quantity column read wrongly is
  // the difference between "12 in stock" and "12 sold last month".
  if (!fields.stock_qty && resolved.mapping.quantity) {
    const q = resolved.mapping.quantity;
    fields.stock_qty = {
      rawHeader: q.rawHeader,
      // Deliberately not 'auto'. It is a domain reinterpretation, not a
      // confident read, and the owner should see it.
      confidence: Math.min(q.confidence, 0.7),
      tier: 'review',
      source: `${q.source} — read as stock on hand because this is a catalogue, not a sales report`,
      canonical: 'quantity',
      reinterpreted: true,
    };
  }

  // --- sku / barcode -------------------------------------------------------
  // Scanning `ignored` as well as `unmapped` on purpose: the shared stack
  // actively IGNORES barcode columns, because analytics had no use for one.
  // Only looking at `unmapped` silently lost it.
  const taken = new Set(Object.keys(fields));
  const claimable = [...(resolved.unmapped || []), ...(resolved.ignored || [])];
  Object.assign(fields, claimSupplementary(claimable, taken));

  // --- what is NOT being imported -----------------------------------------
  //
  // Computed from every header in the file minus the ones a catalogue field
  // claimed — NOT from resolved.unmapped.
  //
  // The difference matters. The shared dictionary is a superset: it mapped
  // "Shelf Location" to `branch`, a field that exists for sales analytics and
  // has no catalogue column. That header was therefore neither in
  // resolved.unmapped nor translated into a field, so it vanished from the
  // report entirely — the owner would never be told a column was dropped.
  // Deriving from the full header list makes disappearing impossible.
  const usedHeaders = new Set(Object.values(fields).map((f) => f.rawHeader));
  const unmapped = headers.filter((h) => !usedHeaders.has(h));

  // Detected as something real, just not something a catalogue stores. Worth
  // showing so "Shelf Location — recognised as branch, not imported" reads as
  // a decision rather than an oversight.
  const detectedButUnused = Object.entries(resolved.mapping)
    .filter(([canonical, d]) => !CANONICAL_TO_CATALOGUE[canonical] && !usedHeaders.has(d.rawHeader))
    .map(([canonical, d]) => ({ rawHeader: d.rawHeader, canonical }));

  const missingRequired = CATALOGUE_REQUIRED.filter((f) => !fields[f]);

  // Everything the confirmation UI needs, in one place, with the reason each
  // decision was made. Nothing here is applied until the owner confirms.
  const proposals = Object.entries(fields).map(([field, d]) => ({
    field,
    rawHeader: d.rawHeader,
    confidence: d.confidence,
    tier: d.tier,
    source: d.source,
    reinterpreted: Boolean(d.reinterpreted),
    needsReview: d.tier !== 'auto',
  }));

  return {
    ok: missingRequired.length === 0 && salesFields.length < 2,
    fields,
    proposals,
    unmapped,
    detectedButUnused,
    missingRequired,
    // Two or more, so a catalogue carrying a lone "Discount" column is not
    // condemned for it.
    looksLikeSalesExport: salesFields.length >= 2,
    salesFields,
    priceFulfilled: Boolean(fields.price),
    productIdentityFulfilled: Boolean(fields.name),
    rowsIn: rows.length,
    rowsOut: records.length,
    records,
    cleaningReport: report,
  };
}

module.exports = {
  analyseCatalogue,
  CANONICAL_TO_CATALOGUE,
  SALES_ONLY_CANONICALS,
  CATALOGUE_REQUIRED,
};
