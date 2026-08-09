/**
 * Product Identity Resolution Engine — Phase 2 (Dual Identity)
 *
 * Runs immediately after semantic mapping, before normalization.
 * Creates TWO identities per product:
 *
 *   1. SOURCE identity — exactly what the pharmacy uploaded (never modified)
 *   2. RESOLVED identity — NAFDAC-enriched metadata (manufacturer, generic, etc.)
 *
 * The uploaded dataset is the source of truth.
 * The NAFDAC registry is only a reference layer used for enrichment.
 *
 * Resolution Rules (applied in priority order):
 *   Rule 1: PRODUCT exists → use it directly
 *   Rule 2: BRAND_NAME + STRENGTH + DOSAGE_FORM
 *   Rule 3: GENERIC_NAME + STRENGTH
 *   Rule 4: GENERIC_NAME + BRAND_NAME + STRENGTH
 *   Rule 5: BRAND_NAME only → PRODUCT = BRAND_NAME
 *   Rule 6: GENERIC_NAME only → PRODUCT = GENERIC_NAME
 *   Rule 7: No identity → flag for user confirmation
 *
 * Manufacturer-Aware Resolution (enrichment only — never overwrites source):
 *   - Detects when a brand has multiple manufacturers in NAFDAC
 *   - If manufacturer column exists in upload, uses it to disambiguate
 *   - Enrichment goes into resolved_* fields only
 *   - Products not found in NAFDAC keep their uploaded value unchanged
 *
 * Output fields per record:
 *   Source: source_product_name, product_name, canonical_product
 *   Resolved: resolved_brand, resolved_generic, resolved_manufacturer,
 *             resolved_strength, resolved_form, resolved_nafdac_no
 *   Meta: resolution_confidence, resolution_source, resolution_status
 */

const {
  enrichFromNafdac, fuzzyLookupProduct,
  getBrandVariants, lookupWithManufacturer,
  weightedMatchNafdac,
} = require('./nafdacLookup');
const { NIGERIAN_BRANDS, identifyDrug } = require('./productNormalizer');
const { parseDrugName } = require('./productParser');

// ---- helpers ------------------------------------------------------------

function clean(val) {
  if (val == null || val === '') return null;
  return String(val).trim();
}

function compose(...parts) {
  const present = parts.filter((p) => p != null && p !== '');
  return present.length > 0 ? present.join(' ') : null;
}

// ---- Rule application ---------------------------------------------------

function resolveIdentity({
  product_name, brand, generic_name, strength, dosage_form,
}) {
  if (product_name && product_name !== 'Unknown') {
    return {
      product_name: clean(product_name),
      rule: 1, ruleLabel: 'Direct PRODUCT column',
      parts_used: ['product_name'], confidence: 0.95,
    };
  }
  if (brand && strength && dosage_form) {
    return {
      product_name: compose(brand, strength, dosage_form),
      rule: 2, ruleLabel: 'Brand + Strength + Dosage Form',
      parts_used: ['brand', 'strength', 'dosage_form'], confidence: 0.85,
    };
  }
  if (generic_name && strength) {
    return {
      product_name: compose(generic_name, strength),
      rule: 3, ruleLabel: 'Generic Name + Strength',
      parts_used: ['generic_name', 'strength'], confidence: 0.75,
    };
  }
  if (generic_name && brand && strength) {
    return {
      product_name: compose(brand, strength, `(${generic_name})`),
      rule: 4, ruleLabel: 'Brand + Generic + Strength',
      parts_used: ['generic_name', 'brand', 'strength'], confidence: 0.80,
    };
  }
  if (brand) {
    return {
      product_name: clean(brand),
      rule: 5, ruleLabel: 'Brand Name only',
      parts_used: ['brand'], confidence: 0.60,
    };
  }
  if (generic_name) {
    return {
      product_name: clean(generic_name),
      rule: 6, ruleLabel: 'Generic Name only',
      parts_used: ['generic_name'], confidence: 0.50,
    };
  }
  return null;
}

// ---- Manufacturer-aware enrichment --------------------------------------

/**
 * Compute resolution tier from confidence score.
 *
 *   auto     — confidence > 0.95  → automatically resolve, include in clinical
 *   review   — 0.80–0.95          → resolve but flag for review
 *   excluded — < 0.80             → keep unresolved, exclude from clinical intelligence
 *
 * Never create false clinical mappings. A wrong drug identity is worse than none.
 */
function computeResolutionTier(confidence) {
  if (confidence > 0.95) return 'auto';
  if (confidence >= 0.80) return 'review';
  return 'excluded';
}

/**
 * Map resolution_status to the method that produced the result.
 * Pure metadata — does not affect matching or analytics.
 */
function computeResolutionMethod(status) {
  switch (status) {
    case 'EXACT_MATCH':
    case 'AMBIGUOUS_MATCH':
    case 'PARTIAL_MATCH':
      return 'weighted_match';
    case 'PARSED_ONLY':
      return 'parser_only';
    default:
      return 'unresolved';
  }
}

/**
 * Infer active ingredients list from resolved generic name.
 * Returns a String[] — at minimum the generic name if known.
 */
function inferredActiveIngredients(resolvedGeneric, genericName) {
  const generic = (resolvedGeneric || genericName || '').trim();
  if (!generic) return [];
  // Simple inference: generic name represents the active ingredient
  // For combination drugs (e.g. "Paracetamol + Caffeine"), split on common delimiters
  if (generic.includes('+')) {
    return generic.split('+').map(s => s.trim()).filter(Boolean);
  }
  if (generic.includes('/')) {
    return generic.split('/').map(s => s.trim()).filter(Boolean);
  }
  return [generic];
}

/**
 * After identity resolution, enrich from NAFDAC with manufacturer awareness.
 *
 * CRITICAL: The uploaded product name is NEVER overwritten.
 * source_product_name = exactly what the pharmacy provided.
 * canonical_product = source_product_name (used by analytics).
 * Enrichment (manufacturer, generic, etc.) goes into resolved_* fields only.
 *
 * Cases:
 *   1. Brand is unique in NAFDAC → resolved fields populated, source unchanged
 *   2. Same brand, multiple manufacturers, manufacturer IS in upload → resolved fields filtered
 *   3. Same brand, multiple manufacturers, manufacturer NOT in upload → best-guess in resolved fields
 *   4. Product not in NAFDAC → keep uploaded value, resolution_status 'uploaded'
 */
function enrichIdentity(resolved, originalFields) {
  const uploadedManufacturer = clean(originalFields.manufacturer);
  const resolvedProductName = resolved ? resolved.product_name : null;
  const brandName = clean(originalFields.brand) || null;
  const genericName = clean(originalFields.generic_name) || null;

  // ---- SOURCE IDENTITY (never modified) ----

  // The source product name is exactly what the pharmacy uploaded.
  // Priority: explicit product_name column > composed from parts > null
  const sourceProductName =
    clean(originalFields.product_name) ||
    resolvedProductName ||
    null;

  // ---- Step A: Parse product name into structured attributes (Prompt 2) ----
  // Run BEFORE NAFDAC lookup — decompose the product name string
  // into brand, generic, strength, form, pack_size
  const parsed = sourceProductName ? parseDrugName(sourceProductName) : null;

  // ---- Step B: Weighted multi-attribute NAFDAC matching (Prompt 3) ----
  // Use parsed attributes + column-provided fields for scoring

  const matchQuery = {
    brand: brandName || (parsed ? parsed.brand : null),
    generic: genericName || (parsed ? parsed.generic : null),
    strength: clean(originalFields.strength) || (parsed ? parsed.strength : null),
    form: clean(originalFields.dosage_form) || (parsed ? parsed.form : null),
    manufacturer: uploadedManufacturer,
  };

  const weightedResult = weightedMatchNafdac(matchQuery);
  const candidateMatches = weightedResult.candidates || [];

  // Best match from weighted scoring
  const bestMatch = candidateMatches.length > 0 ? candidateMatches[0] : null;

  let nafdacManufacturer = bestMatch ? bestMatch.manufacturer : null;
  let nafdacNo = bestMatch ? bestMatch.nafdac_no : null;
  let therapeuticGroup = bestMatch ? bestMatch.therapeutic_group : null;
  let therapeuticSubgroup = bestMatch ? bestMatch.therapeutic_subgroup : null;

  // Brand KB fallback
  if (!nafdacManufacturer && brandName) {
    const brandKey = brandName.toLowerCase().trim();
    if (NIGERIAN_BRANDS[brandKey] && NIGERIAN_BRANDS[brandKey].manufacturer) {
      nafdacManufacturer = NIGERIAN_BRANDS[brandKey].manufacturer;
    }
  }

  // ---- Map weighted match state to resolution ----

  let resolvedManufacturer = nafdacManufacturer || uploadedManufacturer || null;
  let displayProduct = sourceProductName || resolvedProductName;
  let resolutionSource = 'nafdac_weighted';
  let resolutionConfidence = weightedResult.confidence;
  let hasVariants = candidateMatches.length > 1;
  let resolutionStatus;

  // Aliases for Prompt 3/4 states
  if (weightedResult.state === 'EXACT_MATCH') {
    resolutionStatus = 'EXACT_MATCH';
    if (nafdacManufacturer) {
      displayProduct = `${sourceProductName || matchQuery.brand} (${nafdacManufacturer})`;
    }
    resolutionConfidence = Math.max(resolutionConfidence, 0.95);
  } else if (weightedResult.state === 'AMBIGUOUS_MATCH') {
    resolutionStatus = 'AMBIGUOUS_MATCH';
    // NEVER guess manufacturer — display stays as source
    // resolvedManufacturer is kept from bestMatch for reference but NOT displayed
    resolutionConfidence = Math.max(resolutionConfidence, 0.60);
  } else if (weightedResult.state === 'PARTIAL_MATCH') {
    resolutionStatus = 'PARTIAL_MATCH';
    resolutionConfidence = Math.max(resolutionConfidence, 0.50);
  } else if (weightedResult.state === 'NO_MATCH') {
    // Distinguish parser success from parser failure when NAFDAC finds nothing
    const parserExtracted = parsed && (parsed.generic || parsed.strength || parsed.form || parsed.pack_size);
    if (parserExtracted) {
      resolutionStatus = 'PARSED_ONLY';
      resolutionConfidence = parsed.confidence || 0.40;
      resolutionSource = 'parser';
    } else {
      resolutionStatus = resolved ? 'unverified' : 'unknown';
      resolutionConfidence = resolved ? Math.min(resolved.confidence, 0.45) : 0.30;
      resolutionSource = resolved ? 'rule_based' : 'uploaded';
    }
  } else if (!resolutionSource || resolutionSource === 'rule_based') {
    // Fallback: product not in NAFDAC at all
    const parserExtracted = parsed && (parsed.generic || parsed.strength || parsed.form || parsed.pack_size);
    if (parserExtracted) {
      resolutionStatus = 'PARSED_ONLY';
      resolutionConfidence = parsed.confidence || 0.40;
      resolutionSource = 'parser';
    } else {
      resolutionStatus = resolved ? 'unverified' : 'unknown';
      resolutionConfidence = resolved ? Math.min(resolved.confidence, 0.45) : 0.30;
      resolutionSource = resolved ? 'rule_based' : 'uploaded';
    }
  }

  // Safety: if AMBIGUOUS_MATCH, NEVER put manufacturer in display
  if (resolutionStatus === 'AMBIGUOUS_MATCH') {
    displayProduct = sourceProductName || resolvedProductName;
  }

  // ---- Infer missing brand/generic from NAFDAC ----

  let resolvedBrand = brandName;
  let resolvedGeneric = genericName;
  // How sure we are that resolvedGeneric names the same drug the source text
  // meant. An exact knowledge-base hit scores 0.95; a single-character typo
  // resolved by fuzzy match scores 0.65; a two-character difference 0.55.
  // Analytics uses this to decide whether two spellings may be safely counted
  // as one product — without it, every fuzzy match looks equally certain.
  // A generic taken straight from the file's own column is authoritative.
  let resolvedGenericConfidence = genericName ? 1 : 0;

  if (!resolvedGeneric && brandName) {
    const fuzzy = fuzzyLookupProduct(brandName);
    if (fuzzy.bestMatch && fuzzy.source && fuzzy.source !== 'brand_kb') {
      if (fuzzy.bestMatch.generic) {
        resolvedGeneric = fuzzy.bestMatch.generic;
        resolvedGenericConfidence = Number(fuzzy.confidence) || 0;
      }
    }
  }

  // Brand KB inference for missing generic
  if (!resolvedGeneric && resolvedProductName) {
    const id = identifyDrug(resolvedProductName);
    if (id.recognized && id.generic) {
      resolvedGeneric = id.generic;
      resolvedGenericConfidence = Number(id.confidence) || 0;
    }
    if (id.recognized && id.manufacturer && !nafdacManufacturer) {
      nafdacManufacturer = id.manufacturer;
      resolvedManufacturer = resolvedManufacturer || nafdacManufacturer;
      if (!resolutionSource) resolutionSource = 'brand_kb';
    }
    if (id.recognized && !resolvedBrand) resolvedBrand = id.brand;
  }

  // ---- Final structured output ----

  return {
    // === Source Identity (never modified — the pharmacy's own data) ===
    source_product_name: sourceProductName,
    canonical_product: sourceProductName,  // analytics uses this
    product_name: sourceProductName,       // backward compat: legacy consumers

    // === Display name (may include manufacturer for UI) ===
    display_product: displayProduct || sourceProductName,

    // === Resolved Identity (NAFDAC enrichment — separate from source) ===
    resolved_brand: resolvedBrand,
    resolved_generic: resolvedGeneric,
    resolved_generic_confidence: resolvedGeneric ? resolvedGenericConfidence : 0,
    resolved_manufacturer: resolvedManufacturer,
    resolved_strength: clean(originalFields.strength) || null,
    resolved_form: clean(originalFields.dosage_form) || null,
    resolved_nafdac_no: nafdacNo,
    resolved_therapeutic_group: therapeuticGroup,
    resolved_therapeutic_subgroup: therapeuticSubgroup,

    // === Clinical Identity (Layer 3 — healthcare intelligence) ===
    clinical_product_id: nafdacNo || null,
    // Prefer the specific subgroup ("Anti-Malarial") over the broad group
    // ("Anti-Infectives") — NAFDAC's own data carries both, but the broad
    // group is nearly useless for category-level insights (most drugs are
    // "Anti-Infectives"). Only fall back to the group when NAFDAC has no
    // subgroup for this entry.
    therapeutic_class: therapeuticSubgroup || therapeuticGroup || null,
    active_ingredients: inferredActiveIngredients(resolvedGeneric, genericName),

    // === Resolution metadata ===
    resolution_confidence: resolutionConfidence,
    resolution_tier: computeResolutionTier(resolutionConfidence),
    resolution_source: resolutionSource,
    resolution_status: resolutionStatus,
    resolution_method: computeResolutionMethod(resolutionStatus),
    resolution_rule: resolved ? resolved.rule : null,
    resolution_label: resolved ? resolved.ruleLabel : null,
    identity_flagged: !resolved,

    // === Confidence breakdown ===
    parser_confidence: parsed ? parsed.confidence : null,
    lookup_confidence: weightedResult.confidence,

    // === Candidate matches (Prompt 4) ===
    candidate_matches: candidateMatches,

    // === Traceability (original uploaded values, never modified) ===
    original_product_name: originalFields.product_name || null,
    original_brand: originalFields.brand || null,
    original_generic_name: originalFields.generic_name || null,
    original_strength: originalFields.strength || null,
    original_dosage_form: originalFields.dosage_form || null,
    original_manufacturer: uploadedManufacturer,
    parsed_attributes: parsed ? {
      brand: parsed.brand,
      generic: parsed.generic,
      strength: parsed.strength,
      form: parsed.form,
      pack_size: parsed.pack_size,
    } : null,

    enrichment_source: nafdacManufacturer ? 'nafdac' : (resolutionSource === 'rule_based' ? 'rule_based' : null),
    has_variants: hasVariants,
  };
}

// ---- main API: resolve product identities for a batch of records --------

function resolveProductIdentities(rawRows, mapping) {
  const results = [];
  const rulesUsed = {};
  let resolvedCount = 0;
  let flaggedCount = 0;
  let enrichedCount = 0;
  let variantDisambiguated = 0;

  for (const row of rawRows) {
    function read(canonicalCategory) {
      const info = mapping[canonicalCategory];
      if (!info || !info.rawHeader) return null;
      return row[info.rawHeader];
    }

    const originalFields = {
      product_name: read('product_name'),
      brand: read('brand'),
      generic_name: read('generic_name'),
      strength: read('strength'),
      dosage_form: read('dosage_form'),
      manufacturer: read('manufacturer'),
    };

    // Step 1: Resolve identity
    const resolved = resolveIdentity({
      product_name: originalFields.product_name,
      brand: originalFields.brand,
      generic_name: originalFields.generic_name,
      strength: originalFields.strength,
      dosage_form: originalFields.dosage_form,
    });

    if (resolved) {
      resolvedCount++;
      rulesUsed[`rule_${resolved.rule}`] = (rulesUsed[`rule_${resolved.rule}`] || 0) + 1;
    } else {
      flaggedCount++;
      rulesUsed['rule_7_flagged'] = (rulesUsed['rule_7_flagged'] || 0) + 1;
    }

    // Step 2: Manufacturer-aware enrichment
    const enriched = enrichIdentity(resolved, originalFields);

    if (enriched.enrichment_source) enrichedCount++;
    if (enriched.resolution_status === 'AMBIGUOUS_MATCH' ||
        enriched.resolution_status === 'EXACT_MATCH' ||
        enriched.resolution_status === 'PARTIAL_MATCH') {
      variantDisambiguated++;
    }

    // Step 3: Merge back into row (dual identity)
    results.push({
      ...row,

      // === Source Identity (never modified) ===
      source_product_name: enriched.source_product_name,
      canonical_product: enriched.canonical_product,
      _resolved_product_name: enriched.source_product_name,  // backward compat
      display_product: enriched.display_product,

      // === Resolved Identity (NAFDAC enrichment) ===
      _resolved_brand: enriched.resolved_brand,
      _resolved_generic_name: enriched.resolved_generic,
      _resolved_generic_confidence: enriched.resolved_generic_confidence,
      _resolved_manufacturer: enriched.resolved_manufacturer,
      _resolved_strength: enriched.resolved_strength,
      _resolved_dosage_form: enriched.resolved_form,
      _resolved_nafdac_no: enriched.resolved_nafdac_no,
      _resolved_therapeutic_group: enriched.resolved_therapeutic_group,
      _resolved_therapeutic_subgroup: enriched.resolved_therapeutic_subgroup,

      // === Clinical Identity (Layer 3 — healthcare intelligence) ===
      _clinical_product_id: enriched.clinical_product_id,
      _therapeutic_class: enriched.therapeutic_class,
      _active_ingredients: enriched.active_ingredients,
      resolution_tier: enriched.resolution_tier,

      // === NAFDAC enrichment (backward compat) ===
      _nafdac_no: enriched.resolved_nafdac_no,
      _therapeutic_group: enriched.resolved_therapeutic_group,
      _therapeutic_subgroup: enriched.resolved_therapeutic_subgroup,

      // === Candidate matches (Prompt 4) ===
      _candidate_matches: enriched.candidate_matches,
      _parsed_attributes: enriched.parsed_attributes,

      // === Resolution metadata ===
      resolution_confidence: enriched.resolution_confidence,
      resolution_source: enriched.resolution_source,
      resolution_status: enriched.resolution_status,
      resolution_method: enriched.resolution_method,
      parser_confidence: enriched.parser_confidence,
      lookup_confidence: enriched.lookup_confidence,
      _resolution_rule: enriched.resolution_rule,
      _resolution_label: enriched.resolution_label,
      _identity_confidence: enriched.resolution_confidence,
      _identity_flagged: enriched.identity_flagged,
      _enrichment_source: enriched.enrichment_source,

      // === Traceability ===
      _original_product_name: enriched.original_product_name,
      _original_brand: enriched.original_brand,
      _original_generic_name: enriched.original_generic_name,
      _original_strength: enriched.original_strength,
      _original_dosage_form: enriched.original_dosage_form,
      _original_manufacturer: enriched.original_manufacturer,
    });
  }

  return {
    records: results,
    summary: {
      total: rawRows.length,
      resolved: resolvedCount,
      flagged: flaggedCount,
      enriched: enrichedCount,
      variantDisambiguated,
      rulesUsed,
    },
  };
}

function resolveSingleIdentity(rawRow, mapping) {
  const result = resolveProductIdentities([rawRow], mapping);
  return result.records[0] || rawRow;
}

module.exports = {
  resolveIdentity,
  enrichIdentity,
  resolveProductIdentities,
  resolveSingleIdentity,
  computeResolutionMethod,
};
