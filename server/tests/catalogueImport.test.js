/**
 * parseWorkbook — the very first step of the upload, before any cleaning
 * or mapping runs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { parseWorkbook } = require('../services/catalogue/catalogueImport');

test('a UTF-8 naira symbol in a CSV survives parsing', () => {
  // SheetJS's CSV reader does not assume UTF-8 by default. Measured: without
  // codepage: 65001, a real "₦" (e2 82 a6) came out as "â¦" and every priced
  // row in the file was flagged no_price even though the price was right
  // there in the file.
  const csv = 'Product,Price\nPanadol,₦1250.00\n';
  const buffer = Buffer.from(csv, 'utf8');
  const { rows } = parseWorkbook(buffer, 'test.csv');
  assert.equal(rows[0].Price, '₦1250.00');
});

test('an .xlsx file is unaffected by the codepage setting', () => {
  const ws = xlsx.utils.aoa_to_sheet([['Product', 'Price'], ['Panadol', '₦1250.00']]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const { rows } = parseWorkbook(buffer, 'test.xlsx');
  assert.equal(rows[0].Price, '₦1250.00');
});
