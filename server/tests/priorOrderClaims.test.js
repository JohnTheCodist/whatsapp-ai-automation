/**
 * Referring back to an order placed earlier in the same conversation.
 *
 * FROM REAL TRAFFIC
 * The assistant created an order, then a message later recapped "I've sent
 * this to the pharmacy". No create_order ran that turn, so the action-claim
 * guard blocked the reply, escalated to a human, and muted the conversation.
 * Every message the customer sent after that was met with silence.
 *
 * The claim was TRUE. It was being checked against the wrong window — the
 * current turn's tool results rather than the conversation. Exactly the bug
 * `knownPrices` already fixed for prices, and the fix is the same shape.
 *
 * The tests below must hold in both directions: a real prior order permits
 * the recap, and no prior order still blocks it. Loosening this into "always
 * allow" would delete the guard that stopped the assistant inventing orders
 * in the first place.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReply } = require('../services/ai/replyValidator');

// Flat, matching what runTool (catalogueTools.js) actually returns — the
// tool's own run() result, unwrapped. This exact fixture, nested under a
// `.result` key, is what let the "order created THIS turn" case below pass
// while orderWasCreated() checked a shape nothing in production ever
// produces — the bug this file's own header describes as already fixed was
// still live for every real order, caught only by tracing a live handoff.
const ORDER_RESULT = [{
  tool: 'create_order',
  created: true, reference: 'GRW-YT4', status: 'pending',
}];

test('recapping an order placed earlier in the conversation is allowed', () => {
  const r = validateReply(
    "I've sent this to the pharmacy and they'll confirm shortly.",
    [], // nothing this turn
    { priorOrderReferences: ['GRW-YT4'] },
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('the same sentence is still blocked when no order was ever placed', () => {
  const r = validateReply("I've sent this to the pharmacy and they'll confirm shortly.", [], {});
  assert.equal(r.ok, false, 'without an order this is a false claim and must not go out');
  assert.equal(r.violations[0].type, 'unfulfillable_promise');
});

test('an order created THIS turn is still allowed', () => {
  const r = validateReply(
    "I've sent your order to the pharmacy. Your reference is GRW-YT4.",
    ORDER_RESULT,
    {},
  );
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('"reserved" stays blocked even with a prior order', () => {
  // needsOrder:false claims are unconditional. A pending order holds stock
  // internally but the pharmacy has not agreed, so telling the customer it
  // is reserved remains false however many orders exist.
  const r = validateReply(
    "I've set aside 3 packs for you.",
    ORDER_RESULT,
    { priorOrderReferences: ['GRW-YT4'] },
  );
  assert.equal(r.ok, false, 'a prior order must not unlock "set aside"');
});

test('"your order is confirmed" stays blocked with a prior order', () => {
  const r = validateReply('Your order is confirmed.', [], { priorOrderReferences: ['GRW-YT4'] });
  assert.equal(r.ok, false);
});

test('an empty prior-order list behaves exactly like none', () => {
  const r = validateReply("I've notified the pharmacy for you.", [], { priorOrderReferences: [] });
  assert.equal(r.ok, false);
});

test('prices and order claims are validated independently', () => {
  // A true order recap must not smuggle an unverified price past the check.
  const r = validateReply(
    "I've sent this to the pharmacy. That comes to ₦9,999.",
    [],
    { priorOrderReferences: ['GRW-YT4'] },
  );
  assert.equal(r.ok, false, 'the price is still unverified');
  assert.ok(
    r.violations.some((v) => v.type !== 'unfulfillable_promise'),
    'the violation should be about the price, not the order claim',
  );
});
