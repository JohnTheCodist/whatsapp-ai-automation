/**
 * fever_assessment v2.0.0 — ASSESSMENT AND TRIAGE. Patient-facing.
 *
 * ============================================================
 * WHY v2.0.0 AND NOT v1.0.0
 * ============================================================
 * The spec asked for "fever_assessment_v1.0.0". That version already exists
 * (feverAssessmentV1.js), is ACTIVE, and has been referenced by real
 * protocol_executions. Editing it in place would silently change what those
 * encounters mean — the exact failure the Stage 2 Part 1 versioning rule
 * exists to prevent: "an encounter must reference the exact protocol version
 * used during that encounter."
 *
 * v1.0.0 was intake-only: 7 questions, no red flags, no escalation, no
 * transitions. v2.0.0 is a different clinical scope (triage with danger-sign
 * escalation and a malaria pathway), which is a MAJOR version, not a minor
 * one. Both versions coexist; v1.0.0 keeps meaning what it meant.
 *
 * ============================================================
 * FEVER IS NOT MALARIA
 * ============================================================
 * Nothing in this file concludes malaria, and nothing here carries an
 * antimalarial. What it can do is notice that a malaria PATHWAY may be
 * relevant and hand off to nigeria_malaria_assessment — and only if that
 * protocol is ACTIVE and its evidence APPROVED. It is currently DRAFT by
 * design, so today that transition never fires and every febrile run ends
 * with a human. See canTransitionToMalaria() for the gate.
 *
 * ============================================================
 * SOURCE POLICY — A DELIBERATE DEVIATION FROM THE SPEC
 * ============================================================
 * §18 of the brief names "Nigerian National Antimalarial Treatment
 * Guidelines" as the primary malaria source. That file was assessed during
 * ingestion and found INADMISSIBLE: an undated, unattributed 16-slide deck
 * with no issuer, no version, and drug names misspelled inside dosing
 * instructions (docs/clinical/nnatg-extraction-v1.md).
 *
 * Using it would have undone the evidence-admissibility argument the whole
 * Stage 2 Part 2 gate is built on. The danger signs below are instead sourced
 * to Nigeria Standard Treatment Guidelines 2022 p242, an admissible document.
 * This deviation is deliberate and is reported rather than silently applied.
 *
 * ============================================================
 * ON THE RED FLAGS BEING ACTIVE WHEN THE MALARIA ONES ARE NOT
 * ============================================================
 * The malaria draft protocol creates its flags inactive because that whole
 * protocol is unreviewed. These are active, and the asymmetry is intentional:
 *
 *   - every flag here is patient-reportable over chat (no lab values)
 *   - every action is ESCALATE TO A HUMAN — never treat, never dose
 *   - the cost of a false positive is a pharmacist reading a case that turned
 *     out fine; the cost of a false negative is a missed emergency
 *
 * They are sourced to STG 2022 p242, where they are defined as features of
 * SEVERE MALARIA. Their applicability to undifferentiated fever is a clinical
 * judgement a reviewer must confirm — recorded in each rule's
 * source_reference and listed in the review checklist. What is NOT in doubt
 * is that a convulsing or unrousable patient needs a human, which is all
 * these rules do.
 */

const SLUG = 'fever_assessment';
const VERSION = '2.0.0';

/** Populations the protocol distinguishes (§2). Derived, never assumed. */
const POPULATIONS = Object.freeze({
  INFANT: 'infant',           // < 1 year
  CHILD: 'child',             // 1 – 11 years
  ADULT: 'adult',             // 12 – 64
  OLDER_ADULT: 'older_adult', // >= 65
  PREGNANT: 'pregnant',       // overlay, not exclusive
  SPECIAL_RISK: 'special_risk',
  UNKNOWN: 'unknown',         // age declined or not yet given
});

/**
 * Pure. Age (years) + flags → population set.
 *
 * Returns UNKNOWN when age is absent or declined — never a guess. §2 is
 * explicit: "Do not silently assume an age." A protocol step that needs the
 * population must ask, or escalate, rather than defaulting to adult.
 */
function derivePopulations({ ageYears = null, pregnancyStatus = null, specialRisk = false } = {}) {
  const out = new Set();

  if (ageYears === null || ageYears === undefined || Number.isNaN(Number(ageYears))) {
    out.add(POPULATIONS.UNKNOWN);
  } else {
    const age = Number(ageYears);
    if (age < 1) out.add(POPULATIONS.INFANT);
    else if (age < 12) out.add(POPULATIONS.CHILD);
    else if (age < 65) out.add(POPULATIONS.ADULT);
    else out.add(POPULATIONS.OLDER_ADULT);
  }

  // Pregnancy is an overlay: a pregnant 28-year-old is ADULT and PREGNANT.
  // Collapsing them into one value would lose whichever the caller didn't ask for.
  if (pregnancyStatus === 'pregnant' || pregnancyStatus === 'possibly_pregnant') {
    out.add(POPULATIONS.PREGNANT);
  }
  if (specialRisk) out.add(POPULATIONS.SPECIAL_RISK);

  return out;
}

/**
 * May this run hand over to the malaria protocol? (§9)
 *
 * Requires the malaria protocol to be ACTIVE **and** every evidence source it
 * relies on to be APPROVED. Both are false today by design, so this returns
 * false with a reason rather than transitioning into an unreviewed protocol.
 */
async function canTransitionToMalaria(pharmacyId) {
  const protocols = require('../clinicalProtocolService');
  const evidenceSvc = require('../evidenceService');
  const malaria = require('./nigeriaMalariaAssessmentV1');

  const active = await protocols.getActiveProtocol(pharmacyId, malaria.SLUG);
  if (!active) {
    return { allowed: false, reason: 'malaria_protocol_not_active' };
  }

  for (const src of malaria.EVIDENCE_SOURCES) {
    const source = await evidenceSvc.getSourceByKey(pharmacyId, src.sourceKey, src.version);
    if (!source || source.status !== 'active') {
      return { allowed: false, reason: `evidence_not_approved:${src.sourceKey}` };
    }
  }

  return { allowed: true, reason: 'ok', protocolId: active.id, version: active.version };
}

const DEFINITION = Object.freeze({
  slug: SLUG,
  version: VERSION,
  name: 'Fever assessment and triage',
  description:
    'Conversational triage for a febrile complaint. Recognises fever presentations, '
    + 'collects duration, severity and danger signs, distinguishes populations, and routes to '
    + 'urgent referral, pharmacist review, or an approved condition-specific protocol. '
    + 'Contains NO diagnosis, NO medicine selection and NO dosing. Fever is never treated as malaria.',
  conditionDomain: 'fever',
  population:
    'All ages. Distinguishes infant (<1y), child (1-11y), adult (12-64y), older adult (>=65y), '
    + 'with pregnancy and special-risk overlays. Age is asked, never assumed; DECLINED is stored as such.',
  source: 'Nigeria Standard Treatment Guidelines 2022 (danger signs, p242); RxNaija triage structure',
  sourceReference: 'docs/clinical/malaria-consolidated-extraction-v2.md. NOTE: the slide deck named in the brief was assessed INADMISSIBLE and is not used.',

  // Substring-matched by clinicalRouter — see the note in
  // soreThroatAssessmentV1 on why both word orders are listed.
  //
  // A BARE 'malaria' IS DELIBERATELY ABSENT. "Do you have malaria drugs" is a
  // product question the assistant should answer, and the clinical filter
  // draws exactly that line (naming a category is commerce; describing
  // symptoms is clinical). Adding the bare word here would drag every
  // customer shopping for antimalarials into a fever assessment. Only the
  // self-diagnosing phrasings are listed.
  presentingComplaints: [
    'fever', 'feeling hot', 'body is hot', 'history of fever', 'chills', 'rigors',
    'feverish', 'temperature', 'hot body', 'I think I have malaria', 'I think I have typhoid',
    'i have malaria', 'i have typhoid', 'body dey hot', 'i dey hot', 'my body hot',
    'running temperature', 'high temperature', 'shivering', 'cold and fever',
    'hot and cold', 'sweating at night', 'night sweats',
  ],

  questions: [
    {
      questionKey: 'presenting_complaint',
      text: 'Sorry to hear that. Can you tell me a bit more about how you have been feeling?',
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
      // §2: age materially changes the population, so it is asked. DECLINED is
      // a first-class answer — answerNormaliser maps refusals to it, and the
      // engine treats it as answered-but-unknown rather than re-asking forever.
      questionKey: 'patient_age',
      text: 'How old is the patient?',
      helpText: 'Roughly is fine. You can say "prefer not to say".',
      answerType: 'number',
      factConcept: 'age_years',
      unit: 'years',
      required: true,
      priority: 20,
      // No per-question "allowDeclined" flag: answerNormaliser.detectNonAnswer
      // already maps refusals to status 'declined' for EVERY question, and the
      // engine counts declined as answered-not-known rather than re-asking.
      // §2's "store DECLINED, do not assume an age" is therefore already the
      // engine's behaviour, not something this protocol needs to opt into.
      validation: { min: 0, max: 120 },
    },
    {
      questionKey: 'fever_duration',
      text: 'How long has the fever been going on?',
      helpText: 'For example: "since yesterday", "3 days", "about a week".',
      answerType: 'duration',
      factConcept: 'symptom_duration_days',
      unit: 'days',
      required: true,
      priority: 25,
      validation: { min: 0, max: 90 },
    },
    {
      // §5 asks for this exact branch. A thermometer reading and a felt
      // impression are DIFFERENT FACTS with different provenance — asking one
      // question and storing the answer under whichever concept fits keeps
      // `measured` honest.
      questionKey: 'temperature_available',
      text: 'Do you have a thermometer reading, or does it just feel hot?',
      answerType: 'single_choice',
      factConcept: 'has_thermometer_reading',
      required: true,
      priority: 30,
      // The natural answer to an "or" question is often just yes/no, not a
      // repeat of either option's own wording — "No" trapped a real
      // conversation in a loop that re-asked this question on every message
      // for over an hour, because it matched neither choice.
      choices: [
        { value: 'has_reading', label: 'I have a reading', aliases: ['yes', 'i do', 'have one', 'reading', 'thermometer'] },
        {
          value: 'feels_hot_only', label: 'It just feels hot',
          aliases: [
            'no', 'not measured', 'no reading', 'just hot', 'just feels hot',
            'it feel hot', 'it feels hot', 'feel hot', 'feels hot', 'no thermometer',
          ],
        },
      ],
    },
    {
      questionKey: 'measured_temperature',
      text: 'What did the thermometer say?',
      helpText: 'For example "38.7" — in Celsius.',
      answerType: 'number',
      factConcept: 'body_temperature_c',
      unit: 'celsius',
      // NOT recorded as source `measured`, deliberately. A number the patient
      // reads off their own thermometer and types into WhatsApp is
      // patient-reported: the pharmacy measured nothing. Reserving `measured`
      // for a reading a clinician actually took is what keeps that value
      // meaningful. The distinction §15 asks for is preserved instead by the
      // CONCEPT — body_temperature_c (a number they read) versus
      // fever_severity_gauge (an impression) — both patient_reported, and a
      // pharmacist can tell them apart at a glance.
      required: true,
      priority: 35,
      applicability: { all_of: [{ concept: 'has_thermometer_reading', equals: 'has_reading' }] },
      validation: { min: 30, max: 45 },
    },
    {
      questionKey: 'fever_severity',
      text: 'On a scale of 1 to 10, how bad does the fever feel right now?',
      helpText: '1 = barely warm, 10 = the worst you have felt. No thermometer needed.',
      answerType: 'scale',
      factConcept: 'fever_severity_gauge',
      unit: 'scale_1_10',
      required: true,
      priority: 35,
      applicability: { all_of: [{ concept: 'has_thermometer_reading', equals: 'feels_hot_only' }] },
      validation: { min: 1, max: 10 },
    },
    {
      // THE DANGER SCREEN. Asked early (priority 40) and to everyone: §8 says
      // a satisfied red flag must STOP routine assessment, which only works if
      // the screen comes before the long tail of symptom questions.
      questionKey: 'danger_signs_screen',
      text: 'Before we go on — is any of this happening?',
      helpText:
        'Very drowsy or hard to wake · confused · fits or convulsions · trouble breathing · '
        + 'unable to drink or keep fluids down · unable to stand or sit up · stiff neck · '
        + 'bleeding · very dark urine, or passing very little',
      answerType: 'multi_choice',
      factConcept: 'danger_signs_reported',
      required: true,
      priority: 40,
      choices: [
        { value: 'none', label: 'None of these' },
        { value: 'impaired_consciousness', label: 'Very drowsy, confused or hard to wake' },
        { value: 'convulsions', label: 'Fits or convulsions' },
        { value: 'respiratory_distress', label: 'Trouble breathing' },
        { value: 'cannot_drink', label: 'Unable to drink or keep fluids down' },
        { value: 'prostration', label: 'Too weak to stand or sit up' },
        { value: 'neck_stiffness', label: 'Stiff neck' },
        { value: 'abnormal_bleeding', label: 'Unusual bleeding' },
        { value: 'reduced_urine', label: 'Very dark urine, or passing very little' },
      ],
    },
    {
      questionKey: 'associated_symptoms',
      text: 'What else have you been feeling along with the fever?',
      answerType: 'multi_choice',
      factConcept: 'associated_symptoms',
      required: true,
      priority: 50,
      // Skipped when a danger sign fired — §8 forbids continuing routine
      // questioning once escalation is warranted.
      applicability: { all_of: [{ concept: 'danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'chills', label: 'Chills or shivering' },
        { value: 'headache', label: 'Headache' },
        { value: 'body_aches', label: 'Body aches' },
        { value: 'weakness', label: 'Weakness or tiredness' },
        { value: 'cough', label: 'Cough' },
        { value: 'sore_throat', label: 'Sore throat' },
        { value: 'runny_nose', label: 'Runny or blocked nose' },
        { value: 'vomiting', label: 'Vomiting' },
        { value: 'diarrhoea', label: 'Diarrhoea' },
        { value: 'abdominal_pain', label: 'Stomach pain' },
        { value: 'urinary_symptoms', label: 'Pain or burning when passing urine' },
        { value: 'rash', label: 'A rash' },
        { value: 'none', label: 'Nothing else' },
      ],
    },
    {
      questionKey: 'pregnancy_status',
      text: 'Are you pregnant, or could you be?',
      answerType: 'single_choice',
      factConcept: 'pregnancy_status',
      required: true,
      priority: 55,
      // Only where it could apply. Asking a 6-year-old's parent this is not
      // just noise — it damages trust in the whole conversation.
      // min/max, not gte/lte — isApplicable supports equals|contains|min|max|exists.
      // An unrecognised operator falls through to `return false`, which would
      // have made this question permanently inapplicable and silently skipped
      // pregnancy for everyone.
      applicability: {
        all_of: [
          { concept: 'patient_is_self', equals: 'self' },
          { concept: 'age_years', min: 12 },
          { concept: 'age_years', max: 55 },
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
      // §11: store what they SAID. "I took malaria medicine" must not become
      // "patient took artemether-lumefantrine" — answerNormaliser keeps the
      // original response alongside any normalised value.
      questionKey: 'medication_taken',
      text: 'Have you taken any medicine for it so far?',
      helpText: 'Whatever you remember is fine — the name, or just what it was for.',
      answerType: 'text',
      factConcept: 'self_medication_reported',
      required: false,
      priority: 60,
      applicability: { all_of: [{ concept: 'danger_signs_reported', contains: 'none' }] },
      validation: { maxLength: 500 },
    },
    {
      questionKey: 'known_conditions',
      text: 'Do you have any long-term health conditions, or any allergies I should know about?',
      answerType: 'text',
      factConcept: 'reported_conditions_and_allergies',
      required: false,
      priority: 70,
      applicability: { all_of: [{ concept: 'danger_signs_reported', contains: 'none' }] },
      validation: { maxLength: 500 },
    },
  ],

  /**
   * Danger signs. Every one is patient-reportable, every action is escalation
   * to a human, and every one cites STG 2022 p242. See the module header on
   * why these are active while the malaria protocol's are not.
   */
  redFlags: [
    { key: 'impaired_consciousness', name: 'Impaired consciousness, confusion or unrousable', severity: 'emergency', action: 'emergency_referral' },
    { key: 'convulsions', name: 'Fits or convulsions', severity: 'emergency', action: 'emergency_referral' },
    { key: 'respiratory_distress', name: 'Respiratory distress / trouble breathing', severity: 'emergency', action: 'emergency_referral' },
    { key: 'cannot_drink', name: 'Unable to drink or keep fluids down', severity: 'emergency', action: 'emergency_referral' },
    { key: 'prostration', name: 'Prostration — too weak to stand or sit up', severity: 'emergency', action: 'emergency_referral' },
    { key: 'abnormal_bleeding', name: 'Abnormal bleeding', severity: 'emergency', action: 'emergency_referral' },
    { key: 'reduced_urine', name: 'Very dark urine or markedly reduced output', severity: 'emergency', action: 'emergency_referral' },
    {
      key: 'neck_stiffness',
      name: 'Neck stiffness with fever',
      severity: 'emergency',
      action: 'emergency_referral',
      // Honest about provenance: STG p243 lists meningitis as a differential
      // for malaria but does not itself define neck stiffness as a red flag.
      // Included because failing to escalate it is the worse error, and
      // flagged for review rather than presented as sourced.
      note: 'NOT a listed STG severe-malaria feature. STG p243 lists meningitis among fever differentials. Applicability REQUIRES_REVIEW.',
    },
  ],

  /** Declarative. The workflow layer executes; nothing here runs by itself. */
  escalationRules: [
    { trigger: 'any danger sign reported', priority: 'urgent', action: 'URGENT_REFERRAL', cite: 'STG 2022 p242 — severe features are a medical emergency' },
    { trigger: 'infant under 1 year with fever', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'Population outside any approved self-care pathway; STG p245 requires supervision below 5kg' },
    { trigger: 'pregnant or possibly pregnant', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'CONFLICT-011 — STG 2022 and WHO 2025 differ on permitted first-trimester ACTs' },
    { trigger: 'age unknown or declined where population affects routing', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: '§2 — age must not be assumed' },
    { trigger: 'fever duration 7 days or more', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'Outside routine self-limiting presentation; STG p243 differentials incl. typhoid' },
    { trigger: 'conflicting facts affecting safety', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'Part 2 safety gate — conflicts are preserved, never resolved silently' },
    { trigger: 'assessment complete, no danger signs', priority: 'low', action: 'PHARMACIST_REVIEW', cite: 'No approved recommendation is reachable — a human closes every run' },
  ],

  /**
   * §9. Declarative and GATED — canTransitionToMalaria() must return allowed
   * before any of this is acted on. Relevance is not diagnosis: these are the
   * conditions under which a malaria ASSESSMENT becomes worth running.
   */
  protocolTransitions: [
    {
      target: 'nigeria_malaria_assessment',
      targetVersion: '1.0.0',
      when: 'febrile presentation with no danger signs, where malaria assessment is clinically relevant',
      relevanceSignals: ['chills', 'headache', 'body_aches', 'weakness'],
      requires: ['target protocol ACTIVE', 'all target evidence sources APPROVED'],
      note:
        'Relevance only — NOT a malaria diagnosis. The malaria protocol is DRAFT by design, '
        + 'so this transition does not fire today and every run ends with a human.',
    },
  ],

  /** §12. Deliberately empty — this protocol authors no recommendation of any kind. */
  recommendationBoundaries: {
    permitted: ['PATIENT_INFORMATION', 'CLINICAL_ASSESSMENT', 'PHARMACIST_REVIEW', 'URGENT_REFERRAL'],
    forbidden: ['MEDICATION_RECOMMENDATION'],
    reason:
      'Fever is undifferentiated. No approved source in the registry authorises a medicine for '
      + 'undifferentiated fever, and the malaria pathway that might is DRAFT. Any medication must '
      + 'come from a condition-specific approved protocol through the Part 2 safety gate.',
  },
});

/**
 * Install fever_assessment v2.0.0 and activate it.
 *
 * Idempotent. Does NOT touch v1.0.0 — both versions coexist so encounters
 * that referenced v1.0.0 keep meaning what they meant.
 *
 * Creates ZERO recommendations: see recommendationBoundaries.
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
    permittedAdvice: [],
    referralRules: DEFINITION.escalationRules,
    pharmacistReviewRules: DEFINITION.protocolTransitions,
    exclusionCriteria: [
      { rule: 'No medication recommendation is authorised for undifferentiated fever' },
      { rule: 'Malaria transition gated on nigeria_malaria_assessment being ACTIVE with APPROVED evidence' },
    ],
  }, { actorType, actorId });

  for (const q of DEFINITION.questions) {
    await protocols.addQuestion(pharmacyId, protocol.id, q, { actorType, actorId });
  }

  for (const rf of DEFINITION.redFlags) {
    const created = await protocols.createRedFlagRule(pharmacyId, protocol.id, {
      name: rf.name,
      description: rf.note
        ? `Patient-reportable danger sign. ${rf.note}`
        : 'Patient-reportable danger sign. Action is escalation to a human — never treatment.',
      severity: rf.severity,
      action: rf.action,
      // What makes the rule evaluable (0036). Every rf.key is, by
      // construction, one of danger_signs_screen's choice values — the two
      // lists are the same vocabulary, which is what lets a ticked box fire
      // exactly one rule. Before this was persisted the rules were inert
      // data and handleTurn escalated on their mere existence.
      triggerConcept: 'danger_signs_reported',
      triggerValue: rf.key,
      source: 'Nigeria Standard Treatment Guidelines 2022',
      sourceReference: rf.note
        ? `p243 differential list. ${rf.note}`
        : 'p242 severe malaria features. Applicability to undifferentiated fever REQUIRES_REVIEW.',
    }, { actorType, actorId });

    // Active, unlike the malaria protocol's — see the module header for the
    // asymmetry and why it is deliberate.
    await protocols.setRedFlagActive(pharmacyId, created.id, true, { actorType, actorId });
  }

  await protocols.activateProtocol(pharmacyId, protocol.id, { actorType, actorId });
  return protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
}

module.exports = {
  SLUG, VERSION, DEFINITION, POPULATIONS,
  derivePopulations, canTransitionToMalaria, install,
};
