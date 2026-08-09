/**
 * NAFDAC Lookup Engine — loads the NAFDAC pharmaceutical product registry
 * and provides fast lookup by brand name, generic name, or product hints.
 *
 * Features:
 *   - Auto-loads pharma_nafdac_dataset.csv at startup
 *   - Hot-reload support for production (re-read CSV without restart)
 *   - Tokenized fuzzy matching for Nigerian pharmacy spelling variations
 *   - Falls back to hardcoded NIGERIAN_BRANDS knowledge base on cache miss
 *   - Normalizes dosage forms (tablet↔tab, capsule↔cap) for cross-matching
 *
 * Search indexes:
 *   - brandIndex: brand_name → [nafdac entries]
 *   - genericIndex: generic name → [nafdac entries]
 *   - brandTokenIndex: individual word tokens → [nafdac entries]
 */

const fs = require('fs');
const path = require('path');
const { NIGERIAN_BRANDS, FORM_SYNONYMS } = require('./productNormalizer');

// ---- configuration ------------------------------------------------------

const NAFDAC_CSV_PATH = path.join(__dirname, '..', '..', 'data', 'pharma_nafdac_dataset.csv');

// ---- state --------------------------------------------------------------

let nafdacEntries = [];           // All parsed rows
let brandIndex = new Map();       // "brand_name"→ [entries]
let genericIndex = new Map();     // "generic"→ [entries]
let brandTokenIndex = new Map();  // "token"→ [entries]
let genericTokenIndex = new Map();// "token"→ [entries]
let lastLoaded = null;            // ISO timestamp of last load
let totalRecords = 0;

// ---- dosage form normalization ------------------------------------------

/**
 * Normalize a NAFDAC form string to a short canonical form.
 * "Solution for injection" → "injection"
 * "Powder for injection"  → "powder"
 */
function normalizeNafdacForm(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();

  const mappings = [
    [/solution\s*for\s*injection/i, 'injection'],
    [/powder\s*for\s*injection/i, 'powder'],
    [/solution\s*for\s*infusion/i, 'infusion'],
    [/intravenous\s*infusion/i, 'infusion'],
    [/solution\s*for\s*inhalation/i, 'inhaler'],
    [/oral\s*solution/i, 'syrup'],
    [/oral\s*suspension/i, 'suspension'],
    [/nasal\s*spray/i, 'spray'],
    [/eye\s*drops/i, 'drops'],
    [/ear\s*drops/i, 'drops'],
    [/tablet/i, 'tablet'],
    [/capsule/i, 'capsule'],
    [/syrup/i, 'syrup'],
    [/injection/i, 'injection'],
    [/cream/i, 'cream'],
    [/ointment/i, 'ointment'],
    [/gel/i, 'gel'],
    [/suspension/i, 'suspension'],
    [/drops/i, 'drops'],
    [/suppository/i, 'suppository'],
    [/inhaler/i, 'inhaler'],
    [/spray/i, 'spray'],
    [/powder/i, 'powder'],
    [/sachet/i, 'sachet'],
    [/lozenge/i, 'lozenge'],
    [/patch/i, 'patch'],
    [/lotion/i, 'lotion'],
  ];

  for (const [re, canonical] of mappings) {
    if (re.test(s)) return canonical;
  }
  return s;
}

// ---- CSV parsing --------------------------------------------------------

function parseNafdacCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return { entries: [], total: 0, error: `File not found: ${filePath}` };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { entries: [], total: 0, error: 'CSV file is empty or has no data rows' };
  }

  // Parse header
  const headers = parseCSVLine(lines[0]);
  // Expected: brand_name,category,nafdac_no,form,route,strength,registration_date,status,generic,therapeutic_group,therapeutic_subgroup,company

  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < headers.length) continue; // skip malformed rows

    const row = {};
    // Map only the columns we know about (to handle variable column counts)
    for (let j = 0; j < Math.min(headers.length, values.length); j++) {
      row[headers[j].trim()] = values[j].trim();
    }

    // Skip non-drug or inactive entries
    if (row.status && row.status.toLowerCase() !== 'active') continue;
    if (!row.brand_name || row.brand_name === '') continue;

    // Normalize form
    const canonicalForm = normalizeNafdacForm(row.form);

    entries.push({
      brand_name: row.brand_name,
      generic: row.generic || null,
      nafdac_no: row.nafdac_no || null,
      form: canonicalForm,
      form_original: row.form || null,
      route: row.route || null,
      strength: row.strength || null,
      registration_date: row.registration_date || null,
      status: row.status || null,
      therapeutic_group: row.therapeutic_group || null,
      therapeutic_subgroup: row.therapeutic_subgroup || null,
      manufacturer: row.company || null,
    });
  }

  return { entries, total: entries.length, error: null };
}

/**
 * Simple CSV line parser that handles quoted fields.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ---- index building -----------------------------------------------------

function buildIndexes(entries) {
  const brandIdx = new Map();
  const genericIdx = new Map();
  const brandTokIdx = new Map();
  const genericTokIdx = new Map();

  for (const entry of entries) {
    // Brand index — full name
    const brandKey = entry.brand_name.toLowerCase().trim();
    if (!brandIdx.has(brandKey)) brandIdx.set(brandKey, []);
    brandIdx.get(brandKey).push(entry);

    // Brand token index — individual words
    for (const token of brandKey.split(/[\s\-\(\)\/]+/)) {
      const t = token.replace(/[^a-z0-9]/g, '');
      if (t.length < 2) continue;
      if (!brandTokIdx.has(t)) brandTokIdx.set(t, []);
      if (!brandTokIdx.get(t).includes(entry)) {
        brandTokIdx.get(t).push(entry);
      }
    }

    // Generic index
    if (entry.generic) {
      const genericKey = entry.generic.toLowerCase().trim();
      if (!genericIdx.has(genericKey)) genericIdx.set(genericKey, []);
      genericIdx.get(genericKey).push(entry);

      // Generic token index
      for (const token of genericKey.split(/[\s\-\(\)\/]+/)) {
        const t = token.replace(/[^a-z0-9]/g, '');
        if (t.length < 2) continue;
        if (!genericTokIdx.has(t)) genericTokIdx.set(t, []);
        if (!genericTokIdx.get(t).includes(entry)) {
          genericTokIdx.get(t).push(entry);
        }
      }
    }
  }

  return { brandIdx, genericIdx, brandTokIdx, genericTokIdx };
}

// ---- load / reload ------------------------------------------------------

function loadNafdac(filePath) {
  const fp = filePath || NAFDAC_CSV_PATH;
  const { entries, total, error } = parseNafdacCsv(fp);

  if (error) {
    return { success: false, error, totalRecords: 0, lastLoaded: lastLoaded };
  }

  const indexes = buildIndexes(entries);

  nafdacEntries = entries;
  brandIndex = indexes.brandIdx;
  genericIndex = indexes.genericIdx;
  brandTokenIndex = indexes.brandTokIdx;
  genericTokenIndex = indexes.genericTokIdx;
  totalRecords = total;
  lastLoaded = new Date().toISOString();

  return { success: true, totalRecords, lastLoaded };
}

// ---- lookup API ---------------------------------------------------------

/**
 * Search by brand name (exact or fuzzy).
 * Returns best-matching NAFDAC entries.
 */
function lookupByBrand(name, maxResults = 5) {
  if (!name) return [];
  const key = name.toLowerCase().trim();

  // Exact match
  if (brandIndex.has(key)) {
    return brandIndex.get(key).slice(0, maxResults);
  }

  // Tokenized search — find entries where most tokens match
  const tokens = key.split(/[\s\-\(\)\/]+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const scoredEntries = new Map(); // entry → score

  for (const token of tokens) {
    const matches = brandTokenIndex.get(token) || [];
    for (const entry of matches) {
      scoredEntries.set(entry, (scoredEntries.get(entry) || 0) + 1);
    }
  }

  // Sort by score, then filter >= 50% token overlap
  const results = [...scoredEntries.entries()]
    .filter(([_, score]) => score >= Math.ceil(tokens.length * 0.5))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([entry, score]) => ({
      ...entry,
      _matchScore: score,
      _matchTokens: tokens.length,
    }));

  return results;
}

/**
 * Search by generic name (exact or fuzzy).
 */
function lookupByGeneric(name, maxResults = 5) {
  if (!name) return [];
  const key = name.toLowerCase().trim();

  if (genericIndex.has(key)) {
    return genericIndex.get(key).slice(0, maxResults);
  }

  // Tokenized search
  const tokens = key.split(/[\s\-\(\)\/]+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const scoredEntries = new Map();
  for (const token of tokens) {
    const matches = genericTokenIndex.get(token) || [];
    for (const entry of matches) {
      scoredEntries.set(entry, (scoredEntries.get(entry) || 0) + 1);
    }
  }

  return [...scoredEntries.entries()]
    .filter(([_, score]) => score >= Math.ceil(tokens.length * 0.5))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults)
    .map(([entry, score]) => ({
      ...entry,
      _matchScore: score,
    }));
}

/**
 * Fuzzy lookup: tries brand first, then generic, then token overlap.
 * Returns { source: 'nafdac'|'brand_kb'|null, entries[], bestMatch }
 */
function fuzzyLookupProduct(rawName) {
  if (!rawName) return { source: null, entries: [], bestMatch: null };

  const name = rawName.toLowerCase().trim();

  // Step 1: NAFDAC exact brand match
  let results = lookupByBrand(name, 3);
  if (results.length > 0) {
    return {
      source: 'nafdac_brand',
      entries: results,
      bestMatch: results[0],
    };
  }

  // Step 2: NAFDAC generic match (if name looks like a generic)
  // Try generic lookup — first strip common form/strength words
  const cleaned = name
    .replace(/\d+[\.,]?\d*\s*(mg|g|ml|mcg|iu|%)/gi, '')
    .replace(/\b(tablet|capsule|syrup|injection|cream|suspension|drops|powder|sachet)s?\b/gi, '')
    .trim();

  if (cleaned.length >= 3 && cleaned !== name) {
    results = lookupByGeneric(cleaned, 3);
    if (results.length > 0) {
      return {
        source: 'nafdac_generic',
        entries: results,
        bestMatch: results[0],
      };
    }
  }

  // Step 3: NAFDAC generic exact match
  results = lookupByGeneric(name, 3);
  if (results.length > 0) {
    return {
      source: 'nafdac_generic',
      entries: results,
      bestMatch: results[0],
    };
  }

  // Step 4: Fall back to hardcoded NIGERIAN_BRANDS
  const brandKey = name;
  if (NIGERIAN_BRANDS[brandKey]) {
    return {
      source: 'brand_kb',
      entries: [],
      bestMatch: NIGERIAN_BRANDS[brandKey],
    };
  }

  // Alias match in brand KB
  for (const [kbKey, entry] of Object.entries(NIGERIAN_BRANDS)) {
    if (entry.aliases && entry.aliases.includes(brandKey)) {
      return {
        source: 'brand_kb',
        entries: [],
        bestMatch: entry,
      };
    }
  }

  return { source: null, entries: [], bestMatch: null };
}

// ---- manufacturer-aware brand variants ----------------------------------

/**
 * For a given brand name, return all distinct manufacturers found in NAFDAC.
 * Used to detect multi-manufacturer brands that need disambiguation.
 *
 * Returns: { isUnique: boolean, manufacturers: [{name, count, entries[]}], totalRecords }
 */
function getBrandVariants(brandName) {
  if (!brandName) return { isUnique: true, manufacturers: [], totalRecords: 0 };

  const results = lookupByBrand(brandName, 100); // get all matches
  if (results.length === 0) return { isUnique: true, manufacturers: [], totalRecords: 0 };

  // Group by manufacturer
  const byMfr = new Map();
  for (const entry of results) {
    const mfr = entry.manufacturer || 'Unknown';
    if (!byMfr.has(mfr)) byMfr.set(mfr, []);
    byMfr.get(mfr).push(entry);
  }

  const manufacturers = [];
  for (const [name, entries] of byMfr) {
    manufacturers.push({
      name,
      count: entries.length,
      entries,
      sampleGeneric: entries[0]?.generic || null,
      sampleStrength: entries[0]?.strength || null,
      sampleForm: entries[0]?.form || null,
      sampleNafdacNo: entries[0]?.nafdac_no || null,
    });
  }

  manufacturers.sort((a, b) => b.count - a.count);

  return {
    isUnique: manufacturers.length <= 1,
    manufacturers,
    totalRecords: results.length,
  };
}

/**
 * Look up a brand in NAFDAC, filtered by manufacturer name.
 * Used when the uploaded dataset already has a Manufacturer column.
 */
function lookupWithManufacturer(brandName, manufacturerName) {
  if (!brandName || !manufacturerName) return [];

  const mfrKey = manufacturerName.toLowerCase().trim();

  // Step 1: Brand-name lookup filtered by manufacturer
  const brandResults = lookupByBrand(brandName, 50);
  const brandExact = brandResults.filter((e) =>
    e.manufacturer && e.manufacturer.toLowerCase() === mfrKey
  );
  if (brandExact.length > 0) {
    return brandExact.slice(0, 5).map((e) => ({ ...e, _matchType: 'brand_exact_manufacturer' }));
  }
  const brandFuzzy = brandResults.filter((e) =>
    e.manufacturer && e.manufacturer.toLowerCase().includes(mfrKey)
  );
  if (brandFuzzy.length > 0) {
    return brandFuzzy.slice(0, 5).map((e) => ({ ...e, _matchType: 'brand_fuzzy_manufacturer' }));
  }

  // Step 2: Generic-name lookup filtered by manufacturer
  const genericResults = lookupByGeneric(brandName, 50);
  const genericExact = genericResults.filter((e) =>
    e.manufacturer && e.manufacturer.toLowerCase() === mfrKey
  );
  if (genericExact.length > 0) {
    return genericExact.slice(0, 5).map((e) => ({ ...e, _matchType: 'generic_exact_manufacturer' }));
  }
  const genericFuzzy = genericResults.filter((e) =>
    e.manufacturer && e.manufacturer.toLowerCase().includes(mfrKey)
  );
  if (genericFuzzy.length > 0) {
    return genericFuzzy.slice(0, 5).map((e) => ({ ...e, _matchType: 'generic_fuzzy_manufacturer' }));
  }

  // Step 3: Fall back to best brand match without manufacturer filter
  if (brandResults.length > 0) {
    return brandResults.slice(0, 3).map((e) => ({ ...e, _matchType: 'brand_only' }));
  }

  return [];
}

/**
 * Fuzzy search across brand token index.
 * Returns entries whose tokens partially match the query string.
 */
function fuzzySearchBrand(brandName, maxResults = 15) {
  if (!brandTokenIndex) return [];
  const tokens = brandName.toLowerCase().split(/[\s\-\(\)\/]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2);

  const scored = new Map();
  for (const token of tokens) {
    const matches = brandTokenIndex.get(token);
    if (matches) {
      for (const entry of matches) {
        const key = (entry.brand_name || '').toLowerCase() + '||' + (entry.nafdac_no || '');
        scored.set(key, (scored.get(key) || 0) + 1);
      }
    }
  }

  const sorted = [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxResults);

  // Resolve the entries from the brand index
  const results = [];
  for (const [key] of sorted) {
    const [bName] = key.split('||');
    const entries = brandIndex.get(bName);
    if (entries) results.push(...entries);
  }
  return results.slice(0, maxResults);
}

// ---- Weighted multi-attribute NAFDAC matching (Prompt 3) -----------------

/**
 * Match weights — configurable.
 * Total must sum to 1.0.
 */
const MATCH_WEIGHTS = {
  generic:        0.30,
  brand:          0.30,
  strength:       0.20,
  manufacturer:   0.15,
  form:           0.05,
};

/**
 * Match a structured product against NAFDAC using weighted multi-attribute scoring.
 *
 * Unlike the old single-string fuzzyLookupProduct, this compares
 * individual attributes (generic, brand, strength, form, manufacturer)
 * and produces a weighted confidence score + resolution state.
 *
 * Resolution states:
 *   EXACT_MATCH       — all provided fields match, confidence ≥ 0.90
 *   AMBIGUOUS_MATCH   — multiple candidates OR missing manufacturer
 *   PARTIAL_MATCH     — some fields match, confidence ≥ 0.50
 *   NO_MATCH          — no meaningful match found
 *
 * @param {Object} query - { generic, brand, strength, form, manufacturer }
 * @returns {{ state, confidence, candidates[], totalCandidates }}
 */
function weightedMatchNafdac(query = {}) {
  const brand = (query.brand || '').toLowerCase().trim();
  const generic = (query.generic || '').toLowerCase().trim();
  const strength = (query.strength || '').toLowerCase().trim();
  const form = (query.form || '').toLowerCase().trim();
  const manufacturer = (query.manufacturer || '').toLowerCase().trim();

  // Collect candidates from multiple indexes
  let candidates = [];

  // Brand-indexed candidates
  if (brand) candidates.push(...lookupByBrand(brand, 50));

  // Generic-indexed candidates (dedup by nafdac_no)
  if (generic) {
    const genericHits = lookupByGeneric(generic, 50);
    const existingNos = new Set(candidates.map(c => c.nafdac_no));
    for (const hit of genericHits) {
      if (!existingNos.has(hit.nafdac_no)) {
        candidates.push(hit);
        existingNos.add(hit.nafdac_no);
      }
    }
  }

  // Also search brand via token (fuzzy)
  if (brand) {
    const fuzzyHits = fuzzySearchBrand(brand, 30);
    const existingNos = new Set(candidates.map(c => c.nafdac_no));
    for (const hit of fuzzyHits.slice(0, 10)) {
      if (!existingNos.has(hit.nafdac_no)) {
        candidates.push(hit);
        existingNos.add(hit.nafdac_no);
      }
    }
  }

  // Score each candidate
  const scored = candidates.map((c) => {
    let totalScore = 0;
    const details = {};

    // Generic match
    if (generic && c.generic) {
      const gLower = (c.generic || '').toLowerCase();
      if (gLower === generic) {
        details.generic = { match: true, score: MATCH_WEIGHTS.generic };
        totalScore += MATCH_WEIGHTS.generic;
      } else if (gLower.includes(generic) || generic.includes(gLower)) {
        details.generic = { match: true, partial: true, score: MATCH_WEIGHTS.generic * 0.6 };
        totalScore += MATCH_WEIGHTS.generic * 0.6;
      } else {
        details.generic = { match: false, score: 0 };
      }
    }

    // Brand match
    if (brand && c.brand_name) {
      const bLower = (c.brand_name || '').toLowerCase();
      if (bLower === brand) {
        details.brand = { match: true, score: MATCH_WEIGHTS.brand };
        totalScore += MATCH_WEIGHTS.brand;
      } else if (bLower.includes(brand) || brand.includes(bLower)) {
        details.brand = { match: true, partial: true, score: MATCH_WEIGHTS.brand * 0.5 };
        totalScore += MATCH_WEIGHTS.brand * 0.5;
      } else {
        details.brand = { match: false, score: 0 };
      }
    }

    // Strength match
    if (strength && c.strength) {
      const sLower = (c.strength || '').toLowerCase();
      // Normalize strength for comparison
      const normalizeS = (s) => s.replace(/\s+/g, '').replace(/(\d+)(mg|mcg|ml|g)/i, '$1$2');
      if (normalizeS(sLower) === normalizeS(strength)) {
        details.strength = { match: true, score: MATCH_WEIGHTS.strength };
        totalScore += MATCH_WEIGHTS.strength;
      } else if (sLower.includes(strength) || strength.includes(sLower)) {
        details.strength = { match: true, partial: true, score: MATCH_WEIGHTS.strength * 0.5 };
        totalScore += MATCH_WEIGHTS.strength * 0.5;
      } else {
        details.strength = { match: false, score: 0 };
      }
    }

    // Manufacturer match
    if (manufacturer && c.manufacturer) {
      const mLower = (c.manufacturer || '').toLowerCase();
      if (mLower === manufacturer) {
        details.manufacturer = { match: true, score: MATCH_WEIGHTS.manufacturer };
        totalScore += MATCH_WEIGHTS.manufacturer;
      } else if (mLower.includes(manufacturer) || manufacturer.includes(mLower)) {
        details.manufacturer = { match: true, partial: true, score: MATCH_WEIGHTS.manufacturer * 0.6 };
        totalScore += MATCH_WEIGHTS.manufacturer * 0.6;
      } else {
        details.manufacturer = { match: false, score: 0 };
      }
    }

    // Form match
    if (form && c.form) {
      const fLower = (c.form || '').toLowerCase();
      if (fLower === form) {
        details.form = { match: true, score: MATCH_WEIGHTS.form };
        totalScore += MATCH_WEIGHTS.form;
      } else {
        details.form = { match: false, score: 0 };
      }
    }

    return { ...c, _score: totalScore, _scoreDetails: details };
  });

  // Sort by score descending, deduplicate
  scored.sort((a, b) => b._score - a._score);
  const seen = new Set();
  const unique = [];
  for (const c of scored) {
    if (!seen.has(c.nafdac_no)) {
      unique.push(c);
      seen.add(c.nafdac_no);
    }
  }

  const bestScore = unique.length > 0 ? unique[0]._score : 0;

  // Determine resolution state
  let state;
  if (unique.length === 0 || bestScore < 0.20) {
    state = 'NO_MATCH';
  } else if (bestScore >= 0.90) {
    // Check for ambiguity: multiple candidates with same top score
    const topCandidates = unique.filter(c => c._score >= bestScore - 0.05);
    if (topCandidates.length > 1 && !manufacturer) {
      // Missing manufacturer + multiple near-ties → ambiguous
      state = 'AMBIGUOUS_MATCH';
    } else {
      state = 'EXACT_MATCH';
    }
  } else if (bestScore >= 0.50) {
    // Check for ambiguity
    const topCandidates = unique.filter(c => c._score >= bestScore - 0.05);
    if (topCandidates.length > 1 && !manufacturer) {
      state = 'AMBIGUOUS_MATCH';
    } else {
      state = 'PARTIAL_MATCH';
    }
  } else {
    state = 'NO_MATCH';
  }

  return {
    state,
    confidence: bestScore,
    candidates: unique.slice(0, 10).map(c => ({
      brand_name: c.brand_name,
      generic: c.generic,
      strength: c.strength,
      form: c.form,
      manufacturer: c.manufacturer,
      nafdac_no: c.nafdac_no,
      therapeutic_group: c.therapeutic_group,
      therapeutic_subgroup: c.therapeutic_subgroup,
      score: c._score,
      scoreDetails: c._scoreDetails,
    })),
    totalCandidates: unique.length,
  };
}

// ---- (exports are at end of file after all functions are defined) ---------
function enrichFromNafdac({ product_name, brand, generic_name, strength, dosage_form }) {
  const enrichment = {
    nafdac_no: null,
    atc_code: null, // NAFDAC doesn't provide ATC, but we leave the field
    manufacturer: null,
    therapeutic_group: null,
    therapeutic_subgroup: null,
    source: null,
  };

  // Try brand lookup first
  if (brand || product_name) {
    const lookupName = brand || product_name;
    const result = fuzzyLookupProduct(lookupName);

    if (result.bestMatch && result.source && result.source !== 'brand_kb') {
      // NAFDAC match
      const m = result.bestMatch;
      enrichment.nafdac_no = m.nafdac_no || null;
      enrichment.manufacturer = enrichment.manufacturer || m.manufacturer || null;
      enrichment.therapeutic_group = m.therapeutic_group || null;
      enrichment.therapeutic_subgroup = m.therapeutic_subgroup || null;
      enrichment.source = 'nafdac';
    }

    if (result.bestMatch && result.source === 'brand_kb') {
      // Brand KB fallback
      const m = result.bestMatch;
      enrichment.manufacturer = enrichment.manufacturer || m.manufacturer || null;
      enrichment.source = 'brand_kb';
    }
  }

  // Try generic lookup for additional info
  if (generic_name && !enrichment.nafdac_no) {
    const genericResults = lookupByGeneric(generic_name, 1);
    if (genericResults.length > 0) {
      enrichment.nafdac_no = enrichment.nafdac_no || genericResults[0].nafdac_no || null;
      enrichment.manufacturer = enrichment.manufacturer || genericResults[0].manufacturer || null;
      enrichment.therapeutic_group = enrichment.therapeutic_group || genericResults[0].therapeutic_group || null;
      enrichment.therapeutic_subgroup = enrichment.therapeutic_subgroup || genericResults[0].therapeutic_subgroup || null;
      if (!enrichment.source) enrichment.source = 'nafdac_generic';
    }
  }

  return enrichment;
}

// ---- status -------------------------------------------------------------

function getNafdacStatus() {
  return {
    loaded: totalRecords > 0,
    totalRecords,
    lastLoaded,
    indexes: {
      brands: brandIndex.size,
      generics: genericIndex.size,
      brandTokens: brandTokenIndex.size,
      genericTokens: genericTokenIndex.size,
    },
    csvPath: NAFDAC_CSV_PATH,
  };
}

// ---- auto-load at module init -------------------------------------------

(function initialize() {
  const result = loadNafdac();
  if (result.success) {
    console.log(`[nafdacLookup] Loaded ${result.totalRecords} NAFDAC records`);
  } else {
    console.warn(`[nafdacLookup] ${result.error} — falling back to brand KB only`);
  }
})();

module.exports = {
  loadNafdac,
  loadNafdacData: loadNafdac,
  getNafdacStatus,
  lookupByBrand,
  lookupByGeneric,
  fuzzyLookupProduct,
  fuzzySearchBrand,
  enrichFromNafdac,
  getBrandVariants,
  lookupWithManufacturer,
  weightedMatchNafdac,
  MATCH_WEIGHTS,
};
