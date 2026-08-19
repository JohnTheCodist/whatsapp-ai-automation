/**
 * Staff replying to an order alert from their own WhatsApp.
 *
 * The tests that matter most here are the REFUSALS. Accepting a command that
 * was not clearly meant is how a pharmacist confirms stock for the wrong
 * customer from a phone in their pocket, and no amount of convenience is
 * worth that — so "a bare ok does nothing" is as important as "ok ABC-DEF
 * confirms".
 *
 * Pure module: no database, no clock, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStaffCommand, helpText } = require('../services/orders/staffCommands');

// ---- the happy path ----

test('the natural reply to an alert confirms the named order', () => {
  const r = parseStaffCommand('OK 97G-YX4');
  assert.deepEqual(r, { kind: 'act', action: 'ready', reference: '97G-YX4' });
});

test('the verbs a busy person actually types all work', () => {
  for (const [text, action] of [
    ['ok 97G-YX4', 'ready'],
    ['yes 97G-YX4', 'ready'],
    ['confirm 97G-YX4', 'ready'],
    ['ready 97G-YX4', 'ready'],
    ['reject 97G-YX4', 'rejected'],
    ['no 97G-YX4', 'rejected'],
    ['cancel 97G-YX4', 'cancelled'],
    ['collected 97G-YX4', 'completed'],
  ]) {
    const r = parseStaffCommand(text);
    assert.equal(r.kind, 'act', `"${text}" should have been an action`);
    assert.equal(r.action, action, `"${text}" mapped to the wrong status`);
  }
});

test('the reference is found wherever it sits in the sentence', () => {
  // "ok ABC-DEF", "ABC-DEF ok" and "confirm order ABC-DEF" are all natural.
  for (const text of ['ok 97G-YX4', 'confirm order 97G-YX4', 'ok, 97G-YX4 please']) {
    const r = parseStaffCommand(text);
    assert.equal(r.kind, 'act', text);
    assert.equal(r.reference, '97G-YX4');
  }
});

test('a lowercase reference is normalised to how it was sent to them', () => {
  assert.equal(parseStaffCommand('ok 97g-yx4').reference, '97G-YX4');
});

// ---- the numeric shortcut ----

test('1, 2 and 3 are the headline shortcut from the alert', () => {
  assert.deepEqual(parseStaffCommand('1'), { kind: 'needs_reference', action: 'ready' });
  assert.deepEqual(parseStaffCommand('2'), { kind: 'needs_reference', action: 'rejected' });
  assert.deepEqual(parseStaffCommand('3'), { kind: 'needs_reference', action: 'completed' });
});

test('a number WITH a reference names its order outright', () => {
  assert.deepEqual(parseStaffCommand('1 97G-YX4'), {
    kind: 'act', action: 'ready', reference: '97G-YX4',
  });
  assert.deepEqual(parseStaffCommand('2 97g-yx4'), {
    kind: 'act', action: 'rejected', reference: '97G-YX4',
  });
});

test('a number followed by PROSE is not a command', () => {
  // The misfire this guard exists for. "2 packs are gone" is a sentence
  // about stock; reading it as "reject the waiting order" would take a
  // destructive action on a message that was never an instruction. A
  // quantity at the start of a sentence is far too common to accept.
  for (const text of ['2 packs are gone', '1 card left', '3 more coming tomorrow', '1 satchet']) {
    assert.equal(parseStaffCommand(text), null, `"${text}" must not be a command`);
  }
});

test('numbers outside the menu mean nothing', () => {
  for (const text of ['7', '0', '42']) {
    assert.equal(parseStaffCommand(text), null, `"${text}" should not be a command`);
  }
});

// ---- the refusals, which are the point ----

test('a BARE "ok" does not name an order', () => {
  // It is reported as needs_reference rather than acted on. The caller then
  // resolves it ONLY when exactly one order is waiting — with two or more it
  // asks, because the last order the system saw and the last one the
  // pharmacist read are different things.
  const r = parseStaffCommand('ok');
  assert.equal(r.kind, 'needs_reference');
  assert.equal(r.action, 'ready', 'it should still know what they meant, to ask well');
});

test('every verb without a reference asks rather than guesses', () => {
  for (const text of ['confirm', 'reject', 'yes', 'cancel', 'collected']) {
    assert.equal(parseStaffCommand(text).kind, 'needs_reference', text);
  }
});

test('a reference-shaped word without the hyphen is not a reference', () => {
  // Guards against ordinary prose being read as an order id.
  assert.equal(parseStaffCommand('confirm ABCDEF').kind, 'needs_reference');
});

test('ordinary conversation is not a command at all', () => {
  for (const text of [
    'Good morning',
    'How much is paracetamol?',
    'I will be late today',
    'the customer called about 97G-YX4',   // a reference, but no verb
    '',
  ]) {
    assert.equal(parseStaffCommand(text), null, `"${text}" should not be a command`);
  }
});

test('a verb buried mid-sentence does not fire', () => {
  // Only a message that STARTS with an instruction is one. "I told them we
  // cannot confirm 97G-YX4 yet" is a report, not an order to reject it.
  assert.equal(parseStaffCommand('I told them we cannot confirm 97G-YX4 yet'), null);
});

// ---- help ----

test('help is available and names the reference requirement', () => {
  assert.equal(parseStaffCommand('help').kind, 'help');
  assert.equal(parseStaffCommand('?').kind, 'help');
  assert.match(helpText(), /ABC-DEF/);
});

test('LIST asks what is waiting without acting', () => {
  assert.equal(parseStaffCommand('list').kind, 'list');
  assert.equal(parseStaffCommand('pending').kind, 'list');
});
