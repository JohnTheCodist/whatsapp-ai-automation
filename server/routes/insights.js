/**
 * Owner-facing numbers: what the business is doing, and what the assistant is
 * doing for it.
 *
 * WHY THIS IS SEPARATE FROM /api/overview
 * Overview answers "what needs me right now" — it is an operational screen and
 * every figure on it is about the last 24 hours. These are trend and
 * performance figures a pharmacy owner reads occasionally, over weeks. Mixing
 * them meant one query doing both jobs and neither well, and it is why the
 * Overview screen had grown to five unrelated sections.
 *
 * EVERY NUMBER HERE IS COMPUTED. There are no illustrative constants in this
 * file: a dashboard that shows a plausible figure nobody measured is worse
 * than one that shows nothing, because the owner will make decisions on it.
 * Where a thing genuinely cannot be known yet, the field is null and the
 * client renders a dash.
 *
 * Tenant scoping is req.pharmacyId on every query, same as every other route.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
// Read from the engine's own config rather than restated here, so the screen
// can never disagree with the rules that actually decide who is tracked.
const { CONDITION_NAMES, thresholdsFor } = require('../config/conditionMappings');

const router = express.Router();

/** Orders taken faster than this are healthy; slower needs attention. */
const APPROVAL_TARGET_MINUTES = 5;

/** How far back the growth chart looks. */
const TREND_DAYS = 30;

const naira = (kobo) => Math.round(Number(kobo || 0)) / 100;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const P = req.pharmacyId;

    const [
      headline,
      approval,
      trend,
      topProducts,
      aiPerf,
      conditions,
    ] = await Promise.all([

      // ---- the three headline figures --------------------------------------
      db`
        select
          (select count(*)::int from customers where pharmacy_id = ${P}) as total_patients,

          -- AI-assisted revenue: orders that exist because a conversation
          -- produced them. conversation_id is the join that makes this
          -- claimable — an order with no conversation was taken some other
          -- way and must not be credited to the assistant.
          (select coalesce(sum(total_kobo), 0) from orders
            where pharmacy_id = ${P}
              and conversation_id is not null
              and status in ('confirmed', 'ready', 'completed')) as ai_revenue_kobo,

          -- Only CONFIRMED_BY_PURCHASE counts as "tracked". A condition still
          -- gathering evidence is not something to tell an owner we are
          -- tracking, or the number inflates with maybes.
          (select count(distinct customer_id)::int from patient_condition
            where pharmacy_id = ${P} and status = 'CONFIRMED_BY_PURCHASE') as chronic_tracked,

          -- Patients whose evidence is real but still short of the bar. Shown
          -- separately rather than added in: "tracked" has to keep meaning
          -- confirmed, but an owner should still know these exist, because
          -- one more purchase moves them across.
          (select count(distinct customer_id)::int from patient_condition
            where pharmacy_id = ${P} and status = 'PENDING_PURCHASE_EVIDENCE') as chronic_pending
      `,

      // ---- how long staff take to act on an order --------------------------
      //
      // Measured from the order being placed to its FIRST move out of
      // pending, read from status history rather than orders.updated_at —
      // updated_at moves again on every later change, so using it would
      // report the time to the most recent edit rather than the time the
      // customer actually waited.
      db`
        with first_action as (
          select h.order_id,
                 min(h.changed_at) filter (where h.to_status <> 'pending') as acted_at
          from order_status_history h
          where h.pharmacy_id = ${P}
          group by h.order_id
        )
        select
          avg(extract(epoch from (fa.acted_at - o.created_at)) / 60)::numeric as avg_minutes,
          count(*)::int as sample
        from orders o
        join first_action fa on fa.order_id = o.id
        where o.pharmacy_id = ${P}
          and fa.acted_at is not null
          and o.created_at > now() - interval '30 days'
      `,

      // ---- revenue and customers, by day -----------------------------------
      //
      // Built off a generated date series so quiet days appear as zero rather
      // than vanishing — a line chart that silently drops empty days shows a
      // smooth trend that never happened.
      db`
        with days as (
          select generate_series(
            (now() - make_interval(days => ${TREND_DAYS - 1}))::date,
            now()::date,
            interval '1 day'
          )::date as day
        ),
        rev as (
          select created_at::date as day, sum(total_kobo) as kobo
          from orders
          where pharmacy_id = ${P}
            and status in ('confirmed', 'ready', 'completed')
            and created_at > now() - make_interval(days => ${TREND_DAYS})
          group by 1
        ),
        -- A customer is NEW on the day of their first ever order, and
        -- RETURNING on any later day they order. Computed from each order's
        -- rank for that customer, so the two series never double-count the
        -- same person on the same day.
        ranked as (
          select customer_id, created_at::date as day,
                 row_number() over (partition by customer_id order by created_at) as n
          from orders
          where pharmacy_id = ${P} and customer_id is not null
        ),
        cust as (
          select day,
                 count(distinct customer_id) filter (where n = 1)::int as new_customers,
                 count(distinct customer_id) filter (where n > 1)::int as returning_customers
          from ranked
          where day > (now() - make_interval(days => ${TREND_DAYS}))::date
          group by 1
        )
        select d.day,
               coalesce(rev.kobo, 0) as kobo,
               coalesce(cust.new_customers, 0) as new_customers,
               coalesce(cust.returning_customers, 0) as returning_customers
        from days d
        left join rev  on rev.day  = d.day
        left join cust on cust.day = d.day
        order by d.day
      `,

      // ---- what actually sells ---------------------------------------------
      db`
        select oi.name_snapshot as name,
               sum(oi.quantity)::int as units,
               sum(oi.line_total_kobo) as kobo
        from order_items oi
        join orders o on o.id = oi.order_id
        where oi.pharmacy_id = ${P}
          and o.status in ('confirmed', 'ready', 'completed')
          and o.created_at > now() - make_interval(days => ${TREND_DAYS})
        group by oi.name_snapshot
        order by kobo desc
        limit 5
      `,

      // ---- the assistant's own record --------------------------------------
      db`
        select
          (select count(*)::int from conversations where pharmacy_id = ${P}) as conversations,

          -- A product request is a conversation that got as far as naming
          -- something in the catalogue, which is what the conversation
          -- context records under last_product_id.
          (select count(*)::int from conversations
            where pharmacy_id = ${P} and context ? 'last_product_id') as product_requests,

          (select count(*)::int from orders
            where pharmacy_id = ${P} and conversation_id is not null) as ai_orders,

          -- Counted separately from ai_orders, and this distinction is the
          -- whole reason conversion is believable: one conversation can
          -- produce several orders, so dividing ORDERS by CONVERSATIONS
          -- yielded 218% on live data. Both sides of the ratio have to be
          -- the same unit, so the numerator is conversations-that-converted.
          (select count(distinct conversation_id)::int from orders
            where pharmacy_id = ${P} and conversation_id is not null) as converted_conversations,

          (select count(*)::int from handoffs where pharmacy_id = ${P}) as interventions
      `,

      // ---- the chronic register, per condition -----------------------------
      //
      // Counted as DISTINCT PATIENTS, not rows: one person on amlodipine and
      // a statin holds two condition rows, and "3 hypertensive patients" has
      // to mean three people or it is not a number a pharmacy can act on.
      //
      // Confirmed and pending are returned side by side so the caller can
      // show "5 tracked, 2 more close" without a second round trip.
      db`
        select condition_code,
               count(distinct customer_id) filter (where status = 'CONFIRMED_BY_PURCHASE')::int as confirmed,
               count(distinct customer_id) filter (where status = 'PENDING_PURCHASE_EVIDENCE')::int as pending
        from patient_condition
        where pharmacy_id = ${P}
        group by condition_code
      `,
    ]);

    const h = headline[0];
    const a = approval[0];

    const avgMinutes = a.avg_minutes === null ? null : Number(a.avg_minutes);
    const perf = aiPerf[0];

    // Conversion is only meaningful against the conversations that actually
    // asked for something. Against ALL conversations it would count "what
    // time do you close" as a failed sale and read far worse than reality.
    //
    // Numerator and denominator are both CONVERSATIONS. Clamped at 100 as a
    // last line of defence: context can be cleared mid-conversation, so a
    // thread may hold an order while no longer showing the product request
    // that produced it, which would otherwise print a rate above 100% again.
    const conversionBase = Math.max(perf.product_requests, perf.converted_conversations);
    const conversionRate = conversionBase > 0
      ? Math.min(100, Math.round((perf.converted_conversations / conversionBase) * 1000) / 10)
      : null;

    res.json({
      // Every tracked condition is listed even when it has nobody in it. An
      // absent row and a zero look identical to a reader, but they mean
      // opposite things: "we do not follow asthma" versus "we follow it and
      // no patient has qualified yet". Driven off CONDITION_NAMES so adding a
      // condition to the engine shows up here without touching this file.
      conditions: Object.entries(CONDITION_NAMES).map(([code, name]) => {
        const row = conditions.find((c) => c.condition_code === code);
        return {
          code,
          name,
          confirmed: row ? row.confirmed : 0,
          pending: row ? row.pending : 0,
          // What it takes to be counted, so the UI can explain a zero rather
          // than just showing one.
          confirmsAt: thresholdsFor(code).confirmAt,
        };
      }),

      headline: {
        totalPatients: h.total_patients,
        aiAssistedSales: naira(h.ai_revenue_kobo),
        chronicTracked: h.chronic_tracked,
        chronicPending: h.chronic_pending,
      },
      approval: {
        // null when no order has ever been acted on — the client shows a dash
        // rather than "0 minutes", which would read as instant approval.
        averageMinutes: avgMinutes === null ? null : Math.round(avgMinutes * 10) / 10,
        targetMinutes: APPROVAL_TARGET_MINUTES,
        withinTarget: avgMinutes === null ? null : avgMinutes < APPROVAL_TARGET_MINUTES,
        sample: a.sample,
      },
      trend: trend.map((d) => ({
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        revenue: naira(d.kobo),
        newCustomers: d.new_customers,
        returningCustomers: d.returning_customers,
      })),
      topProducts: topProducts.map((p) => ({
        name: p.name,
        units: p.units,
        revenue: naira(p.kobo),
      })),
      ai: {
        conversations: perf.conversations,
        productRequests: perf.product_requests,
        assistedOrders: perf.ai_orders,
        conversionRate,
        interventions: perf.interventions,
      },
      windowDays: TREND_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
