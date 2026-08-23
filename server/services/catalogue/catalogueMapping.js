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

/** Which canonical field, if any, the shared stack assigned this raw header. */
function headerClaimedAs(mapping, rawHeader) {
  for (const [canonical, detail] of Object.entries(mapping)) {
    if (detail.rawHeader === rawHeader) return canonical;
  }
  return null;
}

/**
 * Claim sku/barcode columns.
 *
 * Scans every header, not just the ones the shared stack left unmapped.
 * "Item ID" is an exact synonym for `sku`, but the shared dictionary has no
 * `sku` slot to put it in — so it settles for the closest thing it does have,
 * `invoice_number` (a SALES-only field), on a 57% fuzzy match to "txn id".
 * Left alone, that false claim counts toward looksLikeSalesExport and gets a
 * genuine catalogue rejected as a sales report.
 *
 * A header already doing real catalogue work (claimed as `name`, `price`,
 * etc.) is never stolen — only a header the catalogue would otherwise throw
 * away is up for reclaiming.
 */
function claimSupplementary(headers, mapping, alreadyTaken) {
  const claimed = {};
  for (const raw of headers || []) {
    const normalised = normalizeHeader(raw);
    for (const [field, synonyms] of Object.entries(SUPPLEMENTARY)) {
      if (alreadyTaken.has(field) || claimed[field]) continue;
      if (!synonyms.includes(normalised)) continue;
      const claimedAs = headerClaimedAs(mapping, raw);
      if (claimedAs && CANONICAL_TO_CATALOGUE[claimedAs]) continue; // already a real catalogue field
      claimed[field] = { rawHeader: raw, confidence: 0.95, tier: 'auto', source: `exact match: "${normalised}"` };
      break;
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
  // Scanning every header, not just `unmapped`/`ignored`: the shared stack
  // actively IGNORES barcode columns (analytics had no use for one), but it
  // also sometimes MAPS an sku-shaped header to a sales-only field for lack
  // of anything better ("Item ID" -> invoice_number on a 57% fuzzy match to
  // "txn id"). claimSupplementary refuses to steal a header already doing
  // real catalogue work, so this is safe to run over the full header list.
  const taken = new Set(Object.keys(fields));
  const supplementary = claimSupplementary(headers, resolved.mapping, taken);
  Object.assign(fields, supplementary);

  // --- ask the detector what kind of file this is -------------------------
  // A header just reclaimed above was never real sales evidence — it was the
  // shared dictionary's best guess for a header it has no true home for.
  const reclaimedHeaders = new Set(Object.values(supplementary).map((f) => f.rawHeader));
  const salesFields = SALES_ONLY_CANONICALS.filter(
    (f) => resolved.mapping[f] && !reclaimedHeaders.has(resolved.mapping[f].rawHeader),
  );

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
