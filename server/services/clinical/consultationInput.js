/**
 * What a consultation request may say, and what a finished note reads like —
 * the whole contract, with no database in it.
 *
 * See CONSULTATION_PLAN.md. This exists for the reason `followupInput` and
 * `problemInput` exist: the screen sends strings, the service needs values it
 * can trust, and the conversion belongs somewhere testable without fixtures.
 *
 * TWO THINGS IN HERE ARE THE PRODUCT, NOT PLUMBING.
 *
 *   `finalisationProblems`  what must be filled before a note may be called
 *                           completed — driven by the TYPE, because §23 says
 *                           a minor ailment must not demand the same note as
 *                           a chronic-disease review.
 *
 *   `consultationSummary`   §22's summary, assembled ONLY from what the
 *                           pharmacist entered. It omits what was left empty
 *                           rather than writing "None", because "Referral:
 *                           none" on a note where nobody considered referral
 *                           is a clinical claim this software did not earn.
 */

/**
 * Why the patient is being seen (§7).
 *
 * A fixed list so a history can be filtered by it, plus free text for
 * everything real life does that a list does not — `reasonText` is always
 * available and `other` is not a dead end.
 */
const REASON_CODES = Object.freeze([
  { id: 'headache', label: 'Headache' },
  { id: 'cough', label: 'Cough' },
  { id: 'fever', label: 'Fever' },
  { id: 'skin_rash', label: 'Skin rash' },
  { id: 'medication_question', label: 'Medication question' },
  { id: 'medication_side_effect', label: 'Medication side effect' },
  { id: 'poor_adherence', label: 'Poor adherence' },
  { id: 'bp_review', label: 'Blood pressure review' },
  { id: 'glucose_review', label: 'Blood glucose review' },
  { id: 'weight_management', label: 'Weight management' },
  { id: 'prescription_clarification', label: 'Prescription clarification' },
  { id: 'chronic_followup', label: 'Chronic disease follow-up' },
  { id: 'other', label: 'Other' },
]);

const REASON_IDS = Object.freeze(REASON_CODES.map((r) => r.id));

/** §39. The four Medplum ClinicalImpression carries, and no more. */
const STATUSES = Object.freeze(['draft', 'in_progress', 'completed', 'entered_in_error']);

/** A note that is still being written. */
const OPEN_STATUSES = Object.freeze(['draft', 'in_progress']);

/**
 * §9's focused findings — community pharmacy scope, and deliberately short.
 *
 * §35 is explicit: do not copy hospital fields just because OpenEMR has them.
 * There is no review of systems here and no full physical examination. These
 * are the things a pharmacist actually looks at across a counter.
 */
const FOCUSED_FINDINGS = Object.freeze([
  { id: 'general_appearance', label: 'General appearance' },
  { id: 'hydration', label: 'Hydration' },
  { id: 'respiratory', label: 'Respiratory findings' },
  { id: 'skin', label: 'Skin findings' },
  { id: 'swelling', label: 'Swelling' },
  { id: 'tenderness', label: 'Palpable tenderness' },
  { id: 'other', label: 'Other focused finding' },
]);

const FINDING_IDS = Object.freeze(FOCUSED_FINDINGS.map((f) => f.id));

/** §18. What the pharmacist intends to happen next, as tickable actions. */
const PLAN_ACTIONS = Object.freeze([
  { id: 'continue', label: 'Continue current management' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'education', label: 'Patient education' },
  { id: 'medication_review', label: 'Medication review' },
  { id: 'test_required', label: 'Test required' },
  { id: 'referral', label: 'Referral' },
  { id: 'followup', label: 'Follow-up' },
  { id: 'care_program', label: 'Care programme enrolment' },
  { id: 'other', label: 'Other' },
]);

const PLAN_ACTION_IDS = Object.freeze(PLAN_ACTIONS.map((p) => p.id));

/** The sections a type may require. Phase 1 knows about these five. */
const SECTIONS = Object.freeze(['reason', 'subjective', 'objective', 'assessment', 'plan']);

/** Only a pharmacist or the owner may finalise or retire a note (§33). */
const FINALISING_ROLES = Object.freeze(['owner', 'pharmacist']);

function invalid(field, message, code = 'INVALID') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  err.field = field;
  return err;
}

const text = (v, max) => {
  const s = v == null ? '' : String(v).trim();
  return s.length === 0 ? null : s.slice(0, max);
};

/**
 * Starting a consultation.
 *
 * A type and nothing else is required. §34 says a pharmacist should be able to
 * complete a routine consultation quickly, and demanding the reason before the
 * note even opens is how a workspace becomes a form.
 */
function readConsultationInput(body = {}, definitions = null) {
  const consultationType = String(body.consultationType || body.type || '').trim();
  if (!consultationType) throw invalid('consultationType', 'Choose the kind of consultation.');
  if (definitions && !definitions.some((d) => d.slug === consultationType)) {
    throw invalid('consultationType', 'That is not a consultation type this pharmacy uses.');
  }

  const out = { consultationType, ...readConsultationPatch(body, { partial: false }) };

  // The episode this belongs to, when there is one. A counter consultation has
  // none, and that is the common case rather than the exception (plan §11.1).
  const encounterId = text(body.encounterId, 64);
  out.encounterId = encounterId;

  return out;
}

/**
 * Editing a draft. Every field is optional — this is a workspace that is
 * saved as it is filled, not a form submitted once.
 */
function readConsultationPatch(body = {}, { partial = true } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('reasonCode')) {
    const code = text(body.reasonCode, 64);
    if (code && !REASON_IDS.includes(code)) {
      throw invalid('reasonCode', 'That is not a reason this product lists.');
    }
    out.reasonCode = code;
  }
  if (!partial || has('reasonText')) out.reasonText = text(body.reasonText, 500);
  if (!partial || has('durationText')) out.durationText = text(body.durationText, 120);
  if (!partial || has('patientGoal')) out.patientGoal = text(body.patientGoal, 1000);
  if (!partial || has('subjective')) out.subjective = text(body.subjective, 8000);
  if (!partial || has('objective')) out.objective = text(body.objective, 8000);
  if (!partial || has('assessmentText')) out.assessmentText = text(body.assessmentText, 8000);
  if (!partial || has('planText')) out.planText = text(body.planText, 8000);
  if (!partial || has('notes')) out.notes = text(body.notes, 8000);

  if (!partial || has('focusedFindings')) {
    out.focusedFindings = readFindings(body.focusedFindings);
  }
  if (!partial || has('planActions')) {
    out.planActions = readPlanActions(body.planActions);
  }

  return out;
}

/** §9's findings: a known key, and what the pharmacist saw. */
function readFindings(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('focusedFindings', 'Focused findings must be a set of named observations.');
  }
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (!FINDING_IDS.includes(key)) {
      throw invalid('focusedFindings', 'That is not a finding this product records.');
    }
    const t = text(v, 500);
    // An empty box is an observation NOT MADE, not an empty one. Storing ''
    // would put a finding on the note that nobody looked for.
    if (t) out[key] = t;
  }
  return out;
}

function readPlanActions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw invalid('planActions', 'Plan actions must be a list.');
  const out = [];
  for (const raw of value) {
    const id = String(raw || '').trim();
    if (!PLAN_ACTION_IDS.includes(id)) {
      throw invalid('planActions', 'That is not a plan action this product lists.');
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Retiring a note that should never have existed (§39). */
function readErrorInput(body = {}) {
  const reason = text(body.reason, 500);
  if (!reason) throw invalid('reason', 'Say why this note is being marked entered in error.');
  return { reason };
}

/**
 * Which section is filled, for the finalisation gate and for the summary.
 *
 * One definition of "has something in it", used by both, so a note cannot be
 * finalisable while its summary shows the section as empty.
 */
function sectionFilled(c, section) {
  if (!c) return false;
  switch (section) {
    case 'reason':
      return Boolean(c.reasonCode || c.reasonText);
    case 'subjective':
      return Boolean(c.subjective);
    case 'objective':
      return Boolean(c.objective) || Object.keys(c.focusedFindings || {}).length > 0;
    case 'assessment':
      // Phase 1 has no problem rows yet, so an assessment is what was written.
      // Phase 2 adds `problems` and this is the one line that widens.
      return Boolean(c.assessmentText) || (c.problems || []).length > 0;
    case 'plan':
      return Boolean(c.planText) || (c.planActions || []).length > 0;
    default:
      return false;
  }
}

/**
 * Why this note cannot be finalised yet (§23).
 *
 * Driven by the TYPE's own `required_sections`, which is data — a minor
 * ailment needs a reason, an assessment and a plan; a blood-pressure review
 * also needs the objective findings that make it a review. §23 says do not
 * force unnecessary fields, and the way to keep that true is to let the type
 * say what is necessary rather than hard-coding one list for all of them.
 *
 * Returns sentences a pharmacist can act on, never a boolean.
 */
function finalisationProblems(consultation, definition) {
  const required = (definition && Array.isArray(definition.requiredSections))
    ? definition.requiredSections
    : ['reason', 'assessment', 'plan'];

  const labels = {
    reason: 'Say why the patient was seen.',
    subjective: 'Record what the patient reported.',
    objective: 'Record what was measured or observed.',
    assessment: 'Record your assessment.',
    plan: 'Record the plan.',
  };

  const out = [];
  for (const section of required) {
    if (!SECTIONS.includes(section)) continue;
    if (!sectionFilled(consultation, section)) out.push(labels[section]);
  }
  return out;
}

/** Only a pharmacist or owner may finalise or retire (§33). */
/**
 * §32 — the reason a finalised note is being reopened.
 *
 * Never optional, and the database says so too. 0060's rule for diagnostic
 * reports applies unchanged here: saying a clinical record was amended always
 * says why. A note whose history reads "amended, amended, amended" with no
 * reasons tells the next pharmacist that it changed and nothing else — which
 * is worse than no history, because it looks like one.
 *
 * THREE CHARACTERS IS THE FLOOR, deliberately low. It is there to refuse
 * an empty box and a stray keystroke, not to make somebody justify themselves
 * to a form. "BP was 148/92, not 149/92" and "typo" are both real reasons and
 * both pass; the judgement about whether a reason is a good one belongs to
 * the pharmacist reading the history, not to a length check.
 */
function readAmendmentInput(body = {}) {
  const reason = text(body.reason, 500);
  if (!reason) throw invalid('reason', 'Say why this note is being amended.');
  if (reason.length < 3) {
    throw invalid('reason', 'Say why this note is being amended.');
  }
  return { reason };
}

/**
 * Who may reopen a finalised note.
 *
 * The same roles that may finalise one, which is the only answer that holds
 * together: a note is reopened in order to be re-signed, so anybody who can
 * amend can already sign. Splitting them would let a staff member reopen a
 * record nobody could then close.
 */
function assertMayAmend(actorRole) {
  if (!FINALISING_ROLES.includes(actorRole)) {
    const err = new Error('Only a pharmacist or the owner can amend a finalised consultation.');
    err.status = 403;
    err.code = 'ROLE_REQUIRED';
    throw err;
  }
}
function assertMayFinalise(actorRole) {
  if (!FINALISING_ROLES.includes(actorRole)) {
    const err = new Error('Only a pharmacist or the owner can finalise a consultation.');
    err.status = 403;
    err.code = 'ROLE_REQUIRED';
    throw err;
  }
}

/* ==========================================================================
 * Phase 2 — the problems, what was done, and where it went
 * ======================================================================== */

/**
 * §11. How sure the pharmacist is, kept as a value rather than as prose.
 *
 * The brief is emphatic that a pharmacist must not be forced into a definitive
 * diagnosis. Free text would make uncertainty unsearchable and — worse — would
 * let a screen render "possible angina" in the same weight as a confirmed
 * condition. As a column, the UI can show uncertainty AS uncertainty.
 */
const CERTAINTY = Object.freeze([
  { id: 'possible', label: 'Possible' },
  { id: 'provisional', label: 'Provisional' },
  { id: 'suspected', label: 'Suspected' },
  { id: 'established', label: 'Established' },
  { id: 'needs_evaluation', label: 'Needs medical evaluation' },
]);

const CERTAINTY_IDS = Object.freeze(CERTAINTY.map((c) => c.id));

/** §12's example statuses. */
const PROBLEM_STATUS = Object.freeze([
  { id: 'under_assessment', label: 'Under assessment' },
  { id: 'active', label: 'Active' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'resolved', label: 'Resolved' },
]);

const PROBLEM_STATUS_IDS = Object.freeze(PROBLEM_STATUS.map((s) => s.id));

/** What a problem may point at (§12). Every one is resolvable by clinicalRefs. */
const PROBLEM_REF_KINDS = Object.freeze([
  { id: 'condition', label: 'Condition' },
  { id: 'medication', label: 'Medication' },
  { id: 'test', label: 'Test' },
  { id: 'vitals', label: 'Vitals reading' },
]);

const PROBLEM_REF_IDS = Object.freeze(PROBLEM_REF_KINDS.map((k) => k.id));

/** §14. What the pharmacist did. Nothing here is ever generated. */
const INTERVENTIONS = Object.freeze([
  { id: 'patient_counselling', label: 'Patient counselling' },
  { id: 'medication_counselling', label: 'Medication counselling' },
  { id: 'adherence_counselling', label: 'Adherence counselling' },
  { id: 'lifestyle_counselling', label: 'Lifestyle counselling' },
  { id: 'otc_recommendation', label: 'OTC recommendation' },
  { id: 'self_care_advice', label: 'Self-care advice' },
  { id: 'device_education', label: 'Device-use education' },
  { id: 'administration_education', label: 'Administration technique education' },
  { id: 'mrp_identified', label: 'Medication-related problem identified' },
  { id: 'prescription_clarification', label: 'Prescription clarification' },
  { id: 'prescriber_contacted', label: 'Prescriber contacted' },
  { id: 'referral', label: 'Referral' },
  { id: 'monitoring_advised', label: 'Monitoring advised' },
  { id: 'no_intervention', label: 'No intervention' },
  { id: 'other', label: 'Other' },
]);

const INTERVENTION_IDS = Object.freeze(INTERVENTIONS.map((i) => i.id));

/**
 * §17. Where the patient was sent, including the explicit decision not to
 * send them anywhere.
 *
 * `none` is a REAL answer and is not the same as leaving this alone. See
 * `readReferralInput`.
 */
const REFERRAL_DESTINATIONS = Object.freeze([
  { id: 'none', label: 'No referral required' },
  { id: 'physician', label: 'Refer to physician' },
  { id: 'hospital', label: 'Refer to hospital' },
  { id: 'laboratory', label: 'Refer to laboratory' },
  { id: 'specialist', label: 'Refer to specialist' },
  { id: 'emergency', label: 'Emergency referral' },
  { id: 'other', label: 'Other' },
]);

const REFERRAL_IDS = Object.freeze(REFERRAL_DESTINATIONS.map((r) => r.id));

const REFERRAL_URGENCY = Object.freeze([
  { id: 'routine', label: 'Routine' },
  { id: 'soon', label: 'Soon' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'emergency', label: 'Emergency' },
]);

const URGENCY_IDS = Object.freeze(REFERRAL_URGENCY.map((u) => u.id));

/** §16. What was unclear about a prescription. */
const PRESCRIPTION_ISSUES = Object.freeze([
  { id: 'dose', label: 'Dose clarification' },
  { id: 'frequency', label: 'Frequency clarification' },
  { id: 'duration', label: 'Duration clarification' },
  { id: 'duplicate', label: 'Duplicate therapy' },
  { id: 'interaction', label: 'Interaction concern' },
  { id: 'allergy', label: 'Allergy concern' },
  { id: 'contraindication', label: 'Contraindication concern' },
  { id: 'formulation', label: 'Formulation issue' },
  { id: 'prescriber', label: 'Prescriber clarification' },
  { id: 'other', label: 'Other' },
]);

const PRESCRIPTION_ISSUE_IDS = Object.freeze(PRESCRIPTION_ISSUES.map((p) => p.id));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One problem on the list (§12).
 *
 * It carries a LABEL, a certainty and — at most — a pointer. It deliberately
 * carries no copy of what the pointed-at record says: §3 says reference those
 * records rather than duplicating them, and a copied dose would still read
 * 10 mg after the prescription changed.
 */
function readProblemInput(body = {}) {
  const label = text(body.label, 300);
  if (!label) throw invalid('label', 'Say what the problem is.');

  const certainty = text(body.certainty, 40) || 'possible';
  if (!CERTAINTY_IDS.includes(certainty)) {
    throw invalid('certainty', 'That is not a level of certainty this product records.');
  }

  const status = text(body.status, 40) || 'under_assessment';
  if (!PROBLEM_STATUS_IDS.includes(status)) {
    throw invalid('status', 'That is not a status this product records.');
  }

  const refKind = text(body.refKind, 40);
  const refId = text(body.refId, 64);
  if (refKind && !PROBLEM_REF_IDS.includes(refKind)) {
    throw invalid('refKind', 'A problem can only point at a condition, medication, test or reading.');
  }
  // A half-written pointer resolves to nothing. Either both or neither.
  if (refKind && !refId) throw invalid('refId', 'Choose the record this problem is about.');
  if (refId && !refKind) throw invalid('refKind', 'Say what kind of record this points at.');
  if (refId && !UUID_RE.test(refId)) throw invalid('refId', 'Choose the record this problem is about.');

  return { label, certainty, status, refKind: refKind || null, refId: refId || null, note: text(body.note, 2000) };
}

/** One intervention (§14), optionally about one of the problems. */
function readInterventionInput(body = {}) {
  const kind = text(body.kind, 60);
  if (!INTERVENTION_IDS.includes(kind)) {
    throw invalid('kind', 'That is not an intervention this product records.');
  }
  const problemId = text(body.problemId, 64);
  if (problemId && !UUID_RE.test(problemId)) {
    throw invalid('problemId', 'That is not one of this consultation\'s problems.');
  }
  return { kind, problemId: problemId || null, note: text(body.note, 2000) };
}

/**
 * §17 — the referral decision.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR. Leaving referral alone and
 * choosing "No referral required" are different facts:
 *
 *   destination === null      nobody considered it
 *   destination === 'none'    a pharmacist considered it and decided against
 *
 * The summary renders only the second. "Referral: not required" on a note
 * where referral was never considered is a clinical decision the software
 * invented, and the next pharmacist reads it as one somebody took.
 */
function readReferralInput(body = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, 'destination')) {
    throw invalid('destination', 'Say whether a referral is required.');
  }
  const raw = body.destination;
  if (raw === null || raw === '') {
    // Explicitly clearing it: back to "not considered".
    return { destination: null, reason: null, urgency: null, notes: null };
  }

  const destination = text(raw, 40);
  if (!REFERRAL_IDS.includes(destination)) {
    throw invalid('destination', 'That is not a referral destination this product lists.');
  }

  const reason = text(body.reason, 1000);
  // Somewhere named must say why. A pharmacist reading "Refer to hospital"
  // with no reason cannot act on it, and neither can the hospital.
  if (destination !== 'none' && !reason) {
    throw invalid('reason', 'Say why you are referring.');
  }

  const urgency = text(body.urgency, 40);
  if (urgency && !URGENCY_IDS.includes(urgency)) {
    throw invalid('urgency', 'That is not an urgency this product records.');
  }

  return {
    destination,
    reason,
    urgency: destination === 'none' ? null : (urgency || null),
    notes: text(body.notes, 2000),
  };
}

/** §16 — what was unclear, and what the prescriber said. */
function readPrescriptionInput(body = {}) {
  const issues = [];
  const raw = body.issues == null ? [] : body.issues;
  if (!Array.isArray(raw)) throw invalid('issues', 'Prescription issues must be a list.');
  for (const one of raw) {
    const id = String(one || '').trim();
    if (!PRESCRIPTION_ISSUE_IDS.includes(id)) {
      throw invalid('issues', 'That is not a prescription issue this product lists.');
    }
    if (!issues.includes(id)) issues.push(id);
  }

  const contacted = Boolean(body.prescriberContacted);
  const outcome = text(body.prescriberOutcome, 1000);
  // Recording an outcome without recording that anybody was contacted leaves
  // a sentence nobody can attribute.
  if (outcome && !contacted) {
    throw invalid('prescriberContacted', 'Say that the prescriber was contacted before recording what they said.');
  }

  return { issues, prescriberContacted: contacted, prescriberOutcome: outcome };
}

const certaintyLabel = (id) => (CERTAINTY.find((c) => c.id === id) || {}).label || null;
const problemStatusLabel = (id) => (PROBLEM_STATUS.find((s) => s.id === id) || {}).label || null;
const interventionLabel = (id) => (INTERVENTIONS.find((i) => i.id === id) || {}).label || null;
const referralLabel = (id) => (REFERRAL_DESTINATIONS.find((r) => r.id === id) || {}).label || null;
const urgencyLabel = (id) => (REFERRAL_URGENCY.find((u) => u.id === id) || {}).label || null;
const prescriptionIssueLabel = (id) => (PRESCRIPTION_ISSUES.find((p) => p.id === id) || {}).label || null;

const reasonLabel = (id) => (REASON_CODES.find((r) => r.id === id) || {}).label || null;
const findingLabel = (id) => (FOCUSED_FINDINGS.find((f) => f.id === id) || {}).label || null;
const planActionLabel = (id) => (PLAN_ACTIONS.find((p) => p.id === id) || {}).label || null;

/**
 * §22 — the clinical summary, assembled from what was actually entered.
 *
 * THE RULE THIS ENFORCES: a section the pharmacist left empty is ABSENT from
 * the summary. It is never rendered as "None", "Nil" or "Not required".
 *
 * That distinction is the whole point. "Referral: none required" on a note
 * where nobody considered referral is a clinical claim the software invented,
 * and the next pharmacist reads it as a decision somebody made. §22 says the
 * summary must come from the information the pharmacist actually entered, and
 * the honest way to honour that is to say nothing where nothing was said.
 *
 * Returns parts, not a string, so the screen decides how to render them and
 * the wording can be tested without a DOM.
 */
function consultationSummary(c) {
  if (!c) return [];
  const parts = [];
  const add = (id, label, value) => {
    const lines = (Array.isArray(value) ? value : [value])
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter((v) => v.length > 0);
    if (lines.length > 0) parts.push({ id, label, lines });
  };

  add('reason', 'Reason', [
    [reasonLabel(c.reasonCode), c.reasonText].filter(Boolean).join(' — '),
    c.durationText ? `Duration: ${c.durationText}` : null,
    c.patientGoal,
  ]);
  add('subjective', 'Patient reported', c.subjective);

  const findings = Object.entries(c.focusedFindings || {})
    .map(([k, v]) => `${findingLabel(k) || k}: ${v}`);
  add('objective', 'Findings', [c.objective, ...findings]);

  add('assessment', 'Assessment', c.assessmentText);

  // The order below is the order a pharmacist writes AND reads: the problem
  // list and the interventions belong to the assessment, and the plan is what
  // follows from them. Phase 2 first appended them to the END of this
  // function, which made a note fill in one order and read back in another.

  // §12's problem list, numbered as the pharmacist ordered it. The certainty
  // is printed WITH the label, because "angina" and "possible angina" are
  // different clinical statements and the summary is what gets read.
  add('problems', 'Problems', (c.problems || []).map((pr, i) => {
    const certainty = pr.certainty === 'established' ? null : certaintyLabel(pr.certainty);
    const head = [certainty, pr.label].filter(Boolean).join(' ');
    const status = problemStatusLabel(pr.status);
    return `${i + 1}. ${head}${status ? ` — ${status}` : ''}`;
  }));

  add('interventions', 'Intervention', (c.interventions || []).map((iv) => {
    const label = interventionLabel(iv.kind) || iv.kind;
    return iv.note ? `${label} — ${iv.note}` : label;
  }));

  add('plan', 'Plan', [
    ...(c.planActions || []).map((a) => planActionLabel(a)).filter(Boolean),
    c.planText,
  ]);

  // §17. ONLY when a pharmacist actually decided. A null destination means
  // referral was never considered, and the summary says nothing at all rather
  // than "not required" — which would be a decision nobody took.
  if (c.referralDestination) {
    const lines = [referralLabel(c.referralDestination)];
    if (c.referralUrgency) lines.push(`Urgency: ${urgencyLabel(c.referralUrgency)}`);
    if (c.referralReason) lines.push(c.referralReason);
    if (c.referralNotes) lines.push(c.referralNotes);
    add('referral', 'Referral', lines);
  }

  add('notes', 'Notes', c.notes);
  return parts;
}

/** Everything the screen needs to draw its controls, in one call. */
const consultationOptions = (definitions = []) => ({
  types: definitions,
  reasons: REASON_CODES,
  findings: FOCUSED_FINDINGS,
  planActions: PLAN_ACTIONS,
  statuses: STATUSES,
  // The vocabularies phase 2 added, so the screen draws them from one place.
  certainty: CERTAINTY,
  problemStatuses: PROBLEM_STATUS,
  problemRefKinds: PROBLEM_REF_KINDS,
  interventions: INTERVENTIONS,
  referralDestinations: REFERRAL_DESTINATIONS,
  referralUrgency: REFERRAL_URGENCY,
  prescriptionIssues: PRESCRIPTION_ISSUES,
  capabilities: {
    // Built in phase 2 (0069).
    problems: true,
    interventions: true,
    referral: true,
    // AMENDED 2026-09-28 with the product: phase 3 (0070) built it. A
    // finalised note is reopened with a reason, its previous text is
    // snapshotted, and re-finalising goes through the same gate.
    amendment: true,
    // The audit view (§32), which is the history of one note rather than
    // the patient's whole timeline.
    history: true,
    // Still no appointments table anywhere in this product.
    appointments: false,
  },
});

module.exports = {
  REASON_CODES, REASON_IDS, STATUSES, OPEN_STATUSES, SECTIONS,
  FOCUSED_FINDINGS, FINDING_IDS, PLAN_ACTIONS, PLAN_ACTION_IDS, FINALISING_ROLES,
  CERTAINTY, CERTAINTY_IDS, PROBLEM_STATUS, PROBLEM_STATUS_IDS,
  PROBLEM_REF_KINDS, PROBLEM_REF_IDS, INTERVENTIONS, INTERVENTION_IDS,
  REFERRAL_DESTINATIONS, REFERRAL_IDS, REFERRAL_URGENCY, URGENCY_IDS,
  PRESCRIPTION_ISSUES, PRESCRIPTION_ISSUE_IDS,
  readConsultationInput, readConsultationPatch, readErrorInput,
  readProblemInput, readInterventionInput, readReferralInput, readPrescriptionInput,
  readAmendmentInput, assertMayAmend,
  sectionFilled, finalisationProblems, assertMayFinalise,
  reasonLabel, findingLabel, planActionLabel,
  certaintyLabel, problemStatusLabel, interventionLabel, referralLabel,
  urgencyLabel, prescriptionIssueLabel,
  consultationSummary, consultationOptions,
};
