/**
 * Protocol and red-flag-rule METADATA. Stage 1 only — see 0029's migration
 * header. Every function here manages a LABEL, a VERSION, and an on/off
 * switch. None of them decide what a protocol says, because nothing yet
 * has anything to say: `required_information`, `questions`,
 * `exclusion_criteria`, `pharmacist_review_rules`, `referral_rules` and
 * `permitted_advice` are accepted as opaque jsonb and stored as given,
 * never interpreted here. That interpretation is a later stage's job,
 * under clinical governance this module has no part in.
 *
 * VERSIONING IS NOT OPTIONAL
 * A protocol identity is (pharmacy_id, slug, version) — creating "fever"
 * again under an existing version is an error, not an overwrite (spec §9:
 * an old encounter must keep meaning what it meant when it happened).
 * Retiring a version does not delete it, for the same reason.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordAdminAudit } = require('./clinicalAudit');

const SLUG_RE = /^[a-z0-9_]+$/;
// Semver-shaped, per Stage 2 §1. Stage 1 used major.minor; 0032 migrated
// existing rows to `x.y.0` before tightening the DB constraint to match.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SEVERITIES = new Set(['review', 'urgent', 'emergency']);
const ACTIONS = new Set(['pharmacist_review', 'urgent_referral', 'emergency_referral']);

const PROTOCOL_FIELDS = `
  id, pharmacy_id, slug, name, description, condition_domain, version, status,
  source, source_reference, effective_date, review_date, population,
  required_information, questions, exclusion_criteria,
  pharmacist_review_rules, referral_rules, permitted_advice,
  created_at, updated_at
`;

function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    const err = new Error('slug must be lowercase letters, numbers and underscores only.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
}
function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    const err = new Error('version must look like "1.0.0" (major.minor.patch).');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
}

/**
 * @param {object} args  name (required), slug (required), version (required),
 *   everything else optional and stored as opaque metadata — see header.
 */
async function createProtocol(pharmacyId, args = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  assertSlug(args.slug);
  assertVersion(args.version);
  const name = String(args.name || '').trim();
  if (!name || name.length > 120) {
    const err = new Error('name must be between 1 and 120 characters.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  const db = getSql();
  let row;
  try {
    [row] = await db`
      insert into clinical_protocols (
        pharmacy_id, slug, name, description, condition_domain, version,
        source, source_reference, effective_date, review_date, population,
        required_information, questions, exclusion_criteria,
        pharmacist_review_rules, referral_rules, permitted_advice
      ) values (
        ${pharmacyId}, ${args.slug}, ${name}, ${args.description || null},
        ${args.conditionDomain || null}, ${args.version},
        ${args.source || null}, ${args.sourceReference || null},
        ${args.effectiveDate || null}, ${args.reviewDate || null}, ${args.population || null},
        ${db.json(args.requiredInformation || [])}, ${db.json(args.questions || [])},
        ${db.json(args.exclusionCriteria || [])}, ${db.json(args.pharmacistReviewRules || [])},
        ${db.json(args.referralRules || [])}, ${db.json(args.permittedAdvice || [])}
      )
      returning ${db.unsafe(PROTOCOL_FIELDS)}
    `;
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error(`Protocol "${args.slug}" version ${args.version} already exists.`);
      err.status = 409; err.code = 'DUPLICATE_VERSION';
      throw err;
    }
    throw e;
  }

  await recordAdminAudit({
    pharmacyId, action: 'protocol_created', actorType, actorId,
    entity: 'clinical_protocol', entityId: row.id,
    meta: { slug: row.slug, version: row.version },
  });

  return row;
}

/** The active version of a protocol, if one exists. */
async function getActiveProtocol(pharmacyId, slug) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(PROTOCOL_FIELDS)} from clinical_protocols
    where pharmacy_id = ${pharmacyId} and slug = ${slug} and status = 'active'
    order by version desc limit 1
  `;
  return row || null;
}

/** One exact version, regardless of its current status — for an old encounter that references it (spec §9). */
async function getProtocolVersion(pharmacyId, slug, version) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(PROTOCOL_FIELDS)} from clinical_protocols
    where pharmacy_id = ${pharmacyId} and slug = ${slug} and version = ${version}
  `;
  return row || null;
}

async function listProtocols(pharmacyId, { slug = null, status = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const rows = await db`
    select ${db.unsafe(PROTOCOL_FIELDS)} from clinical_protocols
    where pharmacy_id = ${pharmacyId}
      ${slug ? db`and slug = ${slug}` : db``}
      ${status ? db`and status = ${status}` : db``}
    order by slug, version desc
  `;
  return rows;
}

/**
 * Move a protocol version to 'active', demoting whichever version of the
 * same slug was active before it to 'deprecated'.
 *
 * THIS REVERSES A STAGE 1 DECISION, DELIBERATELY. 0029 allowed two versions
 * of a slug to be active at once, on the grounds that silently retiring the
 * incumbent was a policy call an infrastructure stage should not make.
 * Stage 2 makes that call explicitly: one ACTIVE version per identity. Both
 * writes happen in one transaction because the partial unique index
 * (clinical_protocols_one_active_idx) would otherwise reject the second —
 * correctly, but with a constraint error instead of an orderly handover.
 *
 * Deprecated, NOT retired: historical encounters still reference this
 * version and must keep resolving it (spec §1). Retirement is a separate,
 * deliberate act.
 */
async function activateProtocol(pharmacyId, protocolId, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [target] = await db`
    select id, slug, version, status from clinical_protocols
    where id = ${protocolId} and pharmacy_id = ${pharmacyId}
  `;
  if (!target) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  assertLifecycleTransition(target.status, 'active');

  const demoted = await db.begin(async (tx) => {
    const previous = await tx`
      update clinical_protocols set status = 'deprecated', updated_at = now()
      where pharmacy_id = ${pharmacyId} and slug = ${target.slug}
        and status = 'active' and id <> ${protocolId}
      returning id, version
    `;
    await tx`
      update clinical_protocols set status = 'active', updated_at = now()
      where id = ${protocolId} and pharmacy_id = ${pharmacyId}
    `;
    return previous;
  });

  for (const prev of demoted) {
    await recordAdminAudit({
      pharmacyId, action: 'protocol_deprecated', actorType, actorId,
      entity: 'clinical_protocol', entityId: prev.id,
      meta: { slug: target.slug, version: prev.version, supersededBy: target.version },
    });
  }
  await recordAdminAudit({
    pharmacyId, action: 'protocol_activated', actorType, actorId,
    entity: 'clinical_protocol', entityId: protocolId,
    meta: { slug: target.slug, version: target.version, deprecated: demoted.map((d) => d.version) },
  });

  return getProtocolVersion(pharmacyId, target.slug, target.version);
}

/**
 * Legal lifecycle moves. draft -> active -> deprecated -> retired, plus the
 * ability to retire something that never shipped and to bring a deprecated
 * version back if a rollout is reversed.
 *
 * Enforced in application code as spec §1 requires — a check constraint can
 * police the VALUE but not the TRANSITION, and "retired went straight back
 * to active without anyone re-reviewing it" is exactly the move that needs
 * to be impossible.
 */
const LIFECYCLE = Object.freeze({
  draft: ['active', 'retired'],
  active: ['deprecated', 'retired'],
  deprecated: ['active', 'retired'],
  retired: [],
});

function assertLifecycleTransition(from, to) {
  if (from === to) return;
  if (!LIFECYCLE[from] || !LIFECYCLE[from].includes(to)) {
    const err = new Error(`Cannot move a protocol from ${from} to ${to}.`);
    err.status = 409; err.code = 'ILLEGAL_LIFECYCLE_TRANSITION';
    throw err;
  }
}

async function retireProtocol(pharmacyId, protocolId, { actorType = 'pharmacist', actorId = null } = {}) {
  return setProtocolStatus(pharmacyId, protocolId, 'retired', 'protocol_retired', { actorType, actorId });
}

/** Deprecate without promoting a replacement — a version pulled from use. */
async function deprecateProtocol(pharmacyId, protocolId, { actorType = 'pharmacist', actorId = null } = {}) {
  return setProtocolStatus(pharmacyId, protocolId, 'deprecated', 'protocol_deprecated', { actorType, actorId });
}

async function setProtocolStatus(pharmacyId, protocolId, status, action, { actorType, actorId }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  // Read-then-check-then-write: the lifecycle rule (spec §1) lives in code,
  // so the current status has to be known before the write is attempted.
  const [current] = await db`
    select status from clinical_protocols where id = ${protocolId} and pharmacy_id = ${pharmacyId}
  `;
  if (!current) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  assertLifecycleTransition(current.status, status);

  const [row] = await db`
    update clinical_protocols set status = ${status}, updated_at = now()
    where id = ${protocolId} and pharmacy_id = ${pharmacyId}
    returning ${db.unsafe(PROTOCOL_FIELDS)}
  `;
  if (!row) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  await recordAdminAudit({
    pharmacyId, action, actorType, actorId,
    entity: 'clinical_protocol', entityId: row.id,
    meta: { slug: row.slug, version: row.version },
  });
  return row;
}

// ---------------------------------------------------------------------------
// red-flag rules — metadata only, `active` defaults false (see 0029 header)
// ---------------------------------------------------------------------------

async function createRedFlagRule(pharmacyId, protocolId, args = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const name = String(args.name || '').trim();
  if (!name || name.length > 200) {
    const err = new Error('name must be between 1 and 200 characters.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  const severity = args.severity || 'review';
  const action = args.action || 'pharmacist_review';
  if (!SEVERITIES.has(severity)) {
    const err = new Error(`severity must be one of ${[...SEVERITIES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!ACTIONS.has(action)) {
    const err = new Error(`action must be one of ${[...ACTIONS].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  const db = getSql();
  const [protocol] = await db`select id from clinical_protocols where id = ${protocolId} and pharmacy_id = ${pharmacyId}`;
  if (!protocol) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }

  // triggerConcept/triggerValue are what make a rule evaluable (0036).
  // Without them the rule is stored but inert — redFlagEvaluator will never
  // fire it, and will report it as unconfigured rather than escalating.
  const [row] = await db`
    insert into protocol_red_flags
      (pharmacy_id, protocol_id, name, description, severity, action, source, source_reference,
       trigger_concept, trigger_value)
    values
      (${pharmacyId}, ${protocolId}, ${name}, ${args.description || null}, ${severity}, ${action},
       ${args.source || null}, ${args.sourceReference || null},
       ${args.triggerConcept || null}, ${args.triggerValue || null})
    returning id, protocol_id, name, description, severity, action, active, source, source_reference,
              trigger_concept, trigger_value, created_at, updated_at
  `;

  // NOTE: 'action' here is the outer rule field (pharmacist_review/etc) —
  // the audit call below uses its OWN action string as an object key, not
  // this variable, to avoid the two meanings colliding.
  await recordAdminAudit({
    pharmacyId, action: 'red_flag_rule_created', actorType, actorId,
    entity: 'red_flag_rule', entityId: row.id,
    meta: { protocolId, name },
  });

  return row;
}

async function setRedFlagActive(pharmacyId, ruleId, active, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    update protocol_red_flags set active = ${active}, updated_at = now()
    where id = ${ruleId} and pharmacy_id = ${pharmacyId}
    returning id, protocol_id, name, active
  `;
  if (!row) {
    const err = new Error('Red-flag rule not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  await recordAdminAudit({
    pharmacyId, action: active ? 'red_flag_rule_activated' : 'red_flag_rule_deactivated',
    actorType, actorId,
    entity: 'red_flag_rule', entityId: row.id,
    meta: { name: row.name },
  });
  return row;
}

async function listRedFlagsForProtocol(pharmacyId, protocolId, { activeOnly = false } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select id, protocol_id, name, description, severity, action, active, source, source_reference, created_at, updated_at
    from protocol_red_flags
    where pharmacy_id = ${pharmacyId} and protocol_id = ${protocolId}
      ${activeOnly ? db`and active = true` : db``}
    order by created_at
  `;
}

// ---------------------------------------------------------------------------
// protocol questions (Stage 2 §3)
// ---------------------------------------------------------------------------

const ANSWER_TYPES = new Set([
  'text', 'number', 'boolean', 'date', 'duration', 'scale', 'single_choice', 'multi_choice',
]);

/**
 * Attach a question to a protocol VERSION.
 *
 * Only callable with a draft protocol. Once a version is active, its
 * question set is frozen — that is what makes an encounter's recorded
 * version mean something (spec §1: never mutate an active protocol in a way
 * that changes the historical meaning of an existing encounter). A new
 * question is a new version.
 */
async function addQuestion(pharmacyId, protocolId, spec = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [protocol] = await db`
    select id, slug, version, status from clinical_protocols
    where id = ${protocolId} and pharmacy_id = ${pharmacyId}
  `;
  if (!protocol) {
    const err = new Error('Protocol not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  if (protocol.status !== 'draft') {
    const err = new Error(
      `Cannot add a question to a ${protocol.status} protocol. `
      + 'A published version is immutable — publish a new version instead.'
    );
    err.status = 409; err.code = 'PROTOCOL_NOT_EDITABLE';
    throw err;
  }

  if (!ANSWER_TYPES.has(spec.answerType)) {
    const err = new Error(`answer_type must be one of ${[...ANSWER_TYPES].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!/^[a-z0-9_]+$/.test(spec.questionKey || '')) {
    const err = new Error('question_key must be lowercase letters, numbers and underscores.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!/^[a-z0-9_]+$/.test(spec.factConcept || '')) {
    const err = new Error('fact_concept must be lowercase letters, numbers and underscores.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  const [row] = await db`
    insert into protocol_questions
      (pharmacy_id, protocol_id, question_key, text, help_text, answer_type,
       fact_concept, unit, required, priority, validation, applicability, choices)
    values
      (${pharmacyId}, ${protocolId}, ${spec.questionKey}, ${spec.text}, ${spec.helpText || null},
       ${spec.answerType}, ${spec.factConcept}, ${spec.unit || null},
       ${spec.required !== false}, ${spec.priority ?? 100},
       ${db.json(spec.validation || {})}, ${db.json(spec.applicability || {})},
       ${db.json(spec.choices || [])})
    returning *
  `;

  await recordAdminAudit({
    pharmacyId, action: 'protocol_question_created', actorType, actorId,
    entity: 'protocol_question', entityId: row.id,
    meta: { slug: protocol.slug, version: protocol.version, questionKey: row.question_key },
  });

  return row;
}

/** Every question for a protocol version, in deterministic execution order. */
async function listQuestions(pharmacyId, protocolId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select * from protocol_questions
    where pharmacy_id = ${pharmacyId} and protocol_id = ${protocolId}
    order by priority, question_key
  `;
}

module.exports = {
  createProtocol, getActiveProtocol, getProtocolVersion, listProtocols,
  activateProtocol, deprecateProtocol, retireProtocol, assertLifecycleTransition, LIFECYCLE,
  createRedFlagRule, setRedFlagActive, listRedFlagsForProtocol,
  addQuestion, listQuestions, ANSWER_TYPES,
};
