/**
 * A small harness for describing a clinical conversation as data.
 *
 * WHAT IT IS FOR
 * A scenario says what the patient sends and what should come back — facts,
 * questions, protocol state, red flags, recommendation status, escalation.
 * The assertions then read like the clinical case rather than like database
 * plumbing, which is the only way a pharmacist reviewing these tests could
 * ever check that the expectations are the right ones.
 *
 * DELIBERATELY SMALL. No scenario DSL, no YAML loader, no fixture library —
 * a scenario is a plain object and `run()` is one function. Part 3 asked for
 * a harness, not a framework, and a large one would be the speculative
 * abstraction the engineering standard warns against.
 *
 * THIS IS SOFTWARE VALIDATION, NOT CLINICAL VALIDATION. A passing scenario
 * proves the engine did what the configuration said. It says nothing about
 * whether the configuration is clinically correct — that judgement belongs
 * to a pharmacist, outside this repository.
 */

const assert = require('node:assert/strict');

const { getSql } = require('../../services/db');
const encounters = require('../../services/clinical/clinicalEncounterService');
const engine = require('../../services/clinical/protocolExecutionService');
const workflow = require('../../services/clinical/clinicalWorkflow');

let seq = 0;

/**
 * Create an isolated patient + conversation for one scenario.
 * Each gets its own customer so scenarios never interact.
 */
async function setupPatient(pharmacyId, { displayName = 'Scenario Patient', profile = {} } = {}) {
  const db = getSql();
  seq += 1;
  const phone = `23492${String(Date.now() % 100000).padStart(5, '0')}${String(seq).padStart(3, '0')}`;

  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${pharmacyId}, ${phone}, ${phone}, ${`${phone}@s.whatsapp.net`}, ${displayName})
    returning id
  `;
  const [conversation] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, status, last_message_at)
    values (${pharmacyId}, ${customer.id}, 'bot', 'open', now())
    returning id
  `;

  if (Object.keys(profile).length) {
    const profiles = require('../../services/clinical/patientProfileService');
    await profiles.updatePatientProfile(pharmacyId, customer.id, profile, { actorType: 'pharmacist' });
  }

  return { customerId: customer.id, conversationId: conversation.id, phone };
}

/**
 * Run a scenario.
 *
 * @param {object} scenario
 * @param {string} scenario.name
 * @param {string} scenario.protocolSlug
 * @param {object} [scenario.profile]        seeded patient profile fields
 * @param {Array}  scenario.turns            [{ send, answering, confidence,
 *                                              recommendationKey, firedRedFlags,
 *                                              expect: {...} }]
 * @param {object} [scenario.expectFinal]    assertions after the last turn
 */
async function run(pharmacyId, scenario) {
  const { customerId, conversationId } = await setupPatient(pharmacyId, {
    displayName: scenario.patientName || 'Scenario Patient',
    profile: scenario.profile || {},
  });

  const results = [];

  for (const [i, turn] of (scenario.turns || []).entries()) {
    const label = `${scenario.name} — turn ${i + 1}`;

    const result = await workflow.handleTurn(pharmacyId, {
      conversationId, customerId,
      protocolSlug: scenario.protocolSlug,
      patientMessage: turn.send ?? null,
      answeringKey: turn.answering ?? null,
      clinicalConfidence: turn.confidence ?? null,
      recommendationKey: turn.recommendationKey ?? null,
      firedRedFlags: turn.firedRedFlags ?? null,
    });
    results.push(result);

    const e = turn.expect || {};
    if (e.outcome) {
      assert.equal(result.outcome, e.outcome, `${label}: expected outcome ${e.outcome}, got ${result.outcome}`);
    }
    if (e.priority !== undefined) {
      assert.equal(result.priority, e.priority, `${label}: expected priority ${e.priority}, got ${result.priority}`);
    }
    if (e.questionKey) {
      assert.equal(result.question?.key, e.questionKey,
        `${label}: expected to be asked "${e.questionKey}", got "${result.question?.key}"`);
    }
    if (e.reason) {
      assert.ok(String(result.reason).includes(e.reason) || (result.reasons || []).includes(e.reason),
        `${label}: expected reason "${e.reason}", got "${result.reason}"`);
    }
    if (e.recommendationDelivered !== undefined) {
      assert.equal(Boolean(result.recommendationText), e.recommendationDelivered,
        `${label}: recommendation delivered = ${Boolean(result.recommendationText)}, expected ${e.recommendationDelivered}`);
    }
    if (e.failedSafe !== undefined) {
      assert.equal(Boolean(result.failedSafe), e.failedSafe, `${label}: failedSafe mismatch`);
    }
    // A patient-facing message must NEVER be empty — silence is the one
    // outcome the customer experiences as the system being broken.
    assert.ok(result.patientMessage && result.patientMessage.length > 0,
      `${label}: every outcome must produce something to say to the patient`);
  }

  const final = scenario.expectFinal || {};
  const db = getSql();

  const [encounter] = await db`
    select * from clinical_encounters
    where conversation_id = ${conversationId} order by started_at desc limit 1
  `;

  let state = null;
  if (encounter) {
    const [execution] = await db`
      select * from protocol_executions where encounter_id = ${encounter.id} limit 1
    `;
    if (execution) state = await engine.getExecutionState(pharmacyId, execution.id);
  }

  if (final.protocolState) {
    assert.equal(state?.state, final.protocolState,
      `${scenario.name}: expected protocol state ${final.protocolState}, got ${state?.state}`);
  }
  if (final.facts) {
    for (const [concept, expected] of Object.entries(final.facts)) {
      const fact = state?.factsByConcept.get(concept);
      assert.ok(fact, `${scenario.name}: expected a fact for "${concept}"`);
      assert.equal(String(fact.value), String(expected),
        `${scenario.name}: ${concept} = ${fact.value}, expected ${expected}`);
    }
  }
  if (final.missingRequired) {
    const missing = (state?.missingRequired || []).map((q) => q.question_key).sort();
    assert.deepEqual(missing, [...final.missingRequired].sort(),
      `${scenario.name}: missing-required mismatch`);
  }
  if (final.conflicts !== undefined) {
    assert.equal((state?.conflicts || []).length > 0, final.conflicts,
      `${scenario.name}: conflict presence mismatch`);
  }
  if (final.handoffRaised !== undefined) {
    const [h] = await db`
      select count(*)::int n from handoffs where conversation_id = ${conversationId}
    `;
    assert.equal(h.n > 0, final.handoffRaised,
      `${scenario.name}: expected handoffRaised=${final.handoffRaised}, found ${h.n} handoff(s)`);
  }
  if (final.evaluationStatus) {
    const [ev] = await db`
      select status from recommendation_evaluations
      where encounter_id = ${encounter.id} order by created_at desc limit 1
    `;
    assert.equal(ev?.status, final.evaluationStatus,
      `${scenario.name}: expected evaluation status ${final.evaluationStatus}, got ${ev?.status}`);
  }

  return { results, state, encounter, customerId, conversationId };
}

/** Every audit event recorded for a scenario's patient, in order. */
async function auditTrail(customerId) {
  const db = getSql();
  return db`
    select event_type, actor_type, visibility, metadata, occurred_at
    from customer_events where customer_id = ${customerId} order by id
  `;
}

module.exports = { run, setupPatient, auditTrail };
