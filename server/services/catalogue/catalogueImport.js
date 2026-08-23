/**
 * The two-step catalogue import.
 *
 *   stageUpload()      parse -> clean -> analyse -> stage. Writes NO products.
 *   confirmAndImport() apply the owner's corrections, then upsert.
 *
 * WHY TWO STEPS
 * Detection is good, not certain. A mapping applied without review is a
 * catalogue that is quietly wrong — and "quietly" is the problem, because the
 * way anyone finds out is a customer being quoted the pharmacy's cost price.
 * The owner sees what we propose, why, and how confident we are, and fixes it
 * before a single product row exists.
 *
 * UPSERT, NOT REPLACE
 * Re-uploading a corrected file must not orphan the products already there.
 * Rows are upserted on (pharmacy_id, natural_key), so a second upload updates
 * prices and stock rather than duplicating the shelf.
 */

const crypto = require('node:crypto');
const xlsx = require('xlsx');
const { getSql, assertPharmacyId } = require('../db');
const { analyseCatalogue } = require('./catalogueMapping');
const { buildProduct } = require('./productBuilder');

const MAX_ISSUES_STORED = 500;

/**
 * Parse a spreadsheet buffer into rows.
 *
 * `defval: null` matters: without it SheetJS omits empty cells entirely, so
 * rows have different key sets and a column that is blank in the first row
 * disappears from the header list.
 *
 * `codepage: 65001` matters for CSV. Without it, SheetJS's CSV reader falls
 * back to a non-UTF-8 codepage and every multi-byte character is mangled —
 * measured: a UTF-8 "₦" (e2 82 a6) came out as "â¦". The price then fails to
 * parse and the row is flagged `no_price`, even though the file had a real
 * price. .xlsx files carry their own encoding and are unaffected.
 */
function parseWorkbook(buffer, filename) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true, codepage: 65001 });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error(`${filename} contains no sheets.`);

  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
  return { rows, sheetName, sheetNames: workbook.SheetNames };
}

/**
 * Step 1. Parse, clean, analyse, stage. Nothing is written to products.
 */
async function stageUpload(pharmacyId, { filename, buffer, uploadedBy = null }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const { rows, sheetName, sheetNames } = parseWorkbook(buffer, filename);
  const analysis = analyseCatalogue(rows, { fileName: filename });

  const [upload] = await db`
    insert into catalogue_uploads
      (pharmacy_id, uploaded_by, filename, content_hash, sheet_name,
       status, detected_mapping, analysis, staged_rows, rows_total)
    values
      (${pharmacyId}, ${uploadedBy}, ${filename}, ${contentHash}, ${sheetName},
       ${analysis.ok ? 'awaiting_confirmation' : 'mapping'},
       ${db.json(mappingSummary(analysis))},
       ${db.json(publicAnalysis(analysis, sheetNames))},
       ${db.json(analysis.records || [])},
       ${analysis.rowsOut || 0})
    returning id, status, created_at
  `;

  return {
    uploadId: upload.id,
    status: upload.status,
    ...publicAnalysis(analysis, sheetNames),
  };
}

/** field -> rawHeader, for the detected_mapping column. */
function mappingSummary(analysis) {
  const out = {};
  for (const [field, d] of Object.entries(analysis.fields || {})) out[field] = d.rawHeader;
  return out;
}

/** Everything the owner sees. Deliberately excludes the staged rows. */
function publicAnalysis(analysis, sheetNames = []) {
  return {
    ok: analysis.ok,
    reason: analysis.reason || null,
    proposals: analysis.proposals || [],
    unmapped: analysis.unmapped || [],
    detectedButUnused: analysis.detectedButUnused || [],
    missingRequired: analysis.missingRequired || [],
    looksLikeSalesExport: Boolean(analysis.looksLikeSalesExport),
    salesFields: analysis.salesFields || [],
    rowsIn: analysis.rowsIn || 0,
    rowsOut: analysis.rowsOut || 0,
    sheetNames,
  };
}

/**
 * Step 2. Apply the owner's corrections and write products.
 *
 * @param {object} [overrides] field -> rawHeader, or field -> null to drop a
 *   proposal the owner rejected. Their choice always wins over detection.
 */
async function confirmAndImport(pharmacyId, uploadId, overrides = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [upload] = await db`
    select id, filename, status, analysis, staged_rows
    from catalogue_uploads
    where id = ${uploadId} and pharmacy_id = ${pharmacyId}
  `;
  if (!upload) throw new Error(`Upload ${uploadId} not found for this pharmacy.`);
  if (upload.status === 'completed') throw new Error('This upload has already been imported.');
  if (!upload.staged_rows || upload.staged_rows.length === 0) {
    throw new Error('The staged rows for this upload are gone. Please upload the file again.');
  }

  // Rebuild the field map from what was proposed, then let the owner's
  // corrections overwrite it. An explicit null removes a field entirely.
  const fields = {};
  for (const p of upload.analysis?.proposals || []) {
    fields[p.field] = { rawHeader: p.rawHeader };
  }
  for (const [field, rawHeader] of Object.entries(overrides || {})) {
    if (rawHeader === null || rawHeader === '') delete fields[field];
    else fields[field] = { rawHeader };
  }

  if (!fields.name) throw new Error('A product name column is required before importing.');

  await db`update catalogue_uploads set status = 'importing' where id = ${uploadId}`;

  const rows = upload.staged_rows;
  const issues = [];
  const products = [];
  let rejected = 0;

  rows.forEach((row, index) => {
    const { product, issues: rowIssues } = buildProduct(row, fields);
    // +2: one for the header row, one because spreadsheets are 1-indexed.
    // An issue the owner cannot locate in their own file is not actionable.
    const sheetRow = index + 2;

    for (const issue of rowIssues) {
      if (issues.length < MAX_ISSUES_STORED) issues.push({ row: sheetRow, ...issue });
    }
    if (!product) { rejected += 1; return; }
    products.push(product);
  });

  // Later rows win on a duplicate natural_key. Deduplicating here rather than
  // relying on the upsert is deliberate: Postgres refuses to update the same
  // row twice in one statement, so a file listing a product on two lines
  // would fail the whole import with a constraint error rather than importing.
  const byKey = new Map();
  let duplicates = 0;
  for (const p of products) {
    if (byKey.has(p.natural_key)) duplicates += 1;
    byKey.set(p.natural_key, p);
  }
  const unique = [...byKey.values()];

  if (duplicates > 0 && issues.length < MAX_ISSUES_STORED) {
    issues.push({
      row: null,
      field: 'name',
      reason: 'duplicate_rows_collapsed',
      value: String(duplicates),
      detail: `${duplicates} row(s) named a product that appears earlier in the file. The last one was kept.`,
    });
  }

  let imported = 0;
  if (unique.length > 0) {
    await db.begin(async (tx) => {
      // One statement, not one per product. A 5,000-line catalogue as 5,000
      // round trips to a remote pooler is the same mistake that timed out
      // Baileys' pre-key upload.
      const payload = unique.map((p) => ({
        pharmacy_id: pharmacyId,
        upload_id: uploadId,
        name: p.name,
        natural_key: p.natural_key,
        generic_name: p.generic_name,
        brand_name: p.brand_name,
        category: p.category,
        form: p.form,
        strength: p.strength,
        pack_size: p.pack_size,
        sku: p.sku,
        barcode: p.barcode,
        price_kobo: p.price_kobo,
        stock_qty: p.stock_qty,
        stock_tracked: p.stock_tracked,
        expiry_date: p.expiry_date,
        status: p.status,
        // tx.json(), NOT JSON.stringify(). Stringifying stores the array as a
        // jsonb STRING — jsonb_typeof comes back "string" rather than "array"
        // — and every containment query silently returns nothing. Measured:
        //   select ... where data_flags @> '["no_price"]'  ->  0 rows
        // against a catalogue that genuinely had one. The assistant would
        // never be able to find a flagged product, and nothing would error.
        data_flags: tx.json(p.data_flags),
      }));

      const result = await tx`
        insert into products ${tx(payload,
          'pharmacy_id', 'upload_id', 'name', 'natural_key', 'generic_name', 'brand_name',
          'category', 'form', 'strength', 'pack_size', 'sku', 'barcode',
          'price_kobo', 'stock_qty', 'stock_tracked', 'expiry_date', 'status', 'data_flags')}
        on conflict (pharmacy_id, natural_key) do update set
          upload_id     = excluded.upload_id,
          name          = excluded.name,
          generic_name  = coalesce(excluded.generic_name, products.generic_name),
          brand_name    = coalesce(excluded.brand_name, products.brand_name),
          category      = coalesce(excluded.category, products.category),
          form          = coalesce(excluded.form, products.form),
          strength      = coalesce(excluded.strength, products.strength),
          pack_size     = coalesce(excluded.pack_size, products.pack_size),
          sku           = coalesce(excluded.sku, products.sku),
          barcode       = coalesce(excluded.barcode, products.barcode),
          -- Price and stock are REPLACED, not coalesced. They are the whole
          -- point of a re-upload: a product that has become unpriced must
          -- stop being quoted, and keeping the old price would be worse than
          -- having none.
          price_kobo    = excluded.price_kobo,
          stock_qty     = excluded.stock_qty,
          stock_tracked = excluded.stock_tracked,
          expiry_date   = coalesce(excluded.expiry_date, products.expiry_date),
          status        = excluded.status,
          data_flags    = excluded.data_flags,
          updated_at    = now()
        returning id
      `;
      imported = result.length;

      await tx`
        update catalogue_uploads
        set status = 'completed',
            rows_imported = ${imported},
            rows_rejected = ${rejected},
            issues = ${tx.json(issues)},
            overrides = ${tx.json(overrides || {})},
            -- Staged rows are released here. Keeping them would turn this
            -- table into a copy of every file ever uploaded.
            staged_rows = null,
            completed_at = now()
        where id = ${uploadId}
      `;
    });
  } else {
    await db`
      update catalogue_uploads
      set status = 'failed',
          rows_imported = 0,
          rows_rejected = ${rejected},
          issues = ${db.json(issues)},
          staged_rows = null,
          completed_at = now()
      where id = ${uploadId}
    `;
  }

  return {
    uploadId,
    imported,
    rejected,
    duplicatesCollapsed: duplicates,
    // Counted before truncation, so the number is honest even when the list
    // shown is not the whole list.
    issueCount: issues.length,
    issues: issues.slice(0, 100),
    flagged: {
      noPrice: unique.filter((p) => p.data_flags.includes('no_price')).length,
      unrecognised: unique.filter((p) => p.data_flags.includes('unrecognised_product')).length,
      expired: unique.filter((p) => p.data_flags.includes('expired')).length,
      strengthFromFile: unique.filter((p) => p.data_flags.includes('strength_from_file')).length,
    },
  };
}

module.exports = { stageUpload, confirmAndImport, parseWorkbook };
