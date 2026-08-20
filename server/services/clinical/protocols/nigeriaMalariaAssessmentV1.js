/**
 * nigeria_malaria_assessment v1.0.0 — DRAFT. NOT ACTIVE. NOT PATIENT-FACING.
 *
 * ============================================================
 * THIS PROTOCOL IS DELIBERATELY LEFT IN `draft` AND IS NEVER ACTIVATED
 * ============================================================
 * install() does NOT call activateProtocol(). That is not an oversight and
 * must not be "fixed". Compare feverAssessmentV1.install(), which does
 * activate — the difference is the whole point of this file.
 *
 * Two unresolved conflicts block activation (see
 * docs/clinical/malaria-consolidated-extraction-v2.md §H):
 *
 *   CONFLICT-009  Nigeria STG 2022 p242 states severe anaemia as
 *                 "PCV > 15%". Severe anaemia is a LOW packed cell volume;
 *                 as written the sign is inverted and would flag nearly
 *                 every patient. Almost certainly a typo for < 15% — but a
 *                 threshold that triggers EMERGENCY REFERRAL gets confirmed
 *                 by a clinician, never inferred by a developer. The
 *                 corresponding red flag is therefore created with NO
 *                 machine-evaluable threshold.
 *
 *   CONFLICT-011  Nigeria STG permits "ACTs in all trimesters" and lists
 *                 artesunate-pyronaridine as an alternative. WHO 2025
 *                 §5.2.1.4.1 says artesunate-pyronaridine is NOT recommended
 *                 in the first trimester ("no documented record of use") and
 *                 that SP-containing ACTs are contraindicated. Following the
 *                 STG literally could hand a first-trimester patient an agent
 *                 WHO excludes. Until resolved, pregnancy escalates.
 *
 * ============================================================
 * WHY THIS PROTOCOL CARRIES NO MEDICATION RECOMMENDATION
 * ============================================================
 * Not because the doses are unknown — after four documents they are now
 * well sourced and cross-corroborated. Because of Nigeria STG 2022 p244:
 *
 *   "All patients suspected of malaria should have prompt parasitological
 *    confirmation by microscopy or RDTs BEFORE treatment."
 *
 * A WhatsApp assistant cannot perform microscopy or an RDT. The guideline's
 * own precondition for treating cannot be met over this channel, so no
 * treatment recommendation is reachable here regardless of how complete the
 * dosing tables are. That is the guideline telling us what this channel can
 * and cannot do, and it is encoded structurally: this file creates ZERO
 * protocol_recommendations rows.
 *
 * What this protocol DOES do is triage: collect what a pharmacist needs,
 * detect the severe-malaria features that demand urgent referral, and hand
 * over. That is genuinely useful and carries no treatment risk.
 *
 * ============================================================
 * SOURCES (see the extraction doc for full traceability)
 * ============================================================
 *   S1  Nigeria Standard Treatment Guidelines 2022      — PRIMARY
 *   S2  Nigeria Essential Medicines List Adults 8th Ed 2024
 *   S3  WHO Guidelines for Malaria, 13 August 2025
 *   S4  WHO Guidelines for Treatment of Malaria 3rd Ed 2015 — SUPERSEDED
 *   S5  unattributed slide deck — INADMISSIBLE, deliberately not ingested
 */

const SLUG = 'nigeria_malaria_assessment';
const VERSION = '1.0.0';

/**
 * Evidence sources, all created `draft`. install() never approves them —
 * approveSource() refuses a non-human actor by design, so an automated
 * installer structurally cannot make its own evidence usable.
 */
const EVIDENCE_SOURCES = Object.freeze([
  {
    sourceKey: 'nigeria_stg_2022',
    title: 'Nigeria Standard Treatment Guidelines, 2022',
    publisher: 'Federal Ministry of Health, Nigeria',
    origin: 'nigerian_guidance',
    strength: 'authoritative_guideline',
    version: '2022',
    locator: 'server/nigeria-2022-stg.pdf',
    references: [
      { key: 'dx', section: 'Malaria — Diagnosis (printed p243-244)', population: 'All suspected malaria',
        summary: 'Parasitological confirmation by microscopy or RDT required before treatment. Clinical diagnosis alone is presumptive. Microscopy is gold standard; must not delay treatment where severe malaria is suspected.' },
      { key: 'severe', section: 'Malaria — Severe (Complicated) malaria (printed p242)', population: 'All ages',
        summary: 'Medical emergency. Clinical and laboratory criteria for severe malaria, with thresholds.' },
      { key: 'uncomplicated_rx', section: 'Malaria — Drug Treatment, Tables 10:7 and 10.8 (printed p244-245)', population: 'All ages incl. pregnancy',
        summary: 'AL is the medicine of choice; AA, DHA-PPQ and AS-pyronaridine are alternatives. Weight-banded dosing. Infants <5kg treated under health-care-provider supervision.' },
      { key: 'severe_rx', section: 'Malaria — Pre-referral and severe malaria treatment (printed p245-246)', population: 'All ages',
        summary: 'Pre-referral options in order of preference. Parenteral artesunate is drug of choice. Minimum 24h parenteral. NOT prescriber-facing over this channel.' },
    ],
  },
  {
    sourceKey: 'neml_adult_8th_2024',
    title: 'Nigeria Essential Medicines List for Adults, 8th Edition',
    publisher: 'Federal Ministry of Health and Social Welfare, Nigeria',
    origin: 'nigerian_guidance',
    strength: 'authoritative_guideline',
    version: '8.0-2024',
    locator: 'server/Final-NEML-Adult-8th-Edition.pdf',
    references: [
      { key: 'antimalarials', section: '5.7 Antimalarial medicines (PDF p18 / printed p9)', population: 'ADULTS ONLY',
        summary: 'Approved antimalarials and their formulations/strengths. Formulary only — contains no doses, regimens or indications. Doxycycline restricted to use in combination with quinine.' },
    ],
  },
  {
    sourceKey: 'who_malaria_2025_08_13',
    title: 'WHO Guidelines for Malaria, 13 August 2025',
    publisher: 'World Health Organization, Global Malaria Programme',
    origin: 'global_guidance',
    strength: 'authoritative_guideline',
    version: '2025-08-13',
    locator: 'server/WHO standard guide malaria treatment.pdf (DOI 10.2471/B09514)',
    references: [
      { key: 'first_trimester', section: '5.2.1.4.1 Treatment in the first trimester of pregnancy (2022)', population: 'Pregnant, first trimester',
        summary: 'AL recommended in the first trimester (strong recommendation, low certainty). Other ACTs insufficient evidence for routine use. SP-containing ACTs contraindicated (antifolate). No documented record of artesunate-pyronaridine use in first trimester.' },
    ],
  },
]);

const DEFINITION = Object.freeze({
  slug: SLUG,
  version: VERSION,
  name: 'Nigeria malaria assessment (triage and referral only) — DRAFT',
  description:
    'Structured triage for suspected malaria, derived from Nigeria STG 2022 with '
    + 'WHO 2025 cross-reference. Collects presenting features, duration, severity gauge, '
    + 'pregnancy status and severe-malaria red flags for pharmacist review. '
    + 'Contains NO diagnosis, NO medicine selection and NO dosing: the source guideline '
    + 'requires parasitological confirmation before treatment, which this channel cannot obtain.',
  conditionDomain: 'malaria',
  population:
    'Persons presenting with fever or suspected malaria. Pregnancy escalates (CONFLICT-011). '
    + 'Infants <5kg escalate — STG requires health-care-provider supervision. '
    + 'NEML source is adults-only; paediatric NEML not held.',
  source: 'Nigeria Standard Treatment Guidelines 2022 (primary); NEML 8th Ed 2024; WHO Guidelines for Malaria 13 Aug 2025',
  sourceReference: 'docs/clinical/malaria-consolidated-extraction-v2.md — full page-level traceability',

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
    {
      questionKey: 'fever_duration',
      text: 'How long have you had this fever?',
      helpText: 'For example: "3 days", "since Monday", "about a week".',
      answerType: 'duration',
      factConcept: 'symptom_duration_days',
      unit: 'days',
      required: true,
      priority: 20,
      validation: { min: 0, max: 90 },
    },
    {
      // Same reasoning as fever_assessment: a thermometer reading most people
      // do not have produces guesses that arrive looking like measurements.
      // A self-rating is subjective and says so.
      questionKey: 'fever_severity',
      text: 'On a scale of 1 to 10, how bad is the fever right now? (1 = barely warm, 10 = the worst you have felt)',
      helpText: 'Your own sense of it is fine — no thermometer needed.',
      answerType: 'scale',
      factConcept: 'fever_severity_gauge',
      unit: 'scale_1_10',
      required: true,
      priority: 25,
      validation: { min: 1, max: 10 },
    },
    {
      // S1 p244: parasitological confirmation is required BEFORE treatment.
      // Asked so the pharmacist knows whether it exists — never so the system
      // can proceed to treat on the strength of a "yes".
      questionKey: 'malaria_test_done',
      text: 'Have you had a malaria test (blood test or rapid test) for this illness?',
      answerType: 'single_choice',
      factConcept: 'parasitological_test_status',
      required: true,
      priority: 30,
      choices: [
        { value: 'positive', label: 'Yes — it was positive' },
        { value: 'negative', label: 'Yes — it was negative' },
        { value: 'pending', label: 'Yes — still waiting for the result' },
        { value: 'not_done', label: 'No test yet' },
      ],
    },
    {
      // The severe-malaria screen. Every option is a feature the STG lists at
      // p242. Answering yes to ANY of these is an escalation trigger — the
      // workflow escalates, it does not "handle" them.
      questionKey: 'severe_features_screen',
      text: 'Are any of these happening? Please tell me all that apply, or say "none".',
      helpText:
        'Very drowsy or hard to wake · confusion or unconsciousness · fits or convulsions · '
        + 'trouble breathing · unable to eat or drink · unable to stand or sit up · '
        + 'yellow eyes · bleeding · very dark or "coca-cola" urine · passing little or no urine',
      answerType: 'multi_choice',
      factConcept: 'severe_malaria_features_reported',
      required: true,
      priority: 40,
      choices: [
        { value: 'none', label: 'None of these' },
        { value: 'impaired_consciousness', label: 'Very drowsy, confused or unconscious' },
        { value: 'convulsions', label: 'Fits or convulsions' },
        { value: 'respiratory_distress', label: 'Trouble breathing' },
        { value: 'failure_to_feed', label: 'Unable to eat or drink' },
        { value: 'prostration', label: 'Unable to stand or sit up' },
        { value: 'jaundice', label: 'Yellow eyes or skin' },
        { value: 'abnormal_bleeding', label: 'Unusual bleeding' },
        { value: 'haemoglobinuria', label: 'Very dark or "coca-cola" coloured urine' },
        { value: 'reduced_urine', label: 'Passing little or no urine' },
      ],
    },
    {
      // Conditional follow-up. STG p242 defines multiple convulsions as
      // >2 episodes in 24 hours — asked only when convulsions were reported.
      // The COUNT is recorded for the pharmacist; the system does not decide
      // anything from it.
      questionKey: 'convulsion_count',
      text: 'How many times have the fits happened in the last 24 hours?',
      answerType: 'number',
      factConcept: 'convulsion_episodes_24h',
      unit: 'episodes',
      required: true,
      priority: 45,
      applicability: { all_of: [{ concept: 'severe_malaria_features_reported', contains: 'convulsions' }] },
      validation: { min: 0, max: 50 },
    },
    {
      // Pregnancy escalates until CONFLICT-011 is resolved. Asked to route,
      // never to select a medicine.
      questionKey: 'pregnancy_status',
      text: 'Are you pregnant, or could you be?',
      answerType: 'single_choice',
      factConcept: 'pregnancy_status',
      required: true,
      priority: 50,
      applicability: { all_of: [{ concept: 'patient_is_self', equals: 'self' }] },
      choices: [
        { value: 'pregnant', label: 'Yes, pregnant' },
        { value: 'possibly_pregnant', label: 'Possibly / not sure' },
        { value: 'not_pregnant', label: 'No' },
        { value: 'not_applicable', label: 'Prefer not to say / not applicable' },
      ],
    },
    {
      // STG p245 requires health-care-provider supervision below 5kg, so
      // weight is asked to ROUTE, not to compute a dose. No dosing rule in
      // this protocol consumes it.
      questionKey: 'patient_weight_band',
      text: 'Roughly how much does the patient weigh? An estimate is fine.',
      helpText: 'Recorded for the pharmacist. Say "not sure" if you do not know.',
      answerType: 'single_choice',
      factConcept: 'weight_band',
      required: false,
      priority: 55,
      choices: [
        { value: 'under_5kg', label: 'Under 5 kg (small baby)' },
        { value: '5_to_15kg', label: '5–15 kg' },
        { value: '15_to_25kg', label: '15–25 kg' },
        { value: '25_to_35kg', label: '25–35 kg' },
        { value: 'over_35kg', label: 'Over 35 kg' },
        { value: 'unknown', label: 'Not sure' },
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
  ],

  /**
   * Severe malaria features — Nigeria STG 2022 p242.
   *
   * Every rule is created with `active: false` (the column default). Nothing
   * fires until a clinician turns it on deliberately, which is the same
   * discipline Stage 1 established.
   *
   * `machineEvaluable: false` marks a feature whose threshold cannot be
   * evaluated from anything this channel can collect (a laboratory value), or
   * whose stated threshold is in conflict. These exist so a pharmacist sees
   * the complete STG list, NOT so the system can test them.
   */
  redFlags: [
    // --- clinical, reportable over chat ---
    { key: 'prostration', name: 'Prostration — unable to sit or stand', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'impaired_consciousness', name: 'Impaired consciousness or unrousable coma', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'failure_to_feed', name: 'Failure to feed', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'respiratory_distress', name: 'Respiratory distress', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'multiple_convulsions', name: 'Multiple convulsions — more than 2 episodes in 24 hours', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical (threshold: >2 in 24h)' },
    { key: 'circulatory_collapse', name: 'Circulatory collapse (algid malaria)', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 clinical — requires examination' },
    { key: 'pulmonary_oedema', name: 'Pulmonary oedema (radiological)', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 clinical — radiological' },
    { key: 'abnormal_bleeding', name: 'Abnormal bleeding / DIC', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'jaundice', name: 'Jaundice', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 clinical' },
    { key: 'cerebral_malaria', name: 'Cerebral malaria — coma persisting >30 min after a seizure', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p243 — requires clinical observation' },

    // --- laboratory: none evaluable over WhatsApp ---
    {
      key: 'severe_anaemia',
      name: 'Severe anaemia — THRESHOLD UNRESOLVED (CONFLICT-009)',
      severity: 'emergency', action: 'emergency_referral', machineEvaluable: false,
      cite: 'S1 p242 states "PCV > 15%" which inverts the sign; severe anaemia is a LOW PCV. Presumed <15%, NOT confirmed. Must not be evaluated until a clinician resolves it.',
    },
    { key: 'hypoglycaemia', name: 'Hypoglycaemia — blood glucose < 2.2 mmol/L', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 laboratory' },
    { key: 'acidosis', name: 'Acidosis — HCO3 < 15 mmol/L', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 laboratory (see CONFLICT-010: poor-prognosis list states the sign inverted)' },
    { key: 'haemoglobinuria', name: 'Haemoglobinuria (blackwater fever)', severity: 'emergency', action: 'emergency_referral', machineEvaluable: true, cite: 'S1 p242 laboratory — but dark urine is patient-reportable' },
    { key: 'renal_impairment', name: 'Renal impairment — creatinine > 265 umol/L', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 laboratory' },
    { key: 'hyperlactataemia', name: 'Hyperlactataemia — > 5 mmol/L', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 laboratory' },
    { key: 'hyperparasitaemia', name: 'Hyperparasitaemia — > 5% or 250,000/uL', severity: 'emergency', action: 'emergency_referral', machineEvaluable: false, cite: 'S1 p242 laboratory' },
  ],

  /**
   * Escalation rules, for pharmacist review. Declarative only — the workflow
   * layer decides; nothing here executes.
   */
  escalationRules: [
    { trigger: 'any severe malaria feature reported', priority: 'urgent', action: 'URGENT_REFERRAL', cite: 'S1 p242 — "a medical emergency requiring prompt attention"' },
    { trigger: 'pregnancy or possible pregnancy', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'CONFLICT-011 unresolved — STG and WHO 2025 differ on permitted first-trimester ACTs' },
    { trigger: 'weight band under_5kg', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'S1 p245 — infants <5kg require health-care-provider supervision' },
    { trigger: 'no parasitological test done, or result pending', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'S1 p244 — confirmation required before treatment; this channel cannot obtain it' },
    { trigger: 'test negative but symptoms persist', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'S1 p243 differentials — typhoid, meningitis, encephalitis, septicaemia, other causes of fever' },
    { trigger: 'protocol completed with no red flags', priority: 'low', action: 'PHARMACIST_REVIEW', cite: 'No treatment recommendation is reachable on this channel — a human closes every run' },
  ],
});

/**
 * Install as DRAFT. Idempotent.
 *
 * Creates: evidence sources (draft, unapproved) + references, the protocol
 * (draft), its questions, and its red flags (inactive).
 *
 * Deliberately does NOT: activate the protocol, approve any evidence source,
 * or create a single protocol_recommendations row.
 */
async function install(pharmacyId, { actorType = 'system', actorId = null } = {}) {
  const protocols = require('../clinicalProtocolService');
  const evidence = require('../evidenceService');

  const existing = await protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
  if (existing) return existing;

  // 1. Evidence sources — created draft. approveSource() rejects a non-human
  //    actor, so this installer cannot approve its own evidence even if a
  //    future edit tried to.
  const referenceIds = {};
  for (const src of EVIDENCE_SOURCES) {
    let source;
    try {
      source = await evidence.createSource(pharmacyId, {
        sourceKey: src.sourceKey, title: src.title, publisher: src.publisher,
        origin: src.origin, strength: src.strength, version: src.version, locator: src.locator,
      }, { actorType, actorId });
    } catch (e) {
      if (e.code !== 'DUPLICATE_VERSION' && e.code !== '23505') throw e;
      source = await evidence.getSourceByKey(pharmacyId, src.sourceKey, src.version);
    }
    for (const ref of src.references) {
      const created = await evidence.addReference(pharmacyId, source.id, {
        section: ref.section, summary: ref.summary, population: ref.population,
      }, { actorType, actorId });
      referenceIds[`${src.sourceKey}:${ref.key}`] = created.id;
    }
  }

  // 2. The protocol itself — status defaults to 'draft'.
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
    // Empty, and must stay empty for this protocol: the source guideline
    // requires a parasitological test before treatment, which this channel
    // cannot obtain. See this file's header.
    permittedAdvice: [],
    referralRules: DEFINITION.escalationRules,
    pharmacistReviewRules: [],
    exclusionCriteria: [
      { rule: 'CONFLICT-009 unresolved — severe anaemia threshold sign inverted in source' },
      { rule: 'CONFLICT-011 unresolved — first-trimester ACT selection differs between STG 2022 and WHO 2025' },
      { rule: 'Parasitological confirmation unobtainable over WhatsApp (S1 p244)' },
    ],
  }, { actorType, actorId });

  for (const q of DEFINITION.questions) {
    await protocols.addQuestion(pharmacyId, protocol.id, q, { actorType, actorId });
  }

  // 3. Red flags — created inactive (column default). A clinician activates.
  for (const rf of DEFINITION.redFlags) {
    await protocols.createRedFlagRule(pharmacyId, protocol.id, {
      name: rf.name,
      description: rf.machineEvaluable
        ? `Patient-reportable. ${rf.cite}`
        : `NOT MACHINE-EVALUABLE over this channel — for pharmacist reference only. ${rf.cite}`,
      severity: rf.severity,
      action: rf.action,
      source: 'Nigeria Standard Treatment Guidelines 2022',
      sourceReference: rf.cite,
    }, { actorType, actorId });
  }

  // 4. NO activateProtocol(). NO approveSource(). NO createRecommendation().
  //    See this file's header for why each of those is absent.
  return protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
}

module.exports = { SLUG, VERSION, DEFINITION, EVIDENCE_SOURCES, install };
