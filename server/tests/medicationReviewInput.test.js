/**
 * The contract for a medication review.
 *
 * What these defend against, in order of how much it would cost: a finding
 * recorded with nothing done about it; a follow-up nobody can act on when it
 * arrives; and an intervention pointing at a problem that was never stored,
 * which is the one that would produce a review that reads as complete and
 * answers nothing.
 *
 * Database-free: runs everywhere.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ADHERENCE, PROBLEMS, ACTIONS, OUTCOMES,
  readReviewInput, reviewOptions,
} = require('../services/clinical/medicationReviewInput');

const TODAY = '2026-09-21';
const read = (body, signing = false) => readReviewInput(body, { today: TODAY, signing });

function rejects(body, field, signing = false) {
  assert.throws(() => read(body, signing), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_REVIEW');
    assert.equal(err.field, field);
    return true;
  });
}

test('an empty review is a valid DRAFT — a review is a conversation, not a form', () => {
  const r = read({});
  assert.equal(r.reviewedOn, TODAY);
  assert.equal(r.adherence, 'unknown');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.actions, []);
});

test('adherence defaults to unknown, which is a real answer', () => {
  // Forcing a choice would put "good" against every patient nobody managed
  // to ask, and that reads later as an assessment that was made.
  assert.equal(read({}).adherence, 'unknown');
  assert.equal(read({ adherence: 'poor' }).adherence, 'poor');
  rejects({ adherence: 'ok' }, 'adherence');
});

test('a problem may name the medicine it is about, or stand alone', () => {
  const uuid = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';
  const r = read({
    problems: [
      { problem: 'incorrect_dose', journeyId: uuid, notes: 'Taking two instead of one' },
      // "Cannot afford their medicines" is about the patient, not a row.
      { problem: 'access_cost' },
    ],
  });
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[0].journeyId, uuid);
  assert.equal(r.problems[1].journeyId, null);
  rejects({ problems: [{ problem: 'feels_bad' }] }, 'problem');
  rejects({ problems: [{ notes: 'something' }] }, 'problems');
  rejects({ problems: 'non_adherence' }, 'problems');
});

test('the same problem twice against the same medicine is a double-click, not two findings', () => {
  const uuid = '6f1c2b1e-8d4a-4c3e-9b7a-2f5d8e1a0c44';
  rejects({ problems: [{ problem: 'adverse_effect', journeyId: uuid }, { problem: 'adverse_effect', journeyId: uuid }] }, 'problems');
  // The same problem on two DIFFERENT medicines is two findings.
  const other = '7a2d3c2f-9e5b-4d4f-8c6b-3a6e9f2b1d55';
  assert.equal(read({
    problems: [{ problem: 'adverse_effect', journeyId: uuid }, { problem: 'adverse_effect', journeyId: other }],
  }).problems.length, 2);
});

test('an intervention can only answer a problem this review actually holds', () => {
  // The failure this prevents: a review that reads as complete, where
  // "prescriber contacted" points at a finding nobody stored.
  const r = read({
    problems: [{ problem: 'potential_interaction', ref: 'a' }],
    actions: [{ action: 'prescriber_contacted', problemRef: 'a', notes: 'Rang Dr John' }],
  });
  assert.equal(r.actions[0].problemRef, 'a');
  rejects({
    problems: [{ problem: 'potential_interaction', ref: 'a' }],
    actions: [{ action: 'prescriber_contacted', problemRef: 'b' }],
  }, 'actions');
});

test('an intervention may be general, belonging to no single problem', () => {
  const r = read({ actions: [{ action: 'counselling_provided' }] });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].problemRef, null);
  rejects({ actions: [{ action: 'gave_advice' }] }, 'action');
});

test('SIGNING requires an outcome and an answer to every problem found', () => {
  // A draft may be anything — that is what a draft is for. Signing is the
  // assertion that the review is finished.
  assert.doesNotThrow(() => read({ problems: [{ problem: 'non_adherence' }] }));
  rejects({ problems: [{ problem: 'non_adherence' }], outcome: 'pending' }, 'actions', true);
  rejects({ outcome: null }, 'outcome', true);

  // "Monitoring recommended" is a valid answer to a problem.
  assert.doesNotThrow(() => read({
    outcome: 'monitoring',
    problems: [{ problem: 'non_adherence', ref: 0 }],
    actions: [{ action: 'adherence_counselling', problemRef: 0 }],
  }, true));
  // A review that found nothing signs with an outcome alone.
  assert.doesNotThrow(() => read({ outcome: 'resolved' }, true));
});

test('a follow-up needs both a date and a reason, or neither', () => {
  // A date with no reason is a date nobody can act on when it arrives; a
  // reason with no date never comes round at all.
  rejects({ followUpOn: '2026-10-21' }, 'followUpReason');
  rejects({ followUpReason: 'Check the blood pressure' }, 'followUpOn');
  const r = read({ followUpOn: '2026-10-21', followUpReason: 'Check the blood pressure' });
  assert.equal(r.followUpOn, '2026-10-21');
  assert.equal(r.followUpReason, 'Check the blood pressure');
  assert.equal(read({}).followUpOn, null);
});

test('a follow-up is in the future and a review is not', () => {
  rejects({ followUpOn: '2026-09-01', followUpReason: 'x' }, 'followUpOn');
  rejects({ reviewedOn: '2026-12-01' }, 'reviewedOn');
  assert.equal(read({ reviewedOn: '2026-09-01' }).reviewedOn, '2026-09-01');
});

test('the vocabulary is the brief\'s, and nothing in it is ranked', () => {
  assert.equal(PROBLEMS.length, 13);
  assert.equal(ACTIONS.length, 9);
  assert.deepEqual(OUTCOMES.map((o) => o.value),
    ['resolved', 'monitoring', 'prescriber_follow_up', 'referred', 'pending']);
  assert.deepEqual(ADHERENCE.map((a) => a.value), ['good', 'partial', 'poor', 'unknown']);
  // NO SEVERITY, NO PRIORITY, NO SCORE anywhere. A stored ranking would be
  // the software forming a clinical judgement of its own.
  for (const list of [PROBLEMS, ACTIONS, OUTCOMES, ADHERENCE]) {
    for (const item of list) {
      assert.deepEqual(Object.keys(item).sort(), ['label', 'value'], `${item.value} carries only a label`);
    }
  }
});

test('the options a review form offers are exactly what the contract accepts', () => {
  const options = reviewOptions();
  for (const { value } of options.adherence) assert.doesNotThrow(() => read({ adherence: value }));
  for (const { value } of options.outcomes) assert.doesNotThrow(() => read({ outcome: value }));
  for (const { value } of options.problems) assert.doesNotThrow(() => read({ problems: [{ problem: value }] }));
  for (const { value } of options.actions) assert.doesNotThrow(() => read({ actions: [{ action: value }] }));
});
