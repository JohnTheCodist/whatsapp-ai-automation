/**
 * Drug Classifier — maps pharmacy product names to NAFDAC therapeutic subgroups.
 * Used when the dataset has no explicit Category/Therapeutic_Subgroup column.
 *
 * Over 120 common Nigerian pharmacy drugs mapped to 18 therapeutic categories.
 */

const THERAPEUTIC = {
  // Analgesics & Anti-inflammatories
  paracetamol: 'Analgesics', ibuprofen: 'Analgesics', diclofenac: 'Analgesics',
  naproxen: 'Analgesics', tramadol: 'Analgesics', aspirin: 'Analgesics',
  piroxicam: 'Analgesics', celecoxib: 'Analgesics', indomethacin: 'Analgesics',
  meloxicam: 'Analgesics', 'mefenamic acid': 'Analgesics', pentazocine: 'Analgesics',

  // Antibiotics
  amoxicillin: 'Antibiotics', ampicillin: 'Antibiotics', ciprofloxacin: 'Antibiotics',
  metronidazole: 'Antibiotics', doxycycline: 'Antibiotics', tetracycline: 'Antibiotics',
  erythromycin: 'Antibiotics', azithromycin: 'Antibiotics', cephalexin: 'Antibiotics',
  ceftriaxone: 'Antibiotics', gentamicin: 'Antibiotics', cloxacillin: 'Antibiotics',
  'co-trimoxazole': 'Antibiotics', levofloxacin: 'Antibiotics', ofloxacin: 'Antibiotics',
  nitrofurantoin: 'Antibiotics', cefuroxime: 'Antibiotics', cefixime: 'Antibiotics',
  clarithromycin: 'Antibiotics', clindamycin: 'Antibiotics',
  'amoxicillin-clavulanic': 'Antibiotics', augmentin: 'Antibiotics', flagyl: 'Antibiotics',

  // Antimalarials
  artemether: 'Antimalarials', artesunate: 'Antimalarials', lumefantrine: 'Antimalarials',
  quinine: 'Antimalarials', chloroquine: 'Antimalarials', amodiaquine: 'Antimalarials',
  dihydroartemisinin: 'Antimalarials', primaquine: 'Antimalarials', mefloquine: 'Antimalarials',
  lonart: 'Antimalarials', coartem: 'Antimalarials', 'p-alaxin': 'Antimalarials',

  // Antihypertensives
  amlodipine: 'Antihypertensives', lisinopril: 'Antihypertensives', losartan: 'Antihypertensives',
  nifedipine: 'Antihypertensives', atenolol: 'Antihypertensives',
  hydrochlorothiazide: 'Antihypertensives', enalapril: 'Antihypertensives',
  ramipril: 'Antihypertensives', valsartan: 'Antihypertensives', telmisartan: 'Antihypertensives',
  methyldopa: 'Antihypertensives', propranolol: 'Antihypertensives',
  carvedilol: 'Antihypertensives', furosemide: 'Antihypertensives',
  amiloride: 'Antihypertensives', spironolactone: 'Antihypertensives',

  // Antidiabetics
  metformin: 'Antidiabetics', glibenclamide: 'Antidiabetics', gliclazide: 'Antidiabetics',
  insulin: 'Antidiabetics', glimepiride: 'Antidiabetics',
  'glibenclamide-metformin': 'Antidiabetics', pioglitazone: 'Antidiabetics',

  // GI & Antacids
  omeprazole: 'GI & Antacids', pantoprazole: 'GI & Antacids', lansoprazole: 'GI & Antacids',
  esomeprazole: 'GI & Antacids', ranitidine: 'GI & Antacids', cimetidine: 'GI & Antacids',
  misoprostol: 'GI & Antacids', domperidone: 'GI & Antacids',
  metoclopramide: 'GI & Antacids', dicyclomine: 'GI & Antacids', hyoscine: 'GI & Antacids',
  'aluminium hydroxide': 'GI & Antacids', 'magnesium trisilicate': 'GI & Antacids',
  gestid: 'GI & Antacids', gaviscon: 'GI & Antacids',

  // Vitamins & Supplements
  'vitamin c': 'Vitamins & Supplements', 'vitamin b': 'Vitamins & Supplements',
  multivitamin: 'Vitamins & Supplements', 'folic acid': 'Vitamins & Supplements',
  'ferrous sulphate': 'Vitamins & Supplements', 'ferrous gluconate': 'Vitamins & Supplements',
  zinc: 'Vitamins & Supplements', calcium: 'Vitamins & Supplements',
  'vitamin d': 'Vitamins & Supplements', 'vitamin e': 'Vitamins & Supplements',
  haematinic: 'Vitamins & Supplements', 'ascorbic acid': 'Vitamins & Supplements',
  'b-complex': 'Vitamins & Supplements', 'b complex': 'Vitamins & Supplements',

  // Antihistamines
  loratadine: 'Antihistamines', cetirizine: 'Antihistamines', chlorpheniramine: 'Antihistamines',
  promethazine: 'Antihistamines', fexofenadine: 'Antihistamines',
  levocetirizine: 'Antihistamines', cyproheptadine: 'Antihistamines',

  // Antifungals
  clotrimazole: 'Antifungals', fluconazole: 'Antifungals', ketoconazole: 'Antifungals',
  miconazole: 'Antifungals', nystatin: 'Antifungals', griseofulvin: 'Antifungals',
  itraconazole: 'Antifungals', terbinafine: 'Antifungals',

  // Antihelmintics
  albendazole: 'Antihelmintics', mebendazole: 'Antihelmintics', levamisole: 'Antihelmintics',
  praziquantel: 'Antihelmintics', ivermectin: 'Antihelmintics', piperazine: 'Antihelmintics',

  // Cough & Cold
  ambroxol: 'Cough & Cold', guaifenesin: 'Cough & Cold', dextromethorphan: 'Cough & Cold',
  diphenhydramine: 'Cough & Cold', bromhexine: 'Cough & Cold', pholcodine: 'Cough & Cold',
  menthol: 'Cough & Cold', ephedrine: 'Cough & Cold', pseudoephedrine: 'Cough & Cold',

  // Antiasthmatics
  salbutamol: 'Antiasthmatics', aminophylline: 'Antiasthmatics',
  beclomethasone: 'Antiasthmatics', budesonide: 'Antiasthmatics',
  montelukast: 'Antiasthmatics', ipratropium: 'Antiasthmatics',

  // Steroids
  prednisolone: 'Steroids', dexamethasone: 'Steroids', hydrocortisone: 'Steroids',
  betamethasone: 'Steroids', triamcinolone: 'Steroids', methylprednisolone: 'Steroids',

  // ORS & IV Fluids
  'oral rehydration salts': 'ORS & Electrolytes', ors: 'ORS & Electrolytes',
  drip: 'IV Fluids', 'normal saline': 'IV Fluids', dextrose: 'IV Fluids',
  'ringers lactate': 'IV Fluids',

  // Eye/Ear preparations (prefixed to avoid collision with systemic forms)
  'chloramphenicol eye': 'Eye/Ear', 'gentamicin eye': 'Eye/Ear',
  'betamethasone eye': 'Eye/Ear', timolol: 'Eye/Ear', pilocarpine: 'Eye/Ear',
  'ciprofloxacin eye': 'Eye/Ear', 'ear drops': 'Eye/Ear', 'eye drops': 'Eye/Ear',

  // Dermatologicals
  'calamine lotion': 'Dermatologicals', 'zinc oxide': 'Dermatologicals',
  'benzyl benzoate': 'Dermatologicals', 'sulphur ointment': 'Dermatologicals',
  'silver sulphadiazine': 'Dermatologicals', 'salicylic acid': 'Dermatologicals',

  // Anticonvulsants
  carbamazepine: 'Anticonvulsants', phenytoin: 'Anticonvulsants',
  phenobarbitone: 'Anticonvulsants', 'valproic acid': 'Anticonvulsants',
  gabapentin: 'Anticonvulsants',

  // CNS & Sedatives
  diazepam: 'CNS & Sedatives', clonazepam: 'CNS & Sedatives', lorazepam: 'CNS & Sedatives',
  haloperidol: 'CNS & Sedatives', amitriptyline: 'CNS & Sedatives',
  fluoxetine: 'CNS & Sedatives',

  // Anticoagulants
  warfarin: 'Anticoagulants', heparin: 'Anticoagulants', enoxaparin: 'Anticoagulants',
  clopidogrel: 'Anticoagulants',

  // Vaccines
  vaccine: 'Vaccines', tetanus: 'Vaccines', hepatitis: 'Vaccines',

  // Obstetrics
  oxytocin: 'Obstetrics', ergometrine: 'Obstetrics',

  // Emergency & Anaesthetics
  atropine: 'Emergency', adrenaline: 'Emergency', lidocaine: 'Anaesthetics',
  thiopentone: 'Anaesthetics', ketamine: 'Anaesthetics',
};

/**
 * Classify a product name into a therapeutic category.
 * Returns 'Unclassified' if no match found.
 */
function classifyDrug(name) {
  if (!name) return 'Unclassified';
  const n = String(name).toLowerCase().trim();
  if (THERAPEUTIC[n]) return THERAPEUTIC[n];
  for (const [drug, category] of Object.entries(THERAPEUTIC)) {
    if (n.includes(drug)) return category;
  }
  return 'Unclassified';
}

/**
 * Detect if a category-like column exists in the record fields.
 */
function detectCategoryField(records) {
  const sample = records[0] || {};
  return Object.keys(sample).find(k =>
    /^(category|class|group|therapeutic|subgroup)$/i.test(k)
  ) || null;
}

module.exports = { classifyDrug, detectCategoryField, THERAPEUTIC };
