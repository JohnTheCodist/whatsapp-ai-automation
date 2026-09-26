/**
 * How a medication review is written on screen.
 *
 * The failures these defend against: a review that found nothing rendered as
 * an empty list, so a completed check reads as one nobody did; an
 * intervention shown beside its problem rather than under it, so "which
 * interaction did you ring about" goes unanswered; and a Sign button that
 * refuses without saying what is missing.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADHERENCE_TONE, OUTCOME_TONE, labelFor, reviewDate, findingsLine, followUpLine,
  reviewByLine, findingsByProblem, blockingReasons, medicineLabel, reviewsSummary,
} from './reviewFormat.js';

const review = (over = {}) => ({
  id: 'r1', reviewedOn: '2026-09-21', adherence: 'unknown', status: 'draft',
  problems: [], actions: [], ...over,
});

test('a review that found nothing says so, rather than showing an empty list', () => {
  // "Nothing found" is a result: the medicines were checked and were right.
  // An empty list reads as a review nobody did.
  expect(findingsLine(review())).toBe('Nothing found');
  expect(findingsLine(review({ problems: [{ id: 'p1' }] }))).toBe('1 problem');
  expect(findingsLine(review({
    problems: [{ id: 'p1' }, { id: 'p2' }],
    actions: [{ id: 'a1' }, { id: 'a2' }],
  }))).toBe('2 problems · 2 interventions');
  // Interventions with no problem recorded is a legitimate review — advice
  // was given, nothing was wrong.
  expect(findingsLine(review({ actions: [{ id: 'a1' }] }))).toBe('1 intervention');
});

test('each intervention is read under the problem it answers', () => {
  const r = review({
    problems: [{ id: 'p1', problem: 'potential_interaction' }, { id: 'p2', problem: 'incorrect_dose' }],
    actions: [
      { id: 'a1', action: 'prescriber_contacted', problemId: 'p2' },
      { id: 'a2', action: 'counselling_provided', problemId: null },
    ],
  });
  const { problems, general } = findingsByProblem(r);
  expect(problems[0].actions).toEqual([]);
  expect(problems[1].actions.map((a) => a.action)).toEqual(['prescriber_contacted']);
  // An intervention over the whole review is not an orphan.
  expect(general.map((a) => a.action)).toEqual(['counselling_provided']);
});

test('the Sign button says what is missing instead of failing on submit', () => {
  expect(blockingReasons({ outcome: null })).toContain('Say how the review was left.');
  // A problem found with nothing done about it is an unfinished review.
  expect(blockingReasons({ outcome: 'pending', problems: [{ ref: 0 }], actions: [] }))
    .toContain('Record what you did about the problems you found.');
  expect(blockingReasons({ outcome: 'resolved', followUpOn: '2026-10-21' }))
    .toContain('Say what the follow-up is for.');
  expect(blockingReasons({ outcome: 'resolved', followUpReason: 'Check the BP' }))
    .toContain('Say when to follow up.');

  // "Monitoring recommended" is an answer to a problem, and a review that
  // found nothing signs with an outcome alone.
  expect(blockingReasons({
    outcome: 'monitoring', problems: [{ ref: 0 }], actions: [{ action: 'monitoring_recommended' }],
  })).toEqual([]);
  expect(blockingReasons({ outcome: 'resolved' })).toEqual([]);
});

test('a follow-up is written only when it can actually be acted on', () => {
  expect(followUpLine(review({ followUpOn: '2026-10-21', followUpReason: 'Check the blood pressure' })))
    .toMatch(/^Follow up 21 Oct 2026 — Check the blood pressure$/);
  // Half a follow-up is not shown as one.
  expect(followUpLine(review({ followUpOn: '2026-10-21' }))).toBe(null);
  expect(followUpLine(review({ followUpReason: 'Check the BP' }))).toBe(null);
  expect(followUpLine(review())).toBe(null);
});

test('an unattributed review still says it was signed', () => {
  // DEV_AUTH_BYPASS has no real user, and a review that happened happened.
  expect(reviewByLine(review({ status: 'signed', signedAt: '2026-09-21T10:00:00Z' })))
    .toMatch(/^Signed 21 Sept? 2026$/);
  expect(reviewByLine(review({
    status: 'signed', signedAt: '2026-09-21T10:00:00Z',
    reviewer: { id: 'u1', email: 'ade@example.test' },
  }))).toMatch(/by ade@example\.test$/);
  expect(reviewByLine(review())).toBe('Draft — not signed');
});

test('nothing on this screen ranks a finding', () => {
  // No severity, no risk score, no priority. A stored or displayed ranking
  // would be the software forming a clinical judgement of its own.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'reviewFormat.js'), 'utf8',
  );
  for (const word of ['severity', 'priority', 'riskScore', 'urgent', 'critical']) {
    expect(source.toLowerCase(), word).not.toContain(`${word.toLowerCase()}:`);
  }
  // Poor adherence is queued work, not an alarm — the app reserves red for a
  // person waiting.
  expect(ADHERENCE_TONE.poor).toBe('ui-tone-3');
  expect(ADHERENCE_TONE.unknown).toBe('ui-tone-quiet');
  expect(Object.keys(OUTCOME_TONE)).toHaveLength(5);
});

test('labels come from the server\'s own list, and an unknown value still shows', () => {
  const list = [{ value: 'non_adherence', label: 'Non-adherence' }];
  expect(labelFor(list, 'non_adherence')).toBe('Non-adherence');
  // A value the options call has not returned yet renders as itself rather
  // than vanishing from the record.
  expect(labelFor(list, 'access_cost')).toBe('access_cost');
  expect(labelFor(list, null)).toBe(null);
});

test('every tone key is a value the server accepts', () => {
  // If a key drifts, a chip renders unstyled for ever and nothing fails.
  const server = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'services', 'clinical', 'medicationReviewInput.js'),
    'utf8',
  );
  for (const key of Object.keys(ADHERENCE_TONE)) {
    expect(server, `the server knows the adherence "${key}"`).toContain(`value: '${key}'`);
  }
  for (const key of Object.keys(OUTCOME_TONE)) {
    expect(server, `the server knows the outcome "${key}"`).toContain(`value: '${key}'`);
  }
});

test('a medicine on a review line is named the way it is named everywhere else', () => {
  expect(medicineLabel({ medicineName: 'Amlodipine', strength: '10 mg' })).toBe('Amlodipine 10 mg');
  expect(medicineLabel({ medicineName: 'Amlodipine' })).toBe('Amlodipine');
  expect(medicineLabel(null)).toBe(null);
});

test('the history heading counts reviews, and says plainly when there are none', () => {
  expect(reviewsSummary([])).toBe('No medication review recorded');
  expect(reviewsSummary([review()])).toBe('1 review');
  expect(reviewsSummary([review(), review()])).toBe('2 reviews');
  expect(reviewDate('2026-09-21')).toMatch(/^21 Sept? 2026$/);
  expect(reviewDate(null)).toBe(null);
});
