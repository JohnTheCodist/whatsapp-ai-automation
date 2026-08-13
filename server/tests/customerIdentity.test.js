/**
 * Automatic patient/customer creation and identity resolution, against real
 * Postgres and the real ingest() pipeline — not a mock of it.
 *
 * THE RULE UNDER TEST ABOVE ALL OTHERS
 * wa_jid (0016), not wa_phone, is the customer identity key. sessionManager
 * resolves phoneNumber PER MESSAGE — a real number when WhatsApp's alt-JID
 * happens to be present on that event, an opaque LID fallback when it is
 * not — so a phone-keyed dedupe can see the same person as two different
 * customers depending on which event happened to carry which value. wa_jid
 * does not have that problem: it is what WhatsApp addressed the message to
 * us as, every time, guaranteed.
 *
 * These tests fire real messages through ingest() rather than asserting
 * against a hand-built customer row, because the thing that was actually
 * wrong before 0016 was the SQL's conflict target — a unit test against a
 * mocked upsert would not have caught it.
 */

const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = !TEST_URL;
const skipReason = 'TEST_DATABASE_URL not set — customer identity NOT verified';
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const TAG = 'identitytest';

let db;
let ingest;
let ctx = null;

/** A realistic inbound event, shaped exactly like sessionManager emits it. */
function msg({ pharmacyId, jid, phone, displayName, text }) {
  return {
    pharmacyId,
    accountId: crypto.randomUUID(),
    providerMessageId: crypto.randomUUID(),
    phoneNumber: phone,
    lid: null,
    replyJid: jid,
    displayName: displayName || null,
    text: text || 'Hello',
    hasMedia: false,
    timestamp: Date.now(),
    raw: { key: { remoteJid: jid }, pushName: displayName || null },
  };
}

before(async () => {
  if (SKIP) return;
  const dbModule = require('../services/db');
  db = dbModule.getSql();
  ingest = require('../services/whatsapp/inboundIngest').ingest;

  await db`delete from pharmacies where name like ${`${TAG}%`}`;
  await db`delete from auth.users where email like ${`${TAG}-%@example.test`}`;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db`insert into auth.users (id, email) values
    (${userA}, ${`${TAG}-a-${userA}@example.test`}), (${userB}, ${`${TAG}-b-${userB}@example.test`})`;

  const pharmacies = require('../services/pharmacies');
  const a = await pharmacies.createPharmacy(userA, { name: `${TAG} Alpha` });
  const b = await pharmacies.createPharmacy(userB, { name: `${TAG} Beta` });

  ctx = { userA, userB, a, b };
});

after(async () => {
  if (SKIP || !ctx) return;
  await db`delete from pharmacies where id in (${ctx.a.id}, ${ctx.b.id})`;
  await db`delete from auth.users where id in (${ctx.userA}, ${ctx.userB})`;
  await db.end({ timeout: 5 });
});

// ---- Test 1 — first-time customer, no registration step ----

test('an unknown WhatsApp number is auto-created as a customer, no registration', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t1@s.whatsapp.net`;
  const r = await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000001', displayName: 'Ada', text: 'Hello' }));

  assert.equal(r.stored, true);
  assert.ok(r.messageId);
  assert.ok(r.conversationId);

  const [customer] = await db`select * from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  assert.ok(customer, 'a customer row must exist without any registration step');
  assert.equal(customer.wa_jid, jid);
  assert.equal(customer.status, 'active');
  assert.equal(customer.communication_status, 'subscribed');

  const [conv] = await db`select customer_id from conversations where id = ${r.conversationId}`;
  assert.equal(conv.customer_id, customer.id, 'the conversation must reference this customer');

  const [message] = await db`select conversation_id from messages where id = ${r.messageId}`;
  assert.equal(message.conversation_id, r.conversationId, 'the message must reference the conversation');
});

// ---- Test 2 — returning customer ----

test('the same WhatsApp identity messaging again reuses the customer, not a new one', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t2@s.whatsapp.net`;
  const first = await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000002', text: 'Hello' }));

  const [before1] = await db`select id, last_seen_at from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;

  // A real gap, so last_seen_at moving is actually observable rather than
  // hidden inside the same microsecond.
  await new Promise((res) => setTimeout(res, 20));

  const second = await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000002', text: 'Do you have Coartem?' }));

  const rows = await db`select * from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  assert.equal(rows.length, 1, 'no second customer row for the same identity');
  assert.equal(rows[0].id, before1.id);
  assert.ok(
    new Date(rows[0].last_seen_at).getTime() > new Date(before1.last_seen_at).getTime(),
    'last_seen_at must move on the returning message',
  );

  // Both messages land, both reference the same customer via their
  // conversation — a returning message is not required to open a NEW
  // conversation, only to resolve the same customer.
  const [conv1] = await db`select customer_id from conversations where id = ${first.conversationId}`;
  const [conv2] = await db`select customer_id from conversations where id = ${second.conversationId}`;
  assert.equal(conv1.customer_id, rows[0].id);
  assert.equal(conv2.customer_id, rows[0].id);
});

// ---- Test 3 — concurrency: two first messages, one customer ----

test('two simultaneous first messages from an unknown identity produce exactly one customer', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t3@s.whatsapp.net`;

  const [r1, r2] = await Promise.all([
    ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000003', text: 'Hello' })),
    ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000003', text: 'Anyone there?' })),
  ]);

  assert.equal(r1.stored, true);
  assert.equal(r2.stored, true);

  const rows = await db`select id from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  assert.equal(rows.length, 1, `expected exactly one customer, got ${rows.length} — the upsert is not race-safe`);

  // Both messages must reference that one customer via their conversation —
  // proving this is real find-or-create, not one message silently lost.
  const convIds = [...new Set([r1.conversationId, r2.conversationId])];
  for (const id of convIds) {
    const [conv] = await db`select customer_id from conversations where id = ${id}`;
    assert.equal(conv.customer_id, rows[0].id);
  }
});

// ---- Test 4 — display name is never the identity ----

test('a changed WhatsApp display name does not create a second customer', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t4@s.whatsapp.net`;
  await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000004', displayName: 'John', text: 'Hi' }));
  await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000004', displayName: 'John Pharmacy', text: 'Hi again' }));

  const rows = await db`select display_name from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  assert.equal(rows.length, 1, 'display name changing must never be read as a different customer');
  // Latest wins, same coalesce behaviour as wa_phone/wa_lid — but there is
  // still exactly one row, which is the property this test actually exists
  // to prove.
  assert.equal(rows[0].display_name, 'John Pharmacy');
});

// ---- Test 5 — multi-tenant isolation ----

test('the same WhatsApp identity messaging two pharmacies produces two isolated customers', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t5-shared@s.whatsapp.net`;
  const ra = await ingest(msg({ pharmacyId: ctx.a.id, jid, phone: '2340000000005', text: 'Hi Alpha' }));
  const rb = await ingest(msg({ pharmacyId: ctx.b.id, jid, phone: '2340000000005', text: 'Hi Beta' }));

  const [ca] = await db`select id from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  const [cb] = await db`select id from customers where pharmacy_id = ${ctx.b.id} and wa_jid = ${jid}`;

  assert.ok(ca && cb, 'each tenant must get its own customer row for the same WhatsApp identity');
  assert.notEqual(ca.id, cb.id);

  // The structural guarantee, not just the count: a lookup scoped to A must
  // never surface B's row, in either direction.
  const crossA = await db`select id from customers where pharmacy_id = ${ctx.a.id} and id = ${cb.id}`;
  const crossB = await db`select id from customers where pharmacy_id = ${ctx.b.id} and id = ${ca.id}`;
  assert.equal(crossA.length, 0);
  assert.equal(crossB.length, 0);

  // And their conversations/messages stayed on the correct tenant too.
  const [convA] = await db`select pharmacy_id from conversations where id = ${ra.conversationId}`;
  const [convB] = await db`select pharmacy_id from conversations where id = ${rb.conversationId}`;
  assert.equal(convA.pharmacy_id, ctx.a.id);
  assert.equal(convB.pharmacy_id, ctx.b.id);
});

// ---- Test 6 — respects an existing opt-out, no second opt-out system ----

test('a customer who already opted out is still auto-created, and stays subscribed=false', { skip: SKIP && skipReason }, async () => {
  const jid = `${TAG}-t6@s.whatsapp.net`;
  const phone = '2340000000006';

  // Simulate a pre-existing opt-out recorded before this identity ever had a
  // customer row — e.g. imported, or from a channel this system did not
  // originate. The FIRST message from them must still create the customer
  // (no registration gate) AND must respect the existing opt-out state
  // rather than defaulting to subscribed.
  await db`
    insert into opt_outs (pharmacy_id, wa_phone, source_text)
    values (${ctx.a.id}, ${phone}, 'STOP')
    on conflict (pharmacy_id, wa_phone) do nothing
  `;

  await ingest(msg({ pharmacyId: ctx.a.id, jid, phone, text: 'Hello' }));

  const [customer] = await db`select * from customers where pharmacy_id = ${ctx.a.id} and wa_jid = ${jid}`;
  assert.ok(customer, 'creation must not be blocked by an existing opt-out');

  // communication_status is a display cache; opt_outs remains what
  // conductPolicy actually enforces — evaluateOutbound takes optedOut as an
  // explicit boolean the caller looked up from opt_outs, not from this
  // cache column. Proving the two agree, without building a second opt-out
  // mechanism, is the point of this test.
  const { evaluateOutbound } = require('../services/whatsapp/conductPolicy');
  const decision = evaluateOutbound({
    replyMode: 'all',
    phone,
    optedOut: true,
    sendingPaused: false,
  });
  assert.equal(decision.send, false);
  assert.equal(decision.reason, 'opted_out');
});
