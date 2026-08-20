/**
 * Approved clinical sources and the specific passages recommendations cite.
 *
 * THE INGESTION BOUNDARY (spec §11)
 * A document arriving in this system is `draft` and stays `draft` until a
 * person approves it. Nothing about being uploaded, parsed, or summarised by
 * a model advances that status — approveSource() is the only path, it
 * requires a human actor, and until it runs the source cannot back a
 * recommendation (the gate's evidence_approved check fails).
 *
 * That is the structural answer to "documents must not be dumped into a
 * prompt and treated as medical truth": the prompt is not a path to
 * approval, and approval is the only path to use.
 *
 * NO CONTENT IS AUTHORED HERE. This service records that a document exists,
 * who published it, which version, and which section a recommendation
 * relies on. It never derives clinical claims from a document, and nothing
 * in this file reads document text.
 */

const { getSql, assertPharmacyId } = require('../db');
const { recordAdminAudit } = require('./clinicalAudit');
const { STRENGTH_RANK, ORIGIN_PRECEDENCE, strengthMeets } = require('./safetyGate');

const ORIGINS = new Set(ORIGIN_PRECEDENCE);
const STRENGTHS = new Set(STRENGTH_RANK);

const SOURCE_FIELDS = `
  id, pharmacy_id, source_key, title, publisher, origin, strength, version,
  published_date, review_date, locator, status, approved_by, approved_at,
  created_at, updated_at
`;

/**
 * Register a source. Always lands as `draft` — the status argument is
 * deliberately not accepted, so there is no way to create an
 * already-approved source in one call.
 */
async function createSource(pharmacyId, args = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  if (!/^[a-z0-9_]+$/.test(args.sourceKey || '')) {
    const err = new Error('source_key must be lowercase letters, numbers and underscores.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!ORIGINS.has(args.origin)) {
    const err = new Error(`origin must be one of ${[...ORIGINS].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!STRENGTHS.has(args.strength)) {
    const err = new Error(`strength must be one of ${[...STRENGTHS].join(', ')}.`);
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }
  if (!args.version) {
    const err = new Error('version is required — an unversioned source cannot be cited reproducibly.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  let row;
  try {
    [row] = await db`
      insert into evidence_sources
        (pharmacy_id, source_key, title, publisher, origin, strength, version,
         published_date, review_date, locator)
      values
        (${pharmacyId}, ${args.sourceKey}, ${args.title}, ${args.publisher || null},
         ${args.origin}, ${args.strength}, ${args.version},
         ${args.publishedDate || null}, ${args.reviewDate || null}, ${args.locator || null})
      returning ${db.unsafe(SOURCE_FIELDS)}
    `;
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error(`Evidence source "${args.sourceKey}" version ${args.version} already exists.`);
      err.status = 409; err.code = 'DUPLICATE_SOURCE';
      throw err;
    }
    throw e;
  }

  await recordAdminAudit({
    pharmacyId, action: 'evidence_source_created', actorType, actorId,
    entity: 'evidence_source', entityId: row.id,
    meta: { sourceKey: row.source_key, version: row.version, origin: row.origin, strength: row.strength },
  });
  return row;
}

/**
 * One exact source version, by its stable key — the evidence-side twin of
 * clinicalProtocolService.getProtocolVersion. Returns whatever status the
 * row has (draft included); callers that need an APPROVED source must check
 * status themselves, exactly as the safety gate does.
 */
async function getSourceByKey(pharmacyId, sourceKey, version) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(SOURCE_FIELDS)} from evidence_sources
    where pharmacy_id = ${pharmacyId} and source_key = ${sourceKey} and version = ${version}
  `;
  return row || null;
}

/**
 * A person approves a source for use. The ONLY route from draft to active,
 * and it refuses a non-human actor — an automated pipeline may ingest and
 * propose, never approve.
 */
async function approveSource(pharmacyId, sourceId, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  if (actorType !== 'pharmacist' && actorType !== 'staff') {
    const err = new Error('Only a pharmacist or staff member may approve an evidence source.');
    err.status = 403; err.code = 'FORBIDDEN';
    throw err;
  }
  const db = getSql();
  const [row] = await db`
    update evidence_sources
    set status = 'active', approved_by = ${actorId}, approved_at = now(), updated_at = now()
    where id = ${sourceId} and pharmacy_id = ${pharmacyId} and status = 'draft'
    returning ${db.unsafe(SOURCE_FIELDS)}
  `;
  if (!row) {
    const err = new Error('Draft evidence source not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  await recordAdminAudit({
    pharmacyId, action: 'evidence_source_approved', actorType, actorId,
    entity: 'evidence_source', entityId: row.id,
    meta: { sourceKey: row.source_key, version: row.version },
  });
  return row;
}

async function getSource(pharmacyId, sourceId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select ${db.unsafe(SOURCE_FIELDS)} from evidence_sources
    where id = ${sourceId} and pharmacy_id = ${pharmacyId}
  `;
  return row || null;
}

/** Cite a specific passage. The unit a recommendation actually points at. */
async function addReference(pharmacyId, sourceId, args = {}, { actorType = 'pharmacist', actorId = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const source = await getSource(pharmacyId, sourceId);
  if (!source) {
    const err = new Error('Evidence source not found.');
    err.status = 404; err.code = 'NOT_FOUND';
    throw err;
  }
  if (!args.section) {
    const err = new Error('section is required — a whole-document citation is not traceable.');
    err.status = 400; err.code = 'INVALID_FIELD';
    throw err;
  }

  const [row] = await db`
    insert into evidence_references (pharmacy_id, source_id, section, summary, population, locator)
    values (${pharmacyId}, ${sourceId}, ${args.section}, ${args.summary || null},
            ${args.population || null}, ${args.locator || null})
    returning *
  `;
  await recordAdminAudit({
    pharmacyId, action: 'evidence_reference_created', actorType, actorId,
    entity: 'evidence_reference', entityId: row.id,
    meta: { sourceKey: source.source_key, section: row.section },
  });
  return row;
}

/** A reference with its source, as the gate expects it: {source, reference}. */
async function resolveReference(pharmacyId, referenceId) {
  assertPharmacyId(pharmacyId);
  if (!referenceId) return null;
  const db = getSql();
  const [row] = await db`
    select r.id as ref_id, r.section, r.summary, r.population, r.locator as ref_locator,
           ${db.unsafe(SOURCE_FIELDS.split(',').map((f) => `s.${f.trim()}`).join(', '))}
    from evidence_references r
    join evidence_sources s on s.id = r.source_id
    where r.id = ${referenceId} and r.pharmacy_id = ${pharmacyId}
  `;
  if (!row) return null;
  const { ref_id: refId, section, summary, population, ref_locator: refLocator, ...source } = row;
  return { reference: { id: refId, section, summary, population, locator: refLocator }, source };
}

/**
 * Choose between competing sources for the same claim.
 *
 * Strength first — a stronger source wins outright. Origin breaks ties, with
 * Nigerian guidance ahead of generic international guidance (spec §10),
 * because guidance written for this population reflects local resistance
 * patterns and what a Nigerian pharmacy can actually dispense.
 *
 * Origin NEVER rescues a source that failed the strength requirement; it
 * only orders sources that already qualify.
 */
function preferSource(sources = [], { strengthRank = STRENGTH_RANK } = {}) {
  const usable = sources.filter((s) => s && s.status === 'active');
  if (usable.length === 0) return null;
  return usable.slice().sort((a, b) => {
    const sa = strengthRank.indexOf(a.strength);
    const sb = strengthRank.indexOf(b.strength);
    if (sa !== sb) return sa - sb;
    return ORIGIN_PRECEDENCE.indexOf(a.origin) - ORIGIN_PRECEDENCE.indexOf(b.origin);
  })[0];
}

module.exports = {
  createSource, approveSource, getSource, getSourceByKey, addReference, resolveReference, preferSource,
  strengthMeets, STRENGTH_RANK, ORIGIN_PRECEDENCE,
};
