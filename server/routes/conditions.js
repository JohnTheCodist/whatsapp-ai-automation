/**
 * Purchase-based condition profiles — the read and re-evaluate surface.
 *
 * WHAT THESE ROUTES RETURN, AND THE ONE THING THEY MUST NEVER IMPLY
 * A condition here means "this patient's pharmacy purchase history is
 * consistent with this condition, for pharmacy tracking". It is not a
 * diagnosis. Every response carries `evidenceBasis` and a `disclaimer`
 * alongside the data, and each row's own status value
 * (CONFIRMED_BY_PURCHASE) states how it was established — so a client cannot
 * render the label having lost the basis for it. That redundancy is
 * deliberate: the failure mode worth designing against is a UI showing
 * "Hypertension" as though a doctor said it.
 *
 * MOUNTED UNDER /api/customers, NOT /api/patients.
 * This system already has one identity for the person who buys medicine, and
 * it is the customer. A second noun in the URL space would imply a second
 * record that does not exist, and every client would then have to guess which
 * id it was holding.
 *
 * Tenant scoping is req.pharmacyId on every route, so one pharmacy can never
 * read another's patients — the same guarantee every other route here makes,
 * enforced the same way rather than a new way.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const conditions = require('../services/clinical/conditionProfileService');

const router = express.Router();

/** Stated on every response that carries condition data. */
const BASIS = Object.freeze({
  evidenceBasis: 'PHARMACY_PURCHASE',
  disclaimer: 'Derived from pharmacy purchase history for tracking purposes. Not a medical diagnosis.',
});

/**
 * Confirm the customer belongs to this pharmacy before answering anything
 * about them.
 *
 * Without this a caller could probe another tenant's customer ids and learn,
 * from the difference between an empty list and a 404, whether a given id
 * exists. The queries below are all pharmacy-scoped and would return nothing
 * anyway — this makes the answer an honest 404 rather than a misleading
 * "no conditions".
 */
async function customerExists(pharmacyId, customerId) {
  const db = getSql();
  const [row] = await db`
    select id from customers
    where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  return Boolean(row);
}

/** GET /api/customers/:id/conditions — the current condition profile. */
router.get('/:id/conditions', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    if (!await customerExists(req.pharmacyId, req.params.id)) {
      return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    }
    const rows = await conditions.getPatientConditions(req.pharmacyId, req.params.id);
    res.json({ customerId: req.params.id, ...BASIS, conditions: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/customers/:id/conditions/evaluate — re-run the engine.
 *
 * POST because it writes: it upserts the profile and appends an audit
 * evaluation. `?dryRun=1` runs the engine and returns the result without
 * persisting, which is what a preview wants.
 */
router.post('/:id/conditions/evaluate', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    if (!await customerExists(req.pharmacyId, req.params.id)) {
      return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    }
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const result = await conditions.evaluateAndStore(req.pharmacyId, req.params.id, { persist: !dryRun });
    res.json({
      customerId: req.params.id,
      persisted: !dryRun,
      ...BASIS,
      findings: result.findings,
      // Purchases the engine set aside, and why. A silently ignored purchase
      // is indistinguishable from one that was never recorded, so the
      // rejections are part of the answer rather than a log line.
      rejected: result.rejected,
      nafdacDatasetVersion: result.nafdacDatasetVersion,
      engineVersion: result.engineVersion,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id/conditions/:code/explain — why this classification?
 *
 * Returns the full chain: order -> source product -> NAFDAC match -> active
 * ingredients -> therapeutic subgroup -> condition, plus the thresholds in
 * force when it was decided.
 *
 * `?at=<timestamp>` reads the append-only trail as it stood at a past moment,
 * so a classification made under an older NAFDAC extract can be reconstructed
 * as it was actually decided — not as the same purchases would resolve today.
 */
router.get('/:id/conditions/:code/explain', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    if (!await customerExists(req.pharmacyId, req.params.id)) {
      return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    }
    const explanation = await conditions.explainCondition(
      req.pharmacyId, req.params.id, String(req.params.code).toUpperCase(),
      { at: req.query.at || null },
    );
    if (!explanation) {
      return res.status(404).json({ error: 'No evaluation recorded for that condition.', code: 'NOT_FOUND' });
    }
    res.json({ ...BASIS, ...explanation });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id/conditions/:code/evaluations — the full audit trail.
 *
 * Every evaluation ever recorded, newest first. Reading the
 * nafdac_dataset_version column down this list shows which conclusions were
 * drawn under which reference data.
 */
router.get('/:id/conditions/:code/evaluations', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    if (!await customerExists(req.pharmacyId, req.params.id)) {
      return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    }
    const rows = await conditions.listEvaluations(
      req.pharmacyId, req.params.id, String(req.params.code).toUpperCase(),
    );
    res.json({
      customerId: req.params.id,
      conditionCode: String(req.params.code).toUpperCase(),
      evaluations: rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id/medication-history — the transactions themselves.
 *
 * Kept separate from the condition profile: a condition is an inference, this
 * is the record it was drawn from. Reports PURCHASE EXPOSURE and says so — a
 * dispensing record shows a pack left the shelf, not that anyone took it.
 */
router.get('/:id/medication-history', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    if (!await customerExists(req.pharmacyId, req.params.id)) {
      return res.status(404).json({ error: 'Customer not found.', code: 'NOT_FOUND' });
    }
    const history = await conditions.getMedicationHistory(req.pharmacyId, req.params.id);
    res.json({
      customerId: req.params.id,
      evidenceBasis: 'PHARMACY_PURCHASE',
      disclaimer: 'Purchase exposure only. Does not indicate current medication use.',
      medications: history,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/customers/conditions/evaluate-all — re-evaluate every patient.
 *
 * Run after a catalogue upload or a NAFDAC dataset refresh: both change what
 * the engine would conclude, and neither re-runs it on its own.
 *
 * No collision with the /:id routes above despite being declared after them:
 * this path is two segments (`conditions/evaluate-all`) and every route above
 * is three (`:id/conditions/...`), so Express cannot confuse them whatever the
 * registration order. It does NOT depend on `conditions` failing to look like
 * a customer id — customer ids are uuids, but relying on that would make the
 * routing correct by coincidence rather than by shape.
 */
router.post('/conditions/evaluate-all', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const summary = await conditions.evaluatePharmacy(req.pharmacyId);
    res.json({ ...BASIS, ...summary });
  } catch (err) {
    next(err);
  }
});

/**
 * The chronic register: every tracked condition that actually has patients,
 * with those patients attached.
 *
 * WHY EMPTY CONDITIONS ARE OMITTED RATHER THAN RETURNED AS ZERO
 * A pharmacy with no asthma patients does not want an "Asthma — 0" card; it
 * is a row of furniture that never becomes useful, and four of them push the
 * conditions that DO have patients off the first screen. The caller renders
 * whatever it is given, so the filtering has to happen here — a client that
 * receives zeroes will eventually find a reason to draw them.
 *
 * CONFIRMED ONLY. Patients whose evidence is still accumulating
 * (PENDING_PURCHASE_EVIDENCE) are deliberately excluded: this list is
 * something a pharmacist may act on, and "we think maybe" belongs on the
 * patient's own record where its status is visible, not in a register that
 * reads as a roll call.
 *
 * Two segments, so it cannot collide with the three-segment /:id routes
 * above — the same reasoning as evaluate-all.
 */
router.get('/conditions/registry', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const rows = await db`
      select pc.condition_code,
             pc.condition_name,
             pc.customer_id,
             pc.evidence_strength,
             pc.purchase_status,
             pc.confidence,
             pc.last_observed,
             pc.supporting_transaction_count,
             c.display_name,
             c.full_name,
             c.wa_phone
      from patient_condition pc
      join customers c on c.id = pc.customer_id
      where pc.pharmacy_id = ${req.pharmacyId}
        and pc.status = 'CONFIRMED_BY_PURCHASE'
      order by pc.condition_code, pc.last_observed desc nulls last
    `;

    const byCode = new Map();
    for (const r of rows) {
      if (!byCode.has(r.condition_code)) {
        byCode.set(r.condition_code, {
          code: r.condition_code,
          name: r.condition_name,
          patientCount: 0,
          patients: [],
        });
      }
      const group = byCode.get(r.condition_code);
      group.patientCount += 1;
      group.patients.push({
        customerId: r.customer_id,
        // full_name is what the customer told the pharmacy; display_name is
        // whatever they set on their own phone. The confirmed name wins
        // wherever staff act on it — same rule as the order alerts.
        name: r.full_name || r.display_name || r.wa_phone,
        phone: r.wa_phone,
        evidenceStrength: r.evidence_strength,
        purchaseStatus: r.purchase_status,
        confidence: r.confidence === null ? null : Number(r.confidence),
        lastObserved: r.last_observed,
        purchases: r.supporting_transaction_count,
      });
    }

    // Largest cohort first — that is the one a pharmacy is most likely to act
    // on, and it keeps the ordering stable as counts change.
    const registry = [...byCode.values()].sort((a, b) => b.patientCount - a.patientCount);

    res.json({
      ...BASIS,
      conditions: registry,
      trackedPatients: new Set(rows.map((r) => r.customer_id)).size,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
