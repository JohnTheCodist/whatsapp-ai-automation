/**
 * The consultation contract — no database, so it always runs.
 *
 * Two things in here are the product rather than plumbing, and they are what
 * most of these defend:
 *
 *   the finalisation gate   §23 says a minor ailment must not be held to a
 *                           chronic-disease review's standard, and the way to
 *                           keep that true is to let the TYPE say what it
 *                           needs rather than hard-coding one list.
 *
 *   the clinical summary    §22 says it must be assembled from what the
 *                           pharmacist actually entered. A summary that fills
 *                           its own gaps is a summary that invents findings.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REASON_CODES, REASON_IDS, STATUSES, SECTIONS,
  FOCUSED_FINDINGS, PLAN_ACTIONS, FINALISING_ROLES,
  readConsultationInput, readConsultationPatch, readErrorInput,
  sectionFilled, finalisationProblems, assertMayFinalise,
  CERTAINTY_IDS, PROBLEM_REF_IDS, INTERVENTION_IDS,
  readProblemInput, readInterventionInput, readReferralInput, readPrescriptionInput,
  readAmendmentInput, assertMayAmend,
  consultationSummary, consultationOptions,
} = require('../services/clinical/consultationInput');

const TYPES = [
  { slug: 'minor_ailment', label: 'Minor ailment', requiredSections: ['reason', 'assessment', 'plan'] },
  { slug: 'bp_review', label: 'Blood pressure review', requiredSections: ['reason', 'objective', 'assessment', 'plan'] },
];

// §39, and Medplum's ClinicalImpression. Four states, and a fifth invented
// here would be one nothing writes — the bug 0023 fixed when `mode` carried a
// 'closed' value nobody ever set.
test('a consultation has four states and no more', () => {
  assert.deepEqual([...STATUSES], ['draft', 'in_progress', 'completed', 'entered_in_error']);
});

test('only a pharmacist or the owner may finalise a clinical record', () => {
  // The rule every clinical module here uses: doing the work is not closing
  // the file (§33).
  assert.deepEqual([...FINALISING_ROLES], ['owner', 'pharmacist']);
  assert.doesNotThrow(() => assertMayFinalise('pharmacist'));
  assert.doesNotThrow(() => assertMayFinalise('owner'));
  for (const role of ['staff', null, undefined, 'admin']) {
    assert.throws(() => assertMayFinalise(role), (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'ROLE_REQUIRED');
      return true;
    });
  }
});

test('the reason list is fixed so a history can be filtered, and free text is always available', () => {
  assert.ok(REASON_CODES.length >= 12);
  for (const r of REASON_CODES) assert.ok(r.id && r.label);
  assert.equal(new Set(REASON_IDS).size, REASON_IDS.length);
  // `other` exists so the list is never a dead end.
  assert.ok(REASON_IDS.includes('other'));

  const parsed = readConsultationPatch({ reasonCode: 'cough', reasonText: 'Dry, four days' });
  assert.equal(parsed.reasonCode, 'cough');
  assert.equal(parsed.reasonText, 'Dry, four days');

  assert.throws(() => readConsultationPatch({ reasonCode: 'astrology' }), (e) => {
    assert.equal(e.field, 'reasonCode');
    return true;
  });
});

// §35 is explicit: do not copy hospital fields just because OpenEMR has them.
test('the examination is community-pharmacy scope, not a hospital one', () => {
  const ids = FOCUSED_FINDINGS.map((f) => f.id);
  assert.ok(ids.length <= 8, 'a focused examination, not a full physical');
  for (const hospital of ['review_of_systems', 'cardiovascular_exam', 'neurological_exam', 'family_history', 'social_history']) {
    assert.ok(!ids.includes(hospital), `${hospital} is a hospital field (§35)`);
  }
});

test('a blank finding is an observation NOT MADE, and is not stored as empty', () => {
  // An empty box saved as '' puts a finding on the note that nobody looked
  // for — and the next pharmacist reads it as "checked, nothing found".
  const out = readConsultationPatch({
    focusedFindings: { hydration: 'Well hydrated', skin: '   ', swelling: '' },
  });
  assert.deepEqual(out.focusedFindings, { hydration: 'Well hydrated' });

  assert.throws(() => readConsultationPatch({ focusedFindings: { spleen_size: '2cm' } }), (e) => {
    assert.equal(e.field, 'focusedFindings');
    return true;
  });
  assert.throws(() => readConsultationPatch({ focusedFindings: ['hydration'] }), (e) => {
    assert.equal(e.field, 'focusedFindings');
    return true;
  });
});

test('starting a consultation needs only a type', () => {
  // §34: a routine consultation should be quick. Demanding the reason before
  // the note even opens is how a workspace becomes a form.
  const started = readConsultationInput({ consultationType: 'minor_ailment' }, TYPES);
  assert.equal(started.consultationType, 'minor_ailment');
  assert.equal(started.encounterId, null, 'a counter consultation has no episode');

  assert.throws(() => readConsultationInput({}, TYPES), (e) => {
    assert.equal(e.field, 'consultationType');
    return true;
  });
  // A type this pharmacy does not use is refused rather than stored as a
  // string nothing can render.
  assert.throws(() => readConsultationInput({ consultationType: 'ward_round' }, TYPES), (e) => {
    assert.equal(e.field, 'consultationType');
    return true;
  });
});

// ---- the finalisation gate (§23) -----------------------------------------

test('what a note must contain to be finalised is decided by its TYPE', () => {
  const minorAilment = TYPES[0];
  const bpReview = TYPES[1];

  // The same half-written note: finalisable as a minor ailment, not as a
  // blood-pressure review, which is the whole point of §23's conditional
  // requirements.
  const note = {
    reasonCode: 'cough',
    assessmentText: 'Uncomplicated acute cough',
    planText: 'Hydration, monitor',
    focusedFindings: {},
    planActions: [],
  };
  assert.deepEqual(finalisationProblems(note, minorAilment), []);
  assert.deepEqual(finalisationProblems(note, bpReview), ['Record what was measured or observed.']);

  // With an objective, the review finalises too.
  const withObjective = { ...note, objective: 'BP 138/86 mmHg' };
  assert.deepEqual(finalisationProblems(withObjective, bpReview), []);
});

test('an empty note says everything it is missing, in sentences a pharmacist can act on', () => {
  const problems = finalisationProblems({}, TYPES[0]);
  assert.deepEqual(problems, [
    'Say why the patient was seen.',
    'Record your assessment.',
    'Record the plan.',
  ]);
  // Not a boolean, and not a field name — a person reads these.
  for (const p of problems) assert.match(p, /^[A-Z].*\.$/);
});

test('a section counts as filled by EITHER of the ways it can be filled', () => {
  // The objective is prose or focused findings; the plan is prose or ticked
  // actions. A note whose plan is three ticked actions is a plan.
  assert.equal(sectionFilled({ objective: 'BP 138/86' }, 'objective'), true);
  assert.equal(sectionFilled({ focusedFindings: { hydration: 'Well' } }, 'objective'), true);
  assert.equal(sectionFilled({ focusedFindings: {} }, 'objective'), false);

  assert.equal(sectionFilled({ planActions: ['monitoring'] }, 'plan'), true);
  assert.equal(sectionFilled({ planText: 'Repeat in 2 weeks' }, 'plan'), true);
  assert.equal(sectionFilled({ planActions: [] }, 'plan'), false);

  // The reason is a code OR free text — §7 allows either.
  assert.equal(sectionFilled({ reasonCode: 'cough' }, 'reason'), true);
  assert.equal(sectionFilled({ reasonText: 'Wants a second opinion' }, 'reason'), true);
  assert.equal(sectionFilled({}, 'reason'), false);

  // Phase 2 adds structured problems; the gate already accepts them, so a
  // note whose assessment is entirely structured will finalise.
  assert.equal(sectionFilled({ problems: [{ id: 'x' }] }, 'assessment'), true);
  assert.equal(sectionFilled({ assessmentText: 'Possible ADR' }, 'assessment'), true);

  for (const s of SECTIONS) assert.equal(sectionFilled(null, s), false);
});

// ---- the clinical summary (§22) ------------------------------------------

// THE MOST IMPORTANT TEST IN THIS FILE.
test('the summary OMITS what was never entered, and never writes "none"', () => {
  // §22: "This summary must be generated from the information the pharmacist
  // actually entered. Do not invent clinical findings."
  //
  // "Referral: none required" on a note where nobody considered referral is a
  // clinical claim the software made up, and the next pharmacist reads it as a
  // decision somebody took.
  const sparse = {
    reasonCode: 'cough',
    assessmentText: 'Uncomplicated acute cough',
    focusedFindings: {},
    planActions: [],
  };
  const parts = consultationSummary(sparse);
  const ids = parts.map((p) => p.id);

  assert.deepEqual(ids, ['reason', 'assessment'], 'only what was entered');
  assert.ok(!ids.includes('objective'));
  assert.ok(!ids.includes('subjective'));
  assert.ok(!ids.includes('plan'));

  const rendered = JSON.stringify(parts);
  for (const invented of ['none', 'nil', 'not required', 'no abnormality', 'unremarkable', 'normal']) {
    assert.ok(!rendered.toLowerCase().includes(invented), `the summary invented "${invented}"`);
  }
});

test('the summary reads back exactly what was entered, and labels it', () => {
  const full = {
    reasonCode: 'medication_side_effect',
    reasonText: 'Dizziness after starting amlodipine',
    durationText: '3 days',
    patientGoal: 'Wants to know if the dizziness is the new medicine',
    subjective: 'Dizziness mostly on standing',
    objective: 'BP 118/70 mmHg',
    focusedFindings: { general_appearance: 'Well' },
    assessmentText: 'Possible medication-related dizziness',
    planActions: ['monitoring', 'followup'],
    planText: 'Repeat BP in 2 weeks',
    notes: 'Advised to rise slowly',
  };
  const parts = consultationSummary(full);
  const by = Object.fromEntries(parts.map((p) => [p.id, p.lines]));

  assert.deepEqual(by.reason, [
    'Medication side effect — Dizziness after starting amlodipine',
    'Duration: 3 days',
    'Wants to know if the dizziness is the new medicine',
  ]);
  assert.deepEqual(by.subjective, ['Dizziness mostly on standing']);
  assert.deepEqual(by.objective, ['BP 118/70 mmHg', 'General appearance: Well']);
  assert.deepEqual(by.assessment, ['Possible medication-related dizziness']);
  assert.deepEqual(by.plan, ['Monitoring', 'Follow-up', 'Repeat BP in 2 weeks']);
  assert.deepEqual(by.notes, ['Advised to rise slowly']);

  // Every part carries a label a person reads, not a field name.
  for (const p of parts) assert.match(p.label, /^[A-Z]/);
});

test('the summary of an empty note is empty, rather than a skeleton of headings', () => {
  assert.deepEqual(consultationSummary({}), []);
  assert.deepEqual(consultationSummary(null), []);
});

// ---- retiring a note ------------------------------------------------------

test('a note marked entered in error must say why', () => {
  // 0060's rule, applied here: "saying a report was cancelled, amended or
  // corrected always says why".
  assert.deepEqual(readErrorInput({ reason: 'Recorded against the wrong patient' }),
    { reason: 'Recorded against the wrong patient' });
  for (const bad of [{}, { reason: '' }, { reason: '   ' }]) {
    assert.throws(() => readErrorInput(bad), (e) => {
      assert.equal(e.field, 'reason');
      return true;
    });
  }
});

test('the plan actions are a fixed list, and a repeat is one action', () => {
  const ids = PLAN_ACTIONS.map((p) => p.id);
  assert.ok(ids.includes('referral') && ids.includes('followup'));
  const parsed = readConsultationPatch({ planActions: ['monitoring', 'monitoring', 'followup'] });
  assert.deepEqual(parsed.planActions, ['monitoring', 'followup']);
  assert.throws(() => readConsultationPatch({ planActions: ['prescribe'] }), (e) => {
    assert.equal(e.field, 'planActions');
    return true;
  });
});

test('the screen is told what this phase cannot do, rather than guessing', () => {
  const { capabilities } = consultationOptions(TYPES);
  // AMENDED 2026-09-28 with the product: phase 2 (0069) built the problem
  // list, the interventions and the referral. The rule this pins — the screen
  // is TOLD rather than guessing — is unchanged.
  assert.equal(capabilities.problems, true);
  assert.equal(capabilities.interventions, true);
  assert.equal(capabilities.referral, true);
  // AMENDED 2026-09-28 with the product: phase 3 (0070) built amendment and
  // the per-note history. The rule this pins — the screen is TOLD what it
  // can do rather than guessing — is unchanged.
  assert.equal(capabilities.amendment, true);
  assert.equal(capabilities.history, true);
  // Not a phase: there is still no appointments table anywhere in this
  // product, so the screen must not draw a "Schedule appointment" button.
  assert.equal(capabilities.appointments, false);
});

// ---- phase 2: problems, interventions, referral ---------------------------

// §11 is emphatic that a pharmacist must not be forced into a definitive
// diagnosis. Keeping uncertainty as a VALUE is what lets a screen show it as
// uncertainty instead of rendering a guess in the same weight as a fact.
test('uncertainty is a value, so "possible angina" cannot be shown as "angina"', () => {
  assert.deepEqual([...CERTAINTY_IDS],
    ['possible', 'provisional', 'suspected', 'established', 'needs_evaluation']);

  const p = readProblemInput({ label: 'Angina' });
  assert.equal(p.certainty, 'possible', 'the honest default is the least certain one');
  assert.equal(p.status, 'under_assessment');

  assert.throws(() => readProblemInput({ label: 'Angina', certainty: 'confirmed_diagnosis' }),
    (e) => { assert.equal(e.field, 'certainty'); return true; });
});

test('a problem needs a label, and carries a pointer or nothing — never half of one', () => {
  assert.throws(() => readProblemInput({}), (e) => { assert.equal(e.field, 'label'); return true; });
  assert.throws(() => readProblemInput({ label: '   ' }), (e) => { assert.equal(e.field, 'label'); return true; });

  // A kind with no id names a table and no row; an id with no kind points at
  // nothing anybody can resolve.
  assert.throws(() => readProblemInput({ label: 'x', refKind: 'vitals' }),
    (e) => { assert.equal(e.field, 'refId'); return true; });
  assert.throws(() => readProblemInput({ label: 'x', refId: '11111111-2222-3333-4444-555555555555' }),
    (e) => { assert.equal(e.field, 'refKind'); return true; });
  assert.throws(() => readProblemInput({ label: 'x', refKind: 'appointment', refId: '11111111-2222-3333-4444-555555555555' }),
    (e) => { assert.equal(e.field, 'refKind'); return true; });

  const ok = readProblemInput({ label: 'Uncontrolled BP', refKind: 'vitals', refId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(ok.refKind, 'vitals');
  assert.deepEqual(Object.keys(ok).sort(), ['certainty', 'label', 'note', 'refId', 'refKind', 'status']);
});

test('a problem carries a pointer and NEVER a copy of what the record says', () => {
  // §3: reference those records rather than duplicating them. A copied dose
  // would still read 10 mg after the prescription changed.
  const p = readProblemInput({
    label: 'Poor adherence to metformin',
    refKind: 'medication',
    refId: '11111111-2222-3333-4444-555555555555',
    // Everything below is the caller trying to say what the record holds.
    medicineName: 'Metformin 500 mg', dose: '500 mg', lastResult: '7.8%', systolic: 150,
  });
  assert.deepEqual(Object.keys(p).sort(), ['certainty', 'label', 'note', 'refId', 'refKind', 'status']);
});

test('every kind a problem can point at is one clinicalRefs can resolve', () => {
  const { RESOLVABLE } = require('../services/clinical/clinicalRefs');
  for (const k of PROBLEM_REF_IDS) {
    assert.ok(RESOLVABLE.includes(k), `${k} is offered but names no record`);
  }
});

test('an intervention may be about one problem, or about none', () => {
  assert.ok(INTERVENTION_IDS.includes('no_intervention'), 'doing nothing is a recordable decision');
  const general = readInterventionInput({ kind: 'patient_counselling' });
  assert.equal(general.problemId, null, 'null means "not about one in particular", not "unknown"');

  const about = readInterventionInput({
    kind: 'adherence_counselling', problemId: '11111111-2222-3333-4444-555555555555',
    note: 'Discussed taking metformin with the evening meal.',
  });
  assert.equal(about.kind, 'adherence_counselling');
  assert.match(about.note, /evening meal/);

  assert.throws(() => readInterventionInput({ kind: 'prescribe' }),
    (e) => { assert.equal(e.field, 'kind'); return true; });
});

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('"referral not considered" and "referral not required" are different facts', () => {
  // §17. Leaving referral alone and choosing "No referral required" are not
  // the same. "Referral: not required" on a note where nobody considered it is
  // a clinical decision the software invented, and the next pharmacist reads
  // it as one somebody took.
  const base = { reasonCode: 'cough', assessmentText: 'x', planText: 'y', focusedFindings: {}, planActions: [] };

  const never = consultationSummary(base);
  assert.ok(!never.some((s) => s.id === 'referral'), 'never considered says nothing at all');

  const decided = consultationSummary({ ...base, referralDestination: 'none' });
  const line = decided.find((s) => s.id === 'referral');
  assert.ok(line, 'a decision is recorded');
  assert.deepEqual(line.lines, ['No referral required']);

  const referred = consultationSummary({
    ...base, referralDestination: 'physician',
    referralReason: 'Persistent elevated BP despite treatment', referralUrgency: 'routine',
  });
  assert.deepEqual(referred.find((s) => s.id === 'referral').lines,
    ['Refer to physician', 'Urgency: Routine', 'Persistent elevated BP despite treatment']);
});

test('a referral that names somewhere must say why', () => {
  // A pharmacist reading "Refer to hospital" with no reason cannot act on it,
  // and neither can the hospital.
  assert.throws(() => readReferralInput({ destination: 'hospital' }),
    (e) => { assert.equal(e.field, 'reason'); return true; });

  // "No referral required" needs no reason — the decision IS the content.
  assert.deepEqual(readReferralInput({ destination: 'none' }),
    { destination: 'none', reason: null, urgency: null, notes: null });

  // Clearing it goes back to "not considered".
  assert.deepEqual(readReferralInput({ destination: null }),
    { destination: null, reason: null, urgency: null, notes: null });

  // Saying nothing at all is a malformed request, not a decision.
  assert.throws(() => readReferralInput({}), (e) => { assert.equal(e.field, 'destination'); return true; });

  assert.throws(() => readReferralInput({ destination: 'physician', reason: 'x', urgency: 'whenever' }),
    (e) => { assert.equal(e.field, 'urgency'); return true; });
});

test('the summary numbers the problems and prints the certainty with them', () => {
  // "angina" and "possible angina" are different clinical statements, and the
  // summary is the part that gets read.
  const parts = consultationSummary({
    reasonCode: 'cough', focusedFindings: {}, planActions: [],
    problems: [
      { label: 'Poor adherence to metformin', certainty: 'established', status: 'active' },
      { label: 'medication-related dizziness', certainty: 'possible', status: 'under_assessment' },
    ],
    interventions: [
      { kind: 'adherence_counselling', note: 'Discussed the evening dose.' },
      { kind: 'monitoring_advised', note: null },
    ],
  });

  assert.deepEqual(parts.find((p) => p.id === 'problems').lines, [
    '1. Poor adherence to metformin — Active',
    '2. Possible medication-related dizziness — Under assessment',
  ]);
  assert.deepEqual(parts.find((p) => p.id === 'interventions').lines, [
    'Adherence counselling — Discussed the evening dose.',
    'Monitoring advised',
  ]);
});

test('the summary reads back in the order the note is written', () => {
  // The problem list and the interventions belong to the assessment, and the
  // plan follows from them. This is pinned because phase 2 first appended
  // both to the END of the summary, so a pharmacist filled the screen in one
  // order and read it back in another — and the summary is what the NEXT
  // pharmacist reads, in a hurry, to find out what was decided.
  const parts = consultationSummary({
    reasonCode: 'cough', subjective: 'Four days', objective: 'Chest clear',
    assessmentText: 'Uncomplicated acute cough', planText: 'Hydration',
    focusedFindings: {}, planActions: [],
    problems: [{ label: 'acute cough', certainty: 'possible', status: 'active' }],
    interventions: [{ kind: 'self_care_advice' }],
    referralDestination: 'none', referralReason: 'Self-limiting',
    notes: 'Patient reassured',
  });
  assert.deepEqual(parts.map((x) => x.id), [
    'reason', 'subjective', 'objective', 'assessment',
    'problems', 'interventions', 'plan', 'referral', 'notes',
  ]);
});

test('a note with no problems and no interventions says nothing about them', () => {
  const parts = consultationSummary({
    reasonCode: 'cough', focusedFindings: {}, planActions: [], problems: [], interventions: [],
  });
  const ids = parts.map((p) => p.id);
  assert.ok(!ids.includes('problems'));
  assert.ok(!ids.includes('interventions'));
  assert.ok(!ids.includes('referral'));
});

test('the assessment gate accepts a structured problem list as an assessment', () => {
  // Phase 1 wrote `sectionFilled` to accept either, so a note whose assessment
  // is entirely structured finalises without free text.
  const note = {
    reasonCode: 'cough', planText: 'Hydration', focusedFindings: {}, planActions: [],
    problems: [{ label: 'Uncomplicated acute cough', certainty: 'possible', status: 'active' }],
  };
  assert.deepEqual(finalisationProblems(note, { requiredSections: ['reason', 'assessment', 'plan'] }), []);
});

test('§16 records that a clarification happened, and cannot record an answer nobody was asked for', () => {
  const p = readPrescriptionInput({ issues: ['dose', 'dose', 'interaction'], prescriberContacted: true, prescriberOutcome: 'Dose confirmed' });
  assert.deepEqual(p.issues, ['dose', 'interaction']);
  assert.equal(p.prescriberOutcome, 'Dose confirmed');

  // An outcome with nobody contacted leaves a sentence nobody can attribute.
  assert.throws(() => readPrescriptionInput({ issues: [], prescriberOutcome: 'Dose confirmed' }),
    (e) => { assert.equal(e.field, 'prescriberContacted'); return true; });

  assert.throws(() => readPrescriptionInput({ issues: ['handwriting'] }),
    (e) => { assert.equal(e.field, 'issues'); return true; });
});

/* ==========================================================================
 * Phase 3 — amending a finalised note (§32)
 * ======================================================================== */

// THE MOST IMPORTANT TEST IN THIS BLOCK.
test('an amendment always says why, and a blank box is not a reason', () => {
  // 0060 settled this for diagnostic reports and it holds here unchanged: a
  // clinical record whose history reads "amended, amended, amended" with no
  // reasons tells the next pharmacist that it changed and nothing else —
  // which is worse than no history, because it looks like one.
  for (const bad of [undefined, null, '', '   ', '\t\n', 'ok', '  x  ']) {
    assert.throws(
      () => readAmendmentInput({ reason: bad }),
      (e) => {
        assert.equal(e.status, 400);
        assert.equal(e.field, 'reason', `no field named for ${JSON.stringify(bad)}`);
        return true;
      },
      `accepted ${JSON.stringify(bad)} as a reason`,
    );
  }

  // A SHORT reason is a real reason. The floor refuses an empty box and a
  // stray keystroke; it is not there to make a pharmacist justify themselves
  // to a form, and whether a reason is a good one is a judgement for the
  // person reading the history.
  assert.deepEqual(readAmendmentInput({ reason: 'typo' }), { reason: 'typo' });
  assert.deepEqual(readAmendmentInput({ reason: '  BP was 148/92, not 149/92  ' }),
    { reason: 'BP was 148/92, not 149/92' });
});

test('only a pharmacist or the owner may amend, and it is the same list that signs', () => {
  // Deliberately the SAME roles that may finalise, asserted against the same
  // frozen list rather than a second copy of it. A note is reopened in order
  // to be re-signed, so splitting the two would let a staff member reopen a
  // record that nobody could then close.
  for (const role of FINALISING_ROLES) assert.doesNotThrow(() => assertMayAmend(role));
  for (const role of ['staff', 'assistant', '', null, undefined, 'admin']) {
    assert.throws(() => assertMayAmend(role), (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.code, 'ROLE_REQUIRED');
      return true;
    }, `${role} was allowed to amend`);
  }
});

test('amending adds no status — a reopened note is in progress, not "amended"', () => {
  // 0070 argues this at length. The short version: a note being corrected is
  // NOT finished, and a fifth status would show a half-rewritten clinical
  // record as though it were signed. "Has this been amended, and how often?"
  // is answered by counting the snapshot rows on every read.
  assert.deepEqual(STATUSES, ['draft', 'in_progress', 'completed', 'entered_in_error']);
  assert.ok(!STATUSES.includes('amended'));
});
