/**
 * No production path may reach WhatsApp without declaring what it is sending.
 *
 * This is a source-level test, not a unit test, and that is deliberate. Every
 * other guard here checks behaviour at runtime; this one checks that a future
 * developer cannot ADD a path that skips the guard. A consent check is only
 * as good as the number of places that call it, and the failure mode of
 * forgetting is a message that has already reached somebody.
 *
 * It works by enumerating every call to the transport and requiring each one
 * to be on a list of known, justified exceptions. Add a new
 * sessionManager.sendText() anywhere and this fails until you either route it
 * through sendAndRecordOutbound (which enforces consent) or come here and
 * write down why it does not need to be.
 *
 * That is the point: the exception list is short, and adding to it is a
 * deliberate act with a reason attached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');

/**
 * Every direct transport call that is allowed to exist, and why.
 *
 * Keyed by file, with the reason. Anything not listed here must go through
 * sendAndRecordOutbound so the communication policy runs first.
 */
const ALLOWED_DIRECT_SENDS = {
  // The helper that owns the send and runs the policy before it. This is
  // the call every other path is supposed to reach WhatsApp through.
  'services/whatsapp/outboundMessage.js':
    'The central helper itself — this is the call that runs canSendMessage first.',

  // Alerts to the pharmacy's own staff number, not to a customer. Gating
  // these on customer consent would mean one customer opting out silently
  // disabled the pharmacy's own order notifications.
  'services/orders/staffAlert.js':
    'Recipient is the pharmacy, not the customer. Declared as CATEGORIES.STAFF_ALERT.',

  // The connection self-test messages the pharmacy's own number to prove the
  // socket works. No customer involved.
  'routes/whatsapp.js':
    'Self-test to the pharmacy\'s own number during setup. No customer recipient.',

  // Two branches that fire only when an order has no conversation attached —
  // genuinely rare, since every order in this system originates from one.
  // They send without storing a row, matching long-standing behaviour.
  'routes/orders.js':
    'Fallback branch for an order with no conversation_id — cannot store a message row, so cannot use the helper.',
  'services/worker.js':
    'Same no-conversation fallback in the hold-expiry sweep, plus assistant replies whose send precedes a shared transaction.',
};

/** Recursively collect .js files under server/, skipping tests and modules. */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'scratch') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('every direct WhatsApp send is on the justified-exception list', () => {
  const offenders = [];

  for (const file of sourceFiles(SERVER)) {
    const rel = path.relative(SERVER, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');

    // Match real calls, not the many comments that mention the name.
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (!/sessionManager\.sendText\s*\(/.test(line)) return;
      if (ALLOWED_DIRECT_SENDS[rel]) return;
      offenders.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(
    offenders, [],
    'These call WhatsApp directly, skipping the communication policy. Route them through '
    + 'sendAndRecordOutbound (which enforces consent), or add them to ALLOWED_DIRECT_SENDS '
    + 'in this test with a written reason:\n  ' + offenders.join('\n  '),
  );
});

test('the exception list has not quietly grown', () => {
  // A second lock. Someone adding a file to ALLOWED_DIRECT_SENDS has to also
  // change this number, which makes it visible in review rather than a
  // one-line addition buried in a diff.
  assert.equal(
    Object.keys(ALLOWED_DIRECT_SENDS).length, 5,
    'The number of files allowed to send directly changed. That is not automatically wrong, '
    + 'but it should be a deliberate decision with a reason recorded above.',
  );
});

test('every exception carries a written justification', () => {
  for (const [file, reason] of Object.entries(ALLOWED_DIRECT_SENDS)) {
    assert.ok(
      reason && reason.length > 30,
      `${file} is exempted without a real explanation. "Because it needs to" is not one.`,
    );
  }
});

test('the central helper actually calls the policy before the transport', () => {
  // Guards against the exemption above becoming false — if outboundMessage.js
  // stopped checking consent, every other path would inherit the gap while
  // this suite stayed green.
  const raw = fs.readFileSync(path.join(SERVER, 'services/whatsapp/outboundMessage.js'), 'utf8');

  // Comments must not count. This file's own docstring explains the history
  // by naming sessionManager.sendText(), which an ordinary indexOf finds at
  // line 7 — making the ordering check compare a sentence against real code.
  // Caught by this test failing on correct source, which is the good outcome.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  const policyAt = src.indexOf('canSendMessage(');
  const sendAt = src.indexOf('sessionManager.sendText(');

  assert.ok(policyAt !== -1, 'outboundMessage.js must call canSendMessage');
  assert.ok(sendAt !== -1, 'outboundMessage.js must call sessionManager.sendText');
  assert.ok(
    policyAt < sendAt,
    'canSendMessage must be called BEFORE sessionManager.sendText — a check that runs after '
    + 'the message has gone out is not a check.',
  );
  assert.match(
    src, /allowed[\s\S]{0,200}throw/,
    'a disallowed decision must throw rather than fall through to the send',
  );
});

test('every sendAndRecordOutbound caller passes a category', () => {
  // The policy refuses an unclassified send at runtime, but that surfaces as
  // a failed message in production. Catching it here means a caller that
  // forgets is caught before it ships.
  const offenders = [];

  for (const file of sourceFiles(SERVER)) {
    const rel = path.relative(SERVER, file).split(path.sep).join('/');
    if (rel === 'services/whatsapp/outboundMessage.js') continue;
    const src = fs.readFileSync(file, 'utf8');

    // Each call site is an object literal; check the ~10 lines following the
    // call for a category. Crude, and sufficient — these are all formatted
    // the same way, and a false positive here is a prompt to look, not a bug.
    const re = /sendAndRecordOutbound\s*\([\s\S]{0,600}?\}\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!/category\s*:/.test(m[0])) {
        const lineNo = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${lineNo}`);
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'These send without declaring a communication category, which the policy will refuse '
    + 'at runtime:\n  ' + offenders.join('\n  '),
  );
});
