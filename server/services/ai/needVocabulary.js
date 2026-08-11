/**
 * Everyday words -> the category words a catalogue actually uses.
 *
 * WHY THIS IS NEEDED
 * browse_category matched "malaria" fine and returned nothing for "pain",
 * because the catalogue says "Analgesic". Customers do not say analgesic.
 * Without this the feature works for the categories whose clinical name
 * happens to be the common one, and silently fails for the rest — which
 * looks like an empty shop rather than a vocabulary gap.
 *
 * WHERE THE LINE IS, AND WHY IT MATTERS
 * These are DICTIONARY facts, not clinical ones. "Painkiller" and
 * "analgesic" are two words for the same shelf. That is translation.
 *
 * Deliberately absent: anything that maps a SYMPTOM to a TREATMENT.
 * "fever" is not in here, though it would make malaria searches match more
 * often, because deciding that a fever means malaria is a diagnosis — the
 * exact inference this system is built never to make. A customer saying
 * "fever" gets the pharmacist, not a shelf.
 *
 * Pure, and matched against the pharmacy's REAL categories rather than a
 * fixed list, because every catalogue names its shelves differently.
 */

const SYNONYMS = [
  // pain
  { terms: ['pain', 'painkiller', 'pain killer', 'ache', 'aches', 'headache', 'body pain', 'analgesic'],
    categories: ['analgesic', 'painkiller', 'pain'] },
  // infection
  { terms: ['infection', 'antibiotic', 'antibiotics', 'bacteria'],
    categories: ['antibiotic', 'anti-infective'] },
  // malaria
  { terms: ['malaria', 'antimalarial', 'anti malaria', 'anti-malaria'],
    categories: ['antimalarial', 'malaria'] },
  // cold and cough
  { terms: ['cough', 'cold', 'catarrh', 'flu', 'sore throat', 'blocked nose'],
    categories: ['cold & flu', 'cold and flu', 'cough', 'respiratory'] },
  // supplements
  { terms: ['vitamin', 'vitamins', 'supplement', 'supplements', 'immunity', 'multivitamin'],
    categories: ['supplement', 'vitamin', 'nutrition'] },
  // allergy
  { terms: ['allergy', 'allergies', 'rash', 'itching', 'antihistamine'],
    categories: ['antihistamine', 'allergy'] },
  // chronic
  { terms: ['diabetes', 'diabetic', 'sugar', 'blood sugar'],
    categories: ['antidiabetic', 'diabetes'] },
  { terms: ['blood pressure', 'bp', 'hypertension', 'high blood pressure'],
    categories: ['antihypertensive', 'hypertension', 'blood pressure'] },
  // gut
  { terms: ['diarrhoea', 'diarrhea', 'running stomach', 'dehydration', 'ors'],
    categories: ['rehydration', 'antidiarrhoeal', 'gastrointestinal'] },
  // skin
  { terms: ['cream', 'ointment', 'skin'],
    categories: ['topical', 'dermatological', 'skin'] },
  // family planning
  { terms: ['family planning', 'contraceptive', 'contraception', 'condom', 'condoms'],
    categories: ['family planning', 'contraceptive'] },
];

/**
 * Category terms worth searching for a customer's word.
 *
 * Always includes the original: a customer who says "antimalarial" should
 * match a catalogue that also says antimalarial, without needing the map.
 *
 * @param {string} need
 * @returns {string[]} lowercase terms, most specific first
 */
function categoriesFor(need) {
  const q = String(need || '').toLowerCase().trim();
  if (!q) return [];

  const out = [q];
  for (const entry of SYNONYMS) {
    // Substring both ways, so "something for pain" matches "pain" and
    // "painkiller" matches "pain".
    const hit = entry.terms.some((t) => q.includes(t) || t.includes(q));
    if (hit) {
      for (const c of entry.categories) if (!out.includes(c)) out.push(c);
    }
  }
  return out;
}

module.exports = { categoriesFor, SYNONYMS };
