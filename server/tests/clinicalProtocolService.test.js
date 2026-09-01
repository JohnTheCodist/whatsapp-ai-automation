/**
 * Protocol and red-flag METADATA — Stage 1. No clinical content is created
 * or asserted here, because none exists yet; these tests check versioning,
 * activation, and that duplicate versions are refused, not any medical
 * judgement.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — clinical protocols were NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const protocols = require('../services/clinical/clinicalProtocolService');

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();
  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('Protocol Test A', ${`proto-a-${Date.now()}`}, 'active')
    returning id
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('Protocol Test B', ${`proto-b-${Date.now()}`}, 'active')
    returning id
  `;
  ctx = { pharmacyA: a.id, pharmacyB: b.id };
});

after(async () => {
  if (SKIP || !db) return;
  // audit_logs.pharmacy_id is ON DELETE SET NULL, not CASCADE — deleting the
  // pharmacies first would leave these rows behind as orphaned test data
  // instead of removing them.
  await db`delete from audit_logs where pharmacy_id in (${ctx.pharmacyA}, ${ctx.pharmacyB})`.catch(() => {});
  await db`delete from pharmacies where id in (${ctx.pharmacyA}, ${ctx.pharmacyB})`.catch(() => {});
});

test('a protocol is created as metadata — no clinical content is invented alongside it', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, {
    slug: 'test_fever', name: 'TEST ONLY — Fever', version: '1.0.0', conditionDomain: 'fever',
  }, { actorType: 'pharmacist' });

  assert.equal(p.status, 'draft', 'a protocol must not be active the moment it is created');
  assert.deepEqual(p.questions, [], 'Stage 1 must not populate content — this is placeholder infrastructure only');
  assert.deepEqual(p.permitted_advice, []);
});

test('the same slug+version cannot be created twice', { skip: SKIP && skipReason }, async () => {
  await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_headache', name: 'TEST — Headache', version: '1.0.0' });
  await assert.rejects(
    () => protocols.createProtocol(ctx.pharmacyA, { slug: 'test_headache', name: 'TEST — Headache (dup)', version: '1.0.0' }),
    /already exists/i,
  );
});

test('a new version of the same slug is allowed and both remain independently retrievable (spec §9)', { skip: SKIP && skipReason }, async () => {
  await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_versioned', name: 'TEST — Versioned', version: '1.0.0' });
  await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_versioned', name: 'TEST — Versioned', version: '1.1.0' });

  const v1 = await protocols.getProtocolVersion(ctx.pharmacyA, 'test_versioned', '1.0.0');
  const v11 = await protocols.getProtocolVersion(ctx.pharmacyA, 'test_versioned', '1.1.0');
  assert.ok(v1 && v11);
  assert.notEqual(v1.id, v11.id);
});

// REWRITTEN BY STAGE 2, DELIBERATELY.
//
// This test previously asserted the opposite: that activating v2 left v1
// active too. That was Stage 1's explicit choice (see 0029's header) —
// silently demoting the incumbent looked like a policy call an
// infrastructure stage should not make. Stage 2 §1 makes that call:
// exactly one ACTIVE version per identity.
//
// The guarantee the old test was protecting has NOT been dropped, only
// moved: an old encounter must keep resolving the version it recorded.
// That is now satisfied by `deprecated` rather than by leaving two
// versions live, and is asserted below.
test('activating a new version demotes the incumbent, and the old version stays retrievable', { skip: SKIP && skipReason }, async () => {
  const v1 = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_stable', name: 'TEST — Stable', version: '1.0.0' });
  const v2 = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_stable', name: 'TEST — Stable', version: '2.0.0' });

  await protocols.activateProtocol(ctx.pharmacyA, v1.id, { actorType: 'pharmacist' });
  await protocols.activateProtocol(ctx.pharmacyA, v2.id, { actorType: 'pharmacist' });

  const v1After = await protocols.getProtocolVersion(ctx.pharmacyA, 'test_stable', '1.0.0');
  assert.equal(v1After.status, 'deprecated', 'the incumbent is demoted, not left active alongside v2');
  assert.ok(v1After, 'and it remains retrievable — an encounter that used it must still resolve it');

  const v2After = await protocols.getProtocolVersion(ctx.pharmacyA, 'test_stable', '2.0.0');
  assert.equal(v2After.status, 'active');

  const live = await db`
    select count(*)::int n from clinical_protocols
    where pharmacy_id = ${ctx.pharmacyA} and slug = 'test_stable' and status = 'active'
  `;
  assert.equal(live[0].n, 1, 'exactly one version may be active at a time');
});

test('getActiveProtocol returns the active version, not a retired one', { skip: SKIP && skipReason }, async () => {
  const v1 = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_active_pick', name: 'TEST', version: '1.0.0' });
  await protocols.activateProtocol(ctx.pharmacyA, v1.id, { actorType: 'pharmacist' });
  await protocols.retireProtocol(ctx.pharmacyA, v1.id, { actorType: 'pharmacist' });

  const active = await protocols.getActiveProtocol(ctx.pharmacyA, 'test_active_pick');
  assert.equal(active, null, 'a retired protocol must not be returned as active');
});

test('pharmacy B cannot see or activate pharmacy A\'s protocol', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_isolated', name: 'TEST', version: '1.0.0' });
  const fromB = await protocols.getActiveProtocol(ctx.pharmacyB, 'test_isolated');
  assert.equal(fromB, null);
  await assert.rejects(() => protocols.activateProtocol(ctx.pharmacyB, p.id, {}), /not found/i);
});

// ---- red flags: metadata only, active defaults false -----------------------

test('a red-flag rule starts inactive — nothing fires until a clinician turns it on', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_redflag', name: 'TEST', version: '1.0.0' });
  const rule = await protocols.createRedFlagRule(ctx.pharmacyA, p.id, { name: 'TEST — placeholder rule' });
  assert.equal(rule.active, false);
});

test('activating and deactivating a red flag is tracked', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_redflag2', name: 'TEST', version: '1.0.0' });
  const rule = await protocols.createRedFlagRule(ctx.pharmacyA, p.id, { name: 'TEST rule 2' });

  const on = await protocols.setRedFlagActive(ctx.pharmacyA, rule.id, true, { actorType: 'pharmacist' });
  assert.equal(on.active, true);
  const off = await protocols.setRedFlagActive(ctx.pharmacyA, rule.id, false, { actorType: 'pharmacist' });
  assert.equal(off.active, false);
});

test('listRedFlagsForProtocol can filter to active-only', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_redflag3', name: 'TEST', version: '1.0.0' });
  const r1 = await protocols.createRedFlagRule(ctx.pharmacyA, p.id, { name: 'active one' });
  await protocols.createRedFlagRule(ctx.pharmacyA, p.id, { name: 'inactive one' });
  await protocols.setRedFlagActive(ctx.pharmacyA, r1.id, true, {});

  const activeOnly = await protocols.listRedFlagsForProtocol(ctx.pharmacyA, p.id, { activeOnly: true });
  assert.equal(activeOnly.length, 1);
  assert.equal(activeOnly[0].id, r1.id);

  const all = await protocols.listRedFlagsForProtocol(ctx.pharmacyA, p.id, {});
  assert.equal(all.length, 2);
});

// ---- audit ------------------------------------------------------------
//
// Protocol/red-flag lifecycle has no patient attached — customer_events'
// customer_id is NOT NULL, correctly, since every other row there is a fact
// about a specific person. These go through audit_logs instead (a
// pre-existing, pharmacy-scoped table with zero prior writers) via
// clinicalAudit.recordAdminAudit — see that file's header for the reasoning.

test('protocol and red-flag lifecycle actions are recorded in the pharmacy admin audit log', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_audit', name: 'TEST', version: '1.0.0' });
  await protocols.activateProtocol(ctx.pharmacyA, p.id, { actorType: 'pharmacist' });

  const logs = await db`
    select action, actor_type from audit_logs
    where pharmacy_id = ${ctx.pharmacyA} and entity = 'clinical_protocol' and entity_id = ${p.id}
    order by id
  `;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'protocol_created');
  assert.equal(logs[1].action, 'protocol_activated');
  // audit_logs' own vocabulary has no 'pharmacist' actor_type (it predates
  // this segment) — pharmacist/staff map to its 'user', asserted here so a
  // future change to that mapping is caught rather than silently accepted.
  for (const l of logs) assert.equal(l.actor_type, 'user');
});

test('a red-flag rule\'s admin actions are recorded distinctly from its protocol\'s', { skip: SKIP && skipReason }, async () => {
  const p = await protocols.createProtocol(ctx.pharmacyA, { slug: 'test_audit2', name: 'TEST', version: '1.0.0' });
  const rule = await protocols.createRedFlagRule(ctx.pharmacyA, p.id, { name: 'TEST rule' });
  await protocols.setRedFlagActive(ctx.pharmacyA, rule.id, true, { actorType: 'pharmacist' });

  const logs = await db`
    select action from audit_logs
    where pharmacy_id = ${ctx.pharmacyA} and entity = 'red_flag_rule' and entity_id = ${rule.id}
    order by id
  `;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].action, 'red_flag_rule_created');
  assert.equal(logs[1].action, 'red_flag_rule_activated');
});
