/**
 * cough_assessment v1.0.0 — ASSESSMENT, TRIAGE AND SAFE ROUTING.
 *
 * ============================================================
 * WHAT THIS NEVER CONCLUDES
 * ============================================================
 * Not pneumonia, not bronchitis, not asthma, not tuberculosis, not COVID-19,
 * not influenza, not sinusitis. No antibiotic. No cough medicine. A cough is
 * a symptom with dozens of causes, and this protocol's job is to notice the
 * ones that need a human quickly and route everything else to a pharmacist —
 * not to name a disease.
 *
 * COUGH -> ANTIBIOTIC IS THE RULE THIS FILE EXISTS TO NOT CONTAIN (§15).
 * There is no recommendation of any kind here: zero protocol_recommendations
 * rows, and a test asserting no antibiotic name appears anywhere in the
 * definition.
 *
 * ============================================================
 * RED FLAG SOURCING — AND WHERE IT RUNS OUT
 * ============================================================
 * The severe-respiratory criteria come from Nigeria STG 2022, which states:
 *
 *   "Central cyanosis or SpO2 < 90%; severe respiratory distress (e.g. fast
 *    breathing, grunting, very severe chest in-drawing); general danger sign:
 *    inability to breastfeed or drink, lethargy or unconsciousness, or
 *    convulsions"
 *
 *   "Fast breathing (in breaths/min): < 2 months: >=60; 2-11 months: >=50;
 *    1-5 years: >=40"
 *
 * Those age-banded respiratory rates are exactly the kind of number §7
 * forbids inventing — and they did not have to be invented, because the
 * source supplies them. They are recorded here for the pharmacist and are
 * NOT machine-evaluated, because nobody counts a respiratory rate over
 * WhatsApp.
 *
 * Two flags below are NOT in that source list — haemoptysis and severe chest
 * pain. Both are marked REQUIRES_REVIEW in their source_reference rather than
 * dressed up as sourced. They are included because failing to escalate
 * someone coughing blood is the worse error, and because their action is
 * escalation to a human, never treatment.
 *
 * ============================================================
 * TUBERCULOSIS (§12)
 * ============================================================
 * A long cough routes to a pharmacist. It is NOT called TB screening, no TB
 * threshold is encoded, and no TB question is asked — STG's TB section exists
 * but a TB assessment protocol does not, and §12 forbids inventing screening
 * criteria from memory. The escalation says "persistent cough, outside routine
 * scope"; a clinician decides what that means.
 *
 * ============================================================
 * FEVER COEXISTENCE (§9)
 * ============================================================
 * Cough and fever together must not produce two protocols asking the same
 * questions. The fever questions here are gated on `exists: false` — asked
 * only when the fact is not already known, whether from this run or a
 * concurrent fever_assessment run. Nothing about "cough + fever" implies
 * malaria: that judgement belongs to fever_assessment, which itself gates on
 * the malaria protocol being ACTIVE and APPROVED (it is neither today).
 */

const SLUG = 'cough_assessment';
const VERSION = '1.0.0';

// Populations are NOT redefined here. fever_assessment v2.0.0 already derives
// them and §22 says reuse, not duplicate — two copies of an age-banding rule
// is how they silently drift apart.
const { POPULATIONS, derivePopulations } = require('./feverAssessmentV2');

const DEFINITION = Object.freeze({
  slug: SLUG,
  version: VERSION,
  name: 'Cough assessment and triage',
  description:
    'Conversational triage for a cough complaint. Establishes type, duration and trajectory, '
    + 'screens for respiratory danger signs, distinguishes populations, and routes to urgent '
    + 'referral or pharmacist review. Names no disease, authorises no medicine, and never '
    + 'treats cough as an indication for antibiotics.',
  conditionDomain: 'cough',
  population:
    'All ages. Infant (<1y), child (1-11y), adult (12-64y), older adult (>=65y), with pregnancy '
    + 'and special-risk overlays, derived by feverAssessmentV2.derivePopulations. Age is asked, '
    + 'never assumed; DECLINED is stored as such.',
  source: 'Nigeria Standard Treatment Guidelines 2022 (severe respiratory criteria); RxNaija triage structure',
  sourceReference: 'STG 2022 severe respiratory disease criteria. Two flags marked REQUIRES_REVIEW — see redFlags.',

  // Substring-matched by clinicalRouter — see the note in
  // soreThroatAssessmentV1 on why both word orders are listed.
  presentingComplaints: [
    'cough', 'coughing', 'bad cough', 'dry cough', 'wet cough', 'productive cough',
    'phlegm', 'mucus', 'catarrh with cough', 'chest full of mucus', 'coughing at night',
    'coughing up phlegm', 'cough and fever', 'chest discomfort with cough',
    'i dey cough', 'cough dey worry', 'cough no dey stop', 'cough that will not stop',
    'catarrh', 'chesty cough', 'tight chest', 'bringing up phlegm',
  ],

  questions: [
    {
      questionKey: 'presenting_complaint',
      text: 'Sorry to hear that. Can you tell me a bit more about the cough?',
      answerType: 'text',
      factConcept: 'presenting_complaint',
      required: true,
      priority: 10,
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
        // Aliases matter here more than anywhere else in the protocol: this
        // question gates the PAEDIATRIC branch. 'my child' failing to parse
        // meant the question was re-asked verbatim instead of routing a
        // child's case correctly — and three identical re-asks trip the
        // repeat-detection breaker in conductPolicy, which silences the
        // whole pharmacy.
        { value: 'self', label: 'For me', aliases: ['me', 'myself', 'i', 'my own', 'na me'] },
        {
          value: 'someone_else',
          label: 'For someone else',
          aliases: [
            'someone', 'somebody', 'another person', 'not me',
            'my child', 'my son', 'my daughter', 'my baby', 'my pikin',
            'my wife', 'my husband', 'my mother', 'my father', 'my mum', 'my dad',
            'my brother', 'my sister', 'my friend', 'my neighbour', 'my neighbor',
          ],
        },
      ],
    },
    {
      questionKey: 'patient_age',
      text: 'How old is the patient?',
      helpText: 'Roughly is fine. You can say "prefer not to say".',
      answerType: 'number',
      factConcept: 'age_years',
      unit: 'years',
      required: true,
      priority: 20,
      // Only asked when age is not already on file or already volunteered.
      applicability: { all_of: [{ concept: 'age_years', exists: false }] },
      validation: { min: 0, max: 120 },
    },
    {
      questionKey: 'cough_duration',
      text: 'How long has the cough been going on?',
      helpText: 'For example: "since yesterday", "5 days", "about three weeks".',
      answerType: 'duration',
      factConcept: 'cough_duration_days',
      unit: 'days',
      required: true,
      priority: 25,
      validation: { min: 0, max: 3650 },
    },
    {
      // THE DANGER SCREEN, asked early so §8's "stop routine assessment" has
      // something to stop.
      questionKey: 'respiratory_danger_screen',
      text: 'Before anything else — is any of this happening?',
      helpText:
        'Struggling to breathe or breathing very fast · lips or tongue looking blue · '
        + 'coughing up blood · severe chest pain · very drowsy, confused or hard to wake · '
        + 'fits or convulsions · unable to drink or feed · too weak to stand or sit up',
      answerType: 'multi_choice',
      factConcept: 'respiratory_danger_signs_reported',
      required: true,
      priority: 30,
      choices: [
        { value: 'none', label: 'None of these' },
        { value: 'severe_breathing_difficulty', label: 'Struggling to breathe, or breathing very fast' },
        { value: 'cyanosis', label: 'Lips or tongue looking blue' },
        { value: 'haemoptysis', label: 'Coughing up blood' },
        { value: 'severe_chest_pain', label: 'Severe chest pain' },
        { value: 'impaired_consciousness', label: 'Very drowsy, confused or hard to wake' },
        { value: 'convulsions', label: 'Fits or convulsions' },
        { value: 'cannot_drink', label: 'Unable to drink or feed' },
        { value: 'prostration', label: 'Too weak to stand or sit up' },
      ],
    },
    {
      questionKey: 'cough_type',
      text: 'Is the cough dry, or are you bringing something up?',
      answerType: 'single_choice',
      factConcept: 'cough_is_productive',
      required: true,
      priority: 40,
      applicability: { all_of: [{ concept: 'respiratory_danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'dry', label: 'Dry — nothing comes up' },
        { value: 'productive', label: 'I am bringing up phlegm or mucus' },
        { value: 'unsure', label: 'Not sure' },
      ],
    },
    {
      // Conditional on productive. Characteristics are RECORDED for the
      // pharmacist — no colour or consistency here implies a diagnosis or an
      // antibiotic, which is the classic wrong inference from sputum.
      questionKey: 'sputum_description',
      text: 'What does it look like when you bring it up?',
      helpText: 'Recorded for the pharmacist — colour alone does not decide anything.',
      answerType: 'text',
      factConcept: 'sputum_description_reported',
      required: false,
      priority: 45,
      applicability: { all_of: [{ concept: 'cough_is_productive', equals: 'productive' }] },
      validation: { maxLength: 300 },
    },
    {
      questionKey: 'cough_trajectory',
      text: 'Is it getting better, getting worse, or staying about the same?',
      answerType: 'single_choice',
      factConcept: 'cough_trajectory',
      required: true,
      priority: 50,
      applicability: { all_of: [{ concept: 'respiratory_danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'improving', label: 'Getting better' },
        { value: 'stable', label: 'About the same' },
        { value: 'worsening', label: 'Getting worse' },
      ],
    },
    {
      // §9: asked ONLY when fever is not already known. If the patient opened
      // with "cough and fever", or a fever run already recorded it, this is
      // skipped rather than re-asked.
      questionKey: 'fever_present',
      text: 'Have you had a fever along with it?',
      answerType: 'boolean',
      factConcept: 'fever_present',
      required: true,
      priority: 55,
      applicability: {
        all_of: [
          { concept: 'respiratory_danger_signs_reported', contains: 'none' },
          { concept: 'fever_present', exists: false },
        ],
      },
    },
    {
      questionKey: 'associated_symptoms',
      text: 'What else have you been feeling?',
      answerType: 'multi_choice',
      factConcept: 'associated_symptoms',
      required: true,
      priority: 60,
      applicability: { all_of: [{ concept: 'respiratory_danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'sore_throat', label: 'Sore throat' },
        { value: 'runny_nose', label: 'Runny or blocked nose' },
        { value: 'wheezing', label: 'Wheezing or whistling in the chest' },
        { value: 'shortness_of_breath', label: 'Getting short of breath' },
        { value: 'chest_discomfort', label: 'Chest discomfort' },
        { value: 'headache', label: 'Headache' },
        { value: 'body_aches', label: 'Body aches' },
        { value: 'weakness', label: 'Weakness or tiredness' },
        { value: 'night_symptoms', label: 'Worse at night' },
        { value: 'weight_loss', label: 'Losing weight without trying' },
        { value: 'night_sweats', label: 'Drenching night sweats' },
        { value: 'vomiting', label: 'Vomiting' },
        { value: 'none', label: 'Nothing else' },
      ],
    },
    {
      questionKey: 'known_respiratory_condition',
      text: 'Do you have asthma, or any other long-term chest or breathing condition?',
      answerType: 'text',
      factConcept: 'known_respiratory_condition_reported',
      required: false,
      priority: 70,
      applicability: { all_of: [{ concept: 'respiratory_danger_signs_reported', contains: 'none' }] },
      validation: { maxLength: 300 },
    },
    {
      questionKey: 'pregnancy_status',
      text: 'Are you pregnant, or could you be?',
      answerType: 'single_choice',
      factConcept: 'pregnancy_status',
      required: true,
      priority: 75,
      applicability: {
        all_of: [
          { concept: 'patient_is_self', equals: 'self' },
          { concept: 'age_years', min: 12 },
          { concept: 'age_years', max: 55 },
          { concept: 'pregnancy_status', exists: false },
        ],
      },
      choices: [
        { value: 'pregnant', label: 'Yes, pregnant' },
        { value: 'possibly_pregnant', label: 'Possibly / not sure' },
        { value: 'not_pregnant', label: 'No' },
        { value: 'not_applicable', label: 'Prefer not to say / not applicable' },
      ],
    },
    {
      // §13: store the words. "I took cough syrup" must not become a named
      // active ingredient, and "I took antibiotics" must not acquire a drug,
      // dose or indication it never had.
      questionKey: 'medication_taken',
      text: 'Have you taken anything for it so far?',
      helpText: 'Whatever you remember is fine — the name, or just what it was.',
      answerType: 'text',
      factConcept: 'self_medication_reported',
      required: false,
      priority: 80,
      applicability: { all_of: [{ concept: 'respiratory_danger_signs_reported', contains: 'none' }] },
      validation: { maxLength: 500 },
    },
  ],

  /**
   * Red flags. Every action is escalation to a human — never treatment.
   * `sourced: false` marks a flag NOT present in the STG severe-respiratory
   * list; those carry REQUIRES_REVIEW rather than an implied citation.
   */
  redFlags: [
    { key: 'severe_breathing_difficulty', name: 'Severe respiratory distress — fast breathing, grunting, or severe chest in-drawing', sourced: true },
    { key: 'cyanosis', name: 'Central cyanosis — blue lips or tongue', sourced: true },
    { key: 'impaired_consciousness', name: 'Lethargy, confusion or unconsciousness', sourced: true },
    { key: 'convulsions', name: 'Convulsions', sourced: true },
    { key: 'cannot_drink', name: 'Inability to breastfeed, drink or feed', sourced: true },
    { key: 'prostration', name: 'Prostration — too weak to stand or sit up', sourced: true },
    {
      key: 'haemoptysis', name: 'Coughing up blood (haemoptysis)', sourced: false,
      note: 'NOT in the STG severe-respiratory criteria quoted for this protocol. Included because failing to escalate haemoptysis is the worse error; action is escalation only. Applicability and threshold REQUIRES_REVIEW.',
    },
    {
      key: 'severe_chest_pain', name: 'Severe chest pain with cough', sourced: false,
      note: 'NOT in the STG severe-respiratory criteria quoted for this protocol. Included as an escalation-only trigger. REQUIRES_REVIEW.',
    },
  ],

  /**
   * Recorded for the pharmacist, deliberately NOT machine-evaluated: nobody
   * counts a respiratory rate over WhatsApp, and a self-estimated one would be
   * a guess wearing a number's clothes. Present so a reviewing pharmacist has
   * the source's own thresholds to hand.
   */
  referenceThresholds: {
    fastBreathingBreathsPerMin: [
      { population: 'under_2_months', threshold: 60 },
      { population: '2_to_11_months', threshold: 50 },
      { population: '1_to_5_years', threshold: 40 },
    ],
    oxygenSaturation: { threshold: 90, unit: 'percent', note: 'SpO2 < 90% — requires a pulse oximeter; not obtainable over this channel.' },
    source: 'Nigeria Standard Treatment Guidelines 2022, severe respiratory disease criteria',
    machineEvaluable: false,
  },

  escalationRules: [
    { trigger: 'any respiratory danger sign reported', priority: 'urgent', action: 'URGENT_REFERRAL', cite: 'STG 2022 severe respiratory criteria' },
    { trigger: 'infant under 1 year with cough', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'Paediatric respiratory assessment is outside any approved self-care pathway' },
    { trigger: 'pregnant or possibly pregnant', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'No approved respiratory protocol covers pregnancy' },
    {
      trigger: 'cough persisting 21 days or more',
      priority: 'medium',
      action: 'PHARMACIST_REVIEW',
      // Deliberately NOT called TB screening, and deliberately not a diagnostic
      // threshold. §12 forbids inventing TB criteria; this only says a long
      // cough is outside routine scope and a human should look.
      cite: 'Persistent cough is outside routine self-care scope. This is a ROUTING rule, not a tuberculosis screening criterion — no TB assessment protocol exists and none is implied.',
    },
    { trigger: 'cough worsening', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'Deterioration warrants human assessment' },
    { trigger: 'known asthma or chronic respiratory condition reported', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'No approved asthma protocol exists' },
    { trigger: 'age unknown or declined', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: '§2 — age must not be assumed' },
    { trigger: 'assessment complete, no danger signs', priority: 'low', action: 'PHARMACIST_REVIEW', cite: 'No approved recommendation is reachable — a human closes every run' },
  ],

  /**
   * §11. Every target is a protocol that DOES NOT EXIST YET, except fever.
   * Listed so the routing intent is explicit and reviewable — and gated, so a
   * missing target can never become an invented diagnosis.
   */
  protocolTransitions: [
    {
      target: 'fever_assessment',
      targetVersion: '2.0.0',
      when: 'fever reported alongside cough and fever facts are not already collected',
      requires: ['target protocol ACTIVE'],
      note: 'Coordination, not duplication — the fever protocol owns the fever questions and the malaria-relevance judgement. Cough + fever does NOT imply malaria.',
    },
    { target: 'acute_respiratory_infection_assessment', targetVersion: null, when: 'not implemented', requires: ['protocol must exist and be ACTIVE'], note: 'DOES NOT EXIST. Until it does, route to pharmacist — never infer the diagnosis it would have made.' },
    { target: 'asthma_assessment', targetVersion: null, when: 'not implemented', requires: ['protocol must exist and be ACTIVE'], note: 'DOES NOT EXIST.' },
    { target: 'tuberculosis_assessment', targetVersion: null, when: 'not implemented', requires: ['protocol must exist and be ACTIVE'], note: 'DOES NOT EXIST. §12 — no TB threshold may be created from memory.' },
  ],

  recommendationBoundaries: {
    permitted: ['PATIENT_INFORMATION', 'CLINICAL_ASSESSMENT', 'PHARMACIST_REVIEW', 'URGENT_REFERRAL'],
    forbidden: ['MEDICATION_RECOMMENDATION'],
    reason:
      'Cough is a symptom, not an indication. No approved source in the registry authorises any '
      + 'medicine for undifferentiated cough, and cough is explicitly NOT an indication for '
      + 'antibiotics (§15). Any future respiratory medicine must come from a separate approved '
      + 'protocol with its own evidence and eligibility criteria, through the Part 2 safety gate.',
  },
});

/**
 * May this run hand over to fever_assessment? (§9)
 * Gated the same way fever gates its malaria transition — a target that is not
 * ACTIVE is not a target.
 */
async function canTransitionToFever(pharmacyId) {
  const protocols = require('../clinicalProtocolService');
  const active = await protocols.getActiveProtocol(pharmacyId, 'fever_assessment');
  if (!active) return { allowed: false, reason: 'fever_protocol_not_active' };
  return { allowed: true, reason: 'ok', protocolId: active.id, version: active.version };
}

/** Install and activate. Idempotent. Creates ZERO recommendations. */
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
    permittedAdvice: [],
    referralRules: DEFINITION.escalationRules,
    pharmacistReviewRules: DEFINITION.protocolTransitions,
    exclusionCriteria: [
      { rule: 'Cough is NOT an indication for antibiotics (§15)' },
      { rule: 'No medication recommendation is authorised for undifferentiated cough' },
      { rule: 'No TB, asthma, pneumonia or ARI diagnosis may be inferred — those protocols do not exist' },
    ],
  }, { actorType, actorId });

  for (const q of DEFINITION.questions) {
    await protocols.addQuestion(pharmacyId, protocol.id, q, { actorType, actorId });
  }

  for (const rf of DEFINITION.redFlags) {
    const created = await protocols.createRedFlagRule(pharmacyId, protocol.id, {
      name: rf.name,
      description: rf.sourced
        ? 'Patient-reportable danger sign. Action is escalation to a human — never treatment.'
        : `Escalation-only trigger. ${rf.note}`,
      severity: 'emergency',
      action: 'emergency_referral',
      // See 0036 / redFlagEvaluator. rf.key is a choice value of this
      // protocol's danger screen, so a ticked box fires exactly one rule.
      triggerConcept: 'respiratory_danger_signs_reported',
      triggerValue: rf.key,
      source: 'Nigeria Standard Treatment Guidelines 2022',
      sourceReference: rf.sourced
        ? 'STG 2022 severe respiratory disease criteria. Applicability to undifferentiated cough REQUIRES_REVIEW.'
        : `NOT in the STG criteria quoted for this protocol — REQUIRES_REVIEW. ${rf.note}`,
    }, { actorType, actorId });

    await protocols.setRedFlagActive(pharmacyId, created.id, true, { actorType, actorId });
  }

  await protocols.activateProtocol(pharmacyId, protocol.id, { actorType, actorId });
  return protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
}

module.exports = {
  SLUG, VERSION, DEFINITION, POPULATIONS,
  derivePopulations, canTransitionToFever, install,
};
