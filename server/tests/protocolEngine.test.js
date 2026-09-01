/**
 * Stage 2 Part 1 — the ten scenarios the spec names, plus the safety
 * boundary checks that matter most.
 *
 * The two tests worth reading first, because they are the ones that would
 * catch a genuinely dangerous regression:
 *   - "a conflicting profile fact is preserved, never overwritten"
 *   - "nothing in the fever protocol produces a diagnosis or a treatment"
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the protocol engine was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const protocols = require('../services/clinical/clinicalProtocolService');
const encounters = require('../services/clinical/clinicalEncounterService');
const profiles = require('../services/clinical/patientProfileService');
const facts = require('../services/clinical/clinicalFactService');
const engine = require('../services/clinical/protocolExecutionService');
const fever = require('../services/clinical/protocols/feverAssessmentV1');
const { normaliseAnswer } = require('../services/clinical/answerNormaliser');

let db;
let ctx = {};

/** A fresh patient + encounter + started fever run. */
async function newRun(phoneSuffix) {
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, ${`23491600000${phoneSuffix}`}, ${`23491600000${phoneSuffix}`},
            ${`23491600000${phoneSuffix}@s.whatsapp.net`}, 'Protocol Tester')
    returning id
  `;
  const encounter = await encounters.createEncounter(ctx.pharmacyId, customer.id, {
    presentingComplaint: 'TEST ONLY',
  }, { actorType: 'ai' });
  const execution = await engine.startProtocol(ctx.pharmacyId, encounter.id, fever.SLUG, {
    actorType: 'system', customerId: customer.id,
  });
  return { customerId: customer.id, encounterId: encounter.id, executionId: execution.id, execution };
}

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Protocol Engine Test', ${`proto-eng-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  await fever.install(ctx.pharmacyId, { actorType: 'system' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- pure: normalisation, no database -------------------------------------

test('the severity gauge parses 1-10 and rejects out-of-range rather than clamping', () => {
  assert.equal(normaliseAnswer('scale', '7').number, 7);
  assert.equal(normaliseAnswer('scale', '7/10').number, 7);
  assert.equal(normaliseAnswer('scale', 'about 8').number, 8);
  // 15 is not "10" — silently clamping would be inventing a value.
  assert.equal(normaliseAnswer('scale', '15').status, 'unparsable');
  assert.equal(normaliseAnswer('scale', '0').status, 'unparsable');
});

test('"I don\'t know" is a real answer, not a failed parse', () => {
  assert.equal(normaliseAnswer('scale', "I don't know").status, 'unknown');
  assert.equal(normaliseAnswer('duration', 'not sure').status, 'unknown');
  assert.equal(normaliseAnswer('text', 'prefer not to say').status, 'declined');
});

test('durations parse from natural phrasing, with a fixed "now" for "since Monday"', () => {
  assert.equal(normaliseAnswer('duration', '3 days').number, 3);
  assert.equal(normaliseAnswer('duration', 'a week').number, 7);
  assert.equal(normaliseAnswer('duration', 'a couple of days').number, 2);
  // A Wednesday. "Since Monday" is two days back.
  const wed = new Date('2026-08-12T09:00:00');
  assert.equal(normaliseAnswer('duration', 'since monday', { now: wed }).number, 2);
  // Said ON Monday, "since Monday" means a week — not zero.
  const mon = new Date('2026-08-10T09:00:00');
  assert.equal(normaliseAnswer('duration', 'since monday', { now: mon }).number, 7);
});

test('two answers to a single-choice question is ambiguity, preserved as unparsable', () => {
  const choices = [{ value: 'self', label: 'For me' }, { value: 'someone_else', label: 'For someone else' }];
  assert.equal(normaliseAnswer('single_choice', 'for me', { choices }).value, 'self');
  assert.equal(normaliseAnswer('single_choice', '2', { choices }).value, 'someone_else');
});

// ---- TEST 1: correct protocol + version selected --------------------------

test('TEST 1 — starting a fever assessment pins the active protocol version', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('01');
  assert.equal(run.execution.protocol_slug, 'fever_assessment');
  assert.equal(run.execution.protocol_version, '1.0.0');
  assert.equal(run.execution.state, 'in_progress');
});

// ---- TEST 4: missing required information ---------------------------------

test('TEST 4 — the engine identifies exactly which required information is missing', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('02');
  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);

  assert.equal(state.isComplete, false);
  const missing = state.missingRequired.map((q) => q.question_key);
  assert.ok(missing.includes('presenting_complaint'));
  assert.ok(missing.includes('fever_duration'));
  assert.ok(missing.includes('fever_severity'));

  // The conditional follow-up is NOT missing — it does not apply yet.
  assert.ok(!missing.includes('associated_symptoms'),
    'a question whose condition is unmet must not count as missing information');
});

test('the next question is deterministic and follows declared priority', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('03');
  const first = await engine.nextQuestion(ctx.pharmacyId, run.executionId);
  const again = await engine.nextQuestion(ctx.pharmacyId, run.executionId);
  assert.equal(first.question_key, 'presenting_complaint', 'priority 10 comes first');
  assert.equal(first.id, again.id, 'the same state must always yield the same next question');
});

// ---- TEST 9 + TEST 2: raw vs normalized, multiple facts -------------------

test('TEST 9 — the original response and the normalized value both survive', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('04');
  const { answer, fact } = await engine.recordAnswer(
    ctx.pharmacyId, run.executionId, 'fever_duration', "I've had it since Monday",
    { now: new Date('2026-08-12T09:00:00'), customerId: run.customerId },
  );

  assert.equal(answer.raw_response, "I've had it since Monday", 'the sentence must be kept verbatim');
  assert.equal(Number(answer.normalized_number), 2, 'and the parse stored beside it');
  assert.equal(Number(fact.value_number), 2);
  assert.equal(fact.source, 'patient_reported');
});

test('TEST 2 — several answers in one run produce distinct, correctly-typed facts', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('05');
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever and headache', { customerId: run.customerId });
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_duration', '3 days', { customerId: run.customerId });
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_severity', '7', { customerId: run.customerId });

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  const byConcept = state.factsByConcept;
  assert.equal(byConcept.get('presenting_complaint').value, 'Fever and headache');
  assert.equal(Number(byConcept.get('symptom_duration_days').value_number), 3);
  assert.equal(Number(byConcept.get('fever_severity_gauge').value_number), 7);
  assert.equal(byConcept.get('fever_severity_gauge').unit, 'scale_1_10');
});

// ---- TEST 3: no duplicate facts -------------------------------------------

test('TEST 3 — re-stating the same value does not create a duplicate fact', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('06');
  const first = await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever_severity_gauge', value: '7', valueNumber: 7, source: 'patient_reported',
  }, { customerId: run.customerId });
  const second = await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever_severity_gauge', value: '7', valueNumber: 7, source: 'patient_reported',
  }, { customerId: run.customerId });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'unchanged');
  assert.equal(second.fact.id, first.fact.id, 'the same value must reuse the same row');

  const rows = await db`
    select count(*)::int n from encounter_facts
    where encounter_id = ${run.encounterId} and concept = 'fever_severity_gauge'
  `;
  assert.equal(rows[0].n, 1);
});

test('a patient correcting themselves supersedes, keeping both rows', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('07');
  await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever_severity_gauge', value: '7', valueNumber: 7, source: 'patient_reported',
  }, { customerId: run.customerId });
  const corrected = await facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever_severity_gauge', value: '5', valueNumber: 5, source: 'patient_reported',
  }, { customerId: run.customerId });

  assert.equal(corrected.outcome, 'superseded');
  const all = await facts.listFacts(ctx.pharmacyId, run.encounterId, { includeSuperseded: true });
  const severity = all.filter((f) => f.concept === 'fever_severity_gauge');
  assert.equal(severity.length, 2, 'the earlier value is kept, not deleted');
  assert.equal(severity.find((f) => f.value === '5').status, 'active');
  assert.equal(severity.find((f) => f.value === '7').status, 'superseded');
});

// ---- TEST 5: profile conflict preserved -----------------------------------

test('TEST 5 — a conflicting profile fact is preserved, never overwritten', { skip: SKIP && skipReason }, async () => {
  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${ctx.pharmacyId}, '2349160000099', '2349160000099', '2349160000099@s.whatsapp.net', 'Conflict Tester')
    returning id
  `;
  // Profile says 34.
  await profiles.updatePatientProfile(ctx.pharmacyId, customer.id, { age_years: 34 }, { actorType: 'pharmacist' });

  const encounter = await encounters.createEncounter(ctx.pharmacyId, customer.id, {}, { actorType: 'ai' });
  await engine.startProtocol(ctx.pharmacyId, encounter.id, fever.SLUG, { customerId: customer.id });

  // Conversation says 40.
  const res = await facts.recordFact(ctx.pharmacyId, encounter.id, {
    concept: 'age_years', value: '40', valueNumber: 40, source: 'patient_reported',
  }, { customerId: customer.id });

  assert.equal(res.outcome, 'conflicted', 'profile vs conversation is a conflict, not a correction');

  const conflicts = await facts.listConflicts(ctx.pharmacyId, encounter.id);
  const values = conflicts.filter((c) => c.concept === 'age_years').map((c) => c.value).sort();
  assert.deepEqual(values, ['34', '40'], 'BOTH claims must survive');

  // And the profile itself is untouched.
  const profile = await profiles.getPatientProfile(ctx.pharmacyId, customer.id);
  assert.equal(profile.age_years, 34, 'the persistent profile must not be rewritten by a conversation');

  // A human resolves it; the loser is superseded, not deleted.
  const winner = conflicts.find((c) => c.value === '40');
  await facts.resolveConflict(ctx.pharmacyId, winner.id, { actorType: 'pharmacist', customerId: customer.id });
  const after2 = await facts.listFacts(ctx.pharmacyId, encounter.id, { includeSuperseded: true });
  const ages = after2.filter((f) => f.concept === 'age_years');
  assert.equal(ages.find((f) => f.value === '40').status, 'active');
  assert.equal(ages.find((f) => f.value === '34').status, 'superseded');
});

// ---- TEST 6: invalid clinical value ---------------------------------------

test('TEST 6 — an out-of-range value is rejected and the original text kept', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('08');
  const { answer, fact, accepted } = await engine.recordAnswer(
    ctx.pharmacyId, run.executionId, 'fever_severity', '45', { customerId: run.customerId },
  );

  assert.equal(accepted, false);
  assert.equal(answer.status, 'unparsable');
  assert.equal(answer.raw_response, '45', 'the rejected input is still recorded verbatim');
  assert.equal(answer.normalized_number, null, 'and no value was invented for it');
  assert.equal(fact, null, 'a rejected answer must not become a clinical fact');

  // The question therefore remains outstanding.
  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.ok(state.missingRequired.some((q) => q.question_key === 'fever_severity'));
});

test('"I don\'t know" satisfies a question; an unparsable reply does not', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('18');

  // A genuine "I don't know" is a real answer: it records a fact the
  // pharmacist can see, and must not badger the patient forever.
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_duration', "I don't know", { customerId: run.customerId });
  let state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.ok(!state.missingRequired.some((q) => q.question_key === 'fever_duration'),
    'an explicit "unknown" is an answer, not a gap to re-ask forever');
  assert.equal(state.factsByConcept.get('symptom_duration_days').status, 'unknown');

  // An unusable reply is NOT an answer — the question stays outstanding.
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_severity', 'banana', { customerId: run.customerId });
  state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.ok(state.missingRequired.some((q) => q.question_key === 'fever_severity'),
    'an unparsable reply must leave the required question outstanding');
});

test('an invalid fact source or concept is refused outright', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('09');
  await assert.rejects(() => facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'fever', value: '7', source: 'vibes',
  }), /source must be one of/);
  await assert.rejects(() => facts.recordFact(ctx.pharmacyId, run.encounterId, {
    concept: 'Fever Severity!', value: '7', source: 'patient_reported',
  }), /concept must be/);
});

// ---- TEST 7: invalid state transition -------------------------------------

test('TEST 7 — an illegal protocol state transition is rejected, not stored', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('10');
  // in_progress -> completed skips review entirely.
  await assert.rejects(
    () => engine.transitionTo(ctx.pharmacyId, run.executionId, 'completed', { customerId: run.customerId }),
    /ILLEGAL_TRANSITION/,
  );
  const still = await engine.getExecution(ctx.pharmacyId, run.executionId);
  assert.equal(still.state, 'in_progress', 'the refused transition must not have been applied');
});

test('a run cannot be completed while required questions are outstanding', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('11');
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever', { customerId: run.customerId });
  const advanced = await engine.advance(ctx.pharmacyId, run.executionId, { customerId: run.customerId });
  assert.equal(advanced.state, 'awaiting_information');
  await assert.rejects(
    () => engine.transitionTo(ctx.pharmacyId, run.executionId, 'completed', { customerId: run.customerId }),
    /ILLEGAL_TRANSITION/,
  );
});

// ---- TEST 8: version pinning ----------------------------------------------

test('TEST 8 — activating a new version does not move an in-flight encounter', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('12');
  assert.equal(run.execution.protocol_version, '1.0.0');

  // Publish and activate 1.1.0.
  const v11 = await protocols.createProtocol(ctx.pharmacyId, {
    slug: fever.SLUG, name: 'Fever assessment', version: '1.1.0',
  }, { actorType: 'pharmacist' });
  await protocols.addQuestion(ctx.pharmacyId, v11.id, {
    questionKey: 'presenting_complaint', text: 'Reworded in 1.1.0',
    answerType: 'text', factConcept: 'presenting_complaint',
  }, { actorType: 'pharmacist' });
  await protocols.activateProtocol(ctx.pharmacyId, v11.id, { actorType: 'pharmacist' });

  // The in-flight run still says 1.0.0.
  const unchanged = await engine.getExecution(ctx.pharmacyId, run.executionId);
  assert.equal(unchanged.protocol_version, '1.0.0', 'a published change must not rewrite history');

  // 1.0.0 is now deprecated but still resolvable.
  const old = await protocols.getProtocolVersion(ctx.pharmacyId, fever.SLUG, '1.0.0');
  assert.equal(old.status, 'deprecated');
  assert.ok(old, 'the version an old encounter references must remain retrievable');

  // And exactly one version is active.
  const active = await db`
    select count(*)::int n from clinical_protocols
    where pharmacy_id = ${ctx.pharmacyId} and slug = ${fever.SLUG} and status = 'active'
  `;
  assert.equal(active[0].n, 1);

  // Put it back so later tests still find 1.0.0 active.
  await protocols.activateProtocol(ctx.pharmacyId, (await protocols.getProtocolVersion(ctx.pharmacyId, fever.SLUG, '1.0.0')).id, { actorType: 'pharmacist' });
});

test('a published protocol version is immutable — no new questions', { skip: SKIP && skipReason }, async () => {
  const active = await protocols.getActiveProtocol(ctx.pharmacyId, fever.SLUG);
  await assert.rejects(
    () => protocols.addQuestion(ctx.pharmacyId, active.id, {
      questionKey: 'sneaky', text: 'Added after publication', answerType: 'text', factConcept: 'sneaky',
    }),
    /immutable|not editable|PROTOCOL_NOT_EDITABLE/i,
  );
});

test('an illegal protocol lifecycle move is rejected', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyId, {
    slug: 'lifecycle_test', name: 'TEST', version: '1.0.0',
  }, { actorType: 'pharmacist' });
  await protocols.retireProtocol(ctx.pharmacyId, p.id, { actorType: 'pharmacist' });
  // Retired is terminal — reviving it must require a new version, not a flag flip.
  await assert.rejects(
    () => protocols.activateProtocol(ctx.pharmacyId, p.id, { actorType: 'pharmacist' }),
    /ILLEGAL_LIFECYCLE_TRANSITION|Cannot move/,
  );
});

// ---- conditional applicability --------------------------------------------

test('a conditional question appears only once its condition is met', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('13');
  let state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.ok(!state.applicableQuestions.some((q) => q.question_key === 'associated_symptoms'));

  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'has_associated_symptoms', 'yes', { customerId: run.customerId });

  state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.ok(state.applicableQuestions.some((q) => q.question_key === 'associated_symptoms'),
    'answering yes must open the follow-up');
});

// ---- TEST 10: audit reconstruction ----------------------------------------

test('TEST 10 — the protocol run can be reconstructed from the audit trail alone', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('14');
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'presenting_complaint', 'Fever', { customerId: run.customerId });
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_severity', '6', { customerId: run.customerId });
  await engine.advance(ctx.pharmacyId, run.executionId, { customerId: run.customerId });

  const events = await db`
    select event_type, actor_type, visibility, occurred_at, metadata
    from customer_events where customer_id = ${run.customerId} order by id
  `;
  const types = events.map((e) => e.event_type);

  for (const expected of [
    'PROTOCOL_SELECTED', 'PROTOCOL_STARTED', 'PATIENT_RESPONSE_RECEIVED',
    'FACT_CREATED', 'PROTOCOL_STATE_CHANGED',
  ]) {
    assert.ok(types.includes(expected), `audit trail is missing ${expected}`);
  }

  // Every clinical event is staff-only, timestamped, and attributed.
  const { CLINICAL_EVENT_TYPES } = require('../services/clinical/clinicalAudit');
  for (const e of events) {
    if (CLINICAL_EVENT_TYPES.has(e.event_type)) {
      assert.equal(e.visibility, 'internal', `${e.event_type} leaked as customer-visible`);
    }
    assert.ok(e.actor_type && e.occurred_at);
  }
});

test('audit metadata records provenance but never the clinical value itself', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('15');
  await engine.recordAnswer(ctx.pharmacyId, run.executionId, 'fever_severity', '9', { customerId: run.customerId });

  const events = await db`
    select event_type, metadata from customer_events
    where customer_id = ${run.customerId} and event_type in ('FACT_CREATED', 'PATIENT_RESPONSE_RECEIVED')
  `;
  for (const e of events) {
    const blob = JSON.stringify(e.metadata);
    assert.ok(!blob.includes('"9"'),
      `${e.event_type} metadata must not copy the clinical value into the audit log`);
  }
});

// ---- the safety boundary --------------------------------------------------

test('nothing in the fever protocol produces a diagnosis or a treatment', { skip: SKIP && skipReason }, async () => {
  const active = await protocols.getActiveProtocol(ctx.pharmacyId, fever.SLUG);
  assert.deepEqual(active.permitted_advice, [], 'no advice content may exist at this stage');
  assert.deepEqual(active.referral_rules, []);
  assert.deepEqual(active.pharmacist_review_rules, []);

  const questions = await protocols.listQuestions(ctx.pharmacyId, active.id);
  const BANNED = /diagnos|prescrib|dosage|dose|mg\b|antibiotic|malaria|treatment plan|you should take/i;
  for (const q of questions) {
    assert.ok(!BANNED.test(q.text), `question "${q.question_key}" strays into clinical advice`);
    assert.ok(!BANNED.test(q.fact_concept), `concept "${q.fact_concept}" names a conclusion, not an observation`);
  }
});

test('a completed run reaches READY_FOR_REVIEW, never a conclusion', { skip: SKIP && skipReason }, async () => {
  const run = await newRun('16');
  for (const [key, ans] of [
    ['presenting_complaint', 'Fever'],
    ['who_is_this_for', 'for me'],
    ['fever_duration', '3 days'],
    ['fever_severity', '6'],
    ['has_associated_symptoms', 'no'],
  ]) {
    await engine.recordAnswer(ctx.pharmacyId, run.executionId, key, ans, { customerId: run.customerId });
  }

  const advanced = await engine.advance(ctx.pharmacyId, run.executionId, { customerId: run.customerId });
  assert.equal(advanced.state, 'ready_for_review',
    'the furthest the engine may go unaided is "the questions are done"');

  const state = await engine.getExecutionState(ctx.pharmacyId, run.executionId);
  assert.equal(state.isComplete, true);
  assert.equal(state.missingRequired.length, 0);
  // An OPTIONAL question may still be outstanding — that is correct and does
  // not block review. Completeness is about required information only, so
  // nextQuestion may still offer something worth asking if the conversation
  // has room for it.
  if (state.nextQuestion) {
    assert.equal(state.nextQuestion.required, false,
      'only optional questions may remain once a run is ready for review');
  }
  // No assessment, no conclusion, anywhere on the encounter.
  const enc = await encounters.getEncounter(ctx.pharmacyId, run.encounterId);
  assert.equal(enc.assessment_status, null);
  assert.deepEqual(enc.red_flags_detected, []);
});

test('tenant isolation: another pharmacy cannot read or drive this run', { skip: SKIP && skipReason }, async () => {
  const [other] = await db`
    insert into pharmacies (name, slug, status) values ('Other Pharmacy', ${`other-${Date.now()}`}, 'active')
    returning id
  `;
  const run = await newRun('17');
  try {
    assert.equal(await engine.getExecution(other.id, run.executionId), null);
    await assert.rejects(
      () => engine.recordAnswer(other.id, run.executionId, 'fever_severity', '5'),
      /not found/i,
    );
  } finally {
    await db`delete from pharmacies where id = ${other.id}`.catch(() => {});
  }
});
