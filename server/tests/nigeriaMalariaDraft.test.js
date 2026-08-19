/**
 * nigeria_malaria_assessment v1.0.0 — the DRAFT protocol's safety envelope.
 *
 * These tests exist to make the protocol's restrictions structural rather
 * than a matter of anyone remembering the reasoning. If a future change
 * activates this protocol, approves its evidence, or attaches a medication
 * recommendation, these fail loudly.
 *
 * The reasoning they protect (see the module header and
 * docs/clinical/malaria-consolidated-extraction-v2.md):
 *   - Nigeria STG 2022 requires parasitological confirmation BEFORE treatment,
 *     which a WhatsApp channel cannot obtain.
 *   - CONFLICT-009: the source's severe-anaemia threshold has an inverted sign.
 *   - CONFLICT-011: STG and WHO 2025 differ on first-trimester ACT selection.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the malaria draft protocol was NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const { getSql } = require('../services/db');
const malaria = require('../services/clinical/protocols/nigeriaMalariaAssessmentV1');
const protocols = require('../services/clinical/clinicalProtocolService');
const recommendations = require('../services/clinical/recommendationService');
const evidence = require('../services/clinical/evidenceService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [p] = await db`
    insert into pharmacies (name, slug, status) values ('Malaria Draft Test', ${`mal-draft-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyId: p.id };
  ctx.protocol = await malaria.install(ctx.pharmacyId, { actorType: 'system' });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from audit_logs where pharmacy_id = ${ctx.pharmacyId}`.catch(() => {});
  await db`delete from pharmacies where id = ${ctx.pharmacyId}`.catch(() => {});
});

// ---- the four things that must never change quietly ---------------------

test('the protocol installs as DRAFT and is NOT active', { skip: SKIP && skipReason }, async () => {
  assert.equal(ctx.protocol.status, 'draft');

  const active = await protocols.getActiveProtocol(ctx.pharmacyId, malaria.SLUG);
  assert.equal(active, null, 'nigeria_malaria_assessment must not resolve as an active protocol');
});

test('NO medication recommendation exists for this protocol', { skip: SKIP && skipReason }, async () => {
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  assert.equal(recs.length, 0,
    'the source guideline requires a parasitological test before treatment, which this channel cannot obtain');
});

test('every evidence source is created DRAFT — the installer cannot approve its own evidence', { skip: SKIP && skipReason }, async () => {
  const sources = await db`
    select source_key, status, origin, strength from evidence_sources
    where pharmacy_id = ${ctx.pharmacyId} order by source_key
  `;
  assert.equal(sources.length, 3, 'STG 2022, NEML 2024 and WHO 2025 should all be registered');
  for (const s of sources) {
    assert.equal(s.status, 'draft', `${s.source_key} must await a human approval`);
  }
});

test('an automated actor is refused when it tries to approve a source', { skip: SKIP && skipReason }, async () => {
  const src = await evidence.getSourceByKey(ctx.pharmacyId, 'nigeria_stg_2022', '2022');
  assert.ok(src, 'the STG source should have been registered by install()');
  await assert.rejects(
    () => evidence.approveSource(ctx.pharmacyId, src.id, { actorType: 'ai' }),
    /pharmacist or staff/i,
  );
});

test('every red flag is created INACTIVE', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  assert.ok(flags.length >= 17, 'all STG p242 severe-malaria features should be registered');
  for (const f of flags) {
    assert.equal(f.active, false, `${f.name} must not fire until a clinician activates it`);
  }
});

// ---- the two unresolved conflicts stay visibly unresolved ----------------

test('CONFLICT-009 — the severe anaemia flag carries no usable threshold', { skip: SKIP && skipReason }, async () => {
  const flags = await protocols.listRedFlagsForProtocol(ctx.pharmacyId, ctx.protocol.id, {});
  const anaemia = flags.find((f) => /severe anaemia/i.test(f.name));
  assert.ok(anaemia, 'the flag must exist so a pharmacist sees the complete STG list');
  assert.match(anaemia.name, /THRESHOLD UNRESOLVED/,
    'its name must say the threshold is unresolved, not silently imply a value');
  assert.match(anaemia.description, /NOT MACHINE-EVALUABLE/);
  assert.match(anaemia.source_reference, /inverts the sign|NOT confirmed/i,
    'and must record WHY, so nobody "fixes" it by guessing');
});

test('CONFLICT-011 — pregnancy is asked in order to escalate, not to pick a medicine', { skip: SKIP && skipReason }, async () => {
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const preg = questions.find((q) => q.question_key === 'pregnancy_status');
  assert.ok(preg, 'pregnancy status must be collected');

  const rule = malaria.DEFINITION.escalationRules.find((r) => /pregnan/i.test(r.trigger));
  assert.ok(rule, 'a pregnancy escalation rule must be declared');
  assert.equal(rule.action, 'PHARMACIST_REVIEW');
  assert.match(rule.cite, /CONFLICT-011/);
});

// ---- the questions themselves -------------------------------------------

test('the severe-features screen offers every patient-reportable STG feature', { skip: SKIP && skipReason }, async () => {
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const screen = questions.find((q) => q.question_key === 'severe_features_screen');
  assert.ok(screen);
  const values = (screen.choices || []).map((c) => c.value);
  for (const expected of [
    'impaired_consciousness', 'convulsions', 'respiratory_distress',
    'failure_to_feed', 'prostration', 'jaundice', 'abnormal_bleeding', 'haemoglobinuria',
  ]) {
    assert.ok(values.includes(expected), `severe feature "${expected}" must be screenable`);
  }
  assert.ok(values.includes('none'), 'and the patient must be able to say none apply');
});

test('the convulsion count is only asked when convulsions were reported', { skip: SKIP && skipReason }, async () => {
  const { isApplicable } = require('../services/clinical/protocolExecutionService');
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const q = questions.find((x) => x.question_key === 'convulsion_count');
  assert.ok(q.applicability, 'it must be conditional, not asked of everyone');

  // EVALUATED, not merely shape-asserted. The earlier version of this test
  // checked only that the applicability JSON mentioned "convulsions" — and
  // passed while the `contains` operator it relies on was unimplemented, so
  // the conditional could never fire. Asserting a rule's shape proves nothing
  // about whether the rule runs.
  const withConvulsions = new Map([
    ['severe_malaria_features_reported', { value: 'convulsions,jaundice', status: 'active', value_number: null }],
  ]);
  const without = new Map([
    ['severe_malaria_features_reported', { value: 'jaundice', status: 'active', value_number: null }],
  ]);

  assert.equal(isApplicable(q.applicability, withConvulsions), true,
    'must be asked when convulsions were selected');
  assert.equal(isApplicable(q.applicability, without), false,
    'and must NOT be asked otherwise');
});

test('weight is collected to route, and no dosing rule consumes it', { skip: SKIP && skipReason }, async () => {
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const w = questions.find((x) => x.question_key === 'patient_weight_band');
  assert.ok(w, 'weight band should be collected for the pharmacist');
  assert.equal(w.required, false, 'but never required — an unknown weight must not block triage');

  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  assert.equal(recs.length, 0, 'and nothing computes a dose from it');
});

test('the test-status question exists so the pharmacist knows, not so the system proceeds', { skip: SKIP && skipReason }, async () => {
  const questions = await protocols.listQuestions(ctx.pharmacyId, ctx.protocol.id);
  const q = questions.find((x) => x.question_key === 'malaria_test_done');
  assert.ok(q);
  const values = (q.choices || []).map((c) => c.value);
  assert.deepEqual(values.sort(), ['negative', 'not_done', 'pending', 'positive']);

  // A positive test still leads nowhere automated, because no recommendation
  // is configured. This is the structural guarantee, restated.
  const recs = await recommendations.listRecommendations(ctx.pharmacyId, ctx.protocol.id, {});
  assert.equal(recs.length, 0);
});

// ---- traceability --------------------------------------------------------

test('every registered source carries its origin and strength for the hierarchy', { skip: SKIP && skipReason }, async () => {
  const stg = await evidence.getSourceByKey(ctx.pharmacyId, 'nigeria_stg_2022', '2022');
  const who = await evidence.getSourceByKey(ctx.pharmacyId, 'who_malaria_2025_08_13', '2025-08-13');

  assert.equal(stg.origin, 'nigerian_guidance');
  assert.equal(who.origin, 'global_guidance',
    'WHO 2025 is global guidance despite the misleading filename — it must not outrank Nigerian guidance');
});

test('the superseded WHO 2015 edition is NOT registered as a source', { skip: SKIP && skipReason }, async () => {
  const sources = await db`
    select source_key from evidence_sources where pharmacy_id = ${ctx.pharmacyId}
  `;
  const keys = sources.map((s) => s.source_key);
  assert.ok(!keys.some((k) => /2015|3rd/.test(k)),
    'the superseded 2015 edition must not be citable as current evidence');
});

test('the inadmissible slide deck is not registered as a source', { skip: SKIP && skipReason }, async () => {
  const sources = await db`
    select source_key, title from evidence_sources where pharmacy_id = ${ctx.pharmacyId}
  `;
  for (const s of sources) {
    assert.ok(!/slide|deck|antimalaria_treatment_guidelines/i.test(s.source_key),
      'the unattributed deck must never enter the evidence store');
  }
});

test('install is idempotent — a second call does not duplicate anything', { skip: SKIP && skipReason }, async () => {
  const again = await malaria.install(ctx.pharmacyId, { actorType: 'system' });
  assert.equal(again.id, ctx.protocol.id);

  const [count] = await db`
    select count(*)::int n from clinical_protocols
    where pharmacy_id = ${ctx.pharmacyId} and slug = ${malaria.SLUG}
  `;
  assert.equal(count.n, 1);
});
