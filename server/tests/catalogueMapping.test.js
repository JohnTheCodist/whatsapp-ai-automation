/**
 * Catalogue mapping — the adapter over the ported RxNaija stack.
 *
 * These tests exercise the REAL chain (cleanData -> detectSchema ->
 * resolveMapping), not a stub, so a regression in the ported code shows up
 * here rather than in front of a pharmacy.
 *
 * The three header shapes from the brief are tested literally because they
 * are what actual files look like. The cost-versus-selling-price cases matter
 * most: mapping "Unit Cost" to price makes the assistant quote the pharmacy's
 * own purchase price to every customer, in writing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyseCatalogue } = require('../services/catalogue/catalogueMapping');

const money = (n) => `₦${n.toLocaleString('en-NG')}.00`;

// ---- the three shapes from the brief ----

test('Product | Price | Stock', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol Extra', Price: money(1250), Stock: 12 },
    { Product: 'Augmentin 625mg', Price: money(6400), Stock: 4 },
  ]);
  assert.equal(r.fields.name.rawHeader, 'Product');
  assert.equal(r.fields.price.rawHeader, 'Price');
  assert.equal(r.fields.stock_qty.rawHeader, 'Stock');
  assert.deepEqual(r.missingRequired, []);
  assert.equal(r.ok, true);
});

test('Medicine Name | Selling Price | Qty', () => {
  const r = analyseCatalogue([
    { 'Medicine Name': 'Panadol', 'Selling Price': money(1250), Qty: 12 },
    { 'Medicine Name': 'Augmentin', 'Selling Price': money(6400), Qty: 4 },
  ]);
  assert.equal(r.fields.name.rawHeader, 'Medicine Name');
  assert.equal(r.fields.price.rawHeader, 'Selling Price');
  assert.equal(r.fields.stock_qty.rawHeader, 'Qty', 'a bare Qty in a catalogue is stock on hand');
});

test('a reinterpreted Qty is flagged for review rather than passed off as certain', () => {
  const r = analyseCatalogue([
    { 'Medicine Name': 'Panadol', 'Selling Price': money(1250), Qty: 12 },
  ]);
  assert.equal(r.fields.stock_qty.reinterpreted, true);
  assert.equal(r.fields.stock_qty.tier, 'review');
  assert.match(
    r.fields.stock_qty.source, /catalogue, not a sales report/,
    'the owner should see WHY it was read as stock — 12 in stock and 12 sold are different claims',
  );
});

test('Item Description | Unit Cost | Available Quantity', () => {
  const r = analyseCatalogue([
    { 'Item Description': 'Panadol', 'Unit Cost': money(900), 'Available Quantity': 12 },
    { 'Item Description': 'Augmentin', 'Unit Cost': money(5000), 'Available Quantity': 4 },
  ]);
  assert.equal(r.fields.name.rawHeader, 'Item Description');
  assert.equal(r.fields.stock_qty.rawHeader, 'Available Quantity');
  assert.equal(
    r.fields.cost_price.rawHeader, 'Unit Cost',
    'Unit Cost is what the pharmacy PAID',
  );
  assert.equal(r.fields.price, undefined, 'there is no selling price in this file');
  assert.ok(r.missingRequired.includes('price'));
  assert.equal(r.ok, false, 'importing this silently would leave every product unpriceable');
});

// ---- the expensive mistake ----

test('with both present, selling price wins and cost stays separate', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol', 'Unit Cost': money(900), 'Selling Price': money(1250), Qty: 12 },
    { Product: 'Augmentin', 'Unit Cost': money(5000), 'Selling Price': money(6400), Qty: 4 },
  ]);
  assert.equal(r.fields.price.rawHeader, 'Selling Price');
  assert.equal(r.fields.cost_price.rawHeader, 'Unit Cost');
});

test('cost is never absorbed into price, whatever it is called', () => {
  for (const header of ['Cost', 'Cost Price', 'Purchase Price', 'Buying Price']) {
    const r = analyseCatalogue([
      { Product: 'Panadol', [header]: money(900) },
      { Product: 'Augmentin', [header]: money(5000) },
    ]);
    assert.notEqual(r.fields.price?.rawHeader, header, `"${header}" must not become the selling price`);
  }
});

// ---- sales export guard (task 3.8) ----

test('a sales export is refused rather than imported as a catalogue', () => {
  const r = analyseCatalogue([
    { 'Transaction Date': '2026-01-05', Product: 'Panadol', 'Quantity Sold': 2, Revenue: money(2500), 'Payment Method': 'Cash', Cashier: 'Ada' },
    { 'Transaction Date': '2026-01-06', Product: 'Augmentin', 'Quantity Sold': 1, Revenue: money(6400), 'Payment Method': 'Transfer', Cashier: 'Ada' },
  ]);
  assert.equal(
    r.looksLikeSalesExport, true,
    'every transaction row would otherwise become a product, duplicated per sale',
  );
  assert.ok(r.salesFields.length >= 2);
  assert.equal(r.ok, false);
});

test('one incidental sales-ish column does not condemn a real catalogue', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol', 'Selling Price': money(1250), Stock: 12, Discount: '5%' },
    { Product: 'Augmentin', 'Selling Price': money(6400), Stock: 4, Discount: '0%' },
  ]);
  assert.equal(r.looksLikeSalesExport, false);
});

// ---- the gaps the shared dictionary does not cover ----

test('sku and barcode are claimed, which the shared dictionary has no concept of', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol', SKU: 'PAN-001', Barcode: '6001234567890', Price: money(1250) },
    { Product: 'Augmentin', SKU: 'AUG-002', Barcode: '6009876543210', Price: money(6400) },
  ]);
  assert.equal(r.fields.sku?.rawHeader, 'SKU');
  assert.equal(r.fields.barcode?.rawHeader, 'Barcode');
});

// ---- cleaning is really running ----

test('empty rows are dropped by the ported cleaner before mapping', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol', Price: money(1250), Stock: 12 },
    { Product: '', Price: '', Stock: '' },
    { Product: 'Augmentin', Price: money(6400), Stock: 4 },
  ]);
  assert.equal(r.rowsIn, 3);
  assert.equal(r.rowsOut, 2, 'the blank row must not become a product');
});

test('a rich file maps the optional fields too', () => {
  const r = analyseCatalogue([
    {
      'Item Description': 'PANADOL EXTRA', 'Generic Name': 'Paracetamol', Brand: 'Panadol',
      Category: 'Analgesic', 'Dosage Form': 'Tablet', Strength: '500mg', 'Pack Size': 'x24',
      'Selling Price': money(1250), 'Available Quantity': 12, 'Exp Date': '2027-04-30',
    },
  ]);
  for (const f of ['name', 'generic_name', 'brand_name', 'category', 'form', 'strength', 'pack_size', 'price', 'stock_qty', 'expiry_date']) {
    assert.ok(r.fields[f], `expected ${f} to be mapped`);
  }
});

// ---- honesty ----

test('every proposal explains itself and says whether it needs review', () => {
  const r = analyseCatalogue([{ Product: 'Panadol', 'Unit Cost': money(900), Stock: 12 }]);
  for (const p of r.proposals) {
    assert.ok(p.source && typeof p.source === 'string', `${p.field} has no explanation`);
    assert.ok(['auto', 'review', 'confirm'].includes(p.tier), `${p.field} has tier ${p.tier}`);
    assert.equal(typeof p.needsReview, 'boolean');
  }
});

test('a column the catalogue does not store is reported, never silently dropped', () => {
  // The shared dictionary is a superset and maps "Shelf Location" to `branch`,
  // a sales-analytics field with no catalogue column. Deriving `unmapped` from
  // resolved.unmapped let it vanish from the report entirely — mapped to
  // nothing the owner can see, and never flagged as dropped.
  const r = analyseCatalogue([
    { Product: 'Panadol', Price: money(1250), 'Shelf Location': 'A3' },
    { Product: 'Augmentin', Price: money(6400), 'Shelf Location': 'B1' },
  ]);
  assert.ok(
    r.unmapped.includes('Shelf Location'),
    'a column that will not be imported must appear somewhere the owner looks',
  );
});

test('a recognised-but-unused column says what it was recognised as', () => {
  const r = analyseCatalogue([
    { Product: 'Panadol', Price: money(1250), 'Shelf Location': 'A3' },
    { Product: 'Augmentin', Price: money(6400), 'Shelf Location': 'B1' },
  ]);
  const noted = r.detectedButUnused.find((d) => d.rawHeader === 'Shelf Location');
  assert.ok(noted, 'this should read as a decision, not an oversight');
  assert.equal(noted.canonical, 'branch');
});

test('every header in the file is accounted for — mapped or listed', () => {
  const headers = ['Product', 'Selling Price', 'Stock', 'Shelf Location', 'Supplier', 'Notes'];
  const row = {
    Product: 'Panadol', 'Selling Price': money(1250), Stock: 12,
    'Shelf Location': 'A3', Supplier: 'Emzor', Notes: 'fast mover',
  };
  const r = analyseCatalogue([row, { ...row, Product: 'Augmentin' }]);

  const mappedHeaders = Object.values(r.fields).map((f) => f.rawHeader);
  for (const h of headers) {
    assert.ok(
      mappedHeaders.includes(h) || r.unmapped.includes(h),
      `"${h}" is neither imported nor reported — it disappeared`,
    );
  }
});

test('an empty file is refused with a reason instead of throwing', () => {
  for (const input of [[], null, undefined]) {
    const r = analyseCatalogue(input);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_file');
    assert.deepEqual(r.missingRequired, ['name', 'price']);
  }
});
