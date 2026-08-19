/**
 * fever_assessment v1.0.0 — a FOUNDATION protocol.
 *
 * WHAT THIS IS
 * A structured intake questionnaire that collects what a pharmacist would
 * want to know before looking at a fever case. It proves the protocol
 * framework works end to end: metadata, versioning, questions, answer types,
 * conditional applicability, required-information detection.
 *
 * WHAT THIS IS NOT, AND MUST NOT BECOME
 * There is no diagnosis here, no medicine, no dose, no "if temperature > X
 * then Y". Not one question's answer leads to an automated clinical
 * conclusion. When the questions are done the run reaches READY_FOR_REVIEW
 * and a human takes it from there — that is the entire intended behaviour.
 *
 * Adding a treatment rule to this file would be the single most dangerous
 * change anyone could make to this codebase. It belongs to a later stage,
 * under clinical governance, with a pharmacist's sign-off.
 *
 * WHY SEVERITY IS A 1-10 GAUGE AND NOT A TEMPERATURE
 * Asking "what is your temperature?" assumes a thermometer. Most people
 * messaging a Nigerian pharmacy do not have one, so the honest answers are
 * "I don't know" and the dishonest ones are guesses that arrive looking like
 * measurements. A 1-10 self-rating is subjective and SAYS it is subjective:
 * stored with source patient_reported and unit scale_1_10, a pharmacist
 * reading "8/10, self-reported" knows precisely what they are looking at.
 * If a customer volunteers a real thermometer reading, that is a separate
 * concept with source `measured` — a later version's job, not this one's.
 */

const SLUG = 'fever_assessment';
const VERSION = '1.0.0';

const DEFINITION = Object.freeze({
  slug: SLUG,
  version: VERSION,
  name: 'Fever assessment (intake only)',
  description:
    'Structured intake for a reported fever. Collects presenting complaint, duration, '
    + 'a self-reported severity gauge and associated symptoms for pharmacist review. '
    + 'Contains no diagnosis, no treatment guidance and no medicine selection.',
  conditionDomain: 'fever',
  population: 'Adults and children presenting with reported fever. No age-specific branching in v1.0.0.',
  source: 'RxNaija internal — Stage 2 foundation protocol',
  sourceReference: 'Not derived from any clinical guideline. Intake structure only.',

  questions: [
    {
      questionKey: 'presenting_complaint',
      text: 'What is the main problem you are having today?',
      answerType: 'text',
      factConcept: 'presenting_complaint',
      required: true,
      priority: 10,
      validation: { maxLength: 500 },
    },
    {
      questionKey: 'fever_duration',
      text: 'How long have you been feeling this way?',
      helpText: 'For example: "3 days", "since Monday", "about a week".',
      answerType: 'duration',
      factConcept: 'symptom_duration_days',
      unit: 'days',
      required: true,
      priority: 20,
      // 90 days: past this, a stated duration is far more likely to be a
      // misunderstanding of the question than a real answer, and guessing
      // which would be exactly the silent "fix" §8 forbids. Rejected, kept
      // verbatim, asked again.
      validation: { min: 0, max: 90 },
    },
    {
      questionKey: 'fever_severity',
      text: 'On a scale of 1 to 10, how hot or feverish do you feel right now? (1 = barely warm, 10 = the worst you have felt)',
      helpText: 'Your own sense of it is fine — no thermometer needed.',
      answerType: 'scale',
      factConcept: 'fever_severity_gauge',
      unit: 'scale_1_10',
      required: true,
      priority: 30,
      validation: { min: 1, max: 10 },
    },
    {
      questionKey: 'has_associated_symptoms',
      text: 'Are you having any other symptoms along with this?',
      answerType: 'boolean',
      factConcept: 'has_associated_symptoms',
      required: true,
      priority: 40,
    },
    {
      // Conditional: only asked when the previous answer was yes. This is
      // the framework's applicability feature being exercised for real, not
      // a clinical rule — "ask what they are" follows from "there are some".
      questionKey: 'associated_symptoms',
      text: 'Which other symptoms are you having?',
      answerType: 'multi_choice',
      factConcept: 'associated_symptoms',
      required: true,
      priority: 50,
      applicability: { all_of: [{ concept: 'has_associated_symptoms', equals: 'true' }] },
      choices: [
        { value: 'headache', label: 'Headache' },
        { value: 'body_pain', label: 'Body pain' },
        { value: 'chills', label: 'Chills' },
        { value: 'vomiting', label: 'Vomiting' },
        { value: 'diarrhoea', label: 'Diarrhoea' },
        { value: 'cough', label: 'Cough' },
        { value: 'sore_throat', label: 'Sore throat' },
        { value: 'rash', label: 'Rash' },
        { value: 'other', label: 'Something else' },
      ],
    },
    {
      questionKey: 'existing_medication_taken',
      text: 'Have you taken anything for it so far?',
      helpText: 'Recorded for the pharmacist — no recommendation is made from this.',
      answerType: 'text',
      factConcept: 'self_medication_reported',
      required: false,
      priority: 60,
      validation: { maxLength: 500 },
    },
    {
      questionKey: 'who_is_this_for',
      text: 'Is this for you, or for someone else?',
      answerType: 'single_choice',
      factConcept: 'patient_is_self',
      required: true,
      priority: 15,
      choices: [
        { value: 'self', label: 'For me' },
        { value: 'someone_else', label: 'For someone else' },
      ],
    },
  ],
});

/**
 * Create fever_assessment v1.0.0 for a pharmacy and activate it.
 *
 * Idempotent: if this exact version already exists it is returned untouched.
 * A published version is never edited in place — that is what makes an old
 * encounter's recorded version meaningful.
 */
async function install(pharmacyId, { actorType = 'system', actorId = null } = {}) {
  const protocols = require('../clinicalProtocolService');

  const existing = await protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
  if (existing) return existing;

  const protocol = await protocols.createProtocol(pharmacyId, {
    slug: DEFINITION.slug,
    name: DEFINITION.name,
    version: DEFINITION.version,
    description: DEFINITION.description,
    conditionDomain: DEFINITION.conditionDomain,
    population: DEFINITION.population,
    source: DEFINITION.source,
    sourceReference: DEFINITION.sourceReference,
    requiredInformation: DEFINITION.questions.filter((q) => q.required).map((q) => q.factConcept),
    // Still empty, still deliberately: these carry treatment content in a
    // later stage, and this protocol has none.
    permittedAdvice: [],
    referralRules: [],
    pharmacistReviewRules: [],
  }, { actorType, actorId });

  for (const q of DEFINITION.questions) {
    await protocols.addQuestion(pharmacyId, protocol.id, q, { actorType, actorId });
  }

  await protocols.activateProtocol(pharmacyId, protocol.id, { actorType, actorId });
  return protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
}

module.exports = { SLUG, VERSION, DEFINITION, install };
