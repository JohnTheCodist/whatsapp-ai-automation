/**
 * sore_throat_assessment v1.0.0 — assessment, triage and safe routing.
 *
 * ============================================================
 * THE ANTIBIOTIC QUESTION — WHY THE ANSWER IS "NOT FROM THIS CHANNEL"
 * ============================================================
 * Unlike fever and cough, an approved Nigerian source DOES carry an
 * antibiotic regimen here. Nigeria STG 2022, Tonsillitis (printed p94):
 *
 *   "Amoxicillin — Adult: 250-500 mg orally 8 hourly for 5-7 days;
 *    Child: 40 mg/kg orally every 8 hours for 5-7 days"
 *
 * So §10's condition — "if an approved guideline provides criteria for
 * antibiotic use, represent them as an explicit versioned rule" — is live,
 * not hypothetical. It still yields no antibiotic here, for a reason that is
 * the source's own rather than a policy this file invented:
 *
 * STG prescribes that regimen for TONSILLITIS, and its diagnostic criteria
 * are examination findings:
 *
 *   "Tonsils are swollen, inflamed and covered with purulent exudates"
 *   "Jugulo-digastric lymph nodes are enlarged and tender"
 *
 * Nobody palpates a lymph node over WhatsApp. A patient saying "I think I
 * have white spots" is a reported impression, not a finding — §23 is explicit
 * that it must not be converted into one. The guideline gates its antibiotic
 * behind an examination this channel cannot perform, so the rule's
 * preconditions are structurally unsatisfiable here.
 *
 * This is the same shape as the malaria protocol, where STG requires
 * parasitological confirmation before treatment. In both cases the limit is
 * the source's, not ours — which is a far stronger guarantee than a
 * hand-written "never recommend antibiotics" rule that a later edit could
 * quietly relax.
 *
 * Recorded as a DRAFT recommendation with evidence_status `not_supported`
 * so the reasoning is visible and reviewable, rather than absent and
 * rediscovered later.
 *
 * ============================================================
 * WHAT IS SOURCED, AND FROM WHERE
 * ============================================================
 * Red flags come from three STG sections, and each rule records which:
 *   - Peritonsillar abscess / quinsy (PDF p116): increasing pain with fever
 *     and dysphagia, trismus, "mouth full of saliva", uvula pushed to the
 *     opposite side.
 *   - Foreign bodies in the airways (PDF p108, printed p82): stridor,
 *     cyanosis, imminent asphyxia as features of upper airway obstruction.
 *   - Tonsillitis (PDF p121): "the parenteral route may be required when
 *     there is vomiting or severe dysphagia" — severe dysphagia as a marker
 *     of a presentation oral treatment cannot serve.
 *
 * The airway signs are sourced to a FOREIGN BODY chapter, not a sore throat
 * one. Their applicability to throat infection is a clinical judgement a
 * reviewer must make, and each says so in its source_reference rather than
 * borrowing the citation next to it.
 *
 * ============================================================
 * SYMPTOMATIC GUIDANCE
 * ============================================================
 * STG's Tonsillitis section lists non-drug treatment: "Oral hydration.
 * Salt/warm water gurgle." Harmless whatever the cause, and exactly what §11
 * contemplates. It is authored here as a DRAFT recommendation with
 * evidence_status `limited_support` — because it is drawn from a
 * diagnosis-specific section and applied to undifferentiated sore throat,
 * which is weaker support than the section itself carries for tonsillitis.
 * Under the gate, limited_support does not auto-deliver.
 *
 * Nothing is approved. No source is approved, so nothing is deliverable until
 * a pharmacist reviews it — the path is real and reviewable, not absent.
 */

const SLUG = 'sore_throat_assessment';
const VERSION = '1.0.0';

const { POPULATIONS, derivePopulations } = require('./feverAssessmentV2');

const EVIDENCE_SOURCE = Object.freeze({
  sourceKey: 'nigeria_stg_2022',
  title: 'Nigeria Standard Treatment Guidelines, 2022',
  publisher: 'Federal Ministry of Health, Nigeria',
  origin: 'nigerian_guidance',
  strength: 'authoritative_guideline',
  version: '2022',
  locator: 'server/nigeria-2022-stg.pdf',
  references: [
    { key: 'tonsillitis', section: 'Tonsillitis (printed p94, PDF p120-121)', population: 'Children and young adults',
      summary: 'Clinical features incl. fever, sore throat, dysphagia, swollen tonsils with purulent exudates, tender jugulo-digastric nodes. Non-drug: oral hydration, salt/warm water gargle. Drug: amoxicillin or cotrimoxazole, plus paracetamol.' },
    { key: 'quinsy', section: 'Peritonsillar abscess / quinsy (PDF p116)', population: 'More common in adults with tonsillitis',
      summary: 'Increasing pain, fever and dysphagia; trismus; mouth full of saliva; affected tonsil displaced; uvula pushed to opposite side. Complications: septicaemia, parapharyngeal abscess.' },
    { key: 'airway_fb', section: 'Foreign bodies in the airways (printed p82, PDF p108)', population: 'Children most commonly',
      summary: 'Upper airway obstruction with difficulty breathing and stridor; in severe cases stridor, severe cyanosis and imminent asphyxia requiring immediate intervention. NOTE: documented for foreign bodies, not throat infection.' },
  ],
});

const DEFINITION = Object.freeze({
  slug: SLUG,
  version: VERSION,
  name: 'Sore throat assessment and triage',
  description:
    'Conversational triage for a sore throat complaint. Establishes duration, severity and '
    + 'swallowing ability, screens for airway and abscess danger signs, distinguishes populations, '
    + 'and routes to urgent referral or pharmacist review. Names no disease and authorises no '
    + 'antibiotic: the source guideline gates its antibiotic behind an examination this channel '
    + 'cannot perform.',
  conditionDomain: 'sore_throat',
  population:
    'All ages. Infant (<1y), child (1-11y), adult (12-64y), older adult (>=65y), with pregnancy '
    + 'and special-risk overlays, derived by feverAssessmentV2.derivePopulations. Age asked, never '
    + 'assumed; DECLINED stored as such.',
  source: 'Nigeria Standard Treatment Guidelines 2022 — Tonsillitis, Peritonsillar abscess, Foreign bodies in the airways',
  sourceReference: 'See module header. Airway signs are sourced to a foreign-body chapter; applicability REQUIRES_REVIEW.',

  // Matched as substrings by clinicalRouter, so both word orders of the same
  // complaint need listing — a customer writes "my throat is scratchy" as
  // readily as "scratchy throat", and the first used to miss entirely.
  // Nigerian phrasings ("throat dey pain me") are here for the same reason
  // the clinical filter carries them: it is what people actually type.
  presentingComplaints: [
    'sore throat', 'throat pain', 'my throat hurts', 'painful swallowing', 'scratchy throat',
    'irritated throat', 'difficulty swallowing', 'swollen throat', 'throat is painful',
    'swollen tonsils', 'it hurts when I swallow',
    'throat is scratchy', 'throat is sore', 'throat hurts', 'throat is swollen',
    'throat dey pain', 'my throat dey pain', 'pain in my throat', 'hurts to swallow',
    'hard to swallow', 'cannot swallow', "can't swallow", 'tonsils',
  ],

  questions: [
    {
      questionKey: 'presenting_complaint',
      text: 'Sorry to hear that. Can you tell me a bit more about your throat?',
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
      applicability: { all_of: [{ concept: 'age_years', exists: false }] },
      validation: { min: 0, max: 120 },
    },
    {
      questionKey: 'sore_throat_duration',
      text: 'How long has your throat been sore?',
      helpText: 'For example: "since yesterday", "3 days", "about a week".',
      answerType: 'duration',
      factConcept: 'sore_throat_duration_days',
      unit: 'days',
      required: true,
      priority: 25,
      validation: { min: 0, max: 365 },
    },
    {
      // THE DANGER SCREEN — early, so §9's "stop routine assessment" can bite.
      // Every option maps to a red flag sourced in this file's header.
      questionKey: 'throat_danger_screen',
      text: 'Before we go further — is any of this happening?',
      helpText:
        'Unable to swallow at all · drooling, or spitting saliva out because swallowing hurts too much · '
        + 'struggling to breathe · noisy breathing · cannot open the mouth properly · '
        + 'swelling in the neck · voice sounds muffled · very drowsy or hard to wake',
      answerType: 'multi_choice',
      factConcept: 'throat_danger_signs_reported',
      required: true,
      priority: 30,
      choices: [
        { value: 'none', label: 'None of these' },
        { value: 'cannot_swallow', label: 'Unable to swallow at all' },
        { value: 'drooling', label: 'Drooling, or spitting out saliva' },
        { value: 'breathing_difficulty', label: 'Struggling to breathe' },
        { value: 'stridor', label: 'Noisy or whistling breathing' },
        { value: 'trismus', label: 'Cannot open the mouth properly' },
        { value: 'neck_swelling', label: 'Swelling in the neck' },
        { value: 'muffled_voice', label: 'Voice sounds muffled or different' },
        { value: 'impaired_consciousness', label: 'Very drowsy or hard to wake' },
      ],
    },
    {
      questionKey: 'swallowing_ability',
      text: 'How is swallowing right now?',
      answerType: 'single_choice',
      factConcept: 'swallowing_ability',
      required: true,
      priority: 40,
      applicability: { all_of: [{ concept: 'throat_danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'normal', label: 'Normal — just sore' },
        { value: 'painful', label: 'Painful, but I can manage' },
        { value: 'difficult', label: 'Difficult — I am avoiding food or drink' },
      ],
    },
    {
      questionKey: 'sore_throat_severity',
      text: 'On a scale of 1 to 10, how bad is the pain?',
      helpText: '1 = barely noticeable, 10 = the worst you have felt.',
      answerType: 'scale',
      factConcept: 'sore_throat_severity_gauge',
      unit: 'scale_1_10',
      required: true,
      priority: 45,
      applicability: { all_of: [{ concept: 'throat_danger_signs_reported', contains: 'none' }] },
      validation: { min: 1, max: 10 },
    },
    {
      // §12: asked only when fever is not already known, from this run or a
      // fever_assessment run on the same encounter.
      questionKey: 'fever_present',
      text: 'Have you had a fever along with it?',
      answerType: 'boolean',
      factConcept: 'fever_present',
      required: true,
      priority: 50,
      applicability: {
        all_of: [
          { concept: 'throat_danger_signs_reported', contains: 'none' },
          { concept: 'fever_present', exists: false },
        ],
      },
    },
    {
      // §13: same treatment for cough — never asked twice across protocols.
      questionKey: 'cough_present',
      text: 'Do you have a cough as well?',
      answerType: 'boolean',
      factConcept: 'cough_present',
      required: false,
      priority: 55,
      applicability: {
        all_of: [
          { concept: 'throat_danger_signs_reported', contains: 'none' },
          { concept: 'cough_present', exists: false },
        ],
      },
    },
    {
      questionKey: 'associated_symptoms',
      text: 'What else have you noticed?',
      answerType: 'multi_choice',
      factConcept: 'associated_symptoms',
      required: true,
      priority: 60,
      applicability: { all_of: [{ concept: 'throat_danger_signs_reported', contains: 'none' }] },
      choices: [
        { value: 'runny_nose', label: 'Runny or blocked nose' },
        { value: 'hoarseness', label: 'Hoarse voice' },
        { value: 'swollen_glands', label: 'Swollen or tender glands in the neck' },
        { value: 'white_spots', label: 'White spots on the tonsils' },
        { value: 'rash', label: 'A rash' },
        { value: 'headache', label: 'Headache' },
        { value: 'body_aches', label: 'Body aches' },
        { value: 'nausea_vomiting', label: 'Nausea or vomiting' },
        { value: 'ear_pain', label: 'Ear pain' },
        { value: 'none', label: 'Nothing else' },
      ],
    },
    {
      questionKey: 'pregnancy_status',
      text: 'Are you pregnant, or could you be?',
      answerType: 'single_choice',
      factConcept: 'pregnancy_status',
      required: true,
      priority: 65,
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
      // §16: allergy is required BEFORE any medicine could ever be suggested.
      // Asked here so the absence of an answer is visible, not assumed.
      questionKey: 'known_allergies',
      text: 'Do you have any medicine allergies?',
      helpText: 'Especially penicillin or antibiotics, if you know.',
      answerType: 'text',
      factConcept: 'reported_allergies',
      required: true,
      priority: 70,
      applicability: {
        all_of: [
          { concept: 'throat_danger_signs_reported', contains: 'none' },
          { concept: 'reported_allergies', exists: false },
        ],
      },
      validation: { maxLength: 300 },
    },
    {
      // §15: store the words. "I took antibiotics" acquires no name, dose or
      // indication it never had.
      questionKey: 'medication_taken',
      text: 'Have you taken anything for it so far?',
      helpText: 'Whatever you remember is fine — the name, or just what it was.',
      answerType: 'text',
      factConcept: 'self_medication_reported',
      required: false,
      priority: 75,
      applicability: { all_of: [{ concept: 'throat_danger_signs_reported', contains: 'none' }] },
      validation: { maxLength: 500 },
    },
  ],

  /**
   * Red flags. `ref` names which STG section each came from; `sourced: false`
   * marks one that is NOT in any of them.
   */
  redFlags: [
    { key: 'cannot_swallow', name: 'Unable to swallow', ref: 'tonsillitis', sourced: true,
      cite: 'STG Tonsillitis (PDF p121): "the parenteral route may be required when there is vomiting or severe dysphagia" — severe dysphagia marks a presentation oral treatment cannot serve.' },
    { key: 'drooling', name: 'Drooling / unable to handle saliva', ref: 'quinsy', sourced: true,
      cite: 'STG Peritonsillar abscess (PDF p116): "Difficulty in opening mouth for examination; mouth full of saliva".' },
    { key: 'trismus', name: 'Trismus — cannot open the mouth', ref: 'quinsy', sourced: true,
      cite: 'STG Peritonsillar abscess (PDF p116): "Trismus - spread of oedema and infection to pterygoid muscles".' },
    { key: 'neck_swelling', name: 'Neck swelling', ref: 'quinsy', sourced: true,
      cite: 'STG Peritonsillar abscess (PDF p116): parapharyngeal suppuration/abscess listed among complications.' },
    { key: 'breathing_difficulty', name: 'Difficulty breathing', ref: 'airway_fb', sourced: true,
      cite: 'STG Foreign bodies in the airways (printed p82): "acute upper respiratory tract obstruction with difficulty in breathing and stridor". NOTE: documented for foreign bodies, NOT throat infection — applicability REQUIRES_REVIEW.' },
    { key: 'stridor', name: 'Stridor — noisy breathing', ref: 'airway_fb', sourced: true,
      cite: 'STG Foreign bodies in the airways (printed p82): "In severe cases, stridor, severe cyanosis and imminent asphyxia". NOTE: foreign-body context — applicability REQUIRES_REVIEW.' },
    { key: 'muffled_voice', name: 'Muffled voice with sore throat', ref: null, sourced: false,
      cite: 'NOT in any STG section reviewed for this protocol. Included as an escalation-only trigger because it commonly accompanies the abscess picture STG does describe. REQUIRES_REVIEW.' },
    { key: 'impaired_consciousness', name: 'Impaired consciousness', ref: null, sourced: false,
      cite: 'NOT specific to any STG throat section. A general danger sign; escalation-only. REQUIRES_REVIEW.' },
  ],

  escalationRules: [
    { trigger: 'any throat danger sign reported', priority: 'urgent', action: 'URGENT_REFERRAL', cite: 'STG quinsy / airway obstruction features' },
    { trigger: 'infant under 1 year', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'Outside any approved self-care pathway' },
    { trigger: 'pregnant or possibly pregnant', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'No approved sore-throat pathway covers pregnancy' },
    { trigger: 'swallowing difficult — avoiding food or drink', priority: 'high', action: 'PHARMACIST_REVIEW', cite: 'STG Tonsillitis (PDF p121) treats severe dysphagia as a route-changing feature' },
    { trigger: 'patient requests antibiotics', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'A request is not an indication. STG gates its antibiotic behind examination findings unobtainable here — see module header.' },
    { trigger: 'sore throat 14 days or more', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: 'STG Pharyngitis (PDF p117) lists pharyngeal or laryngeal tumour among differentials for persistent sore throat. ROUTING only — no diagnosis implied.' },
    { trigger: 'allergy information required but unknown', priority: 'medium', action: 'PHARMACIST_REVIEW', cite: '§16 — absence of allergy information must never be read as absence of allergy' },
    { trigger: 'assessment complete, no danger signs', priority: 'low', action: 'PHARMACIST_REVIEW', cite: 'Nothing is approved for delivery yet — a human closes every run' },
  ],

  protocolTransitions: [
    { target: 'fever_assessment', targetVersion: '2.0.0', when: 'fever reported and fever facts not already collected', requires: ['target protocol ACTIVE'],
      note: 'The fever protocol owns fever questions and the malaria-relevance judgement. Sore throat + fever does NOT imply malaria, and no malaria logic is duplicated here (§14).' },
    { target: 'cough_assessment', targetVersion: '1.0.0', when: 'cough reported and cough facts not already collected', requires: ['target protocol ACTIVE'],
      note: 'Cough questions belong to the cough protocol. Cough + sore throat does NOT imply bacterial infection (§13).' },
  ],

  /**
   * Authored as DRAFT so the reasoning is visible and reviewable. Neither is
   * deliverable: the source is unapproved, and their evidence_status values
   * are below the gate's bar in any case.
   */
  recommendationRules: [
    {
      recommendationKey: 'stg_supportive_hydration_gargle',
      recommendationType: 'self_care_advice',
      recommendationText:
        'Sip fluids regularly to stay hydrated, and gargling with warm salty water may ease the soreness. '
        + 'If swallowing becomes difficult, you start drooling, or breathing changes, seek care straight away.',
      ref: 'tonsillitis',
      evidenceStatus: 'limited_support',
      autonomousScope: false,
      rationale:
        'STG Tonsillitis non-drug treatment: "Oral hydration. Salt/warm water gurgle." Harmless whatever '
        + 'the cause. LIMITED_SUPPORT rather than supported because STG states it for TONSILLITIS and this '
        + 'protocol applies it to undifferentiated sore throat — weaker support than the section carries '
        + 'for the diagnosis it was written about.',
    },
    {
      recommendationKey: 'stg_tonsillitis_antibiotic_not_reachable',
      recommendationType: 'seek_pharmacist',
      recommendationText:
        'A pharmacist needs to look at this before any antibiotic could be considered.',
      ref: 'tonsillitis',
      evidenceStatus: 'not_supported',
      autonomousScope: false,
      rationale:
        'STG DOES specify amoxicillin for tonsillitis — but conditions it on examination findings '
        + '("tonsils swollen, inflamed and covered with purulent exudates"; "jugulo-digastric lymph nodes '
        + 'enlarged and tender") that cannot be obtained over WhatsApp. NOT_SUPPORTED records that the rule '
        + 'exists in the source and is unreachable on this channel — deliberately visible rather than absent.',
    },
  ],

  recommendationBoundaries: {
    permitted: ['PATIENT_INFORMATION', 'CLINICAL_ASSESSMENT', 'PHARMACIST_REVIEW', 'URGENT_REFERRAL'],
    forbidden: ['MEDICATION_RECOMMENDATION'],
    reason:
      'Sore throat is a symptom. STG authorises antibiotics for TONSILLITIS on examination findings this '
      + 'channel cannot obtain, so no antibiotic is reachable — the source sets that limit, not this file. '
      + 'A request for antibiotics is not an indication (§10).',
  },
});

async function canTransitionTo(pharmacyId, slug) {
  const protocols = require('../clinicalProtocolService');
  const active = await protocols.getActiveProtocol(pharmacyId, slug);
  if (!active) return { allowed: false, reason: `${slug}_not_active` };
  return { allowed: true, reason: 'ok', protocolId: active.id, version: active.version };
}

/** Install and activate. Idempotent. Recommendations are created DRAFT and are not deliverable. */
async function install(pharmacyId, { actorType = 'system', actorId = null } = {}) {
  const protocols = require('../clinicalProtocolService');
  const evidenceSvc = require('../evidenceService');
  const recommendations = require('../recommendationService');

  const existing = await protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
  if (existing) return existing;

  // Evidence source — draft. install() cannot approve it: approveSource
  // refuses a non-human actor.
  let source;
  try {
    source = await evidenceSvc.createSource(pharmacyId, {
      sourceKey: EVIDENCE_SOURCE.sourceKey, title: EVIDENCE_SOURCE.title,
      publisher: EVIDENCE_SOURCE.publisher, origin: EVIDENCE_SOURCE.origin,
      strength: EVIDENCE_SOURCE.strength, version: EVIDENCE_SOURCE.version,
      locator: EVIDENCE_SOURCE.locator,
    }, { actorType, actorId });
  } catch (e) {
    if (e.code !== 'DUPLICATE_VERSION' && e.code !== '23505') throw e;
    source = await evidenceSvc.getSourceByKey(pharmacyId, EVIDENCE_SOURCE.sourceKey, EVIDENCE_SOURCE.version);
  }

  const refIds = {};
  for (const ref of EVIDENCE_SOURCE.references) {
    const created = await evidenceSvc.addReference(pharmacyId, source.id, {
      section: ref.section, summary: ref.summary, population: ref.population,
    }, { actorType, actorId });
    refIds[ref.key] = created.id;
  }

  const protocol = await protocols.createProtocol(pharmacyId, {
    slug: DEFINITION.slug, name: DEFINITION.name, version: DEFINITION.version,
    description: DEFINITION.description, conditionDomain: DEFINITION.conditionDomain,
    population: DEFINITION.population, source: DEFINITION.source,
    sourceReference: DEFINITION.sourceReference,
    requiredInformation: DEFINITION.questions.filter((q) => q.required).map((q) => q.factConcept),
    permittedAdvice: [],
    referralRules: DEFINITION.escalationRules,
    pharmacistReviewRules: DEFINITION.protocolTransitions,
    exclusionCriteria: [
      { rule: 'A request for antibiotics is not an indication (§10)' },
      { rule: "STG's antibiotic rule requires examination findings unobtainable over this channel" },
      { rule: 'Allergy information must be present before any medicine could be considered (§16)' },
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
        : `Escalation-only trigger, not drawn from the source. ${rf.cite}`,
      severity: 'emergency', action: 'emergency_referral',
      // See 0036 / redFlagEvaluator. rf.key is a choice value of this
      // protocol's danger screen, so a ticked box fires exactly one rule.
      triggerConcept: 'throat_danger_signs_reported',
      triggerValue: rf.key,
      source: 'Nigeria Standard Treatment Guidelines 2022',
      sourceReference: rf.cite,
    }, { actorType, actorId });
    await protocols.setRedFlagActive(pharmacyId, created.id, true, { actorType, actorId });
  }

  // Draft recommendations. Neither is deliverable — the source is unapproved,
  // and limited_support / not_supported are below the gate's bar regardless.
  for (const rule of DEFINITION.recommendationRules) {
    await recommendations.createRecommendation(pharmacyId, protocol.id, {
      recommendationKey: rule.recommendationKey,
      recommendationType: rule.recommendationType,
      recommendationText: rule.recommendationText,
      evidenceReferenceId: refIds[rule.ref],
      evidenceStatus: rule.evidenceStatus,
      autonomousScope: rule.autonomousScope,
      status: 'draft',
    }, { actorType, actorId });
  }

  await protocols.activateProtocol(pharmacyId, protocol.id, { actorType, actorId });
  return protocols.getProtocolVersion(pharmacyId, SLUG, VERSION);
}

module.exports = {
  SLUG, VERSION, DEFINITION, EVIDENCE_SOURCE, POPULATIONS,
  derivePopulations, canTransitionTo, install,
};
