/**
 * The number-exists check, and specifically its failure semantics.
 *
 * The check reduces one abuse signal — repeatedly sending to numbers that are
 * not on WhatsApp. But a risk-reduction measure that can itself swallow
 * messages is a bad trade: a pharmacy losing every staff alert because a
 * lookup timed out is worse than the signal it was avoiding.
 *
 * So "could not tell" and "definitely not on WhatsApp" must stay different
 * answers, and only the second may stop a send.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOW_LOCAL_WHATSAPP = 'true';

const { SessionManager } = require('../services/whatsapp/sessionManager');

const ACCOUNT = 'acc-1';
const JID = '2348012345678@s.whatsapp.net';

/** A manager with one session whose onWhatsApp behaves as told. */
function managerWith(onWhatsApp) {
  const mgr = new SessionManager();
  mgr.sessions.set(ACCOUNT, {
    accountId: ACCOUNT,
    pharmacyId: '11111111-1111-1111-1111-111111111111',
    sock: { onWhatsApp, sendMessage: async () => ({ key: { id: 'OUT-1' } }) },
  });
  return mgr;
}

test('a number on WhatsApp is reported as present', async () => {
  const mgr = managerWith(async () => [{ jid: JID, exists: true }]);
  assert.equal(await mgr.isOnWhatsApp(ACCOUNT, JID), true);
});

test('a number not on WhatsApp is reported as absent', async () => {
  const mgr = managerWith(async () => [{ jid: JID, exists: false }]);
  assert.equal(await mgr.isOnWhatsApp(ACCOUNT, JID), false);
});

test('an empty result is absent, not unknown', async () => {
  // Baileys returns nothing for a number it could look up and did not find.
  const mgr = managerWith(async () => []);
  assert.equal(await mgr.isOnWhatsApp(ACCOUNT, JID), false);
});

test('a failed lookup is null — "could not tell", not "absent"', async () => {
  const mgr = managerWith(async () => { throw new Error('rate limited'); });
  assert.equal(
    await mgr.isOnWhatsApp(ACCOUNT, JID), null,
    'a thrown lookup must not be indistinguishable from a number that does not exist',
  );
});

test('a LID is not checked — there is no number to look up', async () => {
  let called = false;
  const mgr = managerWith(async () => { called = true; return []; });
  assert.equal(await mgr.isOnWhatsApp(ACCOUNT, '34257128960101@lid'), null);
  assert.equal(called, false, 'a LID reached us through a real conversation; its existence is not in question');
});

test('the answer is cached, so an alert line is not looked up on every order', async () => {
  let calls = 0;
  const mgr = managerWith(async () => { calls += 1; return [{ jid: JID, exists: true }]; });
  await mgr.isOnWhatsApp(ACCOUNT, JID);
  await mgr.isOnWhatsApp(ACCOUNT, JID);
  await mgr.isOnWhatsApp(ACCOUNT, JID);
  assert.equal(calls, 1);
});

test('a send to a number that is not on WhatsApp is refused, and says why', async () => {
  const mgr = managerWith(async () => [{ jid: JID, exists: false }]);
  await assert.rejects(
    () => mgr.sendText(ACCOUNT, JID, 'New order waiting', { delay: false, verifyNumber: true }),
    /not a WhatsApp number/,
  );
});

test('a FAILED lookup still sends — the check must not swallow messages', async () => {
  // The case this file exists for. A lookup that errors means we do not know,
  // and refusing on "do not know" would lose a pharmacy's alerts for the
  // duration of any WhatsApp API wobble.
  const mgr = managerWith(async () => { throw new Error('network'); });
  const sent = await mgr.sendText(ACCOUNT, JID, 'New order waiting', { delay: false, verifyNumber: true });
  assert.equal(sent.providerMessageId, 'OUT-1');
});

test('without verifyNumber nothing is looked up at all', async () => {
  // Replies are the hot path and the customer just messaged us — a round trip
  // to confirm they exist is latency spent on a settled question.
  let called = false;
  const mgr = managerWith(async () => { called = true; return [{ jid: JID, exists: false }]; });
  const sent = await mgr.sendText(ACCOUNT, JID, 'Yes, we have that', { delay: false });
  assert.equal(called, false);
  assert.equal(sent.providerMessageId, 'OUT-1');
});
