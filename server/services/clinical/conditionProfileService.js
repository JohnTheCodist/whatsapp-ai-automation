/**
 * Reading a patient's purchases, running the condition engine over them, and
 * storing the result so it can be explained later.
 *
 * THE DIVISION OF LABOUR
 * conditionEngine decides; this module does I/O. The engine is pure and gets
 * tested against the real NAFDAC extract with no database at all, which is
 * what makes the scoring rules cheap to prove. Everything that talks to
 * Postgres lives here.
 *
 * WHAT COUNTS AS A PURCHASE, AND WHY IT IS NOT "AN ORDER"
 * Only orders a pharmacist actually supplied — confirmed, processing, ready or
 * completed. A `pending` order is a request nobody has looked at, and
 * `cancelled` / `rejected` mean the pharmacy declined to supply it. A patient
 * who ASKED for amlodipine and was refused has not purchased it, and building
 * a chronic-condition profile out of refused requests would be the easiest
 * possible way to invent a patient's medical history.
 *
 * This mirrors where stock actually moves: nothing leaves the shelf until a
 * human confirms, so nothing enters a condition profile until then either.
 *
 * WHY EVERY RUN WRITES TWO ROWS
 * patient_condition is overwritten — it is the current profile.
 * patient_condition_evaluation is appended — it is the audit record, stamped
 * with the NAFDAC dataset and engine version that produced it. Overwriting
 * alone would mean a NAFDAC update silently rewrote history.
 */

const { getSql, assertPharmacyId } = require('../db');
const { evaluatePatient, transactionKey } = require('./conditionEngine');
const { resolveClinicalProduct } = require('./clinicalProductResolver');
const { getNafdacDatasetVersion } = require('./nafdacDatasetVersion');
const { ENGINE_VERSION, conditionForSubgroup, conditionName } = require('../../config/conditionMappings');

/**
 * Order statuses that represent medicine actually supplied to the patient.
 *
 * Deliberately excludes 'pending' (nobody has decided yet), 'cancelled' and
 * 'rejected' (the pharmacy declined). See the header.
 */
const DISPENSED_STATUSES = Object.freeze(['confirmed', 'processing', 'ready', 'completed']);

/**
 * Every dispensed line this patient bought, with the product name exactly as
 * it appeared on the order.
 *
 * name_snapshot is the SOURCE product — what the order actually said, frozen
 * at the time it was placed. It is preferred over products.name because a
 * later catalogue upload can rename or archive a product, and the clinical
 * record must not shift underneath a decision that was already made.
 */
async function loadPatientPurchases(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select
      oi.id             as line_id,
      o.id              as order_id,
      o.created_at      as ordered_at,
      oi.product_id     as product_id,
      -- The order's own snapshot, never the current catalogue name.
      oi.name_snapshot  as source_product_name,
      p.generic_name    as generic_name,
      p.brand_name      as brand_name,
      p.strength        as strength,
      p.form            as form
    from order_items oi
    join orders o
      on o.id = oi.order_id
     and o.pharmacy_id = oi.pharmacy_id
    left join products p
      on p.id = oi.product_id
     and p.pharmacy_id = oi.pharmacy_id
    where oi.pharmacy_id = ${pharmacyId}
      and o.customer_id = ${customerId}
      and o.status = any(${DISPENSED_STATUSES})
    order by o.created_at asc, oi.id asc
  `;
}

/**
 * Resolve each purchase to a clinical identity, preserving the source name.
 *
 * Exported because it is the whole "why" chain in one step, and the tests
 * exercise it directly against the real NAFDAC extract rather than a stub — a
 * mapping proved against a fixture proves only that the fixture matches itself.
 */
function resolvePurchases(rows = []) {
  return rows.map((row) => {
    const clinical = resolveClinicalProduct({
      source_product_name: row.source_product_name,
      brand: row.brand_name || null,
      generic_name: row.generic_name || null,
      strength: row.strength || null,
      dosage_form: row.form || null,
    });

    const orderedAt = row.ordered_at ? new Date(row.ordered_at) : null;

    return {
      // An ORDER is the transaction here — there is no separate receipt
      // reference, and an order is exactly "one thing the pharmacy supplied
      // at one time". transactionKey pairs it with the product so a single
      // order containing amlodipine AND metformin counts once per condition.
      sale_id: row.line_id,
      invoice_ref: row.order_id,
      sale_date: orderedAt ? orderedAt.toISOString().slice(0, 10) : null,
      product_id: row.product_id || row.source_product_name,
      // Never overwritten by resolution.
      source_product_name: row.source_product_name,
      matched_product_id: clinical.matched_product_id,
      matched_product_name: clinical.matched_product_name,
      active_ingredients: clinical.active_ingredients,
      therapeutic_subgroup: clinical.therapeutic_subgroup,
      match_status: clinical.match_status,
      match_confidence: clinical.match_confidence,
      resolution_method: clinical.resolution_method,
    };
  });
}

/**
 * Run the engine for one patient and persist the result.
 *
 * @param {object} [options]
 * @param {Date}    [options.now]
 * @param {boolean} [options.persist]  false runs without writing — a preview.
 */
async function evaluateAndStore(pharmacyId, customerId, { now = new Date(), persist = true } = {}) {
  assertPharmacyId(pharmacyId);
  const datasetVersion = getNafdacDatasetVersion();
  const rows = await loadPatientPurchases(pharmacyId, customerId);
  const purchases = resolvePurchases(rows);
  const result = evaluatePatient(purchases, { now, nafdacDatasetVersion: datasetVersion });

  if (!persist) return result;

  const db = getSql();
  for (const f of result.findings) {
    await db`
      insert into patient_condition (
        pharmacy_id, customer_id, condition_code, condition_name,
        status, evidence_type, evidence_strength, purchase_status,
        first_observed, last_observed, days_since_last_purchase,
        supporting_transaction_count, supporting_product_count,
        supporting_products, supporting_ingredients, therapeutic_subgroups,
        confidence, nafdac_dataset_version, engine_version, evaluated_at, updated_at
      ) values (
        ${pharmacyId}, ${customerId}, ${f.condition_code}, ${f.condition_name},
        ${f.status}, ${f.evidence_type}, ${f.evidence_strength}, ${f.purchase_status},
        ${f.first_observed}, ${f.last_observed}, ${f.days_since_last_purchase},
        ${f.supporting_transaction_count}, ${f.supporting_product_count},
        ${db.json(f.supporting_products)}, ${db.json(f.supporting_ingredients)},
        ${db.json(f.therapeutic_subgroups)},
        ${f.confidence}, ${f.nafdac_dataset_version}, ${f.engine_version}, now(), now()
      )
      on conflict (pharmacy_id, customer_id, condition_code) do update set
        condition_name               = excluded.condition_name,
        status                       = excluded.status,
        evidence_type                = excluded.evidence_type,
        evidence_strength            = excluded.evidence_strength,
        purchase_status              = excluded.purchase_status,
        first_observed               = excluded.first_observed,
        last_observed                = excluded.last_observed,
        days_since_last_purchase     = excluded.days_since_last_purchase,
        supporting_transaction_count = excluded.supporting_transaction_count,
        supporting_product_count     = excluded.supporting_product_count,
        supporting_products          = excluded.supporting_products,
        supporting_ingredients       = excluded.supporting_ingredients,
        therapeutic_subgroups        = excluded.therapeutic_subgroups,
        confidence                   = excluded.confidence,
        nafdac_dataset_version       = excluded.nafdac_dataset_version,
        engine_version               = excluded.engine_version,
        evaluated_at                 = now(),
        updated_at                   = now()
    `;

    // The audit record. Append-only — never updated, never deleted.
    await db`
      insert into patient_condition_evaluation (
        pharmacy_id, customer_id, condition_code, status, evidence_strength,
        confidence, supporting_transaction_count, supporting_product_count,
        evidence_chain, thresholds_applied, reason,
        nafdac_dataset_version, engine_version, evaluated_at
      ) values (
        ${pharmacyId}, ${customerId}, ${f.condition_code}, ${f.status}, ${f.evidence_strength},
        ${f.confidence}, ${f.supporting_transaction_count}, ${f.supporting_product_count},
        ${db.json({
          supporting_transactions: f.evidence_chain,
          confidence_components: f.confidence_components,
          therapeutic_subgroups: f.therapeutic_subgroups,
          supporting_ingredients: f.supporting_ingredients,
        })},
        ${db.json(f.thresholds_applied)}, ${f.reason},
        ${f.nafdac_dataset_version}, ${f.engine_version}, now()
      )
    `;
  }

  return result;
}

/**
 * Re-evaluate every patient in a pharmacy who has dispensed purchases.
 *
 * A condition profile is derived from two things that both move underneath it:
 * the patient's orders, and the NAFDAC extract that classifies them. Neither a
 * new order nor a dataset refresh re-runs the engine on its own, so without a
 * sweep a profile silently ages into a statement about data that is no longer
 * current.
 *
 * One failure never stops the rest — a single unresolvable product must not
 * deny every other patient an up-to-date profile.
 */
async function evaluatePharmacy(pharmacyId, { now = new Date(), limit = 1000 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const patients = await db`
    select distinct o.customer_id
    from orders o
    where o.pharmacy_id = ${pharmacyId}
      and o.status = any(${DISPENSED_STATUSES})
    limit ${limit}
  `;

  let evaluated = 0;
  let findings = 0;
  const failures = [];

  for (const p of patients) {
    try {
      const result = await evaluateAndStore(pharmacyId, p.customer_id, { now });
      evaluated += 1;
      findings += result.findings.length;
    } catch (err) {
      failures.push({ customer_id: p.customer_id, error: err.message });
    }
  }

  return { evaluated, patients: patients.length, findings, failures };
}

/** The current condition profile, for a patient profile screen. */
async function getPatientConditions(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select * from patient_condition
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
    order by condition_code
  `;
}

/**
 * Medication history — the transactions themselves, kept separate from the
 * inference drawn over them. A condition is a conclusion; this is the record
 * it was drawn from, and keeping them apart means the conclusion can be
 * revised without touching the facts.
 *
 * Reports PURCHASE EXPOSURE. It does not claim the patient is taking anything.
 */
async function getMedicationHistory(pharmacyId, customerId, { now = new Date() } = {}) {
  const rows = await loadPatientPurchases(pharmacyId, customerId);
  const purchases = resolvePurchases(rows);

  const seen = new Set();
  const byMedicine = new Map();

  for (const p of purchases) {
    const key = transactionKey(p);
    if (seen.has(key)) continue;         // same dedup rule as the engine
    seen.add(key);

    const medKey = p.source_product_name || p.matched_product_name || 'Unknown';
    if (!byMedicine.has(medKey)) {
      byMedicine.set(medKey, {
        medication: medKey,
        source: 'Pharmacy purchase',
        matched_product_name: p.matched_product_name,
        active_ingredients: p.active_ingredients,
        therapeutic_subgroup: p.therapeutic_subgroup,
        match_status: p.match_status,
        first_purchase: null,
        last_purchase: null,
        purchase_count: 0,
      });
    }

    const entry = byMedicine.get(medKey);
    entry.purchase_count += 1;
    if (p.sale_date) {
      if (!entry.first_purchase || p.sale_date < entry.first_purchase) entry.first_purchase = p.sale_date;
      if (!entry.last_purchase || p.sale_date > entry.last_purchase) entry.last_purchase = p.sale_date;
    }
  }

  return [...byMedicine.values()].map((entry) => {
    const code = conditionForSubgroup(entry.therapeutic_subgroup);
    const last = entry.last_purchase ? new Date(entry.last_purchase) : null;
    return {
      ...entry,
      associated_condition: code ? conditionName(code) : null,
      associated_condition_code: code,
      days_since_last_purchase: last
        ? Math.max(0, Math.round((now.getTime() - last.getTime()) / 86400000))
        : null,
      // Named for what it is. Not "currently taking".
      purchase_exposure: entry.purchase_count > 1 ? 'REPEATED' : 'SINGLE',
    };
  });
}

/**
 * Reconstruct why a patient was classified under a condition.
 *
 * Reads the append-only trail, so asking about a classification made under an
 * older NAFDAC extract returns what was actually decided then — not what the
 * same purchases would produce today.
 */
async function explainCondition(pharmacyId, customerId, conditionCode, { at = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const rows = at
    ? await db`
        select * from patient_condition_evaluation
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
          and condition_code = ${conditionCode} and evaluated_at <= ${at}
        order by evaluated_at desc limit 1`
    : await db`
        select * from patient_condition_evaluation
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
          and condition_code = ${conditionCode}
        order by evaluated_at desc limit 1`;

  const evaluation = rows[0] || null;
  if (!evaluation) return null;

  const chain = evaluation.evidence_chain || {};
  return {
    customer_id: customerId,
    condition_code: evaluation.condition_code,
    status: evaluation.status,
    evidence_type: 'PHARMACY_PURCHASE',
    evidence_strength: evaluation.evidence_strength,
    confidence: Number(evaluation.confidence),
    reason: evaluation.reason,
    supporting_transaction_count: evaluation.supporting_transaction_count,
    supporting_product_count: evaluation.supporting_product_count,
    evidence_chain: chain.supporting_transactions || [],
    confidence_components: chain.confidence_components || null,
    thresholds_applied: evaluation.thresholds_applied,
    nafdac_dataset_version: evaluation.nafdac_dataset_version,
    engine_version: evaluation.engine_version,
    evaluated_at: evaluation.evaluated_at,
  };
}

/** Every evaluation ever recorded, newest first. Shows dataset-version history. */
async function listEvaluations(pharmacyId, customerId, conditionCode = null) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return conditionCode
    ? db`
        select * from patient_condition_evaluation
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
          and condition_code = ${conditionCode}
        order by evaluated_at desc`
    : db`
        select * from patient_condition_evaluation
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        order by evaluated_at desc`;
}

module.exports = {
  DISPENSED_STATUSES,
  loadPatientPurchases,
  resolvePurchases,
  evaluateAndStore,
  evaluatePharmacy,
  getPatientConditions,
  getMedicationHistory,
  explainCondition,
  listEvaluations,
  ENGINE_VERSION,
};
