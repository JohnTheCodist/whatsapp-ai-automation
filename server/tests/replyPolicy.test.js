/**
 * The reply gate.
 *
 * Failure here means a half-built assistant messaging a pharmacy's real
 * customers. Every test below is about refusing to send, because that is the
 * direction where being wrong is expensive.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldReply } = require('../services/whatsapp/replyPolicy');

const ALLOWED = '09013993683';           // as a person types it
const ALLOWED_INTL = '2349013993683';    // as WhatsApp reports it
const STRANGER = '2348011112222';

test('an allowlisted number is replied to', () => {
  const d = shouldReply({ replyMode: 'allowlist', phone: ALLOWED_INTL, allowlist: [ALLOWED] });
  assert.equal(d.send, true);
  assert.equal(d.reason, 'allowlisted');
});

test('local and international forms are the same person', () => {
  // The list is written locally, WhatsApp reports internationally. Comparing
  // raw strings here would silently never match.
  assert.equal(shouldReply({ replyMode: 'allowlist', phone: ALLOWED_INTL, allowlist: [ALLOWED] }).send, true);
  assert.equal(shouldReply({ replyMode: 'allowlist', phone: ALLOWED, allowlist: [ALLOWED_INTL] }).send, true);
  assert.equal(shouldReply({ replyMode: 'allowlist', phone: '+234 901 399 3683', allowlist: [ALLOWED] }).send, true);
});

test('a stranger is NOT replied to', () => {
  const d = shouldReply({ replyMode: 'allowlist', phone: STRANGER, allowlist: [ALLOWED] });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'not_allowlisted');
});

test('an empty allowlist means nobody, not everybody', () => {
  const d = shouldReply({ replyMode: 'allowlist', phone: ALLOWED_INTL, allowlist: [] });
  assert.equal(d.send, false, 'this is the branch where a "sensible default" would be dangerous');
  assert.equal(d.reason, 'allowlist_empty');
});

test('a missing allowlist is treated as empty', () => {
  assert.equal(shouldReply({ replyMode: 'allowlist', phone: ALLOWED_INTL }).send, false);
});

test('reply_mode off sends to nobody, including allowlisted numbers', () => {
  const d = shouldReply({ replyMode: 'off', phone: ALLOWED_INTL, allowlist: [ALLOWED] });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'reply_mode_off');
});

test('reply_mode all sends to a stranger — deliberately', () => {
  const d = shouldReply({ replyMode: 'all', phone: STRANGER });
  assert.equal(d.send, true);
  assert.equal(d.reason, 'reply_mode_all');
});

test('an unknown mode fails closed', () => {
  for (const mode of ['ALLOWLIST', 'allow', '', null, undefined, 'true']) {
    const d = shouldReply({ replyMode: mode, phone: ALLOWED_INTL, allowlist: [ALLOWED] });
    assert.equal(d.send, false, `mode ${JSON.stringify(mode)} must not open the gate`);
  }
});

test('an unresolvable sender is never replied to, even in mode all', () => {
  for (const phone of [null, undefined, '', 'abc', '123']) {
    assert.equal(shouldReply({ replyMode: 'all', phone }).send, false);
    assert.equal(shouldReply({ replyMode: 'all', phone }).reason, 'unresolvable_number');
  }
});

test('junk entries in the allowlist do not match anything', () => {
  const d = shouldReply({ replyMode: 'allowlist', phone: STRANGER, allowlist: ['', null, 'abc'] });
  assert.equal(d.send, false);
});

test('every decision carries a reason', () => {
  const cases = [
    { replyMode: 'allowlist', phone: ALLOWED_INTL, allowlist: [ALLOWED] },
    { replyMode: 'allowlist', phone: STRANGER, allowlist: [ALLOWED] },
    { replyMode: 'off', phone: ALLOWED_INTL },
    { replyMode: 'all', phone: STRANGER },
    { replyMode: 'nonsense', phone: STRANGER },
  ];
  for (const c of cases) {
    const d = shouldReply(c);
    assert.ok(d.reason && typeof d.reason === 'string', '"did not reply" with no reason is undebuggable');
  }
});
