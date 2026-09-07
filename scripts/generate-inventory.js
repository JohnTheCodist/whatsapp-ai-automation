#!/usr/bin/env node
/**
 * Synthetic Nigerian pharmacy inventory — a catalogue file to develop against.
 *
 * WHY THIS EXISTS
 * server/data/pharma_nafdac_dataset.csv is a *registration* dictionary: what
 * NAFDAC has approved. It has no prices, no stock, no expiry and no batch —
 * so it cannot exercise the thing this codebase actually does, which is take
 * a shop's own spreadsheet and turn it into sellable products. Testing that
 * path needs a file shaped like what an owner uploads, and the repo has none.
 *
 * WHY IT IS SEEDED
 * `--seed` makes every run byte-identical. A fixture that shifts under you
 * turns "the importer regressed" and "the generator rolled different dice"
 * into the same symptom, and you find out which one only after an hour.
 *
 * TWO SHAPES, ONE CATALOGUE
 *   default   canonical headers, clean values — the happy path.
 *   --messy   the same products as a real shop exports them: naira signs,
 *             thousands separators, uppercased run-on names, blank prices,
 *             four date formats in one column, the same drug spelled twice.
 *             That is the input catalogueMapping and dataCleaner were written
 *             for, and the only kind that proves they work.
 *
 * PRICES ARE PLAUSIBLE, NOT QUOTED
 * The bands below are order-of-magnitude realistic for a Lagos retail shelf,
 * in naira, per pack as described. They are invented. Nothing here should be
 * shown to a customer or used to check a real margin.
 *
 *   node scripts/generate-inventory.js --out inventory.csv
 *   node scripts/generate-inventory.js --messy --rows 300 --seed 7
 */

const fs = require('fs');

// =========================================================================
// The shelf
// =========================================================================

// [name, generic, form, strength, pack, category, manufacturer, costLo, costHi, movement]
//
// `movement` sets the stock band, because a pharmacy does not hold the same
// depth of everything: paracetamol moves by the carton, a BP monitor sits
// there for a month. Flattening that would produce a file where nothing is
// ever near its reorder level, which is exactly the state worth testing.
const CATALOGUE = [
  // ---- Antimalarials ----
  ['Lonart DS', 'Artemether/Lumefantrine', 'Tablet', '80/480mg', 'x6', 'Antimalarial', 'Greenlife Pharmaceuticals', 2600, 3200, 'fast'],
  ['Coartem', 'Artemether/Lumefantrine', 'Tablet', '20/120mg', 'x24', 'Antimalarial', 'Novartis', 2400, 3000, 'fast'],
  ['Amatem Softgel', 'Artemether/Lumefantrine', 'Softgel Capsule', '80/480mg', 'x6', 'Antimalarial', 'Ajanta Pharma', 2200, 2800, 'fast'],
  ['P-Alaxin', 'Dihydroartemisinin/Piperaquine', 'Tablet', '40/320mg', 'x6', 'Antimalarial', 'Bliss GVS Pharma', 2000, 2600, 'fast'],
  ['Camosunate', 'Artesunate/Amodiaquine', 'Suspension', '50/150mg', '60ml', 'Antimalarial', 'Dafra Pharma', 1800, 2400, 'mid'],
  ['Fansidar', 'Sulfadoxine/Pyrimethamine', 'Tablet', '500/25mg', 'x3', 'Antimalarial', 'Roche', 600, 900, 'mid'],
  ['Artesunate Injection', 'Artesunate', 'Injection', '60mg', 'x1 vial', 'Antimalarial', 'Guilin Pharmaceutical', 1200, 1800, 'mid'],
  ['SD Bioline Malaria Rapid Test', 'Malaria RDT', 'Test Kit', null, 'x1', 'Diagnostic', 'Abbott', 700, 1000, 'fast'],
  ['Quinine Sulphate', 'Quinine', 'Tablet', '300mg', 'x30', 'Antimalarial', 'Juhel Nigeria', 900, 1400, 'slow'],

  // ---- Analgesics & antipyretics ----
  ['Emzor Paracetamol', 'Paracetamol', 'Tablet', '500mg', 'x100', 'Analgesic', 'Emzor Pharmaceutical', 1800, 2400, 'fast'],
  ['Panadol Extra', 'Paracetamol/Caffeine', 'Tablet', '500/65mg', 'x24', 'Analgesic', 'Haleon', 1300, 1700, 'fast'],
  ['Emzor Paracetamol Syrup', 'Paracetamol', 'Syrup', '120mg/5ml', '100ml', 'Analgesic', 'Emzor Pharmaceutical', 600, 900, 'fast'],
  ['Ibuprofen', 'Ibuprofen', 'Tablet', '400mg', 'x100', 'Analgesic', 'Juhel Nigeria', 1600, 2200, 'fast'],
  ['Diclofenac Sodium', 'Diclofenac', 'Tablet', '50mg', 'x100', 'Analgesic', 'Fidson Healthcare', 1800, 2400, 'fast'],
  ['Cataflam', 'Diclofenac Potassium', 'Tablet', '50mg', 'x20', 'Analgesic', 'Novartis', 3500, 4500, 'mid'],
  ['Alabukun Powder', 'Aspirin/Caffeine', 'Powder Sachet', null, 'x50', 'Analgesic', 'Alabukun Pharmaceutical', 900, 1400, 'fast'],
  ['Tramadol', 'Tramadol HCl', 'Capsule', '50mg', 'x100', 'Analgesic', 'Ranbaxy', 2500, 3500, 'mid'],
  ['Aspirin', 'Acetylsalicylic Acid', 'Tablet', '75mg', 'x28', 'Cardiovascular', 'Bond Chemical', 400, 700, 'mid'],
  ['Piroxicam', 'Piroxicam', 'Capsule', '20mg', 'x100', 'Analgesic', 'Swiss Pharma Nigeria', 1500, 2100, 'mid'],

  // ---- Antibiotics ----
  ['Ampiclox', 'Ampicillin/Cloxacillin', 'Capsule', '500mg', 'x10', 'Antibiotic', 'Beecham Pharmaceuticals', 900, 1400, 'fast'],
  ['Augmentin', 'Amoxicillin/Clavulanate', 'Tablet', '625mg', 'x14', 'Antibiotic', 'GlaxoSmithKline', 9000, 13000, 'mid'],
  ['Amoxicillin', 'Amoxicillin', 'Capsule', '500mg', 'x100', 'Antibiotic', 'Fidson Healthcare', 2500, 3500, 'fast'],
  ['Amoxil Suspension', 'Amoxicillin', 'Suspension', '125mg/5ml', '100ml', 'Antibiotic', 'Emzor Pharmaceutical', 900, 1400, 'fast'],
  ['Ciprotab', 'Ciprofloxacin', 'Tablet', '500mg', 'x10', 'Antibiotic', 'Fidson Healthcare', 900, 1400, 'fast'],
  ['Ciprofloxacin', 'Ciprofloxacin', 'Tablet', '500mg', 'x10', 'Antibiotic', 'Juhel Nigeria', 600, 1000, 'fast'],
  ['Flagyl', 'Metronidazole', 'Tablet', '400mg', 'x20', 'Antibiotic', 'Sanofi', 1800, 2500, 'fast'],
  ['Metronidazole', 'Metronidazole', 'Tablet', '200mg', 'x1000', 'Antibiotic', 'Bond Chemical', 3000, 4500, 'mid'],
  ['Zinnat', 'Cefuroxime Axetil', 'Tablet', '500mg', 'x10', 'Antibiotic', 'GlaxoSmithKline', 12000, 16000, 'slow'],
  ['Cefuroxime', 'Cefuroxime Axetil', 'Tablet', '500mg', 'x10', 'Antibiotic', 'Swiss Pharma Nigeria', 4000, 6000, 'mid'],
  ['Azithromycin', 'Azithromycin', 'Tablet', '500mg', 'x3', 'Antibiotic', 'Emzor Pharmaceutical', 1500, 2500, 'fast'],
  ['Zithromax', 'Azithromycin', 'Tablet', '500mg', 'x3', 'Antibiotic', 'Pfizer', 4500, 6500, 'slow'],
  ['Doxycycline', 'Doxycycline', 'Capsule', '100mg', 'x100', 'Antibiotic', 'Mopson Pharmaceutical', 1800, 2600, 'mid'],
  ['Erythromycin', 'Erythromycin', 'Tablet', '500mg', 'x100', 'Antibiotic', 'Juhel Nigeria', 2500, 3500, 'mid'],
  ['Septrin', 'Co-trimoxazole', 'Tablet', '480mg', 'x100', 'Antibiotic', 'GlaxoSmithKline', 2000, 3000, 'mid'],
  ['Rocephin', 'Ceftriaxone', 'Injection', '1g', 'x1 vial', 'Antibiotic', 'Roche', 3500, 5500, 'slow'],
  ['Ceftriaxone', 'Ceftriaxone', 'Injection', '1g', 'x1 vial', 'Antibiotic', 'Zhejiang Pharmaceutical', 900, 1500, 'mid'],
  ['Levofloxacin', 'Levofloxacin', 'Tablet', '500mg', 'x5', 'Antibiotic', 'Vitabiotics Nigeria', 1200, 1900, 'mid'],
  ['Gentamicin Injection', 'Gentamicin', 'Injection', '80mg/2ml', 'x10 amp', 'Antibiotic', 'Juhel Nigeria', 1200, 1800, 'slow'],

  // ---- Cough, cold & allergy ----
  ['Piriton', 'Chlorpheniramine', 'Tablet', '4mg', 'x10', 'Antihistamine', 'Haleon', 200, 400, 'fast'],
  ['Chlorpheniramine', 'Chlorpheniramine', 'Tablet', '4mg', 'x1000', 'Antihistamine', 'Bond Chemical', 2500, 3500, 'mid'],
  ['Loratadine', 'Loratadine', 'Tablet', '10mg', 'x10', 'Antihistamine', 'Emzor Pharmaceutical', 400, 700, 'fast'],
  ['Clarityne', 'Loratadine', 'Tablet', '10mg', 'x10', 'Antihistamine', 'Bayer', 1800, 2600, 'slow'],
  ['Cetirizine', 'Cetirizine', 'Tablet', '10mg', 'x10', 'Antihistamine', 'Greenlife Pharmaceuticals', 400, 700, 'fast'],
  ['Procold', 'Paracetamol/Chlorpheniramine/Phenylephrine', 'Tablet', null, 'x100', 'Cold Remedy', 'Mopson Pharmaceutical', 1500, 2200, 'fast'],
  ['Emzolyn Expectorant', 'Guaifenesin', 'Syrup', null, '100ml', 'Cough Remedy', 'Emzor Pharmaceutical', 700, 1100, 'fast'],
  ['Benylin Dry Cough', 'Diphenhydramine', 'Syrup', null, '100ml', 'Cough Remedy', 'Johnson & Johnson', 1800, 2500, 'mid'],
  ['Tutolin Cough Syrup', 'Guaifenesin/Diphenhydramine', 'Syrup', null, '100ml', 'Cough Remedy', 'Tuyil Pharmaceutical', 800, 1300, 'mid'],
  ['Vicks Vaporub', 'Camphor/Menthol/Eucalyptus', 'Ointment', null, '50g', 'Cold Remedy', 'Procter & Gamble', 1200, 1800, 'mid'],
  ['Strepsils', 'Amylmetacresol/Dichlorobenzyl Alcohol', 'Lozenge', null, 'x24', 'Cold Remedy', 'Reckitt', 900, 1400, 'fast'],
  ['Ventolin Inhaler', 'Salbutamol', 'Inhaler', '100mcg', 'x200 doses', 'Respiratory', 'GlaxoSmithKline', 5500, 8000, 'mid'],
  ['Salbutamol Syrup', 'Salbutamol', 'Syrup', '2mg/5ml', '100ml', 'Respiratory', 'Emzor Pharmaceutical', 600, 1000, 'mid'],

  // ---- Gastrointestinal & anthelmintic ----
  ['Omeprazole', 'Omeprazole', 'Capsule', '20mg', 'x14', 'Gastrointestinal', 'Fidson Healthcare', 700, 1200, 'fast'],
  ['Omez', 'Omeprazole', 'Capsule', '20mg', 'x30', 'Gastrointestinal', 'Dr Reddys Laboratories', 2200, 3200, 'mid'],
  ['Gestid Suspension', 'Aluminium/Magnesium Hydroxide', 'Suspension', null, '200ml', 'Gastrointestinal', 'TTK Healthcare', 1200, 1800, 'mid'],
  ['Maalox Suspension', 'Aluminium/Magnesium Hydroxide', 'Suspension', null, '200ml', 'Gastrointestinal', 'Sanofi', 1800, 2600, 'mid'],
  ['Buscopan', 'Hyoscine Butylbromide', 'Tablet', '10mg', 'x20', 'Gastrointestinal', 'Sanofi', 1800, 2600, 'fast'],
  ['Hyoscine Butylbromide', 'Hyoscine Butylbromide', 'Tablet', '10mg', 'x100', 'Gastrointestinal', 'Juhel Nigeria', 2000, 2800, 'mid'],
  ['Imodium', 'Loperamide', 'Capsule', '2mg', 'x10', 'Gastrointestinal', 'Johnson & Johnson', 700, 1200, 'mid'],
  ['ORS Low Osmolarity', 'Oral Rehydration Salts', 'Sachet', '20.5g', 'x1', 'Gastrointestinal', 'DrugField Pharmaceuticals', 100, 200, 'fast'],
  ['Zinc Sulphate Dispersible', 'Zinc Sulphate', 'Tablet', '20mg', 'x10', 'Gastrointestinal', 'DrugField Pharmaceuticals', 200, 400, 'fast'],
  ['Dulcolax', 'Bisacodyl', 'Tablet', '5mg', 'x10', 'Gastrointestinal', 'Boehringer Ingelheim', 900, 1400, 'mid'],
  ['Andrews Liver Salt', 'Sodium Bicarbonate/Citric Acid', 'Powder Sachet', null, 'x30', 'Gastrointestinal', 'Haleon', 900, 1400, 'mid'],
  ['Albendazole', 'Albendazole', 'Tablet', '400mg', 'x1', 'Anthelmintic', 'Greenlife Pharmaceuticals', 80, 180, 'fast'],
  ['Vermox', 'Mebendazole', 'Tablet', '100mg', 'x6', 'Anthelmintic', 'Johnson & Johnson', 900, 1400, 'mid'],

  // ---- Chronic care ----
  ['Amlodipine', 'Amlodipine', 'Tablet', '5mg', 'x30', 'Cardiovascular', 'Emzor Pharmaceutical', 700, 1200, 'fast'],
  ['Amlodipine', 'Amlodipine', 'Tablet', '10mg', 'x30', 'Cardiovascular', 'Emzor Pharmaceutical', 900, 1500, 'fast'],
  ['Lisinopril', 'Lisinopril', 'Tablet', '10mg', 'x28', 'Cardiovascular', 'Swiss Pharma Nigeria', 900, 1400, 'fast'],
  ['Losartan Potassium', 'Losartan', 'Tablet', '50mg', 'x30', 'Cardiovascular', 'Fidson Healthcare', 1200, 1800, 'fast'],
  ['Nifedipine Retard', 'Nifedipine', 'Tablet', '20mg', 'x30', 'Cardiovascular', 'Bayer', 1400, 2000, 'mid'],
  ['Atenolol', 'Atenolol', 'Tablet', '50mg', 'x28', 'Cardiovascular', 'Juhel Nigeria', 600, 1000, 'mid'],
  ['Aldomet', 'Methyldopa', 'Tablet', '250mg', 'x30', 'Cardiovascular', 'Aspen Pharmacare', 1500, 2200, 'mid'],
  ['Moduretic', 'Amiloride/Hydrochlorothiazide', 'Tablet', '5/50mg', 'x30', 'Cardiovascular', 'Merck', 1300, 1900, 'mid'],
  ['Lipitor', 'Atorvastatin', 'Tablet', '20mg', 'x30', 'Cardiovascular', 'Pfizer', 6000, 9000, 'slow'],
  ['Atorvastatin', 'Atorvastatin', 'Tablet', '20mg', 'x30', 'Cardiovascular', 'Cipla', 1500, 2500, 'mid'],
  ['Metformin', 'Metformin', 'Tablet', '500mg', 'x30', 'Antidiabetic', 'Juhel Nigeria', 500, 900, 'fast'],
  ['Glucophage', 'Metformin', 'Tablet', '500mg', 'x30', 'Antidiabetic', 'Merck', 1500, 2200, 'mid'],
  ['Glibenclamide', 'Glibenclamide', 'Tablet', '5mg', 'x100', 'Antidiabetic', 'Bond Chemical', 900, 1400, 'mid'],
  ['Mixtard 30 HM', 'Insulin Human', 'Injection', '100IU/ml', '10ml vial', 'Antidiabetic', 'Novo Nordisk', 7000, 11000, 'slow'],
  ['Actrapid HM', 'Insulin Human', 'Injection', '100IU/ml', '10ml vial', 'Antidiabetic', 'Novo Nordisk', 7000, 11000, 'slow'],
  ['Accu-Chek Active Test Strips', 'Glucose Test Strips', 'Test Strip', null, 'x50', 'Diagnostic', 'Roche', 8000, 12000, 'slow'],

  // ---- Vitamins & supplements ----
  ['Emzor Vitamin C', 'Ascorbic Acid', 'Tablet', '100mg', 'x1000', 'Supplement', 'Emzor Pharmaceutical', 2000, 3000, 'fast'],
  ['Vitamin C Effervescent', 'Ascorbic Acid', 'Effervescent Tablet', '1000mg', 'x10', 'Supplement', 'Greenlife Pharmaceuticals', 900, 1400, 'fast'],
  ['Astymin Forte', 'Amino Acids/Multivitamin', 'Capsule', null, 'x30', 'Supplement', 'Tablets India', 3000, 4500, 'mid'],
  ['Feroglobin B12', 'Iron/Vitamin B12', 'Capsule', null, 'x30', 'Supplement', 'Vitabiotics', 4500, 6500, 'mid'],
  ['Pregnacare Original', 'Prenatal Multivitamin', 'Tablet', null, 'x30', 'Supplement', 'Vitabiotics', 6000, 9000, 'mid'],
  ['Folic Acid', 'Folic Acid', 'Tablet', '5mg', 'x1000', 'Supplement', 'Bond Chemical', 1500, 2500, 'fast'],
  ['Ferrous Sulphate', 'Ferrous Sulphate', 'Tablet', '200mg', 'x1000', 'Supplement', 'Juhel Nigeria', 1800, 2800, 'fast'],
  ['Multivite', 'Multivitamin', 'Tablet', null, 'x1000', 'Supplement', 'Mopson Pharmaceutical', 1500, 2500, 'fast'],
  ['Vitamin B-Complex', 'Vitamin B Complex', 'Tablet', null, 'x1000', 'Supplement', 'Bond Chemical', 1500, 2500, 'fast'],
  ['Seven Seas Cod Liver Oil', 'Cod Liver Oil', 'Capsule', null, 'x30', 'Supplement', 'Seven Seas', 3000, 4500, 'mid'],
  ['Calcium + Vitamin D3', 'Calcium Carbonate/Cholecalciferol', 'Tablet', '500mg/200IU', 'x30', 'Supplement', 'Swiss Pharma Nigeria', 1200, 1900, 'mid'],

  // ---- Dermatology & antifungal ----
  ['Ketoconazole Cream', 'Ketoconazole', 'Cream', '2%', '30g', 'Dermatological', 'Greenlife Pharmaceuticals', 500, 900, 'fast'],
  ['Funbact-A Cream', 'Triamcinolone/Neomycin/Nystatin', 'Cream', null, '30g', 'Dermatological', 'Fidson Healthcare', 600, 1000, 'fast'],
  ['Clotrimazole Cream', 'Clotrimazole', 'Cream', '1%', '20g', 'Dermatological', 'Juhel Nigeria', 400, 700, 'fast'],
  ['Canesten Cream', 'Clotrimazole', 'Cream', '1%', '20g', 'Dermatological', 'Bayer', 2500, 3500, 'slow'],
  ['Fluconazole', 'Fluconazole', 'Capsule', '150mg', 'x1', 'Antifungal', 'Emzor Pharmaceutical', 300, 600, 'fast'],
  ['Griseofulvin', 'Griseofulvin', 'Tablet', '500mg', 'x100', 'Antifungal', 'Bond Chemical', 3500, 5000, 'slow'],
  ['Gentamicin Skin Ointment', 'Gentamicin', 'Ointment', '0.1%', '15g', 'Dermatological', 'Juhel Nigeria', 400, 700, 'mid'],
  ['Betamethasone Cream', 'Betamethasone', 'Cream', '0.1%', '15g', 'Dermatological', 'Swiss Pharma Nigeria', 500, 900, 'mid'],
  ['Benzyl Benzoate Lotion', 'Benzyl Benzoate', 'Lotion', '25%', '100ml', 'Dermatological', 'DrugField Pharmaceuticals', 500, 900, 'mid'],

  // ---- Eye & ear ----
  ['Chloramphenicol Eye Drops', 'Chloramphenicol', 'Eye Drops', '0.5%', '10ml', 'Ophthalmic', 'Juhel Nigeria', 300, 600, 'fast'],
  ['Optrex Eye Drops', 'Naphazoline/Witch Hazel', 'Eye Drops', null, '10ml', 'Ophthalmic', 'Reckitt', 1800, 2600, 'slow'],
  ['Ciprofloxacin Eye/Ear Drops', 'Ciprofloxacin', 'Eye Drops', '0.3%', '5ml', 'Ophthalmic', 'Greenlife Pharmaceuticals', 400, 800, 'mid'],

  // ---- Family planning ----
  ['Postinor-2', 'Levonorgestrel', 'Tablet', '0.75mg', 'x2', 'Contraceptive', 'Gedeon Richter', 1800, 2600, 'fast'],
  ['Gold Circle Condom', 'Latex Condom', 'Condom', null, 'x3', 'Contraceptive', 'Society for Family Health', 100, 250, 'fast'],
  ['Durex Condom', 'Latex Condom', 'Condom', null, 'x3', 'Contraceptive', 'Reckitt', 700, 1200, 'mid'],
  ['Rapid Pregnancy Test Strip', 'hCG Test Strip', 'Test Kit', null, 'x1', 'Diagnostic', 'Wondfo', 150, 350, 'fast'],

  // ---- Consumables, first aid & devices ----
  ['Cotton Wool', 'Absorbent Cotton', 'Roll', null, '100g', 'Consumable', 'Wellis Nigeria', 700, 1200, 'fast'],
  ['Methylated Spirit', 'Denatured Ethanol', 'Solution', '70%', '100ml', 'Antiseptic', 'DrugField Pharmaceuticals', 300, 600, 'fast'],
  ['Hydrogen Peroxide', 'Hydrogen Peroxide', 'Solution', '6%', '100ml', 'Antiseptic', 'DrugField Pharmaceuticals', 300, 600, 'mid'],
  ['Dettol Antiseptic Liquid', 'Chloroxylenol', 'Solution', '4.8%', '250ml', 'Antiseptic', 'Reckitt', 1800, 2600, 'fast'],
  ['Savlon Antiseptic', 'Cetrimide/Chlorhexidine', 'Solution', null, '100ml', 'Antiseptic', 'ABC Pharmaceuticals', 800, 1300, 'mid'],
  ['Elastic Bandage', 'Crepe Bandage', 'Bandage', '4 inch', 'x1', 'Consumable', 'Wellis Nigeria', 400, 800, 'mid'],
  ['Sterile Gauze Swab', 'Cotton Gauze', 'Gauze', '4x4 inch', 'x5', 'Consumable', 'Wellis Nigeria', 300, 600, 'mid'],
  ['Handyplast Adhesive Plaster', 'Adhesive Dressing', 'Plaster', null, 'x10', 'Consumable', 'Beiersdorf', 300, 600, 'fast'],
  ['Disposable Syringe', 'Syringe & Needle', 'Syringe', '5ml', 'x1', 'Consumable', 'Jiangsu Medical', 60, 120, 'fast'],
  ['Surgical Face Mask', 'Face Mask', 'Mask', '3-ply', 'x50', 'Consumable', 'Wellis Nigeria', 1500, 2500, 'slow'],
  ['Hand Sanitizer', 'Ethanol Gel', 'Gel', '70%', '100ml', 'Antiseptic', 'Fidson Healthcare', 700, 1200, 'mid'],
  ['Digital Thermometer', 'Clinical Thermometer', 'Device', null, 'x1', 'Device', 'Omron', 2500, 4000, 'slow'],
  ['Omron M2 Blood Pressure Monitor', 'Sphygmomanometer', 'Device', null, 'x1', 'Device', 'Omron', 25000, 38000, 'slow'],
  ['Accu-Chek Active Glucometer', 'Blood Glucose Meter', 'Device', null, 'x1', 'Device', 'Roche', 12000, 18000, 'slow'],
];

const SUPPLIERS = [
  'Emzor Depot, Lagos',
  'Fidson Healthcare Plc',
  'Greenlife Pharmaceuticals Ltd',
  'Idumota Market — Kola Ventures',
  'Onitsha Head Bridge — Ozo Pharma',
  'Ecomed Pharma Ltd',
  'DrugField Pharmaceuticals',
  'Mopson Pharmaceutical Ltd',
  'Bond Chemical Industries',
  'Juhel Nigeria Ltd',
  'Swiss Pharma Nigeria Ltd',
  'May & Baker Nigeria Plc',
  'Ata-Marina Distributors, Aba',
  'Nemel Wholesale, Ibadan',
];

// Stock depth by movement class. A fast mover at zero is a lost sale today;
// a slow mover sitting at 40 units is dead capital. Both states have to
// appear in the file or the reorder logic is never exercised.
const STOCK_BAND = { fast: [40, 400], mid: [12, 90], slow: [1, 15] };

// Retail markup by category. Chronic-care and device margins are thinner —
// customers price those against three other shops before buying.
const MARKUP = {
  Device: [1.15, 1.25],
  Diagnostic: [1.18, 1.30],
  Cardiovascular: [1.18, 1.30],
  Antidiabetic: [1.18, 1.30],
  Consumable: [1.30, 1.55],
  default: [1.22, 1.45],
};

// =========================================================================
// Deterministic randomness
// =========================================================================

/** mulberry32 — small, fast, and identical on every platform for a given seed. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Shop prices land on round numbers. 1,847 is a spreadsheet; 1,850 is a shelf. */
function roundToShelf(naira) {
  if (naira < 500) return Math.round(naira / 10) * 10;
  if (naira < 5000) return Math.round(naira / 50) * 50;
  return Math.round(naira / 100) * 100;
}

// =========================================================================
// Row synthesis
// =========================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Expiry, deliberately including stock that has already gone bad.
 *
 * A file where everything expires comfortably in the future cannot test the
 * one question a pharmacist actually asks it — what am I about to sell that
 * I should not be selling. So ~8% is already expired and ~12% goes within
 * the quarter.
 */
function makeExpiry(rng, today) {
  const roll = rng();
  let monthsOut;
  if (roll < 0.08) monthsOut = -randInt(rng, 1, 8);
  else if (roll < 0.20) monthsOut = randInt(rng, 0, 3);
  else monthsOut = randInt(rng, 4, 36);

  // Day 0 of the following month is the last day of this one — how the
  // carton is actually printed ("EXP 06/2027" means end of June).
  return new Date(today.getFullYear(), today.getMonth() + monthsOut + 1, 0);
}

function makeBatch(rng, manufacturer, expiry) {
  const code = manufacturer.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN';
  const yy = pad2((expiry.getFullYear() - 2) % 100);
  const mm = pad2(expiry.getMonth() + 1);
  return `${code}${yy}${mm}${String.fromCharCode(65 + randInt(rng, 0, 5))}`;
}

function composeName(brand, strength, form, pack) {
  return [brand, strength, form, pack].filter(Boolean).join(' ');
}

function buildRow(rng, entry, today) {
  const [brand, generic, form, strength, pack, category, maker, costLo, costHi, moves] = entry;

  const cost = roundToShelf(randInt(rng, costLo, costHi));
  const [mLo, mHi] = MARKUP[category] || MARKUP.default;
  const selling = roundToShelf(cost * (mLo + rng() * (mHi - mLo)));

  const [sLo, sHi] = STOCK_BAND[moves];
  const reorder = Math.max(5, Math.round(sLo * (0.6 + rng() * 0.5)));

  // Out of stock and below reorder are normal shelf states, not edge cases —
  // a fifth of any real inventory file looks like this.
  const stockRoll = rng();
  let qty;
  if (stockRoll < 0.07) qty = 0;
  else if (stockRoll < 0.22) qty = randInt(rng, 1, reorder);
  else qty = randInt(rng, reorder + 1, sHi);

  const expiry = makeExpiry(rng, today);

  return {
    product_name: composeName(brand, strength, form, pack),
    generic_name: generic,
    brand,
    category,
    dosage_form: form,
    strength: strength || '',
    pack_size: pack || '',
    manufacturer: maker,
    cost_price: cost,
    selling_price: selling,
    quantity: qty,
    reorder_level: reorder,
    batch_number: makeBatch(rng, maker, expiry),
    expiry_date: `${expiry.getFullYear()}-${pad2(expiry.getMonth() + 1)}-${pad2(expiry.getDate())}`,
    supplier: pick(rng, SUPPLIERS),
    _expiry: expiry,
  };
}

// =========================================================================
// Mess
// =========================================================================

const MESSY_HEADERS = {
  product_name: 'DRUG NAME',
  generic_name: 'Generic',
  brand: 'Brand',
  category: 'Class',
  dosage_form: 'Form',
  strength: 'Dosage',
  pack_size: 'Pack',
  manufacturer: 'Coy',
  cost_price: 'COST PRICE (N)',
  selling_price: 'SELLING PRICE (₦)',
  quantity: 'QTY IN STOCK',
  reorder_level: 'Re-order',
  batch_number: 'Batch No.',
  expiry_date: 'Exp. Date',
  supplier: 'Supplier',
};

function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The four date formats one shop's staff will use inside one column. */
function messyDate(rng, d) {
  switch (randInt(rng, 0, 3)) {
    case 0: return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 1: return `${MONTHS[d.getMonth()]}-${pad2(d.getFullYear() % 100)}`;
    case 2: return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    default: return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
}

function messyPrice(rng, naira) {
  switch (randInt(rng, 0, 4)) {
    case 0: return `₦${withCommas(naira)}.00`;
    case 1: return `N${withCommas(naira)}`;
    case 2: return withCommas(naira);
    case 3: return `${naira}.00`;
    default: return String(naira);
  }
}

/** How the name gets typed at 7pm with customers waiting. */
function messyName(rng, row) {
  const base = row.product_name;
  switch (randInt(rng, 0, 3)) {
    case 0: return base.toUpperCase();
    case 1: return base.replace(/Tablet/i, 'TABS').replace(/Capsule/i, 'CAPS').toUpperCase();
    case 2: return `  ${base}  `;
    default: return base;
  }
}

/**
 * Turn one clean row into what a shop's own file actually contains.
 *
 * The blanks are not noise. "No usable price" and "never counted" are real
 * states the importer has to carry through to data_flags rather than coerce
 * to zero, and a generator that never emits them tests half the pipeline.
 */
function messify(rng, row) {
  const out = { ...row };
  out.product_name = messyName(rng, row);
  out.cost_price = messyPrice(rng, row.cost_price);
  out.selling_price = messyPrice(rng, row.selling_price);
  out.expiry_date = messyDate(rng, row._expiry);

  if (rng() < 0.06) out.selling_price = '';           // priced at the counter
  if (rng() < 0.04) out.cost_price = '-';
  if (rng() < 0.05) out.quantity = '';                // never counted
  if (rng() < 0.03) out.quantity = 'N/A';
  if (rng() < 0.08) out.generic_name = '';
  if (rng() < 0.10) out.batch_number = '';
  if (rng() < 0.05) out.strength = '';
  if (rng() < 0.04) out.supplier = '';

  return out;
}

/**
 * A second spelling of a drug already in the file.
 *
 * Every real catalogue has these — the same product entered twice by two
 * people on two days. They are the whole reason natural_key exists, and
 * duplicateReview has nothing to review without them.
 */
function altSpelling(rng, row) {
  const dup = { ...row };
  const short = row.brand.split(' ')[0].toLowerCase();
  const strengthBit = row.strength ? ` ${row.strength.replace(/mg$/i, '')}` : '';
  dup.product_name = pick(rng, [
    `${short}${strengthBit}`,
    `${row.brand.toUpperCase()} ${row.strength || ''} ${row.pack_size || ''}`.trim(),
    `${short} ${row.dosage_form.toLowerCase()}${strengthBit}`,
  ]);
  dup.quantity = randInt(rng, 0, 40);
  dup.batch_number = makeBatch(rng, row.manufacturer, row._expiry);
  return dup;
}

// =========================================================================
// CSV
// =========================================================================

const COLUMNS = [
  'product_name', 'generic_name', 'brand', 'category', 'dosage_form', 'strength',
  'pack_size', 'manufacturer', 'cost_price', 'selling_price', 'quantity',
  'reorder_level', 'batch_number', 'expiry_date', 'supplier',
];

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, messy) {
  const header = COLUMNS.map((c) => (messy ? MESSY_HEADERS[c] : c));
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// =========================================================================
// CLI
// =========================================================================

function parseArgs(argv) {
  const args = { rows: null, seed: 42, messy: false, out: null, date: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--messy') args.messy = true;
    else if (a === '--rows') { i += 1; args.rows = Number(argv[i]); }
    else if (a === '--seed') { i += 1; args.seed = Number(argv[i]); }
    else if (a === '--out') { i += 1; args.out = argv[i]; }
    else if (a === '--date') { i += 1; args.date = argv[i]; }
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument "${a}". Try --help.`);
  }
  return args;
}

const USAGE = `
Generate a synthetic Nigerian pharmacy inventory catalogue.

  --rows N            how many rows (default: one per product, ${CATALOGUE.length})
  --seed N            PRNG seed; same seed = same file (default: 42)
  --messy             emit a realistic dirty vendor export instead of clean columns
  --date YYYY-MM-DD   "today" for expiry maths (default: the real today)
  --out PATH          write to a file (default: stdout)

  node scripts/generate-inventory.js --out inventory.csv
  node scripts/generate-inventory.js --messy --rows 300 --seed 7 --out messy.csv
`.trim();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.rows !== null && (!Number.isInteger(args.rows) || args.rows < 1)) {
    throw new Error('--rows must be a positive integer.');
  }
  if (!Number.isInteger(args.seed)) throw new Error('--seed must be an integer.');

  const today = args.date ? new Date(`${args.date}T00:00:00`) : new Date();
  if (Number.isNaN(today.getTime())) throw new Error('--date must be YYYY-MM-DD.');

  const rng = makeRng(args.seed);
  const target = args.rows || CATALOGUE.length;

  const rows = [];
  // Walk the catalogue in order first so a default run covers every product,
  // then cycle for a larger --rows. Sampling at random would leave holes in a
  // small file, and a fixture missing insulin is not a pharmacy.
  for (let i = 0; rows.length < target; i += 1) {
    const entry = CATALOGUE[i % CATALOGUE.length];
    const row = buildRow(rng, entry, today);
    rows.push(args.messy ? messify(rng, row) : row);

    // Duplicates only in messy mode: the clean file is the canonical one and
    // must import to exactly as many products as it has rows.
    if (args.messy && rows.length < target && rng() < 0.05) {
      rows.push(messify(rng, altSpelling(rng, row)));
    }
  }

  const emitted = rows.slice(0, target);
  const csv = toCsv(emitted, args.messy);

  if (args.out) {
    fs.writeFileSync(args.out, csv, 'utf8');
    const expired = emitted.filter((r) => r._expiry < today).length;
    const zero = emitted.filter((r) => r.quantity === 0).length;
    console.log(`Wrote ${emitted.length} rows to ${args.out}`);
    console.log(`  seed=${args.seed}  shape=${args.messy ? 'messy' : 'clean'}`);
    console.log(`  ${expired} already expired, ${zero} out of stock`);
  } else {
    process.stdout.write(csv);
  }
}

try {
  main();
} catch (err) {
  console.error(`generate-inventory: ${err.message}`);
  process.exitCode = 1;
}
