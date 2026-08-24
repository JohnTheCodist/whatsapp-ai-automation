/**
 * Overview — what a pharmacy owner wants to know at a glance.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * Vanity metrics. "Characters used", "messages sent this month" and similar
 * measure our product's consumption, not the pharmacy's business. An owner
 * opening this screen is asking three questions: is it working, is anything
 * waiting for me, and is it selling anything. Everything below answers one
 * of those.
 *
 * WHY THE ASSISTANT'S FAILURES ARE ON THE FRONT PAGE
 * `handed_off` and `suppressed` are shown next to `replied`, not buried. A
 * dashboard that only reports successes is how a pharmacy discovers three
 * weeks late that half their customers were quietly escalated to an inbox
 * nobody opened. The uncomfortable number is the useful one.
 *
 * One round trip. Fifteen separate count queries against a remote pooler is
 * how the connection exhaustion from earlier in this build happened.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { warmupStatus } = require('../services/whatsapp/warmupPolicy');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();
    const pid = req.pharmacyId;

    const [row] = await db`
      select
        -- ---- is it working ----
        (select status from whatsapp_accounts
           where pharmacy_id = ${pid} and provider = 'baileys'
           order by created_at limit 1) as connection_status,
        (select display_phone_number from whatsapp_accounts
           where pharmacy_id = ${pid} and provider = 'baileys'
           order by created_at limit 1) as connected_number,

        -- ---- is anything waiting for me ----
        (select count(*)::int from handoffs
           where pharmacy_id = ${pid} and resolved_at is null) as open_handoffs,
        (select count(*)::int from orders
           where pharmacy_id = ${pid} and status = 'pending') as pending_orders,

        -- Conversations whose most recent message is from the CUSTOMER.
        --
        -- The single most important number on this page, and it was missing
        -- from the first version: today showed 18 inbound, 5 replied, 2
        -- handed off, and nothing accounted for the other 11. A dashboard
        -- that reports what the assistant did but not who it left waiting
        -- lets a pharmacy believe it is answering everyone.
        --
        -- Counted per conversation rather than per message, because three
        -- messages answered by one reply is not three failures — someone
        -- whose last word went unanswered is.
        --
        -- The status = 'open' filter is load-bearing and was missing. Note
        -- for future edits: this comment lives INSIDE a JS template literal,
        -- so a backtick here would end the string and break the file.
        -- Without that filter this
        -- counted CLOSED threads too, and a closed thread's last message is
        -- very often inbound — "Hello", "No need", a name, a goodbye. The
        -- live dashboard read 8 people waiting when every one of them was a
        -- dead thread aged 3-9 days that the idle sweep had already closed.
        -- A number that says 8 when the answer is 0 is worse than no number:
        -- it is a queue nobody can ever clear, so staff learn to ignore it.
        --
        -- The correlated "last message" subquery it used to run was also the
        -- slowest thing on this page — one extra index scan per conversation,
        -- on an endpoint the dashboard polls. DISTINCT ON resolves every
        -- conversation's last message in a single ordered pass instead.
        (select count(*)::int from (
           select distinct on (m.conversation_id) m.conversation_id, m.direction
           from messages m
           join conversations c on c.id = m.conversation_id
           where m.pharmacy_id = ${pid} and c.status = 'open'
           order by m.conversation_id, m.id desc
         ) last_msg
         where last_msg.direction = 'inbound') as awaiting_reply,

        -- ---- today ----
        (select count(*)::int from messages
           where pharmacy_id = ${pid} and direction = 'inbound'
             and created_at > now() - interval '24 hours') as messages_in_24h,
        (select count(*)::int from messages
           where pharmacy_id = ${pid} and direction = 'outbound' and author = 'assistant'
             and created_at > now() - interval '24 hours') as replied_24h,
        (select count(*)::int from handoffs
           where pharmacy_id = ${pid}
             and requested_at > now() - interval '24 hours') as handed_off_24h,
        (select count(distinct conversation_id)::int from messages
           where pharmacy_id = ${pid}
             and created_at > now() - interval '24 hours') as active_conversations_24h,
        (select count(*)::int from customers
           where pharmacy_id = ${pid}
             and first_seen_at > now() - interval '24 hours') as new_customers_24h,

        -- ---- is it selling ----
        (select count(*)::int from orders
           where pharmacy_id = ${pid}
             and created_at > now() - interval '7 days') as orders_7d,
        (select coalesce(sum(total_kobo), 0)::bigint from orders
           where pharmacy_id = ${pid} and status in ('confirmed','ready','completed')
             and created_at > now() - interval '7 days') as confirmed_value_7d_kobo,
        (select count(*)::int from orders
           where pharmacy_id = ${pid} and status = 'rejected'
             and created_at > now() - interval '7 days') as rejected_7d,
        -- NOT status = 'expired' (no backticks around that — see the load-
        -- bearing-filter comment above: a backtick pair in here closes the
        -- OUTER template literal this whole query lives in and breaks the
        -- file, exactly the way this one just did) — orders has never had
        -- that value in its check constraint (see 0001_init.sql), so that
        -- filter always
        -- returned zero, silently, for every pharmacy that ever shipped this
        -- query. A hold timing out writes status='cancelled' with an
        -- order_status_history row stamped actor_type='system' instead (see
        -- expireStaleHolds in orderService.js) — that pairing is what
        -- orderEventType() elsewhere already uses to tell "the pharmacy
        -- expired this hold" apart from an ordinary cancellation, so this
        -- reads the same signal rather than inventing a second one.
        (select count(distinct o.id)::int from orders o
           join order_status_history h on h.order_id = o.id
           where o.pharmacy_id = ${pid}
             and h.to_status = 'cancelled' and h.actor_type = 'system'
             and o.created_at > now() - interval '7 days') as expired_7d,

        -- ---- catalogue health ----
        (select count(*)::int from products
           where pharmacy_id = ${pid} and status = 'active') as products_active,
        (select count(*)::int from products
           where pharmacy_id = ${pid} and status = 'active' and price_kobo is null) as products_no_price,
        (select count(*)::int from products
           where pharmacy_id = ${pid} and status = 'active'
             and stock_tracked = true and stock_qty = 0) as products_out_of_stock,

        -- ---- limits and conduct ----
        (select count(*)::int from messages
           where pharmacy_id = ${pid} and direction = 'outbound'
             and created_at > now() - interval '24 hours') as sent_24h,

        ph.daily_reply_cap, ph.sending_paused, ph.paused_reason,
        ph.reply_mode, ph.warmup_enabled, ph.warmup_started_at,
        ph.warmup_day1_limit, ph.warmup_days, ph.bot_name, ph.name as pharmacy_name
      from pharmacies ph
      where ph.id = ${pid}
    `;

    if (!row) return res.status(404).json({ error: 'Pharmacy not found', code: 'NOT_FOUND' });

    // Daily volume, oldest first, for the sparkline. Generated from a date
    // series rather than from the messages table so a day with no traffic
    // appears as a zero instead of vanishing — a gap in a chart reads as
    // "no data" when it actually means "nobody messaged".
    const daily = await db`
      select d::date as day,
             (select count(*)::int from messages m
                where m.pharmacy_id = ${pid} and m.direction = 'inbound'
                  and m.created_at >= d and m.created_at < d + interval '1 day') as inbound,
             (select count(*)::int from messages m
                where m.pharmacy_id = ${pid} and m.direction = 'outbound'
                  and m.created_at >= d and m.created_at < d + interval '1 day') as outbound
      from generate_series(date_trunc('day', now()) - interval '13 days',
                           date_trunc('day', now()), interval '1 day') d
      order by d
    `;

    const warmup = warmupStatus({
      startedAt: row.warmup_started_at,
      enabled: row.warmup_enabled,
      day1Limit: row.warmup_day1_limit,
      warmupDays: row.warmup_days,
    });

    res.json({
      pharmacy: { name: row.pharmacy_name, botName: row.bot_name },
      connection: {
        status: row.connection_status || 'pending',
        number: row.connected_number,
      },
      waiting: {
        handoffs: row.open_handoffs,
        orders: row.pending_orders,
        // Customers whose last message got no response at all — from the
        // assistant or a human. Distinct from `handoffs`: an open handoff is
        // at least visible in the Inbox, whereas these are invisible unless
        // this number exists.
        customers: row.awaiting_reply,
      },
      today: {
        messagesIn: row.messages_in_24h,
        replied: row.replied_24h,
        handedOff: row.handed_off_24h,
        conversations: row.active_conversations_24h,
        newCustomers: row.new_customers_24h,
      },
      sales: {
        orders7d: row.orders_7d,
        confirmedValue7d: Number(row.confirmed_value_7d_kobo) / 100,
        rejected7d: row.rejected_7d,
        expired7d: row.expired_7d,
      },
      catalogue: {
        active: row.products_active,
        noPrice: row.products_no_price,
        outOfStock: row.products_out_of_stock,
      },
      limits: {
        sent24h: row.sent_24h,
        // The lower of the two ceilings is the one actually in force. Showing
        // the daily cap while warm-up is silently enforcing 20 would make the
        // dashboard disagree with the system's own behaviour.
        cap: warmup.active ? Math.min(warmup.limit, row.daily_reply_cap) : row.daily_reply_cap,
        capSource: warmup.active && warmup.limit < row.daily_reply_cap ? 'warmup' : 'daily',
        warmupDay: warmup.active ? warmup.day : null,
        sendingPaused: row.sending_paused,
        pausedReason: row.paused_reason,
        replyMode: row.reply_mode,
      },
      daily: daily.map((d) => ({
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day).slice(0, 10),
        inbound: d.inbound,
        outbound: d.outbound,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
