/**
 * How catalogue fields are PRESENTED to a pharmacy owner.
 *
 * Labels and warnings only. This file deliberately holds no synonyms and does
 * no matching.
 *
 * An earlier version had its own synonym table and scoring. That was replaced
 * by an adapter over the ported RxNaija stack (see catalogueMapping.js), which
 * is hardened against real spreadsheets in ways a fresh table is not. Keeping
 * a second synonym list here would guarantee the two drift, and a mapping bug
 * would then depend on which one happened to win.
 *
 * One source of truth for matching: services/ingestion/dictionary.js.
 * One source of truth for wording: this file.
 */

/**
 * @typedef {object} FieldDisplay
 * @property {string} label     shown against the column in the confirmation UI
 * @property {boolean} required
 * @property {string} [warning] shown when this field is involved in a choice
 *                              the owner could get expensively wrong
 */

/** @type {Record<string, FieldDisplay>} */
const FIELD_DISPLAY = {
  name: {
    label: 'Product name',
    required: true,
    warning: 'This is what customers ask for. If it is wrong, the assistant cannot find the product at all.',
  },
  price: {
    label: 'Selling price',
    required: true,
    warning: 'The price a customer PAYS. Do not map your cost price here — the assistant would quote it to every customer.',
  },
  cost_price: {
    label: 'Cost price (what you paid)',
    required: false,
    warning: 'Never shown to customers. Mapped only so it is kept out of the selling price.',
  },
  stock_qty: {
    label: 'Stock quantity',
    required: false,
    warning: 'Leave this unmapped if the file has no reliable count. A wrong number is worse than none — the assistant would promise stock you do not have.',
  },
  generic_name: { label: 'Generic name', required: false },
  brand_name:   { label: 'Brand name', required: false },
  category:     { label: 'Category', required: false },
  form:         { label: 'Form (tablet, syrup, injection…)', required: false },
  strength:     { label: 'Strength (e.g. 500mg)', required: false },
  pack_size:    { label: 'Pack size', required: false },
  sku:          { label: 'SKU / product code', required: false },
  barcode:      { label: 'Barcode', required: false },
  expiry_date:  { label: 'Expiry date', required: false },
};

/** Plain-language explanation of a confidence tier, for the owner. */
const TIER_DISPLAY = {
  auto:    { label: 'Confident', hint: 'Matched clearly. Change it if it looks wrong.' },
  review:  { label: 'Please check', hint: 'A reasonable match, but worth a look.' },
  confirm: { label: 'Needs your answer', hint: 'Too uncertain to assume. Please choose.' },
};

module.exports = { FIELD_DISPLAY, TIER_DISPLAY };
