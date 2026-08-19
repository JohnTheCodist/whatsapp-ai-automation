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
    const result = await stageUpload(req.pharmacyId, {
      filename: req.file.originalname,
      buffer: req.file.buffer,
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
                   price_kobo, stock_qty, stock_tracked, status, data_flags, description, is_featured
            from products
            where pharmacy_id = ${req.pharmacyId} and name ilike ${'%' + search + '%'}
            order by name limit ${limit}
          `
        : await db`
            select id, name, generic_name, category, form, strength, pack_size,
                   price_kobo, stock_qty, stock_tracked, status, data_flags, description, is_featured
            from products
            where pharmacy_id = ${req.pharmacyId}
            order by updated_at desc limit ${limit}
          `;

      const [totals] = await db`
        select
          count(*)::int as total,
          count(*) filter (where price_kobo is null)::int as no_price,
          count(*) filter (where status = 'active' and price_kobo is not null)::int as sellable,
          count(*) filter (where status = 'hidden')::int as hidden
        from products where pharmacy_id = ${req.pharmacyId}
      `;

      return { rows: list, counts: totals };
    });

    res.json({
      counts,
      products: rows.map((p) => ({
        ...p,
        // Naira for display. The assistant reads price_kobo; this is only so
        // the dashboard does not do currency maths in the browser.
        price: p.price_kobo === null ? null : p.price_kobo / 100,
      })),
    });
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
