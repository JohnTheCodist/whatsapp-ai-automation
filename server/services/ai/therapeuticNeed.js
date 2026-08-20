/**
 * Everyday words -> NAFDAC's controlled therapeutic subgroup vocabulary.
 *
 * WHY THIS EXISTS ALONGSIDE needVocabulary
 * needVocabulary translates a customer's word into the words a PHARMACY'S OWN
 * catalogue might use ("painkiller" -> "analgesic"), and browse_category
 * matches those against category/name/generic_name with ILIKE. That works
 * only when the shelf happens to be labelled with a word close to what the
 * customer said.
 *
 * It misses the case that matters most for chronic medicines: a customer asks
 * for "blood pressure medicine" and the catalogue holds "Amlodipine 10mg"
 * with category "Cardio" or nothing at all. No string in that row resembles
 * "blood pressure". NAFDAC knows Amlodipine's therapeutic subgroup is
 * Hypertension, so resolving the PRODUCT through NAFDAC and matching on the
 * subgroup finds it where text matching cannot.
 *
 * THE VALUES HERE ARE NOT FREE TEXT
 * Every target below is a literal therapeutic_subgroup string from the NAFDAC
 * dataset. That is what makes this a controlled vocabulary rather than a
 * second pile of guesses: a typo produces zero matches instead of a
 * plausible-looking wrong shelf. SUBGROUPS below is the full permitted set,
 * and isKnownSubgroup() exists so a caller can assert against it.
 *
 * WHERE THE LINE IS — THE SAME LINE needVocabulary DREW
 * These map a REQUEST FOR A KIND OF MEDICINE onto the shelf that holds it.
 * That is catalogue navigation: "antimalarial" and "Anti-Malarial" are two
 * spellings of one shelf.
 *
 * Deliberately absent: any SYMPTOM -> TREATMENT inference. "fever" is not
 * here, even though it would make malaria searches hit far more often,
 * because deciding a fever means malaria is a diagnosis — the one inference
 * this system exists never to make. A customer describing symptoms is
 * screened by clinicalFilter before any of this runs and goes to a
 * pharmacist, which is the correct destination and not a failure of this map.
 *
 * The symptom-adjacent words that ARE here (cough, rash, itching) are exactly
 * the ones needVocabulary already accepted, kept identical on purpose: this
 * module widens which PRODUCTS can be found, never which QUESTIONS may be
 * answered without a pharmacist.
 *
 * Pure. No database, no network.
 */

/**
 * The complete controlled vocabulary, verbatim from the NAFDAC dataset's
 * therapeutic_subgroup column. Listed in full — including subgroups nothing
 * below maps to — so that this file states the whole permitted set rather
 * than only the part currently reachable.
 */
const SUBGROUPS = Object.freeze([
  'Other',
  'Analgesic',
  'Antibiotic',
  'Corticosteroid',
  'Anti-Malarial',
  'Vitamin / Mineral',
  'Antifungal',
  'IV Drug',
  'Antiretroviral (ARV)',
  'CNS Agent',
  'Antihistamine / Anti-Allergy',
  'Anthelmintic',
  'GI Agent',
  'Antiviral',
  'Topical Retinoid / Skin Agent',
  'Asthma / COPD Agent',
  'Hypertension',
  'Anticancer',
  'Lipid-Lowering',
  'Diabetes',
  'Oral Rehydration Therapy',
  'PDE5 Inhibitor',
  'Local Anesthetic',
  'Anti-Tuberculosis',
  'Antiplatelet',
  'Anti-Gout',
  'Enzyme Anti-inflammatory',
  'Antiglaucoma Agent',
  'Antidepressants',
  'Topical Anti-Infective',
  'Mucolytic',
  'Antiparkinson Agent',
  'Contraceptive',
  'Uterotonic',
  'Topical Antiseptic',
  'Laxative',
  'BPH Agent',
  'Hormonal Agent',
  'Hemostatic Agent',
]);

const SUBGROUP_SET = new Set(SUBGROUPS.map((s) => s.toLowerCase()));

/**
 * Request phrasing -> subgroup.
 *
 * `terms` are matched against the customer's words in BOTH directions, so
 * "something for pain" finds "pain" and "painkillers" finds "painkiller".
 *
 * Several entries may point at one subgroup — that is the point of a table
 * rather than a pair of enums. Nothing points at two subgroups: a request
 * that genuinely implied two would be a request this map should not be
 * resolving on its own.
 */
const NEED_SUBGROUP = Object.freeze([
  { terms: ['pain', 'painkiller', 'pain killer', 'pain relief', 'ache', 'aches', 'headache', 'analgesic', 'body pain'],
    subgroup: 'Analgesic' },
  { terms: ['antibiotic', 'antibiotics', 'infection', 'bacteria', 'bacterial'],
    subgroup: 'Antibiotic' },
  { terms: ['malaria', 'antimalarial', 'anti malaria', 'anti-malaria', 'antimalaria'],
    subgroup: 'Anti-Malarial' },
  { terms: ['vitamin', 'vitamins', 'supplement', 'supplements', 'multivitamin', 'immunity', 'mineral'],
    subgroup: 'Vitamin / Mineral' },
  { terms: ['fungal', 'antifungal', 'fungus', 'ringworm', 'athlete foot', "athlete's foot"],
    subgroup: 'Antifungal' },
  // rash / itching kept because needVocabulary already accepted them.
  { terms: ['allergy', 'allergies', 'antihistamine', 'rash', 'itching', 'hay fever'],
    subgroup: 'Antihistamine / Anti-Allergy' },
  { terms: ['worm', 'worms', 'deworm', 'dewormer', 'deworming', 'anthelmintic'],
    subgroup: 'Anthelmintic' },
  { terms: ['asthma', 'inhaler', 'copd', 'wheezing'],
    subgroup: 'Asthma / COPD Agent' },
  { terms: ['blood pressure', 'bp', 'hypertension', 'high blood pressure', 'antihypertensive', 'hypertensive'],
    subgroup: 'Hypertension' },
  { terms: ['diabetes', 'diabetic', 'blood sugar', 'sugar level', 'antidiabetic'],
    subgroup: 'Diabetes' },
  { terms: ['cholesterol', 'lipid', 'statin', 'lipid lowering'],
    subgroup: 'Lipid-Lowering' },
  { terms: ['ors', 'oral rehydration', 'rehydration', 'dehydration'],
    subgroup: 'Oral Rehydration Therapy' },
  { terms: ['antacid', 'ulcer', 'heartburn', 'indigestion', 'stomach acid', 'gastric'],
    subgroup: 'GI Agent' },
  // "cough" is here because needVocabulary already accepted it and "cough
  // syrup" is a product request. It maps to the shelf, never to a cause.
  { terms: ['cough', 'catarrh', 'mucus', 'phlegm', 'expectorant', 'mucolytic'],
    subgroup: 'Mucolytic' },
  { terms: ['contraceptive', 'contraception', 'family planning', 'birth control', 'condom', 'condoms'],
    subgroup: 'Contraceptive' },
  { terms: ['laxative', 'constipation', 'purgative'],
    subgroup: 'Laxative' },
  { terms: ['antiseptic', 'disinfectant', 'wound care'],
    subgroup: 'Topical Antiseptic' },
  { terms: ['steroid', 'corticosteroid', 'hydrocortisone'],
    subgroup: 'Corticosteroid' },
  { terms: ['hiv', 'arv', 'antiretroviral'],
    subgroup: 'Antiretroviral (ARV)' },
  { terms: ['tuberculosis', 'tb drugs', 'anti-tuberculosis'],
    subgroup: 'Anti-Tuberculosis' },
  { terms: ['gout', 'uric acid'],
    subgroup: 'Anti-Gout' },
  { terms: ['depression', 'antidepressant', 'antidepressants'],
    subgroup: 'Antidepressants' },
  { terms: ['glaucoma', 'eye pressure'],
    subgroup: 'Antiglaucoma Agent' },
  { terms: ['antiviral', 'herpes'],
    subgroup: 'Antiviral' },
  { terms: ['blood thinner', 'antiplatelet', 'aspirin therapy'],
    subgroup: 'Antiplatelet' },
  { terms: ['prostate', 'bph'],
    subgroup: 'BPH Agent' },
  { terms: ['erectile', 'ed drugs', 'pde5'],
    subgroup: 'PDE5 Inhibitor' },
]);

/**
 * Phrasing this map REFUSES to answer, whatever else it contains.
 *
 * MEASURED, NOT ASSUMED
 * "chest pain" contains the word "pain", so a plain synonym lookup returns
 * Analgesic and the assistant offers painkillers for what may be a cardiac
 * event. That is not hypothetical: clinicalFilter.screenMessage ALLOWS
 * "chest pain" today (it blocks "i have fever" and "my child is vomiting",
 * but not this), so nothing upstream would have stopped it. Verified by
 * running the filter directly before writing this.
 *
 * So this module does not rely on being called only in safe situations. Two
 * kinds of refusal, both narrow on purpose:
 *
 *   RED_FLAG_PHRASES  — emergency-adjacent complaints that must never resolve
 *                       to a shelf, no matter how the sentence is built.
 *   SYMPTOM_STATEMENT — "I have...", "I feel...", i.e. someone DESCRIBING
 *                       their condition rather than naming a product.
 *
 * Kept deliberately short. Over-blocking would recreate the rigidity this
 * feature exists to remove — "do you have painkillers" and "something for
 * back pain" are ordinary retail requests and must keep working. The line is
 * emergency signals and symptom narration, not the word "pain".
 */
const RED_FLAG_PHRASES = Object.freeze([
  'chest pain', 'chest tightness', 'tight chest', 'pain in my chest',
  'difficulty breathing', 'trouble breathing', 'cannot breathe', "can't breathe",
  'shortness of breath', 'short of breath', 'gasping',
  'bleeding', 'blood in', 'coughing blood', 'vomiting blood',
  'unconscious', 'fainted', 'fainting', 'passed out', 'collapsed',
  'seizure', 'convulsion', 'convulsing', 'fitting',
  'severe abdominal pain', 'severe stomach pain',
  'slurred speech', 'numbness on one side', 'stroke',
  'overdose', 'poisoned', 'poisoning', 'swallowed',
  'suicidal', 'kill myself',
]);

/**
 * Someone narrating a condition, not naming a product. Anchored at the start
 * of a clause so "do you have paracetamol" is untouched while "i have a
 * terrible headache" is refused.
 */
const SYMPTOM_STATEMENT = /(^|[.,;!?]\s*)(i|we|my (child|son|daughter|wife|husband|mother|father|baby))\s+(have|has|had|am|is|are|feel|felt|been|keep|dey)\b/i;

/**
 * True when this request must NOT be resolved to a therapeutic shelf.
 *
 * Exported so a caller can distinguish "no opinion" (subgroupsFor returned
 * []) from "deliberately refused" — those mean different things and should
 * not produce the same reply.
 */
function isRefusedNeed(need) {
  const q = String(need || '').toLowerCase().trim();
  if (!q) return false;
  if (RED_FLAG_PHRASES.some((p) => q.includes(p))) return true;
  return SYMPTOM_STATEMENT.test(q);
}

function isKnownSubgroup(value) {
  return SUBGROUP_SET.has(String(value || '').trim().toLowerCase());
}

/**
 * Does the customer's text contain this term as a WHOLE word?
 *
 * Word-boundary, not substring, and one-directional. A plain two-way
 * substring test looked equivalent and was not: "bp" is a substring of the
 * term "bph", so asking for "bp" returned both Hypertension AND BPH Agent —
 * blood-pressure medicine and prostate medicine on the same shelf, from two
 * characters. Every short abbreviation a pharmacy customer actually uses has
 * that hazard.
 *
 * A trailing "s" is allowed so "painkillers" matches the term "painkiller"
 * without needing every plural spelled out in the table.
 */
function matchesTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}s?([^a-z0-9]|$)`, 'i').test(text);
}

/**
 * The therapeutic subgroups a customer's words point at.
 *
 * Returns [] when nothing matches — an honest "this map has no opinion",
 * which the caller must treat as "fall back to text search", never as
 * "nothing is available".
 *
 * @param {string} need  the customer's own words
 * @returns {string[]} controlled subgroup values, never free text
 */
function subgroupsFor(need) {
  const q = String(need || '').toLowerCase().trim();
  if (!q) return [];

  const out = [];

  // A customer who names the subgroup itself ("anthelmintic", "lipid-lowering")
  // should match without needing a synonym row for it.
  for (const s of SUBGROUPS) {
    const key = s.toLowerCase();
    // 'Other' is a real NAFDAC value but means "unclassified" — matching it
    // from the word "other" would return an unrelated grab bag.
    if (key === 'other') continue;
    if (q.includes(key) && !out.includes(s)) out.push(s);
  }

  for (const entry of NEED_SUBGROUP) {
    if (entry.terms.some((t) => matchesTerm(q, t)) && !out.includes(entry.subgroup)) {
      out.push(entry.subgroup);
    }
  }

  return out;
}

module.exports = {
  subgroupsFor, isRefusedNeed, isKnownSubgroup,
  SUBGROUPS, NEED_SUBGROUP, RED_FLAG_PHRASES,
};
