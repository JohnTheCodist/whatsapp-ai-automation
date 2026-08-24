/**
 * Ingestion scope — whose messages we are entitled to keep.
 *
 * This exists because of what the staff inbox actually filled up with during
 * testing: a friend asking about moving to Australia, and a rival health
 * service's sales bot. Baileys is a linked device, so the socket sees the
 * owner's entire WhatsApp account.
 *
 * The asymmetry with conductPolicy is deliberate and is the interesting part.
 * Not SENDING is recoverable, so that gate fails closed on anything unknown.
 * Not STORING is permanent — nothing retries, and the customer is simply
 * gone — so this one fails closed only where identity is in doubt, and open
 * where the configuration is.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldIngest } = require('../services/whatsapp/ingestionPolicy');

const CUSTOMER = '2349013993683';
const FRIEND = '2348055512345';

test("in 'all' mode an unknown sender is kept — they are probably a customer", () => {
  const d = shouldIngest({ ingestMode: 'all', phone: FRIEND });
  assert.equal(d.ingest, true);
});

test("in 'allowlist' mode only allowlisted senders are kept", () => {
  assert.equal(shouldIngest({ ingestMode: 'allowlist', phone: CUSTOMER, allowlist: [CUSTOMER] }).ingest, true);

  const d = shouldIngest({ ingestMode: 'allowlist', phone: FRIEND, allowlist: [CUSTOMER] });
  assert.equal(d.ingest, false, "the owner's private chats must not reach the database");
  assert.equal(d.reason, 'not_allowlisted');
});

test('a blocked sender is dropped in BOTH modes', () => {
  for (const ingestMode of ['all', 'allowlist']) {
    const d = shouldIngest({ ingestMode, phone: FRIEND, allowlist: [FRIEND], blocked: [FRIEND] });
    assert.equal(d.ingest, false, `blocked sender leaked through in ${ingestMode} mode`);
    assert.equal(d.reason, 'blocked_sender');
  }
});

test('blocking beats allowlisting', () => {
  // The owner has explicitly said this is not a customer. That is a later and
  // more specific statement than putting them on a list.
  const d = shouldIngest({ ingestMode: 'allowlist', phone: CUSTOMER, allowlist: [CUSTOMER], blocked: [CUSTOMER] });
  assert.equal(d.ingest, false);
});

test("the owner's own outgoing messages are never stored", () => {
  // These arrive on the socket too. Keeping them would put the owner's half
  // of every private conversation into the record.
  const d = shouldIngest({ ingestMode: 'all', phone: FRIEND, fromMe: true });
  assert.equal(d.ingest, false);
  assert.equal(d.reason, 'from_owner');
});

test('local and international spellings are the same person', () => {
  assert.equal(shouldIngest({ ingestMode: 'allowlist', phone: '09013993683', allowlist: [CUSTOMER] }).ingest, true);
  assert.equal(shouldIngest({ ingestMode: 'allowlist', phone: CUSTOMER, allowlist: ['09013993683'] }).ingest, true);
  assert.equal(shouldIngest({ ingestMode: 'all', phone: '09013993683', blocked: [CUSTOMER] }).ingest, false);
});

test('an unidentifiable sender is dropped — neither list could be checked', () => {
  for (const phone of [null, undefined, '', 'abc', '12']) {
    const d = shouldIngest({ ingestMode: 'all', phone });
    assert.equal(d.ingest, false, `should have dropped ${JSON.stringify(phone)}`);
    assert.equal(d.reason, 'unresolvable_number');
  }
});

/**
 * The staff alert line in allowlist mode.
 *
 * A pharmacy piloting on two numbers still gets "New order — reply 1 to
 * confirm" sent to notify_phone, so discarding the reply here meant the
 * order could never be confirmed from the phone the alert arrived on, with
 * nothing anywhere saying why.
 */
const STAFF = '2348036607553';

test('the staff alert line survives allowlist mode without being listed', () => {
  const d = shouldIngest({
    ingestMode: 'allowlist', phone: STAFF, allowlist: [CUSTOMER], notifyPhone: STAFF,
  });
  assert.equal(d.ingest, true);
});

test('the staff line is matched on digits, not on how it was typed', () => {
  assert.equal(
    shouldIngest({
      ingestMode: 'allowlist', phone: STAFF, allowlist: [], notifyPhone: '08036607553',
    }).ingest,
    true,
  );
});

test('an unrelated sender is still dropped when a staff line is configured', () => {
  const d = shouldIngest({
    ingestMode: 'allowlist', phone: FRIEND, allowlist: [CUSTOMER], notifyPhone: STAFF,
  });
  assert.equal(d.ingest, false);
  assert.equal(d.reason, 'not_allowlisted');
});

test('blocking beats being the staff line — the more deliberate instruction wins', () => {
  const d = shouldIngest({
    ingestMode: 'allowlist', phone: STAFF, allowlist: [], blocked: [STAFF], notifyPhone: STAFF,
  });
  assert.equal(d.ingest, false);
  assert.equal(d.reason, 'blocked_sender');
});

test('no staff line configured leaves allowlist mode exactly as it was', () => {
  assert.equal(
    shouldIngest({ ingestMode: 'allowlist', phone: STAFF, allowlist: [CUSTOMER] }).ingest,
    false,
  );
});

test('an unknown ingest_mode KEEPS the message', () => {
  // The opposite of conductPolicy, and deliberately so. A typo in a config
  // value should not silently discard real customers, because nothing will
  // retry and there is no trace to notice afterwards.
  for (const ingestMode of ['ALL', 'everything', '', null, undefined]) {
    assert.equal(
      shouldIngest({ ingestMode, phone: FRIEND }).ingest, true,
      `mode ${JSON.stringify(ingestMode)} should keep, not discard`,
    );
  }
});

test('every decision carries a reason', () => {
  const cases = [
    { ingestMode: 'all', phone: FRIEND },
    { ingestMode: 'allowlist', phone: FRIEND, allowlist: [CUSTOMER] },
    { ingestMode: 'all', phone: FRIEND, blocked: [FRIEND] },
    { ingestMode: 'all', phone: FRIEND, fromMe: true },
    { ingestMode: 'all', phone: 'nonsense' },
  ];
  for (const c of cases) {
    const d = shouldIngest(c);
    assert.ok(d.reason && typeof d.reason === 'string', 'a silent drop is undebuggable');
  }
});
