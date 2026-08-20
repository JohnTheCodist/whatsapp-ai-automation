/**
 * Red flags must fire on what the PATIENT SAID, not on their existence.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT EVER RETURNING
 * Rules had no trigger (0036), so the only reader could return "all active
 * rules", and handleTurn escalated whenever that list was non-empty. fever
 * v2 installs eight active flags — so every first message, "I have fever"
 * included, produced an immediate EMERGENCY referral before a single
 * question was asked. A protocol with no flags had the opposite failure and
 * never escalated at all.
 *
 * The single most important assertion here is the first one: a patient who
 * reports NO danger signs must fire NOTHING, even though eight rules are
 * active and configured.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — red flag evaluation was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const { evaluateRedFlags, containsValue } = require('../services/clinical/redFlagEvaluator');
const feverV2 = require('../services/clinical/protocols/feverAssessmentV2');

let db;
let ctx = {};

/** Shape getExecutionState produces: concept -> fact row. */
function facts(pairs) {
  return new Map(Object.entries(pairs).map(([k, v]) => [k, { concept: k, value: v }]));
}

// ---- pure containment -----------------------------------------------------

test('containsValue handles arrays, delimited strings and scalars', () => {
  assert.equal(containsValue(['convulsions', 'fever'], 'convulsions'), true);
  assert.equal(containsValue('convulsions,cannot_drink', 'cannot_drink'), true);
  assert.equal(containsValue('convulsions', 'convulsions'), true);
  assert.equal(containsValue(['none'], 'convulsions'), false);
  assert.equal(containsValue('none', 'convulsions'), false);
});

test('containsValue is not fooled by substrings', () => {
  // "drink" must not match "cannot_drink" — a partial match here would fire
  // an emergency referral on an unrelated answer.
  assert.equal(containsValue(['cannot_drink'], 'drink'), false);
  assert.equal(containsValue(['none_of_these'], 'none'), false);
});

test('containsValue tolerates whitespace and case', () => {
  assert.equal(containsValue([' Convulsions '], 'convulsions'), true);
  assert.equal(containsValue('CANNOT_DRINK, none', 'cannot_drink'), true);
});

// ---- against a real protocol ---------------------------------------------

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('RedFlag Test', ${`redflag-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  const protocol = await feverV2.install(ctx.pharmacyId, { actorType: 'system' });
  ctx.protocolId = protocol.id;
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

test('THE REGRESSION: a patient reporting no danger signs fires NOTHING', { skip: SKIP && skipReason }, async () => {
  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
    danger_signs_reported: ['none'],
  }));
  assert.ok(res.evaluated >= 8, 'precondition: the protocol really does have active rules configured');
  assert.deepEqual(res.fired, [], 'eight active rules must produce zero firings for a patient with no danger signs');
});

test('an unanswered danger screen fires nothing — absence of information is not danger', { skip: SKIP && skipReason }, async () => {
  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({}));
  assert.deepEqual(res.fired, [], 'before the screen is answered, nothing may fire');
  assert.ok(res.evaluated >= 8);
});

test('a reported danger sign fires exactly the matching rule', { skip: SKIP && skipReason }, async () => {
  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
    danger_signs_reported: ['convulsions'],
  }));
  assert.equal(res.fired.length, 1, 'one sign must fire one rule, not all of them');
  assert.match(res.fired[0].name, /convulsion/i);
  assert.equal(res.fired[0].severity, 'emergency');
  assert.equal(res.fired[0].action, 'emergency_referral');
});

test('multiple danger signs fire multiple rules, most serious first', { skip: SKIP && skipReason }, async () => {
  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
    danger_signs_reported: ['convulsions', 'cannot_drink', 'neck_stiffness'],
  }));
  assert.equal(res.fired.length, 3);
  const RANK = { emergency: 3, urgent: 2, review: 1 };
  for (let i = 1; i < res.fired.length; i += 1) {
    assert.ok(RANK[res.fired[i - 1].severity] >= RANK[res.fired[i].severity]);
  }
});

test('a fired rule carries its provenance for the pharmacist briefing', { skip: SKIP && skipReason }, async () => {
  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
    danger_signs_reported: ['neck_stiffness'],
  }));
  assert.equal(res.fired.length, 1);
  assert.ok(res.fired[0].source, 'a flag that escalates a patient must say where it came from');
  // neck_stiffness is the one flagged as NOT an STG severe-malaria feature.
  assert.match(res.fired[0].source, /REQUIRES_REVIEW/i);
});

test('an inactive rule never fires even when its trigger is reported', { skip: SKIP && skipReason }, async () => {
  const protocols = require('../services/clinical/clinicalProtocolService');
  const [rule] = await db`
    select id from protocol_red_flags
    where protocol_id = ${ctx.protocolId} and trigger_value = 'prostration'
  `;
  await protocols.setRedFlagActive(ctx.pharmacyId, rule.id, false, { actorType: 'pharmacist' });
  try {
    const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
      danger_signs_reported: ['prostration'],
    }));
    assert.deepEqual(res.fired, [], 'a deactivated rule must stay silent');
  } finally {
    await protocols.setRedFlagActive(ctx.pharmacyId, rule.id, true, { actorType: 'pharmacist' });
  }
});

test('a rule with no trigger configured is INERT, not always-on', { skip: SKIP && skipReason }, async () => {
  const protocols = require('../services/clinical/clinicalProtocolService');
  const created = await protocols.createRedFlagRule(ctx.pharmacyId, ctx.protocolId, {
    name: 'TEST ONLY — unconfigured rule with no trigger',
    severity: 'emergency', action: 'emergency_referral',
  }, { actorType: 'pharmacist' });
  await protocols.setRedFlagActive(ctx.pharmacyId, created.id, true, { actorType: 'pharmacist' });

  const res = await evaluateRedFlags(ctx.pharmacyId, ctx.protocolId, facts({
    danger_signs_reported: ['none'],
  }));
  assert.deepEqual(res.fired, [], 'an unconfigured rule must not escalate a patient');
  assert.ok(
    res.inert.some((i) => /unconfigured rule/.test(i.name)),
    'but it must be reported as inert so a reviewer can see it needs finishing',
  );
});

test('tenant isolation: another pharmacy cannot evaluate this protocol', { skip: SKIP && skipReason }, async () => {
  const [other] = await db`
    insert into pharmacies (name, slug, status) values ('Other RF', ${`otherrf-${Date.now()}`}, 'active')
    returning id
  `;
  try {
    const res = await evaluateRedFlags(other.id, ctx.protocolId, facts({
      danger_signs_reported: ['convulsions'],
    }));
    assert.equal(res.evaluated, 0, 'pharmacy B must see none of pharmacy A\'s rules');
    assert.deepEqual(res.fired, []);
  } finally {
    await db`delete from pharmacies where id = ${other.id}`.catch(() => {});
  }
});
