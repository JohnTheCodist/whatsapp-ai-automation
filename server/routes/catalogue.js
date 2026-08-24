/**
 * Catalogue upload and confirmation — Phase 3, tasks 3.1, 3.4, 3.7.
 *
 *   POST /api/catalogue/upload          file  -> proposed mapping (writes no products)
 *   POST /api/catalogue/:id/confirm     overrides -> import report
 *   GET  /api/catalogue/uploads         history
 *   GET  /api/catalogue/uploads/:id     one upload's analysis
 *   GET  /api/catalogue/products        what the assistant will actually see
 *   GET  /api/catalogue/fields          labels and warnings for the UI
 */

const express = require('express');
const multer = require('multer');
const path = require('node:path');

const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId, readWithRetry } = require('../services/db');
const { stageUpload, confirmAndImport } = require('../services/catalogue/catalogueImport');
const { FIELD_DISPLAY, TIER_DISPLAY } = require('../services/catalogue/catalogueFields');
const { findUnverifiedDuplicates } = require('../services/catalogue/duplicateReview');

const router = express.Router();

const ALLOWED_EXT = new Set(['.xlsx', '.xls', '.csv']);

const upload = multer({
  // In memory: the file is parsed immediately and the rows are staged in
  // Postgres, so there is nothing to gain from writing it to disk — and a
  // disk path is one more thing to clean up and to secure.
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      // Named explicitly: "invalid file" tells an owner nothing about what to
      // do next.
      return cb(new Error(`"${file.originalname}" is not a spreadsheet. Upload a .xlsx, .xls or .csv file.`));
    }
    cb(null, true);
  },
}).single('file');

/** Multer reports its own errors; turn them into something a person can act on. */
function handleUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That file is larger than 10MB. Export just the product list, or split it.'
      : err.message;
    res.status(400).json({ error: message, code: 'UPLOAD_REJECTED' });
  });
}

// ---------------------------------------------------------------------------

router.get('/fields', requireAuth, (req, res) => {
  res.json({ fields: FIELD_DISPLAY, tiers: TIER_DISPLAY });
});

/**
 * Step 1 — analyse only. Deliberately writes nothing to products, so an owner
 * can upload the wrong file and simply walk away.
 */
router.post('/upload', requireAuth, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.', code: 'NO_FILE' });
    }
    // Same allowlist reasoning as the products read: only an explicit
    // 'wholesale' targets the trade prices. A typo'd tier imports as retail,
    // which is visible and correctable; the reverse would quietly overwrite a
    // pharmacy's trade list with retail figures.
    const priceTier = req.body?.tier === 'wholesale' ? 'wholesale' : 'retail';

    const result = await stageUpload(req.pharmacyId, {
      filename: req.file.originalname,
      buffer: req.file.buffer,
      priceTier,
      uploadedBy: req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000'
        ? req.user.id
        : null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2 — apply corrections and import.
 *
 * `overrides` is field -> rawHeader, or field -> null to drop a proposal.
 * The owner's choice always beats detection.
 */
router.post('/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const overrides = req.body?.overrides || {};
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an object of field -> column.', code: 'BAD_OVERRIDES' });
    }
    const report = await confirmAndImport(req.pharmacyId, req.params.id, overrides);
    res.json(report);
  } catch (err) {
    // These are the owner's problem to fix, not server faults, and should
    // read as instructions rather than stack traces.
    if (/not found|already been imported|staged rows|product name column/i.test(err.message)) {
      return res.status(409).json({ error: err.message, code: 'CANNOT_IMPORT' });
    }
    next(err);
  }
});

router.get('/uploads', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const rows = await db`
      select id, filename, sheet_name, status, rows_total, rows_imported, rows_rejected,
             created_at, completed_at,
             jsonb_array_length(coalesce(issues, '[]'::jsonb)) as issue_count
      from catalogue_uploads
      where pharmacy_id = ${req.pharmacyId}
      order by created_at desc
      limit 20
    `;
    res.json({ uploads: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/uploads/:id', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    // staged_rows is deliberately not selected — it is the file's contents,
    // and this endpoint is about the mapping.
    const [row] = await db`
      select id, filename, sheet_name, status, analysis, detected_mapping, overrides,
             rows_total, rows_imported, rows_rejected, issues, created_at, completed_at
      from catalogue_uploads
      where id = ${req.params.id} and pharmacy_id = ${req.pharmacyId}
    `;
    if (!row) return res.status(404).json({ error: 'Upload not found.', code: 'NOT_FOUND' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

/** What the assistant will actually see. */
router.get('/products', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const search = (req.query.q || '').trim();

    // Which price tier this view is showing. Anything other than an explicit
    // 'wholesale' is retail — an unrecognised value must not silently reveal
    // trade prices, so this is an allowlist rather than a !== check.
    const isWholesale = req.query.tier === 'wholesale';

    // Both reads run inside ONE retry unit rather than two.
    //
    // This endpoint failed in production with `read ECONNRESET` thrown by the
    // counts query while the rows query directly above it had just succeeded:
    // the first read drew a live connection, the second drew one the pooler
    // had already dropped. Nothing was wrong with either statement.
    //
    // Retrying them together keeps the list and the totals derived from the
    // same attempt. Retrying only the failing one could pair a fresh count
    // with a stale list, which is a subtler wrong answer than the error was.
    const { rows, counts } = await readWithRetry(async () => {
      const list = search
        ? await db`
            select id, name, generic_name, category, form, strength, pack_size,
                   price_kobo, wholesale_price_kobo, stock_qty, stock_tracked,
                   status, data_flags, description, is_featured
            from products
            where pharmacy_id = ${req.pharmacyId} and name ilike ${'%' + search + '%'}
            order by name limit ${limit}
          `
        : await db`
            select id, name, generic_name, category, form, strength, pack_size,
                   price_kobo, wholesale_price_kobo, stock_qty, stock_tracked,
                   status, data_flags, description, is_featured
            from products
            where pharmacy_id = ${req.pharmacyId}
            order by updated_at desc limit ${limit}
          `;

      // Counted against the tier being VIEWED, not always retail. In the
      // wholesale view "no price" has to mean "no trade price", or the
      // headline figures describe a catalogue the user is not looking at.
      const [totals] = await db`
        select
          count(*)::int as total,
          count(*) filter (
            where (case when ${isWholesale} then wholesale_price_kobo else price_kobo end) is null
          )::int as no_price,
          count(*) filter (
            where status = 'active'
              and (case when ${isWholesale} then wholesale_price_kobo else price_kobo end) is not null
          )::int as sellable,
          count(*) filter (where status = 'hidden')::int as hidden
        from products where pharmacy_id = ${req.pharmacyId}
      `;

      return { rows: list, counts: totals };
    });

    res.json({
      tier: isWholesale ? 'wholesale' : 'retail',
      counts,
      products: rows.map((p) => {
        // The tier being viewed decides `price`. Both columns are still sent:
        // the wholesale view shows the retail figure beside the trade one as
        // context (that comparison is the point of a trade list), and a table
        // that had to re-fetch to show it would flicker on every switch.
        const active = isWholesale ? p.wholesale_price_kobo : p.price_kobo;
        return {
          ...p,
          // Naira for display. The assistant reads the kobo columns; this is
          // only so the dashboard does not do currency maths in the browser.
          price: active === null ? null : active / 100,
          retailPrice: p.price_kobo === null ? null : p.price_kobo / 100,
          wholesalePrice: p.wholesale_price_kobo === null ? null : p.wholesale_price_kobo / 100,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Names that look like the same product but couldn't be confirmed either
 * way — not found in NAFDAC, which doesn't list every drug on the market, so
 * this is a pointer for the pharmacist to check, never an automatic merge.
 */
router.get('/duplicates', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    // { pairs, willMergeOnReimport } — the second is a COUNT of near-identical
    // pairs NAFDAC can name on both sides, which the importer already
    // collapses. They need a re-upload, not a decision, so they are reported
    // as a number rather than as more rows to read.
    const review = await findUnverifiedDuplicates(req.pharmacyId);
    res.json(review);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH a product's selling points.
 *
 * Only `description` and `is_featured` are editable here — deliberately.
 * Price and stock come from the spreadsheet and are replaced on every
 * re-import, so an edit made here would be silently undone by the next
 * upload. Letting someone type a price into this screen would produce a
 * number that looks authoritative and lasts until Tuesday.
 */
router.patch('/products/:id', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const { description, isFeatured } = req.body || {};
    const db = getSql();

    const [row] = await db`
      update products set
        description = ${
          description === undefined
            ? db`description`
            : (String(description).trim() ? String(description).trim().slice(0, 300) : null)
        },
        is_featured = ${isFeatured === undefined ? db`is_featured` : Boolean(isFeatured)},
        updated_at = now()
      where id = ${req.params.id} and pharmacy_id = ${req.pharmacyId}
      returning id, name, description, is_featured
    `;
    if (!row) return res.status(404).json({ error: 'Product not found.', code: 'NOT_FOUND' });
    res.json({ product: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
