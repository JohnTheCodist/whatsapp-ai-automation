/**
 * What an error tells the client.
 *
 * WHY THIS FILE EXISTS. Every input contract in this codebase sets
 * `err.field` so a form can mark the box that is wrong — careInput,
 * vitalsInput, patientFilters, medicationInput all do it. The handler was
 * dropping it, silently, and the forms reading `body.field` highlighted
 * nothing: the message said "Pulse must be a number" while the pulse box
 * looked exactly like the other eight. Found on 2026-09-21 while driving the
 * medication form end to end.
 *
 * The other half of this file is the rule that was already right and must
 * stay right: a 500's message is replaced before it reaches anyone, because
 * an internal error's text is an internal detail.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { errorHandler } = require('../middleware/errorHandler');

/** The two bits of express this handler touches. */
function run(err) {
  const sent = {};
  const res = {
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
  // console.error is the handler's log line; silence it for the test.
  const realError = console.error;
  console.error = () => {};
  try {
    errorHandler(err, { id: 'req-1', method: 'POST', path: '/x', pharmacyId: 'p' }, res, () => {});
  } finally {
    console.error = realError;
  }
  return sent;
}

test('a client error names the field that was wrong, so the form can mark it', () => {
  const err = Object.assign(new Error('Pulse must be a number.'), {
    status: 400, code: 'INVALID_READING', field: 'pulse',
  });
  const sent = run(err);
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'Pulse must be a number.');
  assert.equal(sent.body.code, 'INVALID_READING');
  assert.equal(sent.body.field, 'pulse');
});

test('an error that names no field does not invent one', () => {
  const sent = run(Object.assign(new Error('Patient not found.'), { status: 404, code: 'NOT_FOUND' }));
  assert.equal(sent.body.field, undefined);
  assert.ok(!('field' in sent.body));
});

test('a 500 says nothing about itself — not its message, and not its field', () => {
  // The message is an internal detail and is replaced. A field would be one
  // too: it names a variable in code the caller cannot see.
  const sent = run(Object.assign(new Error('relation "secret_table" does not exist'), {
    field: 'secret_column',
  }));
  assert.equal(sent.status, 500);
  assert.equal(sent.body.error, 'Something went wrong');
  assert.equal(sent.body.code, 'INTERNAL_ERROR');
  assert.ok(!('field' in sent.body));
});

test('every error carries the request id, so a report can be traced to a log line', () => {
  assert.equal(run(new Error('boom')).body.requestId, 'req-1');
  assert.equal(run(Object.assign(new Error('nope'), { status: 400 })).body.requestId, 'req-1');
});

test('a 409 names the record it conflicted with — its id and name, nothing more', () => {
  // The conditions duplicate check: the screen offers "View existing", so it
  // needs to know which record that is.
  const sent = run(Object.assign(new Error('This patient already has an active Hypertension condition.'), {
    status: 409,
    code: 'DUPLICATE_ACTIVE',
    existing: { id: 'p-1', conditionName: 'Hypertension', notes: 'must not leak' },
  }));
  assert.equal(sent.status, 409);
  assert.deepEqual(sent.body.existing, { id: 'p-1', conditionName: 'Hypertension' });

  // A care programme conflicts with a programme, not a condition, and names it
  // under `label` (2026-09-24). The key the caller did NOT set is absent rather
  // than present-and-undefined: "nothing more" includes empty keys, and a
  // screen reading `existing.conditionName` on a programme conflict should find
  // nothing there instead of a hole shaped like an answer.
  const program = run(Object.assign(new Error('Diabetes care is already open for this patient.'), {
    status: 409,
    code: 'DUPLICATE_ACTIVE_PROGRAM',
    existing: { id: 'cp-1', label: 'Diabetes care', customerId: 'must not leak' },
  }));
  assert.deepEqual(program.body.existing, { id: 'cp-1', label: 'Diabetes care' });

  // Not on any other status, even if something set it.
  const other = run(Object.assign(new Error('x'), { status: 400, code: 'X', existing: { id: 'p-1' } }));
  assert.ok(!('existing' in other.body));
});
