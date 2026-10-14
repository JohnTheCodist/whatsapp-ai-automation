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

test('a 5xx whose sentence WE wrote may show it; one we did not may not', () => {
  // Added 2026-10-10 with the AI scribe, which has to tell a pharmacist that
  // transcription is down and the note must be TYPED. That sentence is the
  // entire value of the reply, and `status < 500` was masking it — which is
  // also why `routes/pharmacies.js` and `routes/website.js` have been
  // sending "Something went wrong" in place of their own 503 wording.
  //
  // The distinguishing property was never the status code. It is whether a
  // PERSON wrote the message, so the flag is opt-in and means exactly that.
  const shown = run(Object.assign(
    new Error('Voice transcription is not available right now. Type the note instead.'),
    { status: 503, code: 'LLM_UNAVAILABLE', expose: true },
  ));
  assert.equal(shown.status, 503);
  assert.match(shown.body.error, /Type the note instead/);
  assert.equal(shown.body.code, 'LLM_UNAVAILABLE');

  // A 503 that did NOT opt in is still masked. A library or a pool throwing
  // its own 503 is precisely the internal detail this rule exists to hide.
  const masked = run(Object.assign(
    new Error('ECONNREFUSED 10.0.0.4:5432 while acquiring pool client'),
    { status: 503 },
  ));
  assert.equal(masked.body.error, 'Something went wrong');
  assert.equal(masked.body.code, 'INTERNAL_ERROR');
});

test('only a hand-written sentence is ever marked for the user', () => {
  // THE INVARIANT THAT MAKES THE FLAG SAFE, and the reason it is a grep
  // rather than a behaviour test: `expose` is only sound while every place
  // that sets it is a literal sentence somebody wrote. Set it from a
  // caught error — `e.expose = true` on a database failure — and this
  // middleware starts publishing schema names, which is the one thing it
  // was written to prevent.
  //
  // GOLDEN-007 pins a closed list of senders the same way, for the same
  // reason: the risk is a FIFTH caller, not the four that exist.
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '..');

  const found = [];
  const walk = (dir) => {
    for (const entry of fs2.readdirSync(dir, { withFileTypes: true })) {
      const full = path2.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'tests') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const text = fs2.readFileSync(full, 'utf8');
        if (/\.expose\s*=\s*true/.test(text)) {
          found.push(path2.relative(root, full).split(path2.sep).join('/'));
        }
      }
    }
  };
  walk(root);

  // The closed list. A new entry here has to argue that its message is a
  // sentence written for a user and contains nothing internal.
  //
  // TWO ADDED 2026-10-14 for dictation, and the argument for each:
  //
  //   services/ai/dictation.js  refuses audio past the thirty-second cap
  //     ("Dictation is for short phrases — that was 94 seconds.") and audio
  //     whose length could not be measured. Both are written here; the only
  //     interpolation is a duration the speaker themselves produced.
  //
  //   routes/dictation.js       refuses an oversized body and a file that is
  //     not audio. Written here too — and deliberately NOT multer’s own
  //     message, which would have let text this project did not author
  //     through the exemption the moment multer raised something nobody
  //     anticipated. That hole existed in the first draft and THIS TEST is
  //     what found it.
  //
  // Both are the designed degradation: dictation fails, the pharmacist
  // types instead, and the sentence says so. A masked 5xx telling them
  // nothing is the defect the `expose` flag exists to fix.
  assert.deepEqual(found.sort(), [
    'routes/consultations.js',
    'routes/dictation.js',
    'services/ai/dictation.js',
  ]);
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
