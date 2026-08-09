/**
 * Product Name Normalizer — Phase 4: Pharmacy Knowledge Engine.
 *
 * This is the core competitive advantage. The engine transforms messy
 * Nigerian pharmacy POS data into canonical drug identifiers.
 *
 * Features:
 *   - Brand → generic mapping (Emzor PCM → Paracetamol 500mg Tablet)
 *   - Dosage form normalization (tab, cap, susp, syr, inj, etc.)
 *   - Strength standardization (500MG → 500mg, 5ml → 5mL)
 *   - Pack size detection (x10, pack of 28, etc.)
 *   - Canonical drug IDs for consistent analytics grouping
 *   - Unknown medicines FLAGGED not guessed
 *
 * Canonical format:
 *   "{GenericName} {Strength}{Unit} {Form}"
 *   e.g., "Paracetamol 500mg Tablet"
 */

// ============================================================================
// NIGERIAN PHARMACY KNOWLEDGE BASE
// ============================================================================

/**
 * Nigerian-specific brand → generic mappings.
 *
 * Nigerian pharmacies stock a unique mix of:
 *   - Locally manufactured generics (Emzor, M&B, Swiss Pharma, Fidson, etc.)
 *   - Indian imports (Cipla, Sun Pharma, etc.)
 *   - Chinese imports
 *   - Multinational brands (GSK, Pfizer, Sanofi)
 *
 * Structure: { normalizedBrandKey: { generic, strength, form, category, canonicalId } }
 */
const NIGERIAN_BRANDS = {
  // ---- Analgesics / Antipyretics ----
  'pcm': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', aliases: ['pcm 500', 'pcm 500mg'] },
  'emzor pcm': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'Emzor' },
  'emzor paracetamol': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'Emzor' },
  'mb paracetamol': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'M&B' },
  'panadol': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'GSK' },
  'panadol extra': { generic: 'Paracetamol + Caffeine', strength: '500mg/65mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'GSK' },
  'boska': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic', manufacturer: 'Emzor' },
  'paracetamol': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic' },
  'para': { generic: 'Paracetamol', strength: '500mg', form: 'Tablet', category: 'Analgesic' },

  // ---- NSAIDs ----
  'ibuprofen': { generic: 'Ibuprofen', strength: '400mg', form: 'Tablet', category: 'NSAID' },
  'brufen': { generic: 'Ibuprofen', strength: '400mg', form: 'Tablet', category: 'NSAID', manufacturer: 'Abbott' },
  'ibucap': { generic: 'Ibuprofen', strength: '400mg', form: 'Capsule', category: 'NSAID' },
  'feldene': { generic: 'Piroxicam', strength: '20mg', form: 'Capsule', category: 'NSAID', manufacturer: 'Pfizer' },
  'diclofenac': { generic: 'Diclofenac', strength: '50mg', form: 'Tablet', category: 'NSAID' },
  'voltaren': { generic: 'Diclofenac', strength: '50mg', form: 'Tablet', category: 'NSAID', manufacturer: 'Novartis' },
  'cataflam': { generic: 'Diclofenac Potassium', strength: '50mg', form: 'Tablet', category: 'NSAID', manufacturer: 'Novartis' },
  'diclomax': { generic: 'Diclofenac', strength: '50mg', form: 'Tablet', category: 'NSAID' },
  'aspirin': { generic: 'Aspirin', strength: '300mg', form: 'Tablet', category: 'NSAID' },

  // ---- Antibiotics ----
  'amoxicillin': { generic: 'Amoxicillin', strength: '500mg', form: 'Capsule', category: 'Antibiotic' },
  'amoxil': { generic: 'Amoxicillin', strength: '500mg', form: 'Capsule', category: 'Antibiotic', manufacturer: 'GSK' },
  'ampiclox': { generic: 'Ampicillin + Cloxacillin', strength: '250mg/250mg', form: 'Capsule', category: 'Antibiotic' },
  'ampicillin': { generic: 'Ampicillin', strength: '500mg', form: 'Capsule', category: 'Antibiotic' },
  'augmentin': { generic: 'Amoxicillin + Clavulanic Acid', strength: '625mg', form: 'Tablet', category: 'Antibiotic', manufacturer: 'GSK' },
  'augmentin 625': { generic: 'Amoxicillin + Clavulanic Acid', strength: '625mg', form: 'Tablet', category: 'Antibiotic', manufacturer: 'GSK' },
  'augmentin 375': { generic: 'Amoxicillin + Clavulanic Acid', strength: '375mg', form: 'Tablet', category: 'Antibiotic', manufacturer: 'GSK' },
  'ciprofloxacin': { generic: 'Ciprofloxacin', strength: '500mg', form: 'Tablet', category: 'Antibiotic' },
  'ciprotab': { generic: 'Ciprofloxacin', strength: '500mg', form: 'Tablet', category: 'Antibiotic' },
  'cipro': { generic: 'Ciprofloxacin', strength: '500mg', form: 'Tablet', category: 'Antibiotic' },
  'erythromycin': { generic: 'Erythromycin', strength: '250mg', form: 'Tablet', category: 'Antibiotic' },
  'tetracycline': { generic: 'Tetracycline', strength: '250mg', form: 'Capsule', category: 'Antibiotic' },
  'doxycycline': { generic: 'Doxycycline', strength: '100mg', form: 'Capsule', category: 'Antibiotic' },
  'metronidazole': { generic: 'Metronidazole', strength: '200mg', form: 'Tablet', category: 'Antibiotic' },
  'flagyl': { generic: 'Metronidazole', strength: '200mg', form: 'Tablet', category: 'Antibiotic', manufacturer: 'Sanofi' },
  'septrin': { generic: 'Co-trimoxazole', strength: '480mg', form: 'Tablet', category: 'Antibiotic' },
  'cotrimoxazole': { generic: 'Co-trimoxazole', strength: '480mg', form: 'Tablet', category: 'Antibiotic' },
  'ceftriaxone': { generic: 'Ceftriaxone', strength: '1g', form: 'Injection', category: 'Antibiotic' },
  'rocephin': { generic: 'Ceftriaxone', strength: '1g', form: 'Injection', category: 'Antibiotic', manufacturer: 'Roche' },
  'cefuroxime': { generic: 'Cefuroxime', strength: '500mg', form: 'Tablet', category: 'Antibiotic' },
  'cefixime': { generic: 'Cefixime', strength: '200mg', form: 'Tablet', category: 'Antibiotic' },
  'azithromycin': { generic: 'Azithromycin', strength: '500mg', form: 'Tablet', category: 'Antibiotic' },
  'zithromax': { generic: 'Azithromycin', strength: '500mg', form: 'Tablet', category: 'Antibiotic', manufacturer: 'Pfizer' },
  'gentamicin': { generic: 'Gentamicin', strength: '80mg/2mL', form: 'Injection', category: 'Antibiotic' },

  // ---- Antimalarials ----
  'coartem': { generic: 'Artemether + Lumefantrine', strength: '80mg/480mg', form: 'Tablet', category: 'Antimalarial', manufacturer: 'Novartis' },
  'lonart': { generic: 'Artemether + Lumefantrine', strength: '80mg/480mg', form: 'Tablet', category: 'Antimalarial' },
  'artemether': { generic: 'Artemether', strength: '80mg', form: 'Tablet', category: 'Antimalarial' },
  'artesunate': { generic: 'Artesunate', strength: '50mg', form: 'Tablet', category: 'Antimalarial' },
  'amodiaquine': { generic: 'Amodiaquine', strength: '200mg', form: 'Tablet', category: 'Antimalarial' },
  'camosunate': { generic: 'Artesunate + Amodiaquine', strength: '100mg/270mg', form: 'Tablet', category: 'Antimalarial' },
  'p-alaxin': { generic: 'Dihydroartemisinin + Piperaquine', strength: '40mg/320mg', form: 'Tablet', category: 'Antimalarial' },
  'palaxin': { generic: 'Dihydroartemisinin + Piperaquine', strength: '40mg/320mg', form: 'Tablet', category: 'Antimalarial' },
  'fansidar': { generic: 'Sulfadoxine + Pyrimethamine', strength: '500mg/25mg', form: 'Tablet', category: 'Antimalarial' },
  'malanil': { generic: 'Atovaquone + Proguanil', strength: '250mg/100mg', form: 'Tablet', category: 'Antimalarial' },
  'quinine': { generic: 'Quinine', strength: '300mg', form: 'Tablet', category: 'Antimalarial' },

  // ---- Antihypertensives ----
  'lisinopril': { generic: 'Lisinopril', strength: '10mg', form: 'Tablet', category: 'Antihypertensive' },
  'amlodipine': { generic: 'Amlodipine', strength: '5mg', form: 'Tablet', category: 'Antihypertensive' },
  'norvasc': { generic: 'Amlodipine', strength: '5mg', form: 'Tablet', category: 'Antihypertensive', manufacturer: 'Pfizer' },
  'nifedipine': { generic: 'Nifedipine', strength: '20mg', form: 'Tablet', category: 'Antihypertensive' },
  'atenolol': { generic: 'Atenolol', strength: '50mg', form: 'Tablet', category: 'Antihypertensive' },
  'propranolol': { generic: 'Propranolol', strength: '40mg', form: 'Tablet', category: 'Antihypertensive' },
  'enalapril': { generic: 'Enalapril', strength: '5mg', form: 'Tablet', category: 'Antihypertensive' },
  'losartan': { generic: 'Losartan', strength: '50mg', form: 'Tablet', category: 'Antihypertensive' },
  'moduretic': { generic: 'Amiloride + Hydrochlorothiazide', strength: '5mg/50mg', form: 'Tablet', category: 'Antihypertensive' },
  'aldomet': { generic: 'Methyldopa', strength: '250mg', form: 'Tablet', category: 'Antihypertensive' },

  // ---- Antidiabetics ----
  'metformin': { generic: 'Metformin', strength: '500mg', form: 'Tablet', category: 'Antidiabetic' },
  'glucophage': { generic: 'Metformin', strength: '500mg', form: 'Tablet', category: 'Antidiabetic' },
  'daonil': { generic: 'Glibenclamide', strength: '5mg', form: 'Tablet', category: 'Antidiabetic' },
  'glibenclamide': { generic: 'Glibenclamide', strength: '5mg', form: 'Tablet', category: 'Antidiabetic' },

  // ---- Antacids / Ulcer ----
  'omeprazole': { generic: 'Omeprazole', strength: '20mg', form: 'Capsule', category: 'GI' },
  'losec': { generic: 'Omeprazole', strength: '20mg', form: 'Capsule', category: 'GI', manufacturer: 'AstraZeneca' },
  'ranitidine': { generic: 'Ranitidine', strength: '150mg', form: 'Tablet', category: 'GI' },
  'gestid': { generic: 'Aluminium + Magnesium Hydroxide', strength: '200mg/200mg', form: 'Tablet', category: 'Antacid' },
  'antiacid': { generic: 'Aluminium Hydroxide + Magnesium Trisilicate', form: 'Tablet', category: 'Antacid' },
  'mist mag': { generic: 'Magnesium Trisilicate', form: 'Suspension', category: 'Antacid' },

  // ---- Antihistamines ----
  'loratadine': { generic: 'Loratadine', strength: '10mg', form: 'Tablet', category: 'Antihistamine' },
  'cetirizine': { generic: 'Cetirizine', strength: '10mg', form: 'Tablet', category: 'Antihistamine' },
  'piriton': { generic: 'Chlorpheniramine', strength: '4mg', form: 'Tablet', category: 'Antihistamine' },
  'chlorpheniramine': { generic: 'Chlorpheniramine', strength: '4mg', form: 'Tablet', category: 'Antihistamine' },

  // ---- Anthelmintics ----
  'albendazole': { generic: 'Albendazole', strength: '400mg', form: 'Tablet', category: 'Anthelmintic' },
  'zentel': { generic: 'Albendazole', strength: '400mg', form: 'Tablet', category: 'Anthelmintic' },
  'mebendazole': { generic: 'Mebendazole', strength: '100mg', form: 'Tablet', category: 'Anthelmintic' },
  'vermox': { generic: 'Mebendazole', strength: '100mg', form: 'Tablet', category: 'Anthelmintic' },
  'ivermectin': { generic: 'Ivermectin', strength: '6mg', form: 'Tablet', category: 'Anthelmintic' },

  // ---- Vitamins / Supplements ----
  'vitamin c': { generic: 'Vitamin C', strength: '100mg', form: 'Tablet', category: 'Vitamin' },
  'vc': { generic: 'Vitamin C', strength: '100mg', form: 'Tablet', category: 'Vitamin' },
  'vitamin b complex': { generic: 'Vitamin B Complex', form: 'Tablet', category: 'Vitamin' },
  'b complex': { generic: 'Vitamin B Complex', form: 'Tablet', category: 'Vitamin' },
  'becosym': { generic: 'Vitamin B Complex', form: 'Tablet', category: 'Vitamin' },
  'multivitamin': { generic: 'Multivitamin', form: 'Tablet', category: 'Vitamin' },
  'folic acid': { generic: 'Folic Acid', strength: '5mg', form: 'Tablet', category: 'Vitamin' },
  'ferrous sulfate': { generic: 'Ferrous Sulfate', strength: '200mg', form: 'Tablet', category: 'Mineral' },
  'feroglobin': { generic: 'Iron + Multivitamin', form: 'Syrup', category: 'Supplement' },
  'haemoglobin': { generic: 'Iron + Multivitamin', form: 'Syrup', category: 'Supplement' },

  // ---- Antifungals ----
  'clotrimazole': { generic: 'Clotrimazole', form: 'Cream', category: 'Antifungal' },
  'nystatin': { generic: 'Nystatin', form: 'Suspension', category: 'Antifungal' },
  'fluconazole': { generic: 'Fluconazole', strength: '150mg', form: 'Capsule', category: 'Antifungal' },
  'mycostatin': { generic: 'Nystatin', form: 'Suspension', category: 'Antifungal' },
  'ketoconazole': { generic: 'Ketoconazole', strength: '200mg', form: 'Tablet', category: 'Antifungal' },
  'griseofulvin': { generic: 'Griseofulvin', strength: '500mg', form: 'Tablet', category: 'Antifungal' },

  // ---- ORS / Electrolytes ----
  'ors': { generic: 'Oral Rehydration Salts', form: 'Sachet', category: 'ORS' },
  'dioralyte': { generic: 'Oral Rehydration Salts', form: 'Sachet', category: 'ORS' },
  'electral': { generic: 'Oral Rehydration Salts', form: 'Sachet', category: 'ORS' },

  // ---- Cough / Cold ----
  'actifed': { generic: 'Triprolidine + Pseudoephedrine', form: 'Syrup', category: 'Cough/Cold' },
  'cough syrup': { generic: 'Cough Syrup', form: 'Syrup', category: 'Cough/Cold' },
  'benylin': { generic: 'Diphenhydramine', form: 'Syrup', category: 'Cough/Cold' },
  'prospan': { generic: 'Hedera Helix (Ivy Leaf)', form: 'Syrup', category: 'Cough/Cold' },
};

// ---- dosage form synonyms -----------------------------------------------

const FORM_SYNONYMS = {
  tablet: ['tab', 'tabs', 'tablet', 'tablets', 'tbl'],
  capsule: ['cap', 'caps', 'capsule', 'capsules', 'caplet'],
  syrup: ['syr', 'syrup', 'suspension', 'susp', 'elixir', 'mixture', 'linctus'],
  injection: ['inj', 'injection', 'injectable', 'ampoule', 'amp', 'vial'],
  cream: ['cr', 'cream', 'ointment', 'oint', 'gel', 'lotion'],
  drops: ['drops', 'drop', 'eye drops', 'ear drops', 'nasal drops'],
  powder: ['powder', 'pwdr', 'granules'],
  sachet: ['sachet', 'sachets', 'satchet'],
  suppository: ['suppository', 'supp', 'pessary'],
  inhaler: ['inhaler', 'puff'],
  spray: ['spray', 'nasal spray'],
};

// ---- unit synonyms ------------------------------------------------------

const UNIT_SYNONYMS = {
  'mg': ['mg', 'milligram', 'milligrams', 'mgs'],
  'g': ['g', 'gram', 'grams', 'gm'],
  'mL': ['ml', 'millilitre', 'milliliter', 'mls', 'millilitres'],
  'mcg': ['mcg', 'microgram', 'micrograms', 'ug', 'μg'],
  'IU': ['iu', 'international unit'],
  '%': ['%', 'percent', 'w/w', 'w/v'],
};

// ---- canonical drug ID counter ------------------------------------------

let _canonicalIdCounter = 10000;
const _canonicalIdMap = new Map(); // "GenericName Strength Form" → ID

function getOrCreateCanonicalId(generic, strength, form) {
  const key = `${generic}|${strength || ''}|${form || ''}`.toLowerCase();
  if (_canonicalIdMap.has(key)) return _canonicalIdMap.get(key);

  const id = `DRUG-${_canonicalIdCounter++}`;
  _canonicalIdMap.set(key, id);
  return id;
}

// ---- normalization logic ------------------------------------------------

/**
 * Convert a kebab-case or space-separated name into Title Case.
 * e.g., "panadol extra" → "Panadol Extra", "emzor-pcm" → "Emzor Pcm"
 */
function titleCase(str) {
  if (!str) return '';
  return str
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Prompt 0 — Product Text Normalization (deterministic preprocessing)
 *
 * Applied BEFORE any parsing or identity resolution. Normalizes raw product
 * strings so that downstream steps see clean, standardized text.
 *
 * Transformations (in order):
 *   1. Unicode normalization (NFKD)
 *   2. Lowercase conversion
 *   3. Punctuation removal
 *   4. Whitespace cleanup (collapse + trim)
 *   5. Dosage form abbreviation expansion (TAB → tablet, etc.)
 *   6. Unit normalization (500 MG → 500mg)
 */
function normalizeProductText(raw) {
  if (raw == null || raw === '') return raw;

  let text = String(raw);

  // Step 1: Unicode NFKD normalization (decompose ligatures, normalize accents)
  text = text.normalize('NFKD');

  // Step 2: Lowercase
  text = text.toLowerCase();

  // Step 3: Punctuation removal — keep alphanumeric, spaces, slashes, dots, hyphens, parens, plus
  text = text.replace(/[^a-z0-9\s\/\.\-\(\)\+]/g, ' ');

  // Step 4: Whitespace cleanup
  text = text.replace(/\s+/g, ' ').trim();

  // Step 5: Dosage form abbreviation expansion
  for (const [canonical, synonyms] of Object.entries(FORM_SYNONYMS)) {
    for (const syn of synonyms) {
      // Only replace standalone tokens (word boundaries), not substrings
      const regex = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      text = text.replace(regex, canonical);
    }
  }

  // Step 6a: Gram -> milligram conversion, BEFORE compact formatting. Without
  // this, "1g" and "1000mg" are the same real dose but different text
  // forever — no amount of brand/generic matching downstream fixes that,
  // since they'd already be two different strings by the time anything
  // else runs.
  //
  // No leading \b before the digit — real pharmacy data glues the number
  // straight onto the brand name ("Augmentin1g", "ceftriaxone2 G"), so a
  // digit directly after a letter is the common case, not the exception.
  // Still safe against misreading "500mg": \s*g requires the digits to be
  // followed (after optional whitespace) by a literal "g" — in "500mg" the
  // "m" sits directly between the digits and the "g", so \s* (whitespace
  // only) can't bridge that gap and the match never fires there.
  text = text.replace(/(\d+(?:\.\d+)?)\s*g\b/g, (_, num) => `${Math.round(parseFloat(num) * 1000)}mg`);

  // Step 6b: Unit normalization — standardize space-number-unit format to compact
  // e.g., "500 MG" → "500mg", "10 ML" → "10ml"
  text = text.replace(/\b(\d+(?:\.\d+)?)\s*(mg|g|ml|mcg|iu)\b/gi, '$1$2');

  // Final whitespace cleanup after all replacements
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Find a matching brand entry from the knowledge base.
 * Checks exact match first, then alias match, then partial match.
 */
function lookupBrand(name) {
  const key = name.toLowerCase().trim();

  // Exact match
  if (NIGERIAN_BRANDS[key]) return { entry: NIGERIAN_BRANDS[key], key };

  // Alias match
  for (const [brandKey, entry] of Object.entries(NIGERIAN_BRANDS)) {
    if (entry.aliases && entry.aliases.includes(key)) {
      return { entry, key: brandKey };
    }
  }

  // Partial match (e.g., "emzor pcm extra" contains "emzor pcm")
  const words = key.split(/\s+/);
  for (const [brandKey, entry] of Object.entries(NIGERIAN_BRANDS)) {
    if (brandKey.split(/\s+/).every((w) => words.includes(w))) {
      return { entry, key: brandKey };
    }
  }

  return null;
}

// ---- Fuzzy matching ------------------------------------------------------

/**
 * Levenshtein (edit) distance between two strings.
 * Returns the minimum number of single-character edits (insert, delete, substitute)
 * required to change `a` into `b`.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  // Use single-row optimization for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Fuzzy-match a name against the brand knowledge base.
 * Returns the best-match entry and its edit distance, or null if no match within threshold.
 *
 * Threshold is lenient for longer names (≥6 chars: ≤2 edits, <6 chars: ≤1 edit)
 * and also rejects candidates where the length difference exceeds the threshold.
 */
function fuzzyMatchBrand(name) {
  if (!name || name.length < 3) return null;

  const lower = name.toLowerCase().trim();
  const maxDist = lower.length >= 6 ? 2 : 1;

  let bestEntry = null;
  let bestKey = null;
  let bestDist = Infinity;

  for (const [brandKey, entry] of Object.entries(NIGERIAN_BRANDS)) {
    // Prune: skip candidates with drastically different lengths
    if (Math.abs(brandKey.length - lower.length) > maxDist) continue;

    const dist = levenshtein(lower, brandKey);
    if (dist < bestDist && dist <= maxDist) {
      bestDist = dist;
      bestKey = brandKey;
      bestEntry = entry;
    }
  }

  if (bestEntry) {
    return { entry: bestEntry, key: bestKey, distance: bestDist };
  }
  return null;
}

/**
 * Extract strength from a product name string.
 * Handles: "500mg", "500 mg", "500MG", "500mg/5mL", "80/480mg", "5%"
 */
function extractStrength(name) {
  const patterns = [
    // "500mg/5mL" type
    /(\d+[\.,]?\d*)\s*(mg|g|ml|mcg|iu|%)\s*\/\s*(\d+[\.,]?\d*)\s*(mg|g|ml|mcg)/gi,
    // "80/480mg" type
    /(\d+[\.,]?\d*)\s*\/\s*(\d+[\.,]?\d*)\s*(mg|g|ml|mcg)/gi,
    // "500mg" type
    /(\d+[\.,]?\d*)\s*(mg|g|ml|mcg|iu|%)/gi,
    // "500 MG" type (two words)
    /(\d+[\.,]?\d*)\s+(mg|g|ml|mcg)\b/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (match) {
      // Normalize: lowercase unit
      return match[0]
        .replace(/\s+/g, '')
        .replace(/(MG|Mg)/g, 'mg')
        .replace(/(ML|Ml)/g, 'mL')
        .replace(/(MCG|Mcg)/g, 'mcg')
        .replace(/(G)\b/gi, (s) => s.toUpperCase() === 'G' ? 'g' : s);
    }
  }
  return null;
}

/**
 * Extract dosage form from a product name.
 */
function extractForm(name) {
  const lower = name.toLowerCase().trim();

  for (const [canonical, synonyms] of Object.entries(FORM_SYNONYMS)) {
    for (const syn of synonyms) {
      // Match standalone form word at the end or followed by space
      const re = new RegExp(`\\b${syn}\\b`, 'i');
      if (re.test(lower)) {
        return canonical;
      }
    }
  }

  // Try common Nigerian abbreviations
  if (/\btab(s)?\b/i.test(lower)) return 'tablet';
  if (/\bcap(s)?\b/i.test(lower)) return 'capsule';

  return null;
}

/**
 * Detect pack size from product name.
 * e.g., "x10", "pack of 28", "(28)", "28s", "28 tablets"
 */
function extractPackSize(name) {
  const lower = name.toLowerCase().trim();

  const patterns = [
    /x\s*(\d+)/i,
    /pack\s*(?:of|size)?\s*(\d+)/i,
    /\((\d+)\)/,
    /(\d+)\s*s\b/i,
    /(\d+)\s*(?:tablets|capsules|sachets)$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(lower);
    if (match) return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Check if the product is a recognized/inferable medicine.
 * Returns { recognized, confidence, canonicalId, generic, strength, form, category, manufacturer }
 */
function identifyDrug(raw) {
  if (raw == null || raw === '') return { recognized: false, reason: 'empty' };

  const name = String(raw).toLowerCase().trim();

  // Step 1: Look up brand
  const brand = lookupBrand(name);
  if (brand) {
    const entry = brand.entry;
    return {
      recognized: true,
      confidence: 0.95,
      canonicalId: getOrCreateCanonicalId(entry.generic, entry.strength, entry.form),
      generic: entry.generic,
      strength: entry.strength || null,
      form: entry.form || null,
      category: entry.category || null,
      manufacturer: entry.manufacturer || null,
      brandName: titleCase(brand.key),
      source: 'brand_knowledge_base',
    };
  }

  // Step 2: Try pattern-based identification
  const generic = inferGeneric(name);
  const strength = extractStrength(name);
  const form = extractForm(name);

  if (generic && strength && form) {
    return {
      recognized: true,
      confidence: 0.70,
      canonicalId: getOrCreateCanonicalId(generic, strength, form),
      generic,
      strength,
      form,
      category: guessCategory(name),
      source: 'pattern_inference',
    };
  }

  if (generic && strength) {
    return {
      recognized: true,
      confidence: 0.60,
      canonicalId: getOrCreateCanonicalId(generic, strength, 'Tablet'),
      generic,
      strength,
      form: 'Tablet',
      category: guessCategory(name),
      source: 'partial_pattern',
    };
  }

  // If no brand match and no strength/form extracted, flag as unknown.
  // We never guess medicines — only recognize what we can verify.

  // Step 3: Fuzzy brand match (spelling-tolerant fallback)
  const fuzzy = fuzzyMatchBrand(name);
  if (fuzzy) {
    const entry = fuzzy.entry;
    return {
      recognized: true,
      confidence: Math.max(0.55, 0.80 - fuzzy.distance * 0.15),
      canonicalId: getOrCreateCanonicalId(entry.generic, entry.strength, entry.form),
      generic: entry.generic,
      strength: entry.strength || null,
      form: entry.form || null,
      category: entry.category || null,
      manufacturer: entry.manufacturer || null,
      brandName: titleCase(fuzzy.key),
      source: 'fuzzy_brand_match',
      fuzzyDistance: fuzzy.distance,
    };
  }

  // Step 4: Unknown — flag, don't guess
  return {
    recognized: false,
    confidence: 0,
    reason: 'unknown',
    rawName: raw,
    flag: 'UNKNOWN_MEDICINE',
    message: `"${raw}" could not be matched to any known medicine. Manual review required.`,
  };
}

/**
 * Infer the generic drug name from a product string.
 * Strips known form/strength/unit suffixes and looks for remaining text.
 */
function inferGeneric(name) {
  const lower = name.toLowerCase().trim();

  // Strip known forms
  let cleaned = lower;
  for (const synonyms of Object.values(FORM_SYNONYMS)) {
    for (const syn of synonyms) {
      cleaned = cleaned.replace(new RegExp(`\\b${syn}\\b`, 'gi'), '');
    }
  }

  // Strip strengths
  cleaned = cleaned.replace(/\d+[\.,]?\d*\s*(mg|g|ml|mcg|iu|%)/gi, '');
  cleaned = cleaned.replace(/\d+[\.,]?\d*\s*\/\s*\d+[\.,]?\d*\s*(mg|g|ml)?/gi, '');

  // Strip pack sizes
  cleaned = cleaned.replace(/x\s*\d+/gi, '');
  cleaned = cleaned.replace(/pack\s*(?:of|size)?\s*\d+/gi, '');
  cleaned = cleaned.replace(/\(\d+\)/g, '');
  cleaned = cleaned.replace(/\d+\s*s\b/gi, '');

  // Clean up
  cleaned = cleaned.replace(/\s+/g, ' ').replace(/[^a-z0-9\s\/\(\)]/g, '').trim();

  if (cleaned.length < 3) return null;

  // Only return if the remaining text looks like a plausible drug name
  // (contains alphabetic characters, not just numbers)
  if (!/[a-zA-Z].*[a-zA-Z]/.test(cleaned)) return null;

  // Title case the generic name
  const generic = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  return generic || null;
}

/**
 * Guess the therapeutic category from drug name.
 */
function guessCategory(name) {
  const lower = name.toLowerCase();

  if (/paracetamol|pcm|panadol|analgesic|pain/i.test(lower)) return 'Analgesic';
  if (/ibuprofen|diclofenac|piroxicam|nsaid|aspirin|brufen|voltaren/i.test(lower)) return 'NSAID';
  if (/amox|ampic|augmentin|cef|cipro|erythro|tetra|metronidazole|flagyl|antibiotic|septrin/i.test(lower)) return 'Antibiotic';
  if (/artemether|artesunate|amodiaquine|coartem|lonart|quinine|malaria/i.test(lower)) return 'Antimalarial';
  if (/lisinopril|amlodipine|nifedipine|atenolol|enalapril|losartan|bp|hypertension/i.test(lower)) return 'Antihypertensive';
  if (/metformin|glibenclamide|daonil|diabetes|glucose/i.test(lower)) return 'Antidiabetic';
  if (/omeprazole|losec|ranitidine|antacid|gestid|ulcer/i.test(lower)) return 'GI';
  if (/loratadine|cetirizine|piriton|allergy|antihistamine/i.test(lower)) return 'Antihistamine';
  if (/albendazole|zentel|mebendazole|worm|ivermectin/i.test(lower)) return 'Anthelmintic';
  if (/vitamin|multivitamin|folic|ferrous|iron|supplement/i.test(lower)) return 'Vitamin/Supplement';
  if (/clotrimazole|nystatin|fluconazole|fungal|antifungal/i.test(lower)) return 'Antifungal';
  if (/ors|electrolyte|rehydration/i.test(lower)) return 'ORS';
  if (/cough|cold|actifed|benylin/i.test(lower)) return 'Cough/Cold';

  return null;
}

// ---- main API -----------------------------------------------------------

/**
 * Normalize a single product name with full audit trail.
 *
 * @param {string} raw
 * @returns {{
 *   original: string,
 *   normalized: string,
 *   canonical: string,
 *   canonicalId: string | null,
 *   generic: string | null,
 *   strength: string | null,
 *   form: string | null,
 *   category: string | null,
 *   confidence: number,
 *   recognized: boolean,
 *   flag: string | null,
 *   transformations: string[]
 * }}
 */
function normalizeProductName(raw) {
  const baseResult = {
    original: raw,
    normalized: null,
    canonical: null,
    canonicalId: null,
    generic: null,
    strength: null,
    form: null,
    packSize: null,
    category: null,
    manufacturer: null,
    confidence: 0,
    recognized: false,
    flag: null,
    transformations: [],
  };

  if (raw == null || raw === '') {
    baseResult.normalized = null;
    baseResult.flag = 'EMPTY';
    return baseResult;
  }

  let name = String(raw).trim();
  const originalTrimmed = name;

  // Track transformation: trim
  if (name !== raw) {
    baseResult.transformations.push('trimmed whitespace');
  }

  // ---- Prompt 0: Text normalization (abbreviation expansion, unit cleanup, etc.) ----
  const normalizedText = normalizeProductText(name);
  if (normalizedText !== name) {
    baseResult.transformations.push('text normalized');
    name = normalizedText;
  }

  // Step 1: Identify the drug (uses normalized text)
  const id = identifyDrug(name);

  if (!id.recognized) {
    // Keep original trimmed text for unrecognized products — normalization
    // is only used for identification, not for recording the source identity.
    baseResult.normalized = originalTrimmed;
    baseResult.flag = id.flag || 'UNKNOWN';
    baseResult.recognized = false;
    return baseResult;
  }

  // Step 2: Build canonical name (business identity)
  // When the source is a brand KB match, lead with the brand name — that's
  // the pharmacy's business terminology. But the KB's strength/form are just
  // a default for the most common variant (e.g. the bare "augmentin" entry
  // assumes 625mg) — if the pharmacy's own text actually specifies a
  // strength ("augmentin 1g"), that real value must win, or it gets
  // silently deleted and two genuinely different strengths collapse into
  // one identity. Only fall back to the KB default when the text truly
  // doesn't say.
  let canonical;
  if (id.source === 'brand_knowledge_base' || id.source === 'fuzzy_brand_match') {
    const actualStrength = extractStrength(name) || id.strength || null;
    const actualForm = extractForm(name) || id.form || null;
    const parts = [id.brandName || id.generic];
    if (actualStrength) parts.push(actualStrength);
    if (actualForm) parts.push(actualForm.charAt(0).toUpperCase() + actualForm.slice(1));
    canonical = parts.join(' ');
  } else {
    const parts = [];
    if (id.generic) parts.push(id.generic);
    if (id.strength) parts.push(id.strength);
    if (id.form) parts.push(id.form.charAt(0).toUpperCase() + id.form.slice(1));
    canonical = parts.join(' ');
  }

  // Step 3: Detect pack size
  const packSize = extractPackSize(name);

  baseResult.normalized = canonical;
  baseResult.canonical = canonical;
  baseResult.canonicalId = id.canonicalId;
  baseResult.generic = id.generic;
  baseResult.strength = id.strength;
  baseResult.form = id.form;
  baseResult.packSize = packSize;
  baseResult.category = id.category;
  baseResult.manufacturer = id.manufacturer;
  baseResult.confidence = id.confidence;
  baseResult.recognized = true;

  // Track transformations
  if (name.toLowerCase() !== canonical.toLowerCase()) {
    baseResult.transformations.push(`standardized: "${name}" → "${canonical}"`);
  }
  if (id.source) {
    baseResult.transformations.push(`source: ${id.source}`);
  }

  return baseResult;
}

/**
 * Bulk normalize, returning both the normalized names and a summary.
 */
function normalizeProductNames(records) {
  const results = [];
  const unknownDrugs = new Set();
  const stats = { total: 0, recognized: 0, unknown: 0, uniqueDrugs: new Set() };

  for (const rec of records) {
    stats.total++;
    const result = normalizeProductName(rec.product_name || rec.product);

    if (result.recognized) {
      stats.recognized++;
      stats.uniqueDrugs.add(result.canonicalId);
    } else {
      stats.unknown++;
      if (result.flag === 'UNKNOWN' || result.flag === 'UNKNOWN_MEDICINE') {
        unknownDrugs.add(result.normalized || result.original);
      }
    }

    results.push({
      ...rec,
      product_name: result.normalized || rec.product_name || rec.product || 'Unknown',
      _productCanonicalId: result.canonicalId,
      _productCategory: result.category,
      _productGeneric: result.generic,
      _productConfidence: result.confidence,
      _productFlag: result.flag,
    });
  }

  return {
    records: results,
    stats: {
      total: stats.total,
      recognized: stats.recognized,
      unknown: stats.unknown,
      uniqueCanonicalDrugs: stats.uniqueDrugs.size,
      unknownDrugNames: [...unknownDrugs],
    },
  };
}

module.exports = {
  normalizeProductText,
  normalizeProductName,
  normalizeProductNames,
  identifyDrug,
  lookupBrand,
  extractStrength,
  extractForm,
  extractPackSize,
  NIGERIAN_BRANDS,
  FORM_SYNONYMS,
};
