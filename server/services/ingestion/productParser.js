/**
 * Structured Product Parser — Prompt 2
 *
 * Extracts structured drug attributes from a single product name string
 * BEFORE any NAFDAC lookup occurs.
 *
 * Runs prior to the identity resolver, decomposing strings like:
 *   "Panadol Extra 500mg Tablet" → { brand: "Panadol Extra", strength: "500mg", form: "Tablet" }
 *   "Amcap Amoxicillin 250mg Capsule" → { brand: "Amcap", generic: "Amoxicillin", strength: "250mg", form: "Capsule" }
 *   "Ibuprofen 400mg" → { generic: "Ibuprofen", strength: "400mg" }
 */

// ---- Strength patterns ---------------------------------------------------

const STRENGTH_PATTERNS = [
  // Compound strengths: "80mg/480mg", "500mg/50mg"
  { regex: /(\d+\.?\d*)\s*m?g\s*\/\s*(\d+\.?\d*)\s*m?g/i,  type: 'compound' },
  // Standard: 500mg, 250MG, 10mg/ml, 50mcg
  { regex: /(\d+\.?\d*)\s*(m?g|mcg|iu|ml|meq|mmol|%|g|kg|units?)/i, type: 'standard' },
  // Number-only: "500" at word boundary (less confident)
  { regex: /\b(\d{2,4})\b(?!\s*(?:mg|mcg|ml|g|iu|%|tab|cap|capsule|tablet|syr|inj|ampoule|vial|susp|supp|cream|oint|gel|drops|spray|patch))/i, type: 'bare_number' },
];

const FORM_PATTERNS = [
  { regex: /\btablets?\b/i,                         form: 'Tablet' },
  { regex: /\btab\b(?!\w)/i,                        form: 'Tablet' },
  { regex: /\bcapsules?\b/i,                        form: 'Capsule' },
  { regex: /\bcap\b(?!\s*(?:ph|ac)|$)/i,           form: 'Capsule' },
  { regex: /\bsyrup\b/i,                            form: 'Syrup' },
  { regex: /\bsuspension\b/i,                       form: 'Suspension' },
  { regex: /\bsusp\b(?!\w)/i,                       form: 'Suspension' },
  { regex: /\binject(?:ion|able)\b/i,               form: 'Injection' },
  { regex: /\binj\b(?!\w)/i,                        form: 'Injection' },
  { regex: /\bampoule\b/i,                          form: 'Injection' },
  { regex: /\bvial\b/i,                             form: 'Injection' },
  { regex: /\bcream\b/i,                            form: 'Cream' },
  { regex: /\b(?:oint|ointment)\b/i,                form: 'Ointment' },
  { regex: /\bgel\b/i,                              form: 'Gel' },
  { regex: /\bdrops?\b/i,                           form: 'Drops' },
  { regex: /\bspray\b/i,                            form: 'Spray' },
  { regex: /\bpatch\b/i,                            form: 'Patch' },
  { regex: /\bpowder\b/i,                           form: 'Powder' },
  { regex: /\b(?:supp|suppository)\b/i,             form: 'Suppository' },
  { regex: /\b(?:lozenge|troche)\b/i,               form: 'Lozenge' },
  { regex: /\b(?:inhaler|inhalation)\b/i,           form: 'Inhaler' },
  { regex: /\bsolution\b/i,                         form: 'Solution' },
  { regex: /\beye\s*(?:drop|prep)/i,               form: 'Eye Drop' },
  { regex: /\b(?:ear|otic)\s*drop/i,               form: 'Ear Drop' },
  { regex: /\bdispersible\b/i,                     form: 'Dispersible Tablet' },
  { regex: /\beffervescent\b/i,                    form: 'Effervescent Tablet' },
  { regex: /\bchewable\b/i,                        form: 'Chewable Tablet' },
];

const PACK_SIZE_PATTERNS = [
  { regex: /\b(\d{1,2})'?s\b/i,       unit: 'units' },
  { regex: /\bpack\s*(?:of\s*)?(\d+)/i, unit: 'pack' },
  { regex: /\b(\d+)\s*(?:tab|cap)s?\b(?!\s*(?:mg|ml|mcg|g))/i, unit: null }, // use matched form
];

// ---- Known generics (expanded from NAFDAC + Nigerian market) --------------

const KNOWN_GENERICS = new Set([
  'paracetamol', 'acetaminophen', 'ibuprofen', 'amoxicillin', 'ampicillin',
  'ciprofloxacin', 'metronidazole', 'artemether', 'lumefantrine',
  'artesunate', 'amodiaquine', 'dihydroartemisinin', 'piperaquine',
  'chloroquine', 'quinine', 'sulphadoxine', 'pyrimethamine', 'mefloquine',
  'diclofenac', 'aspirin', 'acetylsalicylic acid', 'naproxen', 'celecoxib',
  'omeprazole', 'esomeprazole', 'lansoprazole', 'pantoprazole',
  'ranitidine', 'cimetidine', 'misoprostol', 'aluminium hydroxide',
  'magnesium trisilicate', 'dimethicone', 'simethicone',
  'metformin', 'glibenclamide', 'glyburide', 'glipizide', 'gliclazide',
  'insulin', 'pioglitazone', 'rosiglitazone',
  'amlodipine', 'nifedipine', 'lisinopril', 'enalapril', 'captopril',
  'losartan', 'valsartan', 'telmisartan', 'atenolol', 'propranolol',
  'hydrochlorothiazide', 'furosemide', 'spironolactone',
  'atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin',
  'salbutamol', 'aminophylline', 'theophylline', 'prednisolone',
  'dexamethasone', 'hydrocortisone', 'betamethasone',
  'chlorpheniramine', 'loratadine', 'cetirizine', 'fexofenadine',
  'promethazine', 'diphenhydramine', 'phenylephrine',
  'vitamin c', 'ascorbic acid', 'vitamin b', 'vitamin b complex',
  'multivitamin', 'ferrous sulphate', 'ferrous gluconate', 'folic acid',
  'zinc', 'zinc sulphate', 'calcium', 'magnesium', 'potassium',
  'clotrimazole', 'miconazole', 'ketoconazole', 'fluconazole',
  'mebendazole', 'albendazole', 'ivermectin', 'praziquantel',
  'cotrimoxazole', 'trimethoprim', 'sulfamethoxazole',
  'ceftriaxone', 'cefuroxime', 'cefixime', 'cephalexin', 'cefpodoxime',
  'erythromycin', 'azithromycin', 'clarithromycin', 'doxycycline',
  'tetracycline', 'gentamicin', 'streptomycin',
  'tramadol', 'codeine', 'morphine', 'pentazocine',
  'diazepam', 'lorazepam', 'bromazepam',
  'carbamazepine', 'phenytoin', 'valproic acid', 'sodium valproate',
  'haloperidol', 'chlorpromazine', 'amitriptyline', 'fluoxetine',
  'sertraline', 'citalopram',
  'warfarin', 'clopidogrel', 'aspirin', 'heparin', 'enoxaparin',
  'nystatin', 'acyclovir', 'ganciclovir',
  'levonorgestrel', 'ethinylestradiol', 'norethisterone', 'medroxyprogesterone',
  'ORS', 'oral rehydration', 'glucose',
  'blood tonic', 'hemoglobin',
]);

// ---- Main API ------------------------------------------------------------

/**
 * Parse a single product name string into structured attributes.
 * Returns null fields where nothing could be determined.
 *
 * @param {string|null} rawName - The product name from the upload
 * @returns {{
 *   brand: string|null,
 *   generic: string|null,
 *   strength: string|null,
 *   form: string|null,
 *   pack_size: string|null,
 *   confidence: number
 * }}
 */
function parseDrugName(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { brand: null, generic: null, strength: null, form: null, pack_size: null, confidence: 0 };
  }

  const original = rawName.trim();
  if (!original) {
    return { brand: null, generic: null, strength: null, form: null, pack_size: null, confidence: 0 };
  }

  let name = original;

  // Step 1: Extract dosage form
  const { form, remaining: afterForm } = extractForm(name);

  // Step 2: Extract strength
  const { strength, remaining: afterStrength } = extractStrength(afterForm);

  // Step 3: Extract pack size
  const { packSize, remaining: afterPack } = extractPackSize(afterStrength);

  // Step 4: Extract generic name
  const { generic, remaining: afterGeneric } = extractGeneric(afterPack);

  // Step 5: Remaining tokens = brand name
  const brand = extractBrand(afterGeneric, original);

  // Step 6: Confidence scoring
  const fieldsFound = [brand, generic, strength, form].filter(Boolean).length;
  const confidence = Math.min(0.95, 0.3 + (fieldsFound * 0.15));

  return {
    brand,
    generic,
    strength,
    form,
    pack_size: packSize,
    confidence,
  };
}

// ---- Internal extraction functions ---------------------------------------

function extractForm(name) {
  // Try each form pattern, preferring longer matches
  let best = null;
  let bestPriority = -1;

  for (let i = 0; i < FORM_PATTERNS.length; i++) {
    const { regex } = FORM_PATTERNS[i];
    const match = name.match(regex);
    if (match) {
      // Prefer earlier patterns (more specific)
      if (bestPriority < 0 || i < bestPriority) {
        best = FORM_PATTERNS[i];
        bestPriority = i;
      }
    }
  }

  if (best) {
    const remaining = name.replace(best.regex, ' ').replace(/\s+/g, ' ').trim();
    return { form: best.form, remaining };
  }

  return { form: null, remaining: name };
}

function extractStrength(name) {
  for (const { regex, type } of STRENGTH_PATTERNS) {
    const match = name.match(regex);
    if (match) {
      if (type === 'compound') {
        // "80mg/480mg" → "80mg/480mg"
        const strength = match[0];
        const remaining = name.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
        return { strength, remaining };
      }
      if (type === 'standard') {
        // "500mg", "10mg/ml", "50mcg"
        const strength = match[0];
        const remaining = name.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
        return { strength, remaining };
      }
      if (type === 'bare_number') {
        // Less confident — only extract if it looks like a standalone strength
        // (not a product code or year)
        const num = parseInt(match[1], 10);
        if (num >= 10 && num <= 1000) {
          const strength = match[0] + 'mg'; // assume mg
          const remaining = name.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
          return { strength, remaining };
        }
      }
    }
  }
  return { strength: null, remaining: name };
}

function extractPackSize(name) {
  for (const { regex, unit } of PACK_SIZE_PATTERNS) {
    const match = name.match(regex);
    if (match) {
      const remaining = name.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 1000) {
        return { packSize: match[0], remaining };
      }
    }
  }
  return { packSize: null, remaining: name };
}

function extractGeneric(name) {
  if (!name) return { generic: null, remaining: name };

  const tokens = name.split(/\s+/);
  const lowerTokens = tokens.map(t => t.toLowerCase().replace(/[,.;:]$/, ''));

  // Find longest generic match first
  let bestMatch = null;
  let bestLength = 0;
  let bestIndex = -1;

  for (let i = 0; i < lowerTokens.length; i++) {
    // Try single token
    if (KNOWN_GENERICS.has(lowerTokens[i]) && lowerTokens[i].length > bestLength) {
      bestMatch = lowerTokens[i];
      bestLength = lowerTokens[i].length;
      bestIndex = i;
    }
    // Try two tokens (e.g. "vitamin c", "blood tonic", "ferrous sulphate")
    if (i < lowerTokens.length - 1) {
      const two = `${lowerTokens[i]} ${lowerTokens[i + 1]}`;
      if (KNOWN_GENERICS.has(two) && two.length > bestLength) {
        bestMatch = two;
        bestLength = two.length;
        bestIndex = i;
      }
    }
    // Try three tokens (e.g. "aluminium hydroxide gel")
    if (i < lowerTokens.length - 2) {
      const three = `${lowerTokens[i]} ${lowerTokens[i + 1]} ${lowerTokens[i + 2]}`;
      if (KNOWN_GENERICS.has(three) && three.length > bestLength) {
        bestMatch = three;
        bestLength = three.length;
        bestIndex = i;
      }
    }
  }

  if (bestMatch) {
    // Capitalize first letter of each word
    const generic = bestMatch.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    // Remove matched tokens from remaining
    const span = bestMatch.split(' ').length;
    const remaining = [...tokens.slice(0, bestIndex), ...tokens.slice(bestIndex + span)].join(' ').trim();
    return { generic, remaining };
  }

  return { generic: null, remaining: name };
}

function extractBrand(remaining, original) {
  // If nothing left after extraction, try to infer from original
  const cleaned = (remaining || '').replace(/[^a-zA-Z0-9\s\-+./()]/g, '').trim();

  // Special case: combination drugs with + (e.g. "Artemether + Lumefantrine")
  // The "+" indicates this is a combined generic description, not a brand
  if (cleaned.includes('+') && !/[A-Z][a-z]+/.test(cleaned)) {
    return null;
  }

  // If remaining looks like a brand name (starts with uppercase, not just numbers)
  if (cleaned && /[A-Za-z]/.test(cleaned) && cleaned.length > 1) {
    return cleaned;
  }

  // If nothing specific extracted, the whole original might be a brand
  if (!cleaned && /[A-Za-z]/.test(original) && original.length > 2) {
    return original;
  }

  return null;
}

// ---- Multi-product parsing -----------------------------------------------

/**
 * Parse a product name and return enriched attributes that can feed
 * into the identity resolver. The parsed fields supplement any
 * separately-columned fields already in the data.
 */
function enrichWithParser(row, productKey, brandKey, genericKey) {
  const productName = row[productKey];
  if (!productName) return {};

  const parsed = parseDrugName(productName);

  return {
    _parsed_generic: parsed.generic || null,
    _parsed_brand: parsed.brand || null,
    _parsed_strength: parsed.strength || null,
    _parsed_form: parsed.form || null,
    _parsed_pack_size: parsed.pack_size || null,
    _parsed_confidence: parsed.confidence,
  };
}

module.exports = {
  parseDrugName,
  enrichWithParser,
  KNOWN_GENERICS,
};
