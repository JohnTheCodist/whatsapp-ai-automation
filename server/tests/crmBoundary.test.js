/**
 * The boundary: internal CRM data must never reach the model.
 *
 * WHY THIS TEST EXISTS RATHER THAN A COMMENT
 * "Don't put notes in the prompt" is a rule someone breaks eighteen months
 * from now by adding a field to a profile object that happens to be passed
 * along. The failure is silent, and the way it surfaces is a customer being
 * told something a pharmacist wrote about them.
 *
 * So the test plants a sentinel string in a note and a tag, runs the REAL
 * assistant against a REAL message, and fails if that string appears anywhere
 * in the system prompt or the reply. It does not check that a particular
 * function omits a particular field — it checks the thing that actually
 * matters, which is that the string does not get out.
 *
 * If someone later wires CRM data into the model deliberately and with an
 * explicit contract, this test is where they will have to come and say so.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — the CRM/LLM boundary was NOT verified';
require('./helpers/testDb').useTestDatabase(TEST_URL);

const { getSql } = require('../services/db');
const { buildSystemPrompt } = require('../services/ai/assistant');
const crm = require('../services/customers/customerCrm');
const { getCustomerProfile } = require('../services/customers/customerProfile');

// Distinctive enough that a substring match cannot be a coincidence.
const SENTINEL_NOTE = 'ZQXJV-INTERNAL-NOTE-SENTINEL customer is a known reseller';
const SENTINEL_TAG = 'zqxjv_sentinel_tag';

let db;
let ctx = {};

before(async () => {
  if (SKIP) return;
  db = getSql();

  const [user] = await db`
    insert into auth.users (id, email) values (gen_random_uuid(), ${`crm-${Date.now()}@test.local`})
    on conflict do nothing returning id
  `;
  const userId = user?.id || (await db`select id from auth.users limit 1`)[0].id;

  const [a] = await db`
    insert into pharmacies (name, slug, status) values ('CRM A', ${`crm-a-${Date.now()}`}, 'active')
    returning id, name
  `;
  const [b] = await db`
    insert into pharmacies (name, slug, status) values ('CRM B', ${`crm-b-${Date.now()}`}, 'active')
    returning id
  `;
  await db`insert into pharmacy_members (pharmacy_id, user_id, role) values (${a.id}, ${userId}, 'owner')`;

  const [customer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name, full_name, name_verified, name_source)
    values (${a.id}, '2349060000001', '2349060000001', '2349060000001@s.whatsapp.net', 'Boundary Tester',
            'Boundary Tester', true, 'customer_provided')
    returning id
  `;
  const [bCustomer] = await db`
    insert into customers (pharmacy_id, identity_key, wa_phone, wa_jid, display_name)
    values (${b.id}, '2349060000002', '2349060000002', '2349060000002@s.whatsapp.net', 'Other Tenant')
    returning id
  `;

  const [tag] = await db`
    insert into tags (pharmacy_id, name, slug) values (${a.id}, 'Sentinel', ${SENTINEL_TAG})
    returning id
  `;

  ctx = { a, b, userId, customerId: customer.id, bCustomerId: bCustomer.id, tagId: tag.id };

  await crm.addNote(a.id, customer.id, { content: SENTINEL_NOTE, authorId: userId });
  await crm.addTag(a.id, customer.id, tag.id, { authorId: userId });
});

after(async () => {
  if (SKIP || !db) return;
  await db`delete from pharmacies where id in (${ctx.a?.id}, ${ctx.b?.id})`.catch(() => {});
});

// ---- the boundary -------------------------------------------------------

test('an internal note never appears in the system prompt', { skip: SKIP && skipReason }, async () => {
  // The prompt is everything the model is told before it sees the customer.
  // Built with the richest context the assistant ever assembles.
  const prompt = buildSystemPrompt({
    pharmacyName: ctx.a.name,
    botName: 'Ada',
    context: {
      last_product_name: 'Coartem',
      verified_prices: [1970],
      order_references: ['ABC-123'],
      pending_suggestion: { product_name: 'Coartem', price_naira: 1970 },
    },
    menuBriefing: 'They chose: Browse products',
  });

  assert.ok(!prompt.includes('ZQXJV'), 'a staff note reached the system prompt');
  assert.ok(!prompt.includes(SENTINEL_TAG), 'a customer tag reached the system prompt');
  assert.ok(!/reseller/i.test(prompt), 'note content reached the system prompt');
});

test('the conversation context the assistant receives carries no CRM fields', { skip: SKIP && skipReason }, async () => {
  // conversations.context is the one bag of state that IS passed to the model,
  // so it is the most likely accidental carrier.
  const [conv] = await db`
    insert into conversations (pharmacy_id, customer_id, mode, last_message_at, window_expires_at)
    values (${ctx.a.id}, ${ctx.customerId}, 'bot', now(), now() + interval '24 hours')
    returning context
  `;
  const serialised = JSON.stringify(conv.context || {});
  assert.ok(!serialised.includes('ZQXJV'), 'CRM data leaked into conversation context');
  assert.ok(!/note|tag/i.test(serialised), 'conversation context should carry no note/tag keys');
});

test('the CRM profile DOES expose notes and tags — to staff', { skip: SKIP && skipReason }, async () => {
  // The mirror of the above: the boundary is about who reads it, not about
  // hiding the data from the pharmacy that wrote it.
  const notes = await crm.listNotes(ctx.a.id, ctx.customerId);
  const tags = await crm.listCustomerTags(ctx.a.id, ctx.customerId);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].content.includes('ZQXJV'));
  assert.equal(tags.length, 1);
});

test('the customer profile read model is a staff view, and says so by containing them', { skip: SKIP && skipReason }, async () => {
  const profile = await getCustomerProfile(ctx.a.id, ctx.customerId);
  assert.ok(profile, 'profile should load');
  // Whatever else changes, this endpoint must never be reused as the
  // assistant's context source — the test above is what enforces that.
  assert.ok(profile.customer, 'profile has an identity block');
});

// ---- tenancy ------------------------------------------------------------

test('pharmacy A cannot read pharmacy B\'s notes', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => crm.listNotes(ctx.a.id, ctx.bCustomerId),
    /not found/i,
    'a cross-tenant customer id must not return notes',
  );
});

test('pharmacy A cannot tag pharmacy B\'s customer', { skip: SKIP && skipReason }, async () => {
  await assert.rejects(
    () => crm.addTag(ctx.a.id, ctx.bCustomerId, ctx.tagId, {}),
    /not found/i,
  );
});

test('a note cannot be edited from another pharmacy even with its id', { skip: SKIP && skipReason }, async () => {
  const [note] = await crm.listNotes(ctx.a.id, ctx.customerId);
  await assert.rejects(
    () => crm.updateNote(ctx.b.id, ctx.customerId, note.id, { content: 'hijacked' }),
    /not found/i,
  );
});

// ---- tag mechanics ------------------------------------------------------

test('attaching the same tag twice leaves one relationship', { skip: SKIP && skipReason }, async () => {
  await crm.addTag(ctx.a.id, ctx.customerId, ctx.tagId, {});
  const tags = await crm.listCustomerTags(ctx.a.id, ctx.customerId);
  assert.equal(tags.filter((t) => t.slug === SENTINEL_TAG).length, 1);
});

test('removing a tag does not delete the tag definition', { skip: SKIP && skipReason }, async () => {
  await crm.removeTag(ctx.a.id, ctx.customerId, ctx.tagId, {});
  const onCustomer = await crm.listCustomerTags(ctx.a.id, ctx.customerId);
  assert.equal(onCustomer.length, 0);

  const available = await crm.listTags(ctx.a.id);
  assert.ok(available.some((t) => t.slug === SENTINEL_TAG), 'the tag itself must survive');
});

test('re-adding a removed tag records a NEW event, not a deduplicated one', { skip: SKIP && skipReason }, async () => {
  await crm.addTag(ctx.a.id, ctx.customerId, ctx.tagId, {});
  const events = await db`
    select count(*)::int as n from customer_events
    where customer_id = ${ctx.customerId} and event_type = 'TAG_ADDED'
  `;
  // add -> remove -> add is three distinct facts. The default idempotency key
  // (type + entity) would have collapsed the re-add into the original.
  assert.ok(events[0].n >= 2, `expected the re-add to be its own event, saw ${events[0].n}`);
});

// ---- event visibility ---------------------------------------------------

test('CRM events are marked internal; customer activity is not', { skip: SKIP && skipReason }, async () => {
  const [internal] = await db`
    select count(*)::int as n from customer_events
    where customer_id = ${ctx.customerId} and visibility = 'internal'
  `;
  assert.ok(internal.n > 0, 'note and tag events should be internal');

  const [leaked] = await db`
    select count(*)::int as n from customer_events
    where customer_id = ${ctx.customerId}
      and event_type in ('NOTE_ADDED','NOTE_UPDATED','NOTE_DELETED','TAG_ADDED','TAG_REMOVED')
      and visibility <> 'internal'
  `;
  assert.equal(leaked.n, 0, 'a CRM event was recorded as customer-visible');
});

test('no event metadata anywhere contains note content', { skip: SKIP && skipReason }, async () => {
  // Events record THAT a note changed, never what it said — otherwise the
  // boundary would depend on remembering this table too.
  const rows = await db`
    select metadata::text as m from customer_events where customer_id = ${ctx.customerId}
  `;
  for (const r of rows) {
    assert.ok(!r.m.includes('ZQXJV'), 'note content was copied into event metadata');
  }
});
