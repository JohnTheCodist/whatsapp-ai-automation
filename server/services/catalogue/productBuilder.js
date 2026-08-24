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
const { fuzzyResolveGeneric } = require('../ingestion/nafdacLookup');

// identifyDrug() sources that are NOT already anchored to a known entry —
// pattern_inference/partial_pattern strip strength/form and keep whatever
// text is left, fuzzy_brand_match found a close BRAND (not generic) name.
// Only these are worth checking against NAFDAC; brand_knowledge_base is
// already a real match and re-checking it would only add a chance to
// overwrite a correct identity with a wrong fuzzy one.
const UNANCHORED_SOURCES = new Set(['pattern_inference', 'partial_pattern', 'fuzzy_brand_match']);

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

  // --- NAFDAC anchor, for an identity the KB only pattern-guessed at -------
  //
  // identifyDrug()'s pattern step strips strength/form and keeps whatever
  // text is left as "the generic" — it never checks that text against
  // anything, so "Cirpofloxacin 500mg" becomes its own recognised identity,
  // distinct from "Ciprofloxacin 500mg". fuzzyResolveGeneric() checks that
  // leftover text against NAFDAC's real generic-name list, one name at a
  // time, and — critically — refuses to answer if more than one registered
  // generic is close enough to be a candidate. That refusal is what keeps
  // this safe: a real Look-Alike-Sound-Alike pair (Hydralazine/Hydroxyzine,
  // Prednisone/Prednisolone) sitting a couple of edits apart must never be
  // picked between by spelling alone, so it is left exactly as unresolved
  // as it was before this check existed.
  let resolvedGeneric = identity.generic;
  if (!identity.recognized || UNANCHORED_SOURCES.has(identity.source)) {
    const nafdacMatch = fuzzyResolveGeneric(identity.generic || rawName);
    if (nafdacMatch && nafdacMatch.matchType === 'fuzzy') {
      resolvedGeneric = nafdacMatch.generic;
      issues.push({
        field: 'name',
        reason: 'name_matched_via_nafdac',
        value: rawName,
        detail: `"${identity.generic || rawName}" is not a spelling we recognise, but it is ` +
          `${nafdacMatch.distance} character${nafdacMatch.distance === 1 ? '' : 's'} from ` +
          `"${nafdacMatch.generic}", which is registered with NAFDAC. Treated as the same product ` +
          `as other listings of "${nafdacMatch.generic}".`,
      });
    } else if (nafdacMatch && nafdacMatch.matchType === 'exact' && identity.generic) {
      // Same drug, just NAFDAC's canonical casing/spacing — not a
      // correction worth telling anyone about.
      resolvedGeneric = nafdacMatch.generic;
    }
  }

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
    // A negative number parsed fine — it just isn't a valid quantity. Calling
    // that "unparseable" tells the owner nothing they can act on; a shelf
    // count of -5 is a data-entry problem, not a formatting one.
    const parsedNegative = parseCurrency(stockRaw);
    if (parsedNegative !== null && Number.isFinite(parsedNegative) && parsedNegative < 0) {
      issues.push({
        field: 'stock_qty',
        reason: 'negative_stock',
        value: clean(stockRaw),
        detail: 'Stock quantity cannot be negative. Treated as unknown — please check this row.',
      });
    } else {
      issues.push({ field: 'stock_qty', reason: 'unparseable_stock', value: clean(stockRaw) });
    }
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

  const genericFromReference = isRealGeneric(resolvedGeneric, rawName) ? resolvedGeneric : null;

  const dataFlags = [];
  if (priceKobo === null) dataFlags.push('no_price');
  // no_generic_name, NOT "unrecognised_product", which is what this was
  // called and which describes something the check does not do. It fires
  // whenever there is no generic worth SHOWING — and much the commonest
  // reason for that is isRealGeneric rejecting a generic already contained in
  // the product name. "Omeprazole 20mg" is a drug the registry knows
  // perfectly well and was still labelled unrecognised.
  //
  // The old name was not merely untidy. duplicateReview was built on it in
  // the belief that it meant "NAFDAC cannot confirm this name", and so put
  // the wrong pairs in front of a pharmacist under a heading promising the
  // opposite. A flag that reads as a stronger claim than it makes is one
  // the next reader will misuse the same way.
  if (!genericFromReference && !clean(get('generic_name'))) dataFlags.push('no_generic_name');
  if (issues.some((i) => i.reason === 'strength_differs_from_reference')) dataFlags.push('strength_from_file');
  if (issues.some((i) => i.reason === 'name_matched_via_nafdac')) dataFlags.push('nafdac_typo_corrected');
  if (expiry && expiry.getTime() < Date.now()) dataFlags.push('expired');

  return {
    product: {
      name: rawName,
      // DETERMINISTIC, derived only from the product text plus a KB lookup
      // that is itself a pure function of that text — never from
      // identity.canonicalId. That looks like a stable drug identifier and is
      // not — it is a counter assigned in the order products are first seen
      // in a process. Measured 2026-08-29: across two runs of the same code,
      // Augmentin and Panadol swapped DRUG-10000 and DRUG-10001 purely
      // because the input order differed. Keying on it would, on the next
      // upload, merge one drug's row into another drug's data.
      //
      // The anchor is resolvedGeneric, not raw text, when it's known. Plain
      // TEXT normalization only lowercases and trims, so "Metformin500mg" and
      // "Metformin 500mg" — the same drug, spaced differently — produced two
      // natural_keys and showed up as two products. resolvedGeneric collapses
      // that: it comes from the same brand/pattern lookup for both spellings
      // ("Metformin"), independent of input whitespace, and — unlike
      // canonicalId — depends only on the input text and the static KB, so it
      // is stable across runs and process restarts.
      //
      // A genuine misspelling ("Cirpofloxacin" vs "Ciprofloxacin") IS
      // collapsed here, but only via the NAFDAC anchor above — never by
      // comparing two uploaded spellings to each other directly. The
      // difference matters: comparing this row's text to NAFDAC's ~950 real
      // generic names, one at a time, with an ambiguity guard that refuses to
      // pick between two close candidates, cannot merge a real
      // look-alike-sound-alike pair (Hydralazine/Hydroxyzine,
      // Prednisone/Prednisolone) — there is no "other row" for it to get
      // confused with. Comparing two uploaded rows to each other instead
      // would risk exactly that. Anything NAFDAC has no opinion on falls back
      // to normalizeProductText(rawName) exactly as before: a visible,
      // fixable duplicate rather than a silent, unverifiable merge.
      //
      // Strength and form are appended from the FACTS computed above (file
      // first, KB last), not re-derived from identity.canonical — that field
      // bakes in the KB's own form guess, which is inconsistent for the same
      // drug across spacing variants (measured: "Omeprazole20mg" guessed
      // Tablet, "Omeprazole 20mg" guessed Capsule) and would silently split
      // the very products this anchor exists to merge. Appending form also
      // keeps "Diclofenac Gel" and "Diclofenac Cream" apart even though
      // normalizeProductText folds gel/cream into one word for sales
      // analytics — an upload of one must never silently overwrite the
      // other.
      natural_key: `TEXT:${resolvedGeneric ? normalizeProductText(resolvedGeneric) : normalizeProductText(rawName)}` +
        `${strength ? `::${normaliseStrength(strength)}` : ''}` +
        `${form ? `::${String(form).trim().toLowerCase()}` : ''}`,
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
