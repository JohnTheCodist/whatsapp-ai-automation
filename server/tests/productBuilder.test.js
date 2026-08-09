/**
 * Row -> product.
 *
 * The strength tests are the ones that matter. The ported normaliser
 * overwrites the strength stated in a file with its own reference default —
 * measured, not theorised. In analytics that is harmless grouping; in a
 * catalogue it means telling a customer the wrong strength of an antibiotic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProduct, toKobo, toDate } = require('../services/catalogue/productBuilder');

const F = {
  name: { rawHeader: 'Product' },
  price: { rawHeader: 'Price' },
  stock_qty: { rawHeader: 'Stock' },
};

// ---- the safety-relevant one ----

test('the strength in the file wins over the reference default', () => {
  const { product } = buildProduct({ Product: 'Amoxil 250mg', Price: '₦1,200' }, F);
  assert.equal(
    product.strength, '250mg',
    'the reference data says 500mg for Amoxil — recording that would misstate an antibiotic the pharmacy actually stocks',
  );
});

test('a disagreement with the reference is recorded, never silent', () => {
  const { product, issues } = buildProduct({ Product: 'Panadol 1000mg', Price: '₦900' }, F);
  const flagged = issues.find((i) => i.reason === 'strength_differs_from_reference');
  assert.ok(flagged, 'a silent correction is the dangerous kind');
  assert.match(flagged.detail, /1000mg/);
  assert.ok(product.data_flags.includes('strength_from_file'));
});

test('agreement produces no noise', () => {
  const { issues } = buildProduct({ Product: 'Amoxil 500mg', Price: '₦1,500' }, F);
  assert.equal(issues.filter((i) => i.reason === 'strength_differs_from_reference').length, 0);
});

test('an explicit strength column beats anything parsed from the name', () => {
  const fields = { ...F, strength: { rawHeader: 'Strength' } };
  const { product } = buildProduct({ Product: 'Amoxil 250mg', Strength: '125mg', Price: '₦800' }, fields);
  assert.equal(product.strength, '125mg');
});

// ---- identity ----

test('natural_key ignores case and surrounding whitespace', () => {
  const a = buildProduct({ Product: '  PANADOL EXTRA 500mg x24 ', Price: '₦1,250' }, F).product;
  const b = buildProduct({ Product: 'panadol extra 500mg x24', Price: '₦1,250' }, F).product;
  assert.equal(a.natural_key, b.natural_key, 'a re-upload must not duplicate the same row');
});

test('natural_key does NOT depend on the order products are processed', () => {
  // The reference data assigns canonicalId as a per-process counter, so the
  // same drug gets DRUG-10000 or DRUG-10001 purely by input order. Keying on
  // that would merge one drug's row into another drug's data on re-upload.
  const forward = ['Augmentin 625mg', 'Panadol Extra', 'Amoxil 500mg']
    .map((n) => buildProduct({ Product: n, Price: '₦100' }, F).product.natural_key);
  const reverse = ['Amoxil 500mg', 'Panadol Extra', 'Augmentin 625mg']
    .map((n) => buildProduct({ Product: n, Price: '₦100' }, F).product.natural_key);

  assert.equal(forward[0], reverse[2], 'Augmentin must key the same regardless of position');
  assert.equal(forward[2], reverse[0], 'Amoxil must key the same regardless of position');
  assert.equal(new Set([...forward, ...reverse]).size, 3, 'three drugs must yield exactly three keys');
});

test('different products never share a natural_key', () => {
  const keys = ['Panadol Extra', 'Augmentin 625mg', 'Zzz Herbal Mix 10ml', 'Cotton Wool 100g']
    .map((n) => buildProduct({ Product: n, Price: '₦100' }, F).product.natural_key);
  assert.equal(new Set(keys).size, 4, 'a collision here merges unrelated products into one row');
});

test('an unknown product is flagged rather than given an invented generic', () => {
  // The reference data answers "Cotton Wool" as the generic name of
  // "Cotton Wool 100g" — an echo, not knowledge.
  const { product } = buildProduct({ Product: 'Cotton Wool 100g', Price: '₦500' }, F);
  assert.equal(product.generic_name, null, 'restating the product name is not a generic name');
  assert.ok(product.data_flags.includes('unrecognised_product'));
});

test('a real generic is still taken from the reference data', () => {
  const { product } = buildProduct({ Product: 'Amoxil 500mg', Price: '₦1,500' }, F);
  assert.equal(product.generic_name, 'Amoxicillin');
  assert.ok(!product.data_flags.includes('unrecognised_product'));
});

// ---- price ----

test('price is stored as integer kobo', () => {
  assert.equal(buildProduct({ Product: 'Panadol', Price: '₦1,250.00' }, F).product.price_kobo, 125000);
  assert.equal(toKobo('₦0.50'), 50);
});

test('a missing price is flagged but the product is still imported', () => {
  const { product, issues } = buildProduct({ Product: 'Panadol', Price: '' }, F);
  assert.equal(product.price_kobo, null, 'null is not zero — the assistant must never quote it');
  assert.ok(product.data_flags.includes('no_price'));
  assert.ok(issues.some((i) => i.reason === 'missing_or_unparseable_price'));
  assert.equal(
    product.status, 'active',
    'stocking it without a price is real — "we have it, let me check the price" beats "we do not have it"',
  );
});

test('a row with no product name is rejected outright', () => {
  const { product, issues } = buildProduct({ Product: '   ', Price: '₦100' }, F);
  assert.equal(product, null);
  assert.equal(issues[0].reason, 'missing_product_name');
});

// ---- stock ----

test('no stock column means untracked, not zero', () => {
  const { product } = buildProduct({ Product: 'Panadol', Price: '₦100' }, { name: F.name, price: F.price });
  assert.equal(product.stock_tracked, false);
  assert.equal(product.stock_qty, null, 'zero would mean "we counted none", which is a different claim');
});

test('a counted zero is preserved as zero', () => {
  const { product } = buildProduct({ Product: 'Panadol', Price: '₦100', Stock: 0 }, F);
  assert.equal(product.stock_tracked, true);
  assert.equal(product.stock_qty, 0);
});

test('unparseable stock is flagged rather than guessed', () => {
  const { product, issues } = buildProduct({ Product: 'Panadol', Price: '₦100', Stock: 'plenty' }, F);
  assert.equal(product.stock_qty, null);
  assert.ok(issues.some((i) => i.reason === 'unparseable_stock'));
});

// ---- expiry ----

test('an expired item is imported but hidden from customers', () => {
  const fields = { ...F, expiry_date: { rawHeader: 'Exp' } };
  const { product, issues } = buildProduct({ Product: 'Panadol', Price: '₦100', Exp: '2020-01-31' }, fields);
  assert.equal(product.status, 'hidden');
  assert.ok(product.data_flags.includes('expired'));
  assert.ok(issues.some((i) => i.reason === 'already_expired'));
});

test('a future expiry leaves the product active', () => {
  const fields = { ...F, expiry_date: { rawHeader: 'Exp' } };
  const { product } = buildProduct({ Product: 'Panadol', Price: '₦100', Exp: '2099-12-31' }, fields);
  assert.equal(product.status, 'active');
});

test('date parsing handles the formats pharmacy files actually use', () => {
  assert.equal(toDate('2027-04-30').toISOString().slice(0, 7), '2027-04');
  assert.equal(toDate('04/2027').toISOString().slice(0, 7), '2027-04', 'bare month/year means end of that month');
  assert.equal(toDate(46000).toISOString().slice(0, 4), '2025', 'Excel serial date');
  assert.equal(toDate(''), null);
  assert.equal(toDate('not a date'), null);
});
