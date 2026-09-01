/**
 * Conduct rules — what makes this system structurally unable to look like spam.
 *
 * Not a disguise. The reported reasons a number gets actioned are behavioural,
 * and each rule here removes one of them as a possibility rather than
 * instructing the system not to do it.
 *
 * Every test is about NOT sending, because not sending is always recoverable
 * and the number is not.
 *
 * Pure — the clock is injected, so 3am is testable at any hour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOutbound, isOptOutRequest, isQuietHour } = require('../services/whatsapp/conductPolicy');

const ALLOWED = '2349013993683';
const base = {
  replyMode: 'allowlist',
  phone: ALLOWED,
  allowlist: [ALLOWED],
  now: new Date('2026-08-09T13:00:00'), // 1pm local, well outside quiet hours
  limits: { quietHoursEnabled: false },
  counts: {},
};

test('an ordinary reply to an allowlisted customer in business hours is sent', () => {
  const d = evaluateOutbound(base);
  assert.equal(d.send, true, JSON.stringify(d));
});

// ---- opt-out ----

test('someone who asked to stop is never messaged again', () => {
  const d = evaluateOutbound({ ...base, optedOut: true });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'opted_out');
});

test('opt-out outranks the allowlist', () => {
  // Being on the list is permission from the pharmacy. "Stop" is a refusal
  // from the person. The person wins.
  const d = evaluateOutbound({ ...base, replyMode: 'all', optedOut: true });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'opted_out');
});

test('the phrases people actually use to opt out are recognised', () => {
  for (const text of [
    'STOP', 'stop', 'Unsubscribe', 'cancel',
    'stop messaging me', 'please do not contact me again',
    'remove me from your list', 'leave me alone',
    'abeg stop', 'no dey disturb me', "don't text me",
  ]) {
    assert.equal(isOptOutRequest(text), true, `missed: "${text}"`);
  }
});

test('ordinary messages are not mistaken for opt-outs', () => {
  for (const text of [
    'Do you have Panadol?', 'How much is it', 'I want two',
    'Where is the shop', 'stop by later today',
    'Thanks', 'ok', '',
  ]) {
    assert.equal(isOptOutRequest(text), false, `false opt-out on: "${text}"`);
  }
});

test('"don\'t send the order yet" is shopping, NOT an opt-out', () => {
  // FROM LIVE TRAFFIC, and the reason the matcher was narrowed. The first
  // string below is verbatim: `don't … send` matched, the customer was opted
  // out permanently mid-order, and their next four messages were silently
  // suppressed. Nobody was told — not the customer, not the pharmacy.
  //
  // "send" is a commerce verb in a pharmacy far more often than a
  // communication one, and the object is what disambiguates it.
  for (const text of [
    "Okay I have lots of drugs I want to buy so don't send The order unless we are done okay ?",
    "don't send the order yet",
    'do not send it until I confirm',
    "don't send my order now",
    'no more sending orders without asking me first',
  ]) {
    assert.equal(isOptOutRequest(text), false, `false opt-out on: "${text}"`);
  }
});

test('but "don\'t send me messages" is still a real opt-out', () => {
  // The narrowing must not open a hole. When the OBJECT is the message rather
  // than the order, it is a consent withdrawal and still has to be honoured.
  for (const text of [
    "don't send me messages",
    'do not send me any texts',
    'stop sending me messages',
    "don't send me anything again",
  ]) {
    assert.equal(isOptOutRequest(text), true, `missed a genuine opt-out: "${text}"`);
  }
});

// ---- quiet hours ----

test('the assistant is silent overnight', () => {
  const at = (h) => evaluateOutbound({
    ...base,
    now: new Date(`2026-08-09T${String(h).padStart(2, '0')}:00:00`),
    limits: { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 6 },
  });
  assert.equal(at(23).send, false, '11pm');
  assert.equal(at(3).send, false, '3am — instant replies at 3am is one of the few things here that does not look human');
  assert.equal(at(5).send, false, '5am');
  assert.equal(at(9).send, true, '9am');
  assert.equal(at(21).send, true, '9pm');
});

test('a quiet window spanning midnight is handled', () => {
  // start <= h && h < end silently gets this wrong for 22->6.
  assert.equal(isQuietHour(23, 22, 6), true);
  assert.equal(isQuietHour(2, 22, 6), true);
  assert.equal(isQuietHour(12, 22, 6), false);
  // and a window that does not wrap
  assert.equal(isQuietHour(13, 12, 14), true);
  assert.equal(isQuietHour(15, 12, 14), false);
});

// ---- rate limits ----

test('one conversation cannot be replied to endlessly within an hour', () => {
  const d = evaluateOutbound({
    ...base,
    limits: { quietHoursEnabled: false, hourlyConversationCap: 15 },
    counts: { repliesThisConversationHour: 15 },
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'conversation_rate_limit');
  assert.ok(!d.pause, 'one chatty customer is not evidence the system is broken');
});

test('the daily ceiling PAUSES rather than throttles', () => {
  const d = evaluateOutbound({
    ...base,
    limits: { quietHoursEnabled: false, dailyReplyCap: 200 },
    counts: { repliesToday: 200 },
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'daily_cap_reached');
  assert.equal(
    d.pause, true,
    'unexplained volume on an unofficial channel is the moment to stop, not to continue slower',
  );
});

// ---- the caps are for cold outbound, not for answering someone ----------
//
// A customer amended an order at 07:20 on 2026-08-28 and the assistant went
// quiet on them. That particular silence was a different bug, but it sent us
// looking at every path that can stop a reply without saying so — and these
// two caps could stop one at message 16 of a conversation the customer was
// driving, with no message to them and nothing but a log line.
//
// warmupPolicy already had exactly this flaw and was already fixed for it:
// it used to count replies_today and now counts business-initiated sends
// only. These caps were not fixed with it.

test('a reply inside a conversation the customer opened is not rate limited', () => {
  const d = evaluateOutbound({
    ...base,
    isReply: true,
    limits: { quietHoursEnabled: false, hourlyConversationCap: 15 },
    counts: { repliesThisConversationHour: 40 },
  });
  assert.equal(d.send, true, 'an attentive customer working through an order must not be cut off');
});

test('the daily ceiling does not silence replies either', () => {
  const d = evaluateOutbound({
    ...base,
    isReply: true,
    limits: { quietHoursEnabled: false, dailyReplyCap: 200 },
    counts: { repliesToday: 500 },
  });
  assert.equal(d.send, true);
  assert.ok(!d.pause, 'answering customers must never trip the circuit breaker');
});

test('the exemption is opt-in, not the default', () => {
  // If isReply defaulted true, a business-initiated send path added later
  // would inherit the exemption by forgetting to mention it — and cold
  // outbound volume is the thing the caps actually exist for. Same discipline
  // as checkLine's `wholesale` flag in orderLimits.
  const d = evaluateOutbound({
    ...base,
    limits: { quietHoursEnabled: false, hourlyConversationCap: 15 },
    counts: { repliesThisConversationHour: 40 },
  });
  assert.equal(d.send, false, 'omitting the flag must mean "not a reply"');
  assert.equal(d.reason, 'conversation_rate_limit');
});

test('being a reply exempts the VOLUME caps and nothing else', () => {
  // Everything below is about whether we may speak to this person at all, or
  // whether something is broken. Neither becomes acceptable because a
  // customer spoke first, and a blanket "replies always send" would have
  // quietly deleted all four.
  const reply = { ...base, isReply: true, limits: { quietHoursEnabled: false } };

  assert.equal(evaluateOutbound({ ...reply, optedOut: true }).reason, 'opted_out');
  assert.equal(evaluateOutbound({ ...reply, sendingPaused: true }).reason, 'sending_paused');
  assert.equal(
    evaluateOutbound({ ...reply, counts: { identicalRecentReplies: 3 } }).reason,
    'repeating_itself',
  );
  assert.equal(
    evaluateOutbound({
      ...reply,
      now: new Date('2026-08-09T03:00:00'),
      limits: { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 6 },
    }).reason,
    'quiet_hours',
  );
  assert.equal(
    evaluateOutbound({ ...reply, phone: '2340000000000', allowlist: [ALLOWED] }).reason,
    'not_allowlisted',
  );
});

test('a repeating assistant trips the breaker', () => {
  // Two automated systems talking to each other look like ordinary traffic
  // until they suddenly do not. Repetition is the give-away.
  const d = evaluateOutbound({
    ...base,
    counts: { identicalRecentReplies: 3 },
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'repeating_itself');
  assert.equal(d.pause, true);
});

// ---- the breaker ----

test('a paused pharmacy sends nothing at all', () => {
  const d = evaluateOutbound({ ...base, sendingPaused: true });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'sending_paused');
});

test('the breaker is checked before everything else', () => {
  // Nothing below it — not the allowlist, not a fresh conversation — can
  // talk past a pause.
  const d = evaluateOutbound({ ...base, replyMode: 'all', sendingPaused: true, counts: {} });
  assert.equal(d.reason, 'sending_paused');
});

// ---- fails closed ----

test('an unknown reply mode sends nothing', () => {
  for (const mode of ['ALLOWLIST', 'yes', '', null, undefined]) {
    assert.equal(evaluateOutbound({ ...base, replyMode: mode }).send, false, `mode ${JSON.stringify(mode)}`);
  }
});

test('an unresolvable number is never messaged', () => {
  for (const phone of [null, undefined, '', 'abc', '12']) {
    assert.equal(evaluateOutbound({ ...base, phone }).send, false);
  }
});

test('an empty allowlist means nobody', () => {
  assert.equal(evaluateOutbound({ ...base, allowlist: [] }).send, false);
});

test('local and international spellings of one number are the same person', () => {
  assert.equal(evaluateOutbound({ ...base, phone: '09013993683' }).send, true);
  assert.equal(evaluateOutbound({ ...base, allowlist: ['09013993683'] }).send, true);
});

test('every decision carries a reason', () => {
  const cases = [
    { ...base, sendingPaused: true },
    { ...base, optedOut: true },
    { ...base, replyMode: 'off' },
    { ...base, counts: { repliesToday: 999 }, limits: { quietHoursEnabled: false, dailyReplyCap: 200 } },
    base,
  ];
  for (const c of cases) {
    const d = evaluateOutbound(c);
    assert.ok(d.reason && typeof d.reason === 'string', 'a silent non-reply is undebuggable');
  }
});
