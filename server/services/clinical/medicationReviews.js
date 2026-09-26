/**
 * The pharmacist's medication review: starting one, saving it, signing it,
 * and reading what was found.
 *
 * ONE REVIEW IS THREE TABLES (0056) and one transaction. Problems and
 * interventions are written with the review they belong to, never separately,
 * so a half-saved review — findings with no interventions, or interventions
 * pointing at problems that were not stored — cannot exist.
 *
 * SAVING REPLACES THE FINDINGS. A review being written is edited as a whole:
 * the form sends the problems and interventions it currently holds, and this
 * replaces them. Merging would leave a problem the pharmacist had removed
 * still in the record, which on this screen means a finding nobody stands
 * behind.
 *
 * A SIGNED REVIEW IS NOT EDITED. It is the record of a professional act. A
 * later correction is a new review — which is also how the history reads
 * honestly, rather than as though the pharmacist had always thought the
 * second thing.
 *
 * EVERY QUERY IS SCOPED BY pharmacy_id IN ITS OWN WHERE CLAUSE — GOLDEN-001.
 */

const { getSql, assertPharmacyId } = require('../db');

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function shapeReview(row, problems = [], actions = []) {
  return {
    id: row.id,
    reviewedOn: row.reviewed_on,
    reviewer: row.reviewer_id ? { id: row.reviewer_id, email: row.reviewer_email || null } : null,
    adherence: row.adherence,
    adherenceNotes: row.adherence_notes,
    notes: row.notes,
    outcome: row.outcome,
    followUpOn: row.follow_up_on,
    followUpReason: row.follow_up_reason,
    followUpNotes: row.follow_up_notes,
    status: row.status,
    signedAt: row.signed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    problems,
    actions,
  };
}

const REVIEW_SELECT = `
  r.id, r.reviewed_on::text as reviewed_on, r.reviewer_id, r.adherence, r.adherence_notes,
  r.notes, r.outcome, r.follow_up_on::text as follow_up_on, r.follow_up_reason,
  r.follow_up_notes, r.status, r.signed_at, r.created_at, r.updated_at,
  u.email as reviewer_email
`;

/** The problems and interventions of a set of reviews, in one round trip. */
async function findingsFor(sql, pharmacyId, reviewIds) {
  if (!reviewIds.length) return { problems: new Map(), actions: new Map() };
  const [problemRows, actionRows] = await Promise.all([
    sql`
      select p.id, p.review_id, p.problem, p.journey_id, p.notes, j.medicine_name
      from medication_review_problems p
      left join medication_journeys j on j.id = p.journey_id and j.pharmacy_id = ${pharmacyId}
      where p.pharmacy_id = ${pharmacyId} and p.review_id = any(${reviewIds})
      order by p.position, p.created_at, p.id
    `,
    sql`
      select id, review_id, problem_id, action, notes
      from medication_review_actions
      where pharmacy_id = ${pharmacyId} and review_id = any(${reviewIds})
      order by position, created_at, id
    `,
  ]);

  const problems = new Map();
  for (const r of problemRows) {
    if (!problems.has(r.review_id)) problems.set(r.review_id, []);
    problems.get(r.review_id).push({
      id: r.id,
      problem: r.problem,
      journeyId: r.journey_id,
      // The medicine's name travels with the problem so a review reads
      // without the caller joining back to the medication list.
      medicineName: r.medicine_name || null,
      notes: r.notes,
    });
  }
  const actions = new Map();
  for (const r of actionRows) {
    if (!actions.has(r.review_id)) actions.set(r.review_id, []);
    actions.get(r.review_id).push({
      id: r.id, action: r.action, problemId: r.problem_id, notes: r.notes,
    });
  }
  return { problems, actions };
}

/** This patient's reviews, newest first. */
async function listReviews(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  // The same empty answer as a patient with no reviews: a caller must not be
  // able to tell "not yours" from "nothing here".
  if (!customer) return { reviews: [] };

  const rows = await sql`
    select ${sql.unsafe(REVIEW_SELECT)}
    from medication_reviews r
    left join auth.users u on u.id = r.reviewer_id
    where r.pharmacy_id = ${pharmacyId} and r.customer_id = ${customerId}
    order by r.reviewed_on desc, r.created_at desc
  `;
  const { problems, actions } = await findingsFor(sql, pharmacyId, rows.map((r) => r.id));
  return {
    reviews: rows.map((r) => shapeReview(r, problems.get(r.id) || [], actions.get(r.id) || [])),
  };
}

async function getReview(pharmacyId, customerId, id, { sql = null } = {}) {
  assertPharmacyId(pharmacyId);
  const db = sql || getSql();
  const [row] = await db`
    select ${db.unsafe(REVIEW_SELECT)}
    from medication_reviews r
    left join auth.users u on u.id = r.reviewer_id
    where r.id = ${id} and r.pharmacy_id = ${pharmacyId} and r.customer_id = ${customerId}
  `;
  if (!row) throw httpError(404, 'NOT_FOUND', 'Medication review not found.');
  const { problems, actions } = await findingsFor(db, pharmacyId, [row.id]);
  return shapeReview(row, problems.get(row.id) || [], actions.get(row.id) || []);
}

/**
 * Start one. A draft, so the pharmacist can work through the medicines and
 * come back to it — a review is a conversation, not a form submission.
 *
 * ONE OPEN DRAFT PER PATIENT. Two drafts would be two half-records of the
 * same sitting, and neither would be the review.
 */
async function startReview(pharmacyId, customerId, { actorId = null, today = null } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  const [customer] = await sql`
    select id from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!customer) throw httpError(404, 'NOT_FOUND', 'Patient not found.');

  const [open] = await sql`
    select id from medication_reviews
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId} and status = 'draft'
    order by created_at desc limit 1
  `;
  // Hand back the draft they already have rather than refusing: a pharmacist
  // who clicked "start" twice wants the review they were writing.
  if (open) return getReview(pharmacyId, customerId, open.id);

  const [row] = await sql`
    insert into medication_reviews ${sql({
    pharmacy_id: pharmacyId,
    customer_id: customerId,
    reviewer_id: actorId,
    ...(today ? { reviewed_on: today } : {}),
  })}
    returning id
  `;
  return getReview(pharmacyId, customerId, row.id);
}

/**
 * Save a draft, or sign it.
 *
 * @param {{ sign?: boolean }} opts
 */
async function saveReview(pharmacyId, customerId, id, fields, { actorId = null, sign = false } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();

  return sql.begin(async (tx) => {
    const [before] = await tx`
      select id, status from medication_reviews
      where id = ${id} and pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      for update
    `;
    if (!before) throw httpError(404, 'NOT_FOUND', 'Medication review not found.');
    if (before.status === 'signed') {
      throw httpError(409, 'ALREADY_SIGNED', 'This review is signed. Record a new review instead.');
    }

    await tx`
      update medication_reviews set ${tx({
    reviewed_on: fields.reviewedOn,
    adherence: fields.adherence,
    adherence_notes: fields.adherenceNotes,
    notes: fields.notes,
    outcome: fields.outcome,
    follow_up_on: fields.followUpOn,
    follow_up_reason: fields.followUpReason,
    follow_up_notes: fields.followUpNotes,
    updated_at: new Date().toISOString(),
    ...(sign ? { status: 'signed', signed_at: new Date().toISOString(), reviewer_id: actorId } : {}),
  })}
      where id = ${id} and pharmacy_id = ${pharmacyId}
    `;

    // Replace the findings wholesale — see the header. Deleting the actions
    // first because they reference the problems.
    await tx`delete from medication_review_actions where review_id = ${id} and pharmacy_id = ${pharmacyId}`;
    await tx`delete from medication_review_problems where review_id = ${id} and pharmacy_id = ${pharmacyId}`;

    // The form's problems carry a position, not an id — neither exists until
    // now. Insert the problems, keep what each position became, then point
    // the interventions at the real rows.
    // POSITION, not the clock: inside this transaction every row shares one
    // created_at, so without it a review reads back in a random order (0057).
    const byRef = new Map();
    const problemList = fields.problems || [];
    for (let i = 0; i < problemList.length; i += 1) {
      const p = problemList[i];
      const [row] = await tx`
        insert into medication_review_problems ${tx({
    pharmacy_id: pharmacyId,
    review_id: id,
    journey_id: p.journeyId,
    problem: p.problem,
    notes: p.notes,
    position: i,
  })}
        returning id
      `;
      byRef.set(String(p.ref), row.id);
    }
    const actionList = fields.actions || [];
    for (let i = 0; i < actionList.length; i += 1) {
      const a = actionList[i];
      await tx`
        insert into medication_review_actions ${tx({
    pharmacy_id: pharmacyId,
    review_id: id,
    problem_id: a.problemRef === null ? null : byRef.get(a.problemRef) || null,
    action: a.action,
    notes: a.notes,
    position: i,
  })}
      `;
    }

    return getReview(pharmacyId, customerId, id, { sql: tx });
  });
}

/**
 * The medicines a review is about: what the patient is on right now.
 *
 * Read at the moment the review is written rather than stored with it. A
 * review is a record of what a pharmacist assessed, and the medicines it
 * concerned are already in the record with their own dates — copying them
 * would be a second, staler list of the same thing.
 */
async function reviewableMedications(pharmacyId, customerId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const rows = await sql`
    select id, medicine_name, strength, form, dose, route, frequency, source, status
    from medication_journeys
    where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
      and status in ('active', 'draft')
    order by medicine_name
  `;
  return rows.map((r) => ({
    id: r.id,
    medicineName: r.medicine_name,
    strength: r.strength,
    form: r.form,
    dose: r.dose,
    route: r.route,
    frequency: r.frequency,
    source: r.source,
    status: r.status,
  }));
}

module.exports = {
  listReviews, getReview, startReview, saveReview, reviewableMedications,
};
