/**
 * Purchase-based condition inference.
 *
 * RUN AGAINST THE REAL NAFDAC EXTRACT, NOT A FIXTURE.
 * Every resolution test below goes through the actual
 * pharma_nafdac_dataset.csv the server loads at startup. A mapping proved
 * against a hand-written stub proves only that the stub matches the stub;
 * the thing worth knowing is whether "Teva Amlodipine 10mg" resolves in the
 * registry this pharmacy actually ships with.
 *
 * NO DATABASE. The resolver and the engine are both pure, so the whole chain
 * — source product -> NAFDAC -> ingredient -> subgroup -> condition ->
 * evidence -> status — is testable without Postgres. Only persistence needs a
 * database, and persistence is the part with the least logic in it.
 *
 * Dates are fixed and `now` is injected everywhere, so a recency or span
 * calculation cannot pass in March and fail in September.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveClinicalProduct, splitIngredients } = require('../services/clinical/clinicalProductResolver');
const { evaluatePatient, transactionKey, computeConfidence, REJECTED, STATUS } = require('../services/clinical/conditionEngine');
const { conditionForSubgroup, thresholdsFor, ACCEPTED_MATCH_STATUSES } = require('../config/conditionMappings');
const { getNafdacDatasetVersion } = require('../services/clinical/nafdacDatasetVersion');

const NOW = new Date('2026-05-01T00:00:00Z');

/** A purchase of a named product on a given date, resolved for real. */
function purchase(name, date, { saleId, invoice = null } = {}) {
  const clinical = resolveClinicalProduct({ source_product_name: name });
  return {
    sale_id: saleId != null ? saleId : Math.floor(Math.random() * 1e9),
    invoice_ref: invoice,
    sale_date: date,
    product_id: name,          // stable per product for dedup keying
    source_product_name: name,
    matched_product_id: clinical.matched_product_id,
    matched_product_name: clinical.matched_product_name,
    active_ingredients: clinical.active_ingredients,
    therapeutic_subgroup: clinical.therapeutic_subgroup,
    match_status: clinical.match_status,
    match_confidence: clinical.match_confidence,
    resolution_method: clinical.resolution_method,
  };
}

/** Enough purchases to clear the configured confirmation threshold. */
function monthly(name, months, opts = {}) {
  return months.map((m, i) => purchase(name, `2026-${String(m).padStart(2, '0')}-04`, {
    saleId: (opts.base || 1000) + i,
  }));
}

function findingFor(result, code) {
  return result.findings.find((f) => f.condition_code === code) || null;
}

// ---- 1-4: product resolution ---------------------------------------------

test('1. Amlodipine resolves by exact generic to the hypertension subgroup', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Amlodipine 10mg' });
  assert.ok(ACCEPTED_MATCH_STATUSES.includes(r.match_status), `status was ${r.match_status}`);
  assert.equal(r.therapeutic_subgroup, 'Hypertension');
  assert.equal(conditionForSubgroup(r.therapeutic_subgroup), 'HYPERTENSION');
});

test('2. A branded amlodipine still resolves — the brand prefix does not defeat it', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Teva Amlodipine 10mg' });
  assert.ok(ACCEPTED_MATCH_STATUSES.includes(r.match_status), `status was ${r.match_status}`);
  assert.equal(conditionForSubgroup(r.therapeutic_subgroup), 'HYPERTENSION');
  assert.ok(r.active_ingredients.includes('Amlodipine'));
});

test('3. Co-Aprovel resolves from the BRAND alone — the upload never names the generic', () => {
  // The case the spec singles out: a pharmacy sells the brand, and nothing in
  // the transaction says what is in it. NAFDAC is the only thing that knows.
  const r = resolveClinicalProduct({ source_product_name: 'Co-Aprovel 150 mg/12.5 mg Tablet' });
  assert.equal(r.match_status, 'EXACT');
  assert.equal(r.therapeutic_subgroup, 'Hypertension');
  assert.deepEqual(r.active_ingredients, ['Irbesartan', 'Hydrochlorothiazide']);
});

test('4. A combination product yields both actives but counts as ONE purchase', () => {
  assert.deepEqual(splitIngredients('Irbesartan/Hydrochlorothiazide'), ['Irbesartan', 'Hydrochlorothiazide']);

  // Both ingredients are antihypertensive. The patient must not end up looking
  // like someone on two agents because one pack contained two molecules.
  const result = evaluatePatient([purchase('Co-Aprovel 150 mg/12.5 mg Tablet', '2026-01-04', { saleId: 1 })], { now: NOW });
  const f = findingFor(result, 'HYPERTENSION');
  assert.ok(f, 'expected a hypertension finding');
  assert.equal(f.supporting_transaction_count, 1);
  assert.equal(f.evidence_chain.length, 1, 'one pack is one dispensing event');
});

// ---- 5-8: subgroup -> condition mapping ----------------------------------

test('5. Metformin maps to diabetes', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Metformin 500mg' });
  assert.ok(ACCEPTED_MATCH_STATUSES.includes(r.match_status));
  assert.equal(conditionForSubgroup(r.therapeutic_subgroup), 'DIABETES');
});

test('6. Amlodipine maps to hypertension', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Amlodipine 5mg' });
  assert.equal(conditionForSubgroup(r.therapeutic_subgroup), 'HYPERTENSION');
});

test('7. Salbutamol maps to ASTHMA_OR_COPD — not asthma, and not COPD', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Salbutamol' });
  const code = conditionForSubgroup(r.therapeutic_subgroup);
  assert.equal(code, 'ASTHMA_OR_COPD');
  // The source data classifies these agents together. Claiming either one
  // specifically would be inventing a distinction NAFDAC does not make.
  assert.notEqual(code, 'ASTHMA');
  assert.notEqual(code, 'COPD');
});

test('8. Atorvastatin maps to dyslipidemia', () => {
  const r = resolveClinicalProduct({ source_product_name: 'Atorvastatin 20mg' });
  assert.equal(conditionForSubgroup(r.therapeutic_subgroup), 'DYSLIPIDEMIA');
});

// ---- 9-11: evidence accumulation -----------------------------------------

test('9. Repeated purchases strengthen the evidence and confirm the condition', () => {
  const result = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]), { now: NOW });
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.status, STATUS.CONFIRMED);
  assert.equal(f.supporting_transaction_count, 4);
  assert.ok(['STRONG', 'CONFIRMED'].includes(f.evidence_strength), `level was ${f.evidence_strength}`);
  assert.equal(f.first_observed, '2026-01-04');
  assert.equal(f.last_observed, '2026-04-04');
});

test('10. Different medicines for the SAME condition accumulate onto one condition', () => {
  const result = evaluatePatient([
    ...monthly('Amlodipine 10mg', [1, 2], { base: 10 }),
    ...monthly('Losartan 50mg', [3], { base: 20 }),
    ...monthly('Hydrochlorothiazide 25mg', [4], { base: 30 }),
  ], { now: NOW });

  const hypertension = result.findings.filter((f) => f.condition_code === 'HYPERTENSION');
  assert.equal(hypertension.length, 1, 'three antihypertensives must not create three conditions');
  assert.equal(hypertension[0].supporting_transaction_count, 4);
  assert.ok(hypertension[0].supporting_products.length >= 3);
  assert.equal(hypertension[0].status, STATUS.CONFIRMED);
});

test('11. One patient can hold several independent conditions', () => {
  const result = evaluatePatient([
    ...monthly('Metformin 500mg', [1, 2, 3, 4], { base: 100 }),
    ...monthly('Amlodipine 10mg', [1, 2, 3, 4], { base: 200 }),
    ...monthly('Atorvastatin 20mg', [1, 2, 3, 4], { base: 300 }),
  ], { now: NOW });

  const codes = result.findings.map((f) => f.condition_code).sort();
  assert.deepEqual(codes, ['DIABETES', 'DYSLIPIDEMIA', 'HYPERTENSION']);
  for (const f of result.findings) {
    assert.equal(f.status, STATUS.CONFIRMED, `${f.condition_code} should be confirmed on its own evidence`);
    assert.equal(f.supporting_transaction_count, 4);
  }
});

// ---- 12-14, 20: false-positive protection --------------------------------

test('12. An ambiguous product creates nothing', () => {
  const ambiguous = {
    sale_id: 1, sale_date: '2026-01-04', product_id: 'x',
    source_product_name: 'Mystery Combination Tablet',
    active_ingredients: [], therapeutic_subgroup: 'Hypertension',
    match_status: 'AMBIGUOUS', match_confidence: 0.6,
  };
  const result = evaluatePatient([ambiguous], { now: NOW });
  assert.equal(result.findings.length, 0, 'an ambiguous identity must not classify a patient');
  assert.equal(result.rejected[0].reason, REJECTED.MATCH_STATUS);
});

test('13. An unresolved product creates nothing', () => {
  const result = evaluatePatient([purchase('Zzzz Unknown Product', '2026-01-04', { saleId: 1 })], { now: NOW });
  assert.equal(result.findings.length, 0);
  assert.ok(result.rejected.length > 0);
});

test('14. A duplicated transaction counts once', () => {
  // The same receipt imported twice — same invoice, same date, same product.
  const rows = [
    purchase('Amlodipine 10mg', '2026-01-04', { saleId: 1, invoice: 'INV-900' }),
    purchase('Amlodipine 10mg', '2026-01-04', { saleId: 2, invoice: 'INV-900' }),
    ...monthly('Amlodipine 10mg', [2, 3, 4], { base: 50 }),
  ];
  const result = evaluatePatient(rows, { now: NOW });
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.supporting_transaction_count, 4, 'the duplicate inflated the evidence');
  assert.ok(result.rejected.some((r) => r.reason === REJECTED.DUPLICATE));
});

test('20. An unsupported therapeutic class creates no condition', () => {
  // The spec's own example: Vitamin C must never become diabetes. It resolves
  // perfectly well — it is simply not mapped to anything, which is the point.
  for (const name of ['Vitamin C 100mg', 'Paracetamol 500mg', 'Amoxicillin 500mg']) {
    const r = resolveClinicalProduct({ source_product_name: name });
    assert.equal(conditionForSubgroup(r.therapeutic_subgroup), null, `${name} mapped to a condition`);
  }
  const result = evaluatePatient(monthly('Vitamin C 100mg', [1, 2, 3, 4]), { now: NOW });
  assert.equal(result.findings.length, 0, 'no amount of vitamin C is a chronic condition');
});

// ---- 15, 18-19: temporal model and profile -------------------------------

test('15. Historical purchases stay on the profile but are marked NO_RECENT_PURCHASE', () => {
  // Confirmed long ago, nothing since. The condition must not silently vanish,
  // and must not claim the patient is currently buying.
  const result = evaluatePatient(
    monthly('Amlodipine 10mg', [1, 2, 3, 4]),
    { now: new Date('2027-06-01T00:00:00Z') },
  );
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.status, STATUS.CONFIRMED, 'a confirmed condition is never auto-downgraded');
  assert.equal(f.purchase_status, 'NO_RECENT_PURCHASE');
  assert.ok(f.days_since_last_purchase > 365);
});

test('18. A single purchase is PENDING, not confirmed, under the default threshold', () => {
  // Dyslipidemia, not hypertension: hypertension and diabetes deliberately
  // confirm on one purchase now (see the ONE_PURCHASE_CONFIRMS override in
  // conditionMappings.js) — a product decision, not the general rule this
  // test exists to prove. Dyslipidemia still uses the cautious default.
  const result = evaluatePatient([purchase('Atorvastatin 20mg', '2026-04-04', { saleId: 1 })], { now: NOW });
  const f = findingFor(result, 'DYSLIPIDEMIA');
  assert.equal(f.status, STATUS.PENDING);
  assert.equal(f.status, 'PENDING_PURCHASE_EVIDENCE');
  assert.equal(f.evidence_strength, 'WEAK');
  assert.equal(f.supporting_transaction_count, 1);
});

test('18b. Hypertension and diabetes confirm on a single purchase, by design', () => {
  const htn = evaluatePatient([purchase('Amlodipine 10mg', '2026-04-04', { saleId: 1 })], { now: NOW });
  const diabetes = evaluatePatient([purchase('Metformin 500mg', '2026-04-04', { saleId: 2 })], { now: NOW });
  assert.equal(findingFor(htn, 'HYPERTENSION').status, 'CONFIRMED_BY_PURCHASE');
  assert.equal(findingFor(diabetes, 'DIABETES').status, 'CONFIRMED_BY_PURCHASE');
});

test('19. The profile carries its evidence, never a bare label', () => {
  const result = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]), { now: NOW });
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.evidence_type, 'PHARMACY_PURCHASE');
  assert.ok(f.supporting_products.length > 0);
  assert.ok(f.supporting_ingredients.length > 0);
  assert.ok(f.therapeutic_subgroups.includes('Hypertension'));
  assert.ok(f.first_observed && f.last_observed);
  // The status word itself must state the evidence basis.
  assert.match(f.status, /BY_PURCHASE/);
});

// ---- 16-17: versioning, confidence, audit --------------------------------

test('16. Every finding is stamped with the NAFDAC dataset and engine version', () => {
  const version = getNafdacDatasetVersion();
  assert.ok(version && version !== 'unavailable', 'dataset version must be resolvable');

  const result = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]),
    { now: NOW, nafdacDatasetVersion: version });
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.nafdac_dataset_version, version);
  assert.ok(f.engine_version.startsWith('condition-engine/'));
});

test('17. Confidence is deterministic, bounded, and rises with evidence', () => {
  const weak = evaluatePatient([purchase('Amlodipine 10mg', '2026-04-04', { saleId: 1 })], { now: NOW });
  const strong = evaluatePatient([
    ...monthly('Amlodipine 10mg', [1, 2], { base: 10 }),
    ...monthly('Losartan 50mg', [3, 4], { base: 20 }),
  ], { now: NOW });

  const w = findingFor(weak, 'HYPERTENSION').confidence;
  const s = findingFor(strong, 'HYPERTENSION').confidence;
  assert.ok(s > w, `more evidence must score higher (${s} vs ${w})`);
  for (const v of [w, s]) assert.ok(v >= 0 && v <= 1, `confidence out of range: ${v}`);

  // Same input, same output — twice.
  const again = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]), { now: NOW });
  const once = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]), { now: NOW });
  assert.equal(findingFor(again, 'HYPERTENSION').confidence, findingFor(once, 'HYPERTENSION').confidence);

  // And it is arithmetic, not an opinion.
  const c = computeConfidence({
    purchases: 5, distinctMedications: 2, spanDays: 240, daysSinceLast: 10, minMatchConfidence: 0.99,
  });
  assert.ok(c.confidence > 0.8, `expected strong evidence to score high, got ${c.confidence}`);
  assert.ok(c.components.productMatch > 0.9);
});

test('19b. A finding carries the full evidence chain, so it can be reconstructed', () => {
  const result = evaluatePatient(monthly('Amlodipine 10mg', [1, 2, 3, 4]),
    { now: NOW, nafdacDatasetVersion: getNafdacDatasetVersion() });
  const f = findingFor(result, 'HYPERTENSION');

  assert.equal(f.evidence_chain.length, 4);
  for (const link of f.evidence_chain) {
    // PATIENT -> TRANSACTION -> SOURCE PRODUCT -> NAFDAC MATCH ->
    // ACTIVE INGREDIENT -> THERAPEUTIC SUBGROUP -> CONDITION
    assert.ok(link.transaction_key, 'transaction identity');
    assert.ok(link.source_product_name, 'source product preserved');
    assert.ok(link.matched_product_id || link.matched_product_name, 'NAFDAC match');
    assert.ok(link.active_ingredients.length > 0, 'active ingredients');
    assert.equal(link.therapeutic_subgroup, 'Hypertension');
    assert.ok(link.match_confidence >= 0.9);
  }
  assert.ok(f.thresholds_applied, 'the rule in force is pinned to the finding');
  assert.match(f.reason, /hypertension|Hypertension/);
  assert.match(f.reason, /NAFDAC dataset/);
});

test('the source product name is never replaced by the resolved one', () => {
  const result = evaluatePatient([purchase('Teva Amlodipine 10mg', '2026-01-04', { saleId: 1 })], { now: NOW });
  const f = findingFor(result, 'HYPERTENSION');
  assert.equal(f.evidence_chain[0].source_product_name, 'Teva Amlodipine 10mg');
  assert.ok(f.supporting_products.includes('Teva Amlodipine 10mg'));
});

test('transaction identity matches the rule analytics already counts by', () => {
  const a = { invoice_ref: 'INV-1', sale_date: '2026-01-04', product_id: 7, sale_id: 1 };
  const b = { invoice_ref: 'INV-1', sale_date: '2026-01-04', product_id: 7, sale_id: 2 };
  assert.equal(transactionKey(a), transactionKey(b), 'same receipt, same product, same day');

  // A receipt listing two different medicines is two qualifying purchases.
  const c = { invoice_ref: 'INV-1', sale_date: '2026-01-04', product_id: 9, sale_id: 3 };
  assert.notEqual(transactionKey(a), transactionKey(c));

  // With no invoice reference, each row stands alone — the same fallback the
  // analytics transaction count uses.
  const d = { invoice_ref: null, sale_date: '2026-01-04', product_id: 7, sale_id: 4 };
  const e = { invoice_ref: null, sale_date: '2026-01-04', product_id: 7, sale_id: 5 };
  assert.notEqual(transactionKey(d), transactionKey(e));
});

test('thresholds are configuration, and the engine reads them per condition', () => {
  // DYSLIPIDEMIA, not HYPERTENSION, for the "falls back to defaults" check —
  // hypertension has its own deliberate override (confirmAt: WEAK) and no
  // longer matches an unknown condition's fallback threshold by design.
  const t = thresholdsFor('DYSLIPIDEMIA');
  assert.ok(t.confirmAt, 'a condition must declare where confirmation begins');
  assert.ok(t.WEAK.purchases >= 1);
  assert.equal(thresholdsFor('NOT_A_REAL_CONDITION').confirmAt, t.confirmAt, 'unknown conditions fall back to defaults');

  const htn = thresholdsFor('HYPERTENSION');
  assert.equal(htn.confirmAt, 'WEAK', 'hypertension confirms on one purchase, by design');
});

// ---- 28: the critical acceptance tests -----------------------------------

/** The spec's four end-to-end cases, each run over the real registry. */
function acceptance(name, expectedCondition) {
  const result = evaluatePatient(monthly(name, [1, 2, 3, 4]),
    { now: NOW, nafdacDatasetVersion: getNafdacDatasetVersion() });
  return findingFor(result, expectedCondition);
}

test('ACCEPTANCE: Teva Amlodipine 10mg -> Hypertension, CONFIRMED_BY_PURCHASE', () => {
  const f = acceptance('Teva Amlodipine 10mg', 'HYPERTENSION');
  assert.ok(f, 'no hypertension finding');
  assert.equal(f.condition_name, 'Hypertension');
  assert.equal(f.status, 'CONFIRMED_BY_PURCHASE');
  assert.equal(f.evidence_type, 'PHARMACY_PURCHASE');
  assert.ok(f.supporting_ingredients.includes('Amlodipine'));
  assert.ok(f.therapeutic_subgroups.includes('Hypertension'));
});

test('ACCEPTANCE: Co-Aprovel 150/12.5 -> Irbesartan + HCTZ -> Hypertension, CONFIRMED_BY_PURCHASE', () => {
  const f = acceptance('Co-Aprovel 150 mg/12.5 mg Tablet', 'HYPERTENSION');
  assert.ok(f, 'no hypertension finding');
  assert.equal(f.status, 'CONFIRMED_BY_PURCHASE');
  assert.deepEqual(f.supporting_ingredients, ['Irbesartan', 'Hydrochlorothiazide']);
});

test('ACCEPTANCE: Metformin 500mg -> Diabetes, CONFIRMED_BY_PURCHASE', () => {
  const f = acceptance('Metformin 500mg', 'DIABETES');
  assert.ok(f, 'no diabetes finding');
  assert.equal(f.condition_name, 'Diabetes');
  assert.equal(f.status, 'CONFIRMED_BY_PURCHASE');
});

test('ACCEPTANCE: Atorvastatin 20mg -> Dyslipidemia, CONFIRMED_BY_PURCHASE', () => {
  const f = acceptance('Atorvastatin 20mg', 'DYSLIPIDEMIA');
  assert.ok(f, 'no dyslipidemia finding');
  assert.equal(f.condition_name, 'Dyslipidemia');
  assert.equal(f.status, 'CONFIRMED_BY_PURCHASE');
});
