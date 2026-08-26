/**
 * A staff reply must be traceable to the message it answers.
 *
 * WHY THIS IS TESTED AT ALL
 * An order alert can identify itself in the text — "1 ABC-123" names an
 * order. A pharmacist answering a customer's clinical question types free
 * prose, and there is nothing in "yes, but leave 2 hours between them" that
 * says which of three waiting customers it belongs to. WhatsApp's own
 * reply-to gesture says so exactly, and `contextInfo.stanzaId` is the only
 * carrier of that fact.
 *
 * THE CASE THAT WOULD OTHERWISE SHIP BROKEN
 * contextInfo hangs off whichever message variant carries it, and the variant
 * differs by type. Every reply typed during development is an
 * extendedTextMessage, so reading only that one passes every manual test and
 * then fails the first time a pharmacist replies with a photo of a
 * prescription — silently, because a missing quote looks identical to "not a
 * reply".
 *
 * No socket, no network, no database: _onMessages is called directly and the
 * emitted event is inspected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOW_LOCAL_WHATSAPP = 'true';

const { SessionManager } = require('../services/whatsapp/sessionManager');

const SESSION = { accountId: 'acc-1', pharmacyId: '11111111-1111-1111-1111-111111111111' };

/** One inbound message, shaped the way Baileys delivers it. */
function inbound(message, { fromMe = false } = {}) {
  return {
    key: { id: 'MSG-1', remoteJid: '2348012345678@s.whatsapp.net', fromMe },
    pushName: 'Chidi',
    messageTimestamp: 1735689600,
    message,
  };
}

/** Run one message through and return the emitted payload, or null. */
async function emitted(message) {
  const mgr = new SessionManager();
  let captured = null;
  mgr.on('message', (m) => { captured = m; });
  await mgr._onMessages(SESSION, { messages: [inbound(message)], type: 'notify' });
  return captured;
}

const QUOTED = { stanzaId: 'ALERT-ABC-123', participant: '2348036607553@s.whatsapp.net' };

test('a plain text reply carries the id of the message it quotes', async () => {
  const m = await emitted({
    extendedTextMessage: { text: 'Yes, but leave 2 hours between them.', contextInfo: QUOTED },
  });
  assert.equal(m?.quotedMessageId, 'ALERT-ABC-123');
  assert.equal(m?.text, 'Yes, but leave 2 hours between them.');
});

test('an ordinary message that quotes nothing reports null, not undefined', async () => {
  const m = await emitted({ conversation: 'Do you have paracetamol?' });
  // null means "not a reply". undefined would mean the field was never
  // considered, and the two must not be confused by anything downstream.
  assert.equal(m?.quotedMessageId, null);
});

test('extendedTextMessage with no contextInfo is not a reply', async () => {
  const m = await emitted({ extendedTextMessage: { text: 'Hello' } });
  assert.equal(m?.quotedMessageId, null);
});

// The regression this file exists for. Each of these is a real way a
// pharmacist replies — a photo of a prescription, a voice note when they are
// driving, a forwarded document — and each carries contextInfo somewhere
// different.
for (const [label, variant] of [
  ['a photo reply', 'imageMessage'],
  ['a voice note reply', 'audioMessage'],
  ['a document reply', 'documentMessage'],
  ['a video reply', 'videoMessage'],
  ['a sticker reply', 'stickerMessage'],
]) {
  test(`${label} carries the quoted id too`, async () => {
    const m = await emitted({ [variant]: { contextInfo: QUOTED } });
    assert.equal(
      m?.quotedMessageId, 'ALERT-ABC-123',
      `contextInfo on ${variant} was dropped — a reply of this kind would look like a fresh message`,
    );
  });
}

test('the quoted id survives into the stored payload', async () => {
  // safePayload trims the raw Baileys object before it is written, so a field
  // that is not named there is gone for good — and this one cannot be
  // reconstructed from anything else on the row.
  const { REPLY_WINDOW_HOURS } = require('../services/whatsapp/inboundIngest');
  assert.ok(REPLY_WINDOW_HOURS, 'module loads');

  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'services', 'whatsapp', 'inboundIngest.js'),
    'utf8',
  );
  assert.match(
    src, /quotedMessageId:\s*msg\.quotedMessageId/,
    'safePayload must carry quotedMessageId, or the worker can never match a staff reply to its alert',
  );
});
