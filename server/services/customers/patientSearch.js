/**
 * Patient search: name or phone, the eight filters in patientFilters.js, and
 * the chronic switch.
 *
 * ONE QUERY, EVERY SUBQUERY SCOPED. Each fact a filter reads (profile,
 * orders, refills, conditions, encounters, tags, assignment) is joined on
 * the customer AND pharmacy_id, so no filter can widen the search into
 * another tenant's rows. The outer WHERE starts from `pharmacy_id =`; the
 * isolation test in patientSearch.test.js plants a matching patient in a
 * second pharmacy for every filter.
 *
 * WHAT EACH COLUMN MEANS — kept here, next to the SQL that decides it:
 *   age          from the date of birth if recorded, else the age last
 *                reported (to the assistant or by staff)
 *   last visit   the latest of: a WhatsApp message, an order, a dispense
 *   follow-up    the patient's worst current supply, by refillSchedule's
 *                rules (the same bands as the refill call list)
 *   risk         danger sign in a consultation (last 90 days), lapsed on a
 *                followed medicine, tagged "Pharmacist follow-up"
 *
 * Not derived, not stored: a patient's follow-up status and risk flags are
 * computed from today's Lagos date on every search, like every other status
 * in this system.
 */

const { getSql, assertPharmacyId } = require('../db');
const {
  REMIND_DAYS_BEFORE, LAPSE_DAYS_AFTER, lagosDate, addDays, refillStatus,
} = require('../refills/refillSchedule');
const {
  RED_FLAG_WINDOW_DAYS, LAST_VISIT, CHRONIC_CONDITIONS, ageBand, readPatientFilters, fixedOptions,
} = require('./patientFilters');

const FOLLOW_UP_TAG = 'pharmacist_follow_up';

/**
 * The WHERE fragments for a validated filter set. Each reads the columns the
 * `base` CTE exposes (b.*), or a subquery keyed on b.id and the pharmacy.
 */
function filterConditions(sql, pharmacyId, f, today) {
  const conds = [];
  const dueFrom = addDays(today, 1);                        // tomorrow: still has medicine
  const dueTo = addDays(today, REMIND_DAYS_BEFORE);        // inside the reminder window
  const overdueFrom = addDays(today, -(LAPSE_DAYS_AFTER - 1));
  const lapsedTo = addDays(today, -LAPSE_DAYS_AFTER);

  // An open supply of an ACTIVE journey whose run-out date is in [from, to].
  const supplyBetween = (from, to) => sql`
    exists (
      select 1 from refills r
      join medication_journeys j on j.id = r.journey_id and j.pharmacy_id = ${pharmacyId} and j.status = 'active'
      where r.customer_id = b.id and r.pharmacy_id = ${pharmacyId} and r.status = 'open'
        ${from ? sql`and r.run_out_on >= ${from}::date` : sql``}
        ${to ? sql`and r.run_out_on <= ${to}::date` : sql``}
    )
  `;
  const redFlag = sql`
    exists (
      select 1 from clinical_encounters ce
      join patient_profiles pp2 on pp2.id = ce.patient_profile_id and pp2.pharmacy_id = ${pharmacyId}
      where pp2.customer_id = b.id and ce.pharmacy_id = ${pharmacyId}
        and jsonb_array_length(ce.red_flags_detected) > 0
        and ce.started_at >= (${today}::date - ${RED_FLAG_WINDOW_DAYS}::int)
    )
  `;
  const lapsed = supplyBetween(null, lapsedTo);
  const followUpTag = sql`
    exists (
      select 1 from patient_tags pt
      join tags t on t.id = pt.tag_id and t.pharmacy_id = ${pharmacyId}
      where pt.customer_id = b.id and pt.pharmacy_id = ${pharmacyId} and t.slug = ${FOLLOW_UP_TAG}
    )
  `;

  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Digits typed as 080... should find 23480...: search the phone on its
    // last digits as well as literally.
    const digits = f.q.replace(/\D/g, '');
    const phoneTail = digits.length >= 4 ? `%${digits.replace(/^0/, '')}%` : null;
    conds.push(sql`(
      b.name ilike ${like} or b.wa_phone ilike ${like}
      ${phoneTail ? sql`or b.wa_phone like ${phoneTail}` : sql``}
    )`);
  }

  if (f.age) {
    const band = ageBand(f.age);
    if (band.min === null) {
      conds.push(sql`b.age is null`);
    } else {
      conds.push(sql`b.age >= ${band.min}`);
      if (band.max !== null) conds.push(sql`b.age <= ${band.max}`);
    }
  }

  if (f.gender) {
    conds.push(f.gender === 'unknown'
      ? sql`(b.sex is null or b.sex = 'unknown')`
      : sql`b.sex = ${f.gender}`);
  }

  // A patient "has" a condition for these filters when EITHER the purchase
  // engine inferred it (0037) OR a person recorded it and it is current and
  // not refuted (0059), matched on the house code both carry. Owner's
  // decision, 2026-09-22: recording Hypertension must put the patient under
  // the chronic switch, not wait for their purchases to catch up.
  const hasCondition = (codes) => sql`(
    exists (
      select 1 from patient_condition pc
      where pc.customer_id = b.id and pc.pharmacy_id = ${pharmacyId}
        and pc.condition_code = any(${codes}) and pc.status = 'CONFIRMED_BY_PURCHASE'
    )
    or exists (
      select 1 from patient_problems pr
      where pr.customer_id = b.id and pr.pharmacy_id = ${pharmacyId}
        and pr.local_code = any(${codes})
        and pr.clinical_status in ('active', 'recurrence', 'relapse')
        and pr.verification_status not in ('refuted', 'entered_in_error')
    )
  )`;

  if (f.condition) {
    conds.push(hasCondition([f.condition]));
  }

  // The chronic switch. Narrows alongside Condition rather than replacing
  // it, so "chronic on + condition diabetes" is the diabetics — not every
  // chronic patient, which an OR here would have quietly returned.
  if (f.chronic) {
    conds.push(hasCondition(CHRONIC_CONDITIONS));
  }

  if (f.medication) {
    const like = `%${f.medication.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`exists (
      select 1 from medication_journeys j
      where j.customer_id = b.id and j.pharmacy_id = ${pharmacyId}
        and j.status = 'active' and j.medicine_name ilike ${like}
    )`);
  }

  if (f.lastVisit) {
    const window = LAST_VISIT.find((w) => w.value === f.lastVisit);
    if (window.withinDays) {
      conds.push(sql`b.last_visit_on >= ${addDays(today, -window.withinDays)}::date`);
    } else {
      // Never visited counts as "more than 90 days ago" — it is certainly not recent.
      conds.push(sql`(b.last_visit_on is null or b.last_visit_on < ${addDays(today, -window.olderThanDays)}::date)`);
    }
  }

  if (f.followUp) {
    conds.push({
      any: supplyBetween(null, dueTo),
      due: supplyBetween(dueFrom, dueTo),
      overdue: supplyBetween(overdueFrom, today),
      lapsed,
    }[f.followUp]);
  }

  if (f.pharmacist) {
    conds.push(f.pharmacist === 'unassigned'
      ? sql`b.assigned_pharmacist_id is null`
      : sql`b.assigned_pharmacist_id = ${f.pharmacist}`);
  }

  if (f.risk) {
    conds.push({
      any: sql`(${redFlag} or ${lapsed} or ${followUpTag})`,
      red_flag: redFlag,
      lapsed,
      follow_up: followUpTag,
    }[f.risk]);
  }

  return { conds, redFlag, lapsed, followUpTag };
}

/**
 * @param {string} pharmacyId
 * @param {object} filters  output of readPatientFilters
 * @param {{ today?: string }} [opts]  Lagos date; injectable for tests
 * @returns {Promise<{ today: string, total: number, patients: object[] }>}
 */
async function searchPatients(pharmacyId, filters, { today = lagosDate() } = {}) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const f = { ...readPatientFilters({}), ...filters };
  const { conds, redFlag, lapsed, followUpTag } = filterConditions(sql, pharmacyId, f, today);
  const where = conds.length ? conds.reduce((acc, c) => sql`${acc} and ${c}`) : sql`true`;

  const rows = await sql`
    with base as (
      select c.id,
             coalesce(nullif(c.full_name, ''), nullif(c.display_name, ''), c.wa_phone) as name,
             c.wa_phone, c.communication_status, c.assigned_pharmacist_id,
             pp.sex,
             coalesce(date_part('year', age(${today}::date, pp.date_of_birth))::int, pp.age_years) as age,
             greatest(
               (c.last_seen_at at time zone 'Africa/Lagos')::date,
               (lo.last_order_at at time zone 'Africa/Lagos')::date,
               ld.last_dispensed_on
             ) as last_visit_on,
             fu.earliest_run_out
      from customers c
      left join patient_profiles pp
        on pp.customer_id = c.id and pp.pharmacy_id = ${pharmacyId}
      left join lateral (
        select max(o.created_at) as last_order_at
        from orders o where o.customer_id = c.id and o.pharmacy_id = ${pharmacyId}
      ) lo on true
      left join lateral (
        select max(r.dispensed_on) as last_dispensed_on
        from refills r where r.customer_id = c.id and r.pharmacy_id = ${pharmacyId}
      ) ld on true
      left join lateral (
        select min(r.run_out_on) as earliest_run_out
        from refills r
        join medication_journeys j on j.id = r.journey_id and j.pharmacy_id = ${pharmacyId} and j.status = 'active'
        where r.customer_id = c.id and r.pharmacy_id = ${pharmacyId} and r.status = 'open'
      ) fu on true
      where c.pharmacy_id = ${pharmacyId}
    )
    select b.id, b.name, b.wa_phone, b.communication_status, b.sex, b.age,
           b.last_visit_on::text as last_visit_on,
           b.earliest_run_out::text as earliest_run_out,
           b.assigned_pharmacist_id, u.email as assigned_pharmacist_email,
           ${redFlag} as risk_red_flag,
           ${lapsed} as risk_lapsed,
           ${followUpTag} as risk_follow_up,
           -- Recorded current conditions by their recorded name, then any
           -- purchase inference whose code nobody has recorded yet — the
           -- same condition is never listed twice under two names.
           coalesce((
             select array_agg(n order by n) from (
               select pr.condition_name as n
               from patient_problems pr
               where pr.customer_id = b.id and pr.pharmacy_id = ${pharmacyId}
                 and pr.clinical_status in ('active', 'recurrence', 'relapse')
                 and pr.verification_status not in ('refuted', 'entered_in_error')
               union
               select pc.condition_name
               from patient_condition pc
               where pc.customer_id = b.id and pc.pharmacy_id = ${pharmacyId} and pc.status = 'CONFIRMED_BY_PURCHASE'
                 and not exists (
                   select 1 from patient_problems pr2
                   where pr2.customer_id = b.id and pr2.pharmacy_id = ${pharmacyId}
                     and pr2.local_code = pc.condition_code
                     and pr2.verification_status not in ('refuted', 'entered_in_error')
                 )
             ) names
           ), '{}') as conditions,
           coalesce((
             select array_agg(j.medicine_name order by j.medicine_name)
             from medication_journeys j
             where j.customer_id = b.id and j.pharmacy_id = ${pharmacyId} and j.status = 'active'
           ), '{}') as medications,
           count(*) over ()::int as total
    from base b
    left join auth.users u on u.id = b.assigned_pharmacist_id
    where ${where}
    order by b.last_visit_on desc nulls last, b.name, b.id
    limit ${f.limit}
  `;

  const patients = rows.map((r) => {
    const followUp = r.earliest_run_out ? refillStatus({ runOutOn: r.earliest_run_out, today }) : null;
    return {
      id: r.id,
      name: r.name,
      phone: r.wa_phone,
      optedOut: r.communication_status === 'opted_out',
      age: r.age,
      sex: r.sex && r.sex !== 'unknown' ? r.sex : null,
      conditions: r.conditions,
      medications: r.medications,
      lastVisitOn: r.last_visit_on,
      // Only a supply that needs action is a follow-up; "upcoming" is not.
      followUp: followUp && followUp.status !== 'upcoming' ? { ...followUp, runOutOn: r.earliest_run_out } : null,
      assignedPharmacist: r.assigned_pharmacist_id
        ? { id: r.assigned_pharmacist_id, email: r.assigned_pharmacist_email }
        : null,
      risks: [
        r.risk_red_flag && 'red_flag',
        r.risk_lapsed && 'lapsed',
        r.risk_follow_up && 'follow_up',
      ].filter(Boolean),
    };
  });

  return { today, total: rows[0]?.total ?? 0, patients };
}

/**
 * Everything the filter bar offers, in one request: the fixed lists with
 * their labels, plus this pharmacy's own conditions, medicines and
 * pharmacists. Only values that exist are offered — a condition nobody has
 * is not a choice.
 */
async function searchOptions(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const sql = getSql();
  const [conditions, medications, pharmacists] = await Promise.all([
    // Every house code the Condition filter can match: purchase inferences
    // and recorded current conditions alike (the filter reads both).
    sql`
      select value, min(label) as label from (
        select condition_code as value, condition_name as label
        from patient_condition
        where pharmacy_id = ${pharmacyId} and status = 'CONFIRMED_BY_PURCHASE'
        union all
        select local_code, condition_name
        from patient_problems
        where pharmacy_id = ${pharmacyId} and local_code is not null
          and clinical_status in ('active', 'recurrence', 'relapse')
          and verification_status not in ('refuted', 'entered_in_error')
      ) codes
      group by value
      order by label
    `,
    sql`
      select distinct medicine_name as value
      from medication_journeys
      where pharmacy_id = ${pharmacyId} and status = 'active'
      order by medicine_name
      limit 200
    `,
    sql`
      select m.user_id as value, u.email as label, m.role
      from pharmacy_members m
      left join auth.users u on u.id = m.user_id
      where m.pharmacy_id = ${pharmacyId} and m.role in ('pharmacist', 'owner')
      order by u.email
    `,
  ]);
  return {
    ...fixedOptions(),
    condition: conditions.map(({ value, label }) => ({ value, label })),
    medication: medications.map(({ value }) => ({ value, label: value })),
    pharmacist: [
      { value: 'unassigned', label: 'Unassigned' },
      ...pharmacists.map(({ value, label }) => ({ value, label: label || 'Pharmacist' })),
    ],
  };
}

module.exports = { searchPatients, searchOptions };
