/**
 * One spreadsheet row -> one product record.
 *
 * WHY THE FILE BEATS THE KNOWLEDGE BASE
 * The ported productNormalizer is excellent at identity: it turns
 * "AMOXIL CAP 500MG x100" into "Amoxil 500mg Capsule" with a stable
 * canonicalId, which is exactly what natural_key needs so two spellings of
 * one drug do not become two products.
 *
 * But it also OVERWRITES the strength stated in the file with its own
 * default. Measured 2026-08-09:
 *
 *     "Panadol 1000mg"  -> 500mg
 *     "Augmentin 1g"    -> 625mg
 *     "Amoxil 250mg"    -> 500mg
 *     "Vitamin C 500mg" -> 100mg
 *
 * For sales analytics that is harmless — rows are being grouped, and the
 * canonical form is the point. For a catalogue it is not. This data answers
 * "how much is Amoxil 250mg?", and recording 500mg means telling a customer
 * the wrong strength of an antibiotic.
 *
 * So: identity comes from the knowledge base, FACTS come from the file. Where
 * they disagree the file wins and the disagreement is recorded in data_flags,
 * because a silent correction is the dangerous kind.
 */

const { normalizeProductName, normalizeProductText, extractStrength, extractForm, extractPackSize } =
  require('../ingestion/productNormalizer');
const { parseCurrency } = require('../ingestion/dataCleaner');

/**
 * Is this "generic name" real, or just the product name echoed back?
 *
 * The reference data returns a generic for things it does not actually know:
 *
 *     "Cotton Wool 100g"    -> generic "Cotton Wool"
 *     "Zzz Herbal Mix 10ml" -> generic "Zzz Herbal Mix"
 *     "Amoxil 500mg"        -> generic "Amoxicillin"   <- the real one
 *
 * A generic that is contained in the product name tells us nothing and
 * would show a pharmacist a "generic name" column full of restated brands.
 */
function isRealGeneric(generic, rawName) {
  if (!generic) return false;
  const g = String(generic).toLowerCase().replace(/\s+/g, '');
  const n = String(rawName).toLowerCase().replace(/\s+/g, '');
  return g.length > 2 && !n.includes(g);
}

/** Naira -> kobo. Money is stored as an integer; floats do not survive arithmetic. */
function toKobo(value) {
  const naira = parseCurrency(value);
  if (naira === null || !Number.isFinite(naira) || naira < 0) return null;
  return Math.round(naira * 100);
}

function toInt(value) {
  const n = parseCurrency(value);
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // Excel serial date.
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  // Bare month/year, common on expiry columns: treat as end of that month.
  const monthYear = s.match(/^(\d{1,2})[/-](\d{4})$/);
  if (monthYear) {
    const d = new Date(Date.UTC(Number(monthYear[2]), Number(monthYear[1]), 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * @param {object} row      one cleaned sheet row, keyed by RAW header
 * @param {object} fields   from analyseCatalogue().fields — field -> {rawHeader}
 * @returns {{product: object|null, issues: object[]}}
 */
function buildProduct(row, fields) {
  const issues = [];
  const get = (field) => {
    const spec = fields[field];
    return spec ? row[spec.rawHeader] : undefined;
  };

  const rawName = clean(get('name'));
  if (!rawName) {
    return { product: null, issues: [{ field: 'name', reason: 'missing_product_name', value: null }] };
  }

  const identity = normalizeProductName(rawName);

  // --- facts, from the file first -----------------------------------------
  //
  // Explicit columns beat anything parsed out of the name, which beats the
  // knowledge base. The KB is only ever a last resort for a fact.
  const fileStrength = clean(get('strength')) || extractStrength(rawName) || null;
  const fileForm     = clean(get('form'))     || extractForm(rawName)     || null;
  const filePack     = clean(get('pack_size'));
  const parsedPack   = filePack || (extractPackSize(rawName) ?? null);

  const strength = fileStrength || identity.strength || null;
  const form     = fileForm     || identity.form     || null;
  const packSize = parsedPack !== null && parsedPack !== undefined
    ? String(parsedPack)
    : (identity.packSize !== null && identity.packSize !== undefined ? String(identity.packSize) : null);

  // The correction that must never be silent.
  if (fileStrength && identity.strength && normaliseStrength(fileStrength) !== normaliseStrength(identity.strength)) {
    issues.push({
      field: 'strength',
      reason: 'strength_differs_from_reference',
      value: fileStrength,
      detail: `This file says ${fileStrength}; the reference data expects ${identity.strength}. Keeping ${fileStrength} from your file.`,
    });
  }

  // --- price ---------------------------------------------------------------
  const priceKobo = toKobo(get('price'));
  if (priceKobo === null) {
    // Not fatal. A product with no price still belongs in the catalogue so
    // the assistant can say "we stock it, let me check the price" instead of
    // "we do not have it". It simply must never be quoted.
    issues.push({ field: 'price', reason: 'missing_or_unparseable_price', value: clean(get('price')) });
  }

  // --- stock ---------------------------------------------------------------
  const stockRaw = get('stock_qty');
  const stockTracked = Boolean(fields.stock_qty);
  const stockQty = stockTracked ? toInt(stockRaw) : null;
  if (stockTracked && stockQty === null && clean(stockRaw) !== null) {
    issues.push({ field: 'stock_qty', reason: 'unparseable_stock', value: clean(stockRaw) });
  }

  // --- expiry --------------------------------------------------------------
  const expiry = toDate(get('expiry_date'));
  if (expiry && expiry.getTime() < Date.now()) {
    issues.push({
      field: 'expiry_date',
      reason: 'already_expired',
      value: expiry.toISOString().slice(0, 10),
      detail: 'This item is past its expiry date. It will be imported but hidden from customers.',
    });
  }

  const genericFromReference = isRealGeneric(identity.generic, rawName) ? identity.generic : null;

  const dataFlags = [];
  if (priceKobo === null) dataFlags.push('no_price');
  if (!genericFromReference && !clean(get('generic_name'))) dataFlags.push('unrecognised_product');
  if (issues.some((i) => i.reason === 'strength_differs_from_reference')) dataFlags.push('strength_from_file');
  if (expiry && expiry.getTime() < Date.now()) dataFlags.push('expired');

  return {
    product: {
      name: rawName,
      // DETERMINISTIC, derived only from the product text.
      //
      // NOT identity.canonicalId. That looks like a stable drug identifier
      // and is not — it is a counter assigned in the order products are first
      // seen in a process. Measured 2026-08-29: across two runs of the same
      // code, Augmentin and Panadol swapped DRUG-10000 and DRUG-10001 purely
      // because the input order differed. Keying on it would, on the next
      // upload, merge one drug's row into another drug's data.
      //
      // The cost of using text is that "AMOXIL CAP 500MG x100" and
      // "Amoxil 500mg Capsule" stay two rows. That is the safe direction:
      // a duplicate is visible and fixable, a silent merge is neither.
      natural_key: `TEXT:${normalizeProductText(rawName)}`,
      generic_name: clean(get('generic_name')) || genericFromReference,
      brand_name:   clean(get('brand_name')) || null,
      category:     clean(get('category')) || identity.category || null,
      form,
      strength,
      pack_size: packSize,
      sku:     clean(get('sku')),
      barcode: clean(get('barcode')),
      price_kobo: priceKobo,
      stock_qty: stockQty,
      stock_tracked: stockTracked,
      expiry_date: expiry,
      // Expired stock is imported but not offered. Deleting it would hide a
      // real shelf problem from the pharmacy.
      status: expiry && expiry.getTime() < Date.now() ? 'hidden' : 'active',
      data_flags: dataFlags,
    },
    issues,
  };
}

/** '500 MG' and '500mg' are the same strength; '1g' and '1000mg' are not compared. */
function normaliseStrength(s) {
  return String(s).toLowerCase().replace(/\s+/g, '');
}

module.exports = { buildProduct, toKobo, toInt, toDate };
