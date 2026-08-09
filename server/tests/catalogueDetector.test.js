/**
 * Column detection for real pharmacy spreadsheets.
 *
 * The three header shapes from the brief are tested literally, because they
 * are what actual files look like. The cost-vs-selling-price tests matter
 * most: mapping "Unit Cost" to `price` makes the assistant quote the
 * pharmacy's own purchase price to every customer, in writing.
 *
 * Pure — no database, no files.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectCatalogueSchema } = require('../services/catalogue/catalogueDetector');

// ---- the three shapes from the brief ----

test('Product | Price | Stock', () => {
  const r = detectCatalogueSchema(['Product', 'Price', 'Stock']);
  assert.equal(r.mapping.Product, 'name');
  assert.equal(r.mapping.Price, 'price');
  assert.equal(r.mapping.Stock, 'stock_qty');
  assert.deepEqual(r.missingRequired, []);
});

test('Medicine Name | Selling Price | Qty', () => {
  const r = detectCatalogueSchema(['Medicine Name', 'Selling Price', 'Qty']);
  assert.equal(r.mapping['Medicine Name'], 'name');
  assert.equal(r.mapping['Selling Price'], 'price');
  assert.equal(r.mapping.Qty, 'stock_qty');
});

test('Item Description | Unit Cost | Available Quantity', () => {
  const r = detectCatalogueSchema(['Item Description', 'Unit Cost', 'Available Quantity']);
  assert.equal(r.mapping['Item Description'], 'name');
  assert.equal(r.mapping['Available Quantity'], 'stock_qty');
  assert.equal(
    r.mapping['Unit Cost'], 'cost_price',
    'Unit Cost is what the pharmacy PAID — quoting it to customers loses money on every sale',
  );
  assert.ok(
    r.missingRequired.includes('price'),
    'with only a cost column there is no sellable price, and the owner must be told',
  );
});

// ---- the expensive mistake ----

test('when both are present, selling price wins and cost is kept separate', () => {
  const r = detectCatalogueSchema(['Product', 'Unit Cost', 'Selling Price', 'Qty']);
  assert.equal(r.mapping['Selling Price'], 'price');
  assert.equal(r.mapping['Unit Cost'], 'cost_price');
});

test('cost is never silently absorbed into price, whatever it is called', () => {
  for (const header of ['Cost', 'Cost Price', 'Purchase Price', 'Buying Price', 'Wholesale Price']) {
    const r = detectCatalogueSchema(['Product', header]);
    assert.notEqual(r.mapping[header], 'price', `"${header}" must not become the selling price`);
  }
});

// ---- value-shape evidence ----

test('an ambiguous "Amount" column of money maps to price, not stock', () => {
  const rows = [
    { Product: 'Panadol', Amount: '₦1,250.00' },
    { Product: 'Augmentin', Amount: '₦6,400.00' },
    { Product: 'Vitamin C', Amount: '₦900.00' },
  ];
  const r = detectCatalogueSchema(['Product', 'Amount'], rows);
  assert.equal(r.mapping.Amount, 'price');
});

test('a column of small whole numbers reads as stock, not price', () => {
  const rows = [
    { Item: 'Panadol', Units: 12 },
    { Item: 'Augmentin', Units: 4 },
    { Item: 'Vitamin C', Units: 30 },
  ];
  const r = detectCatalogueSchema(['Item', 'Units'], rows);
  assert.notEqual(r.mapping.Units, 'price');
});

test('a date column is recognised as expiry rather than a number field', () => {
  const rows = [
    { Product: 'Panadol', Exp: '2027-04-30' },
    { Product: 'Augmentin', Exp: '2026-11-01' },
  ];
  const r = detectCatalogueSchema(['Product', 'Exp'], rows);
  assert.equal(r.mapping.Exp, 'expiry_date');
});

// ---- sales export guard (task 3.8) ----

test('a sales export is identified rather than imported as a catalogue', () => {
  const r = detectCatalogueSchema([
    'Transaction Date', 'Product', 'Quantity Sold', 'Revenue', 'Payment Method', 'Cashier',
  ]);
  assert.equal(
    r.looksLikeSalesExport, true,
    'every transaction row would otherwise become a product, duplicated per sale',
  );
  assert.ok(r.salesExportSignals.length >= 2);
});

test('one incidental signal does not condemn a real catalogue', () => {
  const r = detectCatalogueSchema(['Product', 'Price', 'Stock', 'Discount']);
  assert.equal(r.looksLikeSalesExport, false, 'a catalogue may legitimately carry a discount column');
});

// ---- honesty about what it does not know ----

test('missing required fields are reported, not invented', () => {
  const r = detectCatalogueSchema(['Supplier', 'Notes', 'Shelf']);
  assert.ok(r.missingRequired.includes('name'));
  assert.ok(r.missingRequired.includes('price'));
});

test('unrecognised columns are left unmapped rather than forced', () => {
  const r = detectCatalogueSchema(['Product', 'Price', 'Shelf Location', 'Supplier Ref']);
  assert.ok(r.unmapped.includes('Shelf Location'));
  assert.equal(r.mapping['Shelf Location'], undefined);
});

test('one column cannot claim two fields, and one field cannot take two columns', () => {
  const r = detectCatalogueSchema(['Price', 'Price NGN', 'Product']);
  const assigned = Object.values(r.mapping);
  assert.equal(new Set(assigned).size, assigned.length, 'duplicate field assignment');
  assert.equal(new Set(Object.keys(r.mapping)).size, Object.keys(r.mapping).length);
});

test('every column gets a proposal with alternatives for the confirmation step', () => {
  const r = detectCatalogueSchema(['Medicine Name', 'Selling Price']);
  assert.equal(r.proposals.length, 2);
  for (const p of r.proposals) {
    assert.ok(Array.isArray(p.alternatives));
    assert.ok(typeof p.confident === 'boolean');
  }
});

// ---- robustness ----

test('survives empty, blank and malformed headers', () => {
  for (const headers of [[], null, undefined, ['', '   ', null, undefined]]) {
    const r = detectCatalogueSchema(headers);
    assert.deepEqual(r.mapping, {});
    assert.ok(r.missingRequired.includes('name'));
  }
});

test('handles camelCase and underscored headers', () => {
  const r = detectCatalogueSchema(['ProductName', 'SellingPrice', 'stock_qty']);
  assert.equal(r.mapping.ProductName, 'name');
  assert.equal(r.mapping.SellingPrice, 'price');
  assert.equal(r.mapping.stock_qty, 'stock_qty');
});

test('a column with no matching field is not force-fitted to a required one', () => {
  const r = detectCatalogueSchema(['Warehouse Bin Reference']);
  assert.equal(r.mapping['Warehouse Bin Reference'], undefined);
});
