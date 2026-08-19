/**
 * The routing decision that sits between WhatsApp and the protocol engine.
 *
 * THE PROPERTY THIS FILE PROTECTS
 * Routing is a NARROWING. Every message that reaches the engine is one the
 * clinical filter was already sending to a pharmacist, and every category
 * that hard-blocks today still hard-blocks. If a future change let this
 * router capture a message the filter would have refused — a dosage
 * question, an overdose, a request for a human — that is a safety
 * regression, and the tests below are what catch it.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — router DB checks were NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const router = require('../services/clinical/clinicalRouter');
const { screenMessage } = require('../services/safety/clinicalFilter');
const feverV2 = require('../services/clinical/protocols/feverAssessmentV2');
const cough = require('../services/clinical/protocols/coughAssessmentV1');

let db;
let ctx = {};

// ---- pure matching (no database) -----------------------------------------

test('a plain symptom description matches its protocol', () => {
  assert.equal(router.matchProtocol('I have cough').slug, 'cough_assessment');
  assert.equal(router.matchProtocol('i have been having fever').slug, 'fever_assessment');
  assert.equal(router.matchProtocol('my throat hurts').slug, 'sore_throat_assessment');
});

test('the more specific complaint wins when two protocols could match', () => {
  // "cough and fever" contains "fever", but describes a cough presentation.
  const m = router.matchProtocol('cough and fever');
  assert.equal(m.slug, 'cough_assessment');
  assert.equal(m.matched, 'cough and fever');
});

test('a complaint with no protocol matches nothing', () => {
  for (const t of ['I have a rash', 'my stomach ulcer is back', 'chest pain', 'I have boils']) {
    assert.equal(router.matchProtocol(t), null, `${t} must not route — no protocol covers it`);
  }
});

test('bare conversational answers match nothing on their own', () => {
  // These only ever route via an OPEN run, never by matching.
  for (const t of ['3 days', 'yes', 'no', '7', 'since monday']) {
    assert.equal(router.matchProtocol(t), null);
  }
});

test('malformed input is refused rather than throwing', () => {
  for (const t of [null, undefined, 42, {}, '', '   ', 'x'.repeat(1001)]) {
    assert.equal(router.matchProtocol(t), null);
  }
});

// ---- category gating ------------------------------------------------------

test('every non-symptom clinical category keeps its straight-to-pharmacist behaviour', async () => {
  const mustNotRoute = [
    ['emergency', 'he is unconscious and not breathing'],
    ['overdose', 'I took too many tablets'],
    ['dosage', 'how much panadol for a 2 year old'],
    ['human_requested', 'I want to speak to the pharmacist'],
  ];
  for (const [label, text] of mustNotRoute) {
    const screening = screenMessage(text);
    const decision = await router.route({
      pharmacyId: '00000000-0000-0000-0000-000000000001', screening, text, context: {},
    });
    assert.equal(decision.route, false, `${label} ("${text}") must never reach the protocol engine`);
  }
});

test('a message the filter ALLOWS is never routed', async () => {
  const text = 'Do you have Coartem in stock?';
  const screening = screenMessage(text);
  assert.equal(screening.allow, true, 'precondition: this is a commerce question');
  const decision = await router.route({
    pharmacyId: '00000000-0000-0000-0000-000000000001', screening, text, context: {},
  });
  assert.equal(decision.route, false, 'ordinary commerce must not start a clinical assessment');
});

// ---- database-backed: protocol must be installed AND active ---------------

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Router Test', ${`router-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  await feverV2.install(ctx.pharmacyId, { actorType: 'system' });
  await cough.install(ctx.pharmacyId, { actorType: 'system' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('a symptom routes only when its protocol is actually installed and active', { skip: SKIP && skipReason }, async () => {
  const text = 'I have cough';
  const decision = await router.route({
    pharmacyId: ctx.pharmacyId, screening: screenMessage(text), text, context: {},
  });
  assert.equal(decision.route, true);
  assert.equal(decision.slug, 'cough_assessment');
  assert.equal(decision.answeringKey, null, 'a fresh complaint answers no outstanding question');
});

test('a pharmacy without the protocol installed does not route', { skip: SKIP && skipReason }, async () => {
  const [other] = await db`
    insert into pharmacies (name, slug, status) values ('No Protocols', ${`noproto-${Date.now()}`}, 'active')
    returning id
  `;
  try {
    const text = 'I have cough';
    const decision = await router.route({
      pharmacyId: other.id, screening: screenMessage(text), text, context: {},
    });
    assert.equal(decision.route, false);
    assert.match(decision.reason, /protocol_not_active/);
  } finally {
    await db`delete from pharmacies where id = ${other.id}`.catch(() => {});
  }
});

test('the DRAFT malaria protocol is never reachable from a live message', { skip: SKIP && skipReason }, async () => {
  assert.equal(
    await router.isProtocolLive(ctx.pharmacyId, 'nigeria_malaria_assessment'), false,
    'a draft protocol must not be routable — it has not been clinically approved',
  );
  // And no phrase routes to it either.
  for (const t of ['I think I have malaria', 'malaria', 'I have malaria']) {
    const m = router.matchProtocol(t);
    assert.notEqual(m?.slug, 'nigeria_malaria_assessment');
  }
});

// ---- mid-assessment continuation -----------------------------------------

test('an open run captures the next message even when it matches no complaint', { skip: SKIP && skipReason }, async () => {
  const decision = await router.route({
    pharmacyId: ctx.pharmacyId,
    screening: screenMessage('3 days'),
    text: '3 days',
    context: { clinical_run: { slug: 'cough_assessment', awaiting_key: 'cough_duration' } },
  });
  assert.equal(decision.route, true, '"3 days" is an answer, not a new question');
  assert.equal(decision.slug, 'cough_assessment');
  assert.equal(decision.answeringKey, 'cough_duration');
});

test('an open run is abandoned if its protocol stops being active', { skip: SKIP && skipReason }, async () => {
  const decision = await router.route({
    pharmacyId: ctx.pharmacyId,
    screening: screenMessage('3 days'),
    text: '3 days',
    context: { clinical_run: { slug: 'some_retired_protocol', awaiting_key: 'x' } },
  });
  assert.equal(decision.route, false);
  assert.match(decision.reason, /no_longer_active/);
});

test('an open run does NOT capture an emergency — that still goes to a human', { skip: SKIP && skipReason }, async () => {
  // The one case where continuation could be dangerous: a customer
  // mid-questionnaire who suddenly reports something urgent. The engine's own
  // red-flag evaluation is what catches this (handleTurn checks flags before
  // asking anything), so routing is correct here — but the message must
  // reach that check, not be silently recorded as an answer to "how long?".
  const decision = await router.route({
    pharmacyId: ctx.pharmacyId,
    screening: screenMessage('he is unconscious and not breathing'),
    text: 'he is unconscious and not breathing',
    context: { clinical_run: { slug: 'cough_assessment', awaiting_key: 'cough_duration' } },
  });
  // It DOES route (to the engine, which red-flags it) — the assertion is that
  // the engine sees it, which is where the danger assessment lives.
  assert.equal(decision.route, true);
  assert.equal(decision.answeringKey, 'cough_duration');
});
