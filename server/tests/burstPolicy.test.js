/**
 * The rules that stop the assistant answering like a machine.
 *
 * Pure — times are passed in, so "four seconds later" is tested without
 * waiting four seconds, and the randomness is injected so a jitter test is
 * not a coin flip that fails one run in twenty.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  decideBurst, SETTLE_MS, MIN_SEND_GAP_MS, JITTER_MS,
} = require('../services/whatsapp/burstPolicy');

/** A message old enough to answer, from a pharmacy that is not mid-burst. */
const CALM = { hasNewerMessage: false, messageAgeMs: 60_000, msSinceLastSend: 600_000 };

test('an ordinary question is answered immediately', () => {
  assert.deepEqual(decideBurst(CALM), { action: 'send', reason: 'ok' });
});

test('a message with a newer one behind it is not answered at all', () => {
  // "hi" / "do you have amoxicillin" / "500mg" / "how much" is ONE question.
  // Answering the fragments gives four replies to four halves of a sentence.
  const d = decideBurst({ ...CALM, hasNewerMessage: true });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'superseded_by_newer_message');
});

test('superseded wins even when the message is old and the line is quiet', () => {
  // No amount of waiting makes a fragment into the whole question, so this
  // must be checked before settle and pacing rather than after.
  const d = decideBurst({
    hasNewerMessage: true, messageAgeMs: 3_600_000, msSinceLastSend: 3_600_000,
  });
  assert.equal(d.action, 'skip');
});

test('a message that just arrived waits for the rest of the thought', () => {
  const d = decideBurst({ ...CALM, messageAgeMs: 500 });
  assert.equal(d.action, 'defer');
  assert.equal(d.reason, 'waiting_for_customer_to_finish');
  assert.equal(d.delayMs, SETTLE_MS - 500);
});

test('the settle wait is the remainder, not a fresh interval each time', () => {
  // Otherwise a customer typing steadily every 3 seconds is never answered:
  // each pass restarts the full wait and the job defers forever.
  const d = decideBurst({ ...CALM, messageAgeMs: SETTLE_MS - 200 });
  assert.equal(d.delayMs, 200);
});

test('a message exactly at the settle threshold is answered', () => {
  assert.equal(decideBurst({ ...CALM, messageAgeMs: SETTLE_MS }).action, 'send');
});

test('a reply too soon after the last send is spaced out', () => {
  const d = decideBurst({ ...CALM, msSinceLastSend: 500, random: 0 });
  assert.equal(d.action, 'defer');
  assert.equal(d.reason, 'pacing_outbound');
  assert.equal(d.delayMs, MIN_SEND_GAP_MS - 500);
});

test('pacing adds jitter, so sends are not on a fixed metronome', () => {
  // A perfectly regular 2500ms interval is its own signature.
  const none = decideBurst({ ...CALM, msSinceLastSend: 0, random: 0 });
  const most = decideBurst({ ...CALM, msSinceLastSend: 0, random: 1 });
  assert.equal(none.delayMs, MIN_SEND_GAP_MS);
  assert.equal(most.delayMs, MIN_SEND_GAP_MS + JITTER_MS);
  assert.ok(most.delayMs > none.delayMs, 'jitter must actually vary the delay');
});

test('a pharmacy that has never sent anything is not paced', () => {
  // null is "no previous send", not "sent at time zero" — treating it as the
  // latter would delay the very first message a pharmacy ever sends.
  assert.equal(decideBurst({ ...CALM, msSinceLastSend: null }).action, 'send');
});

test('settle is checked before pacing', () => {
  // Both apply; the customer may still be typing, and there is no point
  // pacing a reply that is about to be superseded anyway.
  const d = decideBurst({ hasNewerMessage: false, messageAgeMs: 100, msSinceLastSend: 0 });
  assert.equal(d.reason, 'waiting_for_customer_to_finish');
});

test('a deferral always asks for a positive delay', () => {
  // A zero or negative run_after would re-queue the job to run immediately,
  // spinning the worker on the same row instead of waiting.
  for (const ageMs of [0, 1, SETTLE_MS - 1]) {
    const d = decideBurst({ ...CALM, messageAgeMs: ageMs });
    assert.ok(d.delayMs > 0, `age ${ageMs} produced delay ${d.delayMs}`);
  }
  for (const since of [0, 1, MIN_SEND_GAP_MS - 1]) {
    const d = decideBurst({ ...CALM, msSinceLastSend: since, random: 0 });
    assert.ok(d.delayMs > 0, `gap ${since} produced delay ${d.delayMs}`);
  }
});
