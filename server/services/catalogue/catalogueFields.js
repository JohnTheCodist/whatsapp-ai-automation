/**
 * The canonical vocabulary of a pharmacy CATALOGUE.
 *
 * Not a sales export. The ported dictionary from the analytics product knows
 * about transaction dates, revenue and quantity sold; a catalogue has none of
 * those, and inheriting that vocabulary would mean a detector confidently
 * mapping the wrong things.
 *
 * THE MOST IMPORTANT DISTINCTION IN THIS FILE is selling price versus cost
 * price. Real pharmacy spreadsheets routinely carry both, under headings as
 * close as "Price" and "Unit Cost". Map cost to `price` and the assistant
 * quotes the wrong number to every customer — losing money on each sale and
 * doing it in writing.
 *
 * The ported schemaDetector has a comment about exactly this class of bug:
 * "TotalAmount_NGN" scored as a tax column and a pharmacy's revenue was read
 * as tax. Same shape of mistake, worse consequences here.
 *
 * So cost price is a FIRST-CLASS field that we detect in order to keep it
 * away from `price`, not a synonym we quietly absorb.
 */

/**
 * @typedef {object} FieldSpec
 * @property {string} label        shown to the pharmacy owner
 * @property {boolean} required
 * @property {string[]} synonyms   normalised header forms that mean this field
 * @property {string} [note]       shown in the confirmation UI when ambiguous
 */

/** @type {Record<string, FieldSpec>} */
const CATALOGUE_FIELDS = {
  name: {
    label: 'Product name',
    required: true,
    note: 'What the customer asks for. Used to match "do you have Augmentin?".',
    synonyms: [
      'product', 'product name', 'item', 'item name', 'item description',
      'description', 'drug', 'drug name', 'medicine', 'medicine name',
      'name', 'particulars', 'stock item', 'product description', 'goods',
    ],
  },

  price: {
    label: 'Selling price',
    required: true,
    note: 'The price a customer pays. NOT what the pharmacy paid for it.',
    synonyms: [
      'price', 'selling price', 'sale price', 'sales price', 'retail price',
      'unit price', 'unit selling price', 'amount', 'rate', 'srp',
      'price ngn', 'price naira', 'selling', 'mrp',
    ],
  },

  // Detected specifically so it can be kept OUT of `price`.
  cost_price: {
    label: 'Cost price (what you paid)',
    required: false,
    note: 'Never quoted to customers. Detected so it is not mistaken for the selling price.',
    synonyms: [
      'cost', 'unit cost', 'cost price', 'purchase price', 'buying price',
      'buy price', 'landing cost', 'wholesale price', 'supplier price',
      'cost ngn', 'purchase rate',
    ],
  },

  stock_qty: {
    label: 'Stock quantity',
    required: false,
    note: 'Leave unmapped if this file has no reliable stock count.',
    synonyms: [
      'qty', 'quantity', 'stock', 'stock qty', 'stock quantity', 'in stock',
      'available', 'available quantity', 'available qty', 'on hand',
      'balance', 'stock balance', 'quantity in stock', 'closing stock', 'count',
    ],
  },

  generic_name: {
    label: 'Generic name',
    required: false,
    synonyms: [
      'generic', 'generic name', 'active ingredient', 'ingredient',
      'molecule', 'composition', 'inn',
    ],
  },

  brand_name: {
    label: 'Brand name',
    required: false,
    synonyms: ['brand', 'brand name', 'trade name', 'manufacturer brand', 'make'],
  },

  category: {
    label: 'Category',
    required: false,
    synonyms: [
      'category', 'class', 'classification', 'type', 'group', 'department',
      'therapeutic class', 'drug class', 'product category', 'section',
    ],
  },

  form: {
    label: 'Form',
    required: false,
    note: 'Tablet, syrup, capsule, injection…',
    synonyms: ['form', 'dosage form', 'formulation', 'presentation', 'dosage'],
  },

  strength: {
    label: 'Strength',
    required: false,
    note: 'e.g. 500mg. Often embedded in the product name instead.',
    synonyms: ['strength', 'dose', 'dosage strength', 'potency', 'mg', 'concentration'],
  },

  pack_size: {
    label: 'Pack size',
    required: false,
    synonyms: [
      'pack', 'pack size', 'packsize', 'packaging', 'unit', 'units',
      'pack qty', 'size', 'quantity per pack', 'uom', 'unit of measure',
    ],
  },

  sku: {
    label: 'SKU / product code',
    required: false,
    synonyms: ['sku', 'code', 'product code', 'item code', 'stock code', 'ref', 'reference', 'id'],
  },

  barcode: {
    label: 'Barcode',
    required: false,
    synonyms: ['barcode', 'bar code', 'ean', 'upc', 'gtin', 'scan code'],
  },

  expiry_date: {
    label: 'Expiry date',
    required: false,
    synonyms: [
      'expiry', 'expiry date', 'exp', 'exp date', 'expiration', 'expiration date',
      'best before', 'use by', 'expires',
    ],
  },
};

/**
 * Headers that mean the file is a SALES EXPORT, not a catalogue.
 *
 * Task 3.8. An owner who uploads last month's sales report gets a clear "this
 * is the wrong file" instead of a catalogue full of nonsense products — every
 * transaction row would become a product, duplicated per sale.
 */
const SALES_EXPORT_SIGNALS = [
  'transaction date', 'transaction id', 'receipt', 'receipt no', 'invoice',
  'invoice no', 'quantity sold', 'qty sold', 'revenue', 'total amount',
  'amount paid', 'payment method', 'cashier', 'customer name', 'sale date',
  'sold by', 'discount', 'vat', 'tax',
];

/** Fields without which a catalogue cannot answer a customer question. */
const REQUIRED_FIELDS = Object.entries(CATALOGUE_FIELDS)
  .filter(([, spec]) => spec.required)
  .map(([field]) => field);

/** Every canonical field name. */
const ALL_FIELDS = Object.keys(CATALOGUE_FIELDS);

module.exports = {
  CATALOGUE_FIELDS,
  SALES_EXPORT_SIGNALS,
  REQUIRED_FIELDS,
  ALL_FIELDS,
};
