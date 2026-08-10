/**
 * Background job worker — Postgres-backed, in-process.
 *
 * No Redis, no BullMQ. At a few hundred messages a day a second stateful
 * service is more operational surface than the problem justifies, and
 * `for update skip locked` is exactly the primitive a queue needs. Swap it
 * when queue depth is a measured problem rather than an anticipated one.
 *
 * WHAT IT DOES
 * Handles `process_inbound`: allowlist gate, then the assistant, then either
 * send the reply or open a handoff and mute the assistant.
 *
 * It was deliberately built with a FIXED reply first and the model added
 * afterwards. Once an LLM is in the path a silent failure could be the model,
 * the prompt, the tools, the send path, the worker or the socket; proving the
 * pipe deterministically meant this step started from a known-good baseline
 * rather than debugging six things at once.
 *
 * A handoff is silent to the customer on purpose. Saying "a human will reply
 * shortly" while no staff inbox exists would be a promise the product cannot
 * yet keep, and an unkept promise is worse than no reply.
 */

const { getSql } = require('./db');
const { sessionManager } = require('./whatsapp/sessionManager');
const { evaluateOutbound, isOptOutRequest } = require('./whatsapp/conductPolicy');
const { evaluateWarmup } = require('./whatsapp/warmupPolicy');
const { normalizeMsisdn } = require('./whatsapp/senderIdentity');
const { expireStaleHolds } = require('./orders/orderService');
const { respond } = require('./ai/assistant');
const { buildMenu, isMenuRequest, parseSelection, intentBriefing } = require('./ai/menu');
const { env } = require('../config/env');

/**
 * Map an assistant escalation category onto the handoff reasons the schema
 * allows. Anything unrecognised becomes 'unsupported' rather than being
 * dropped — a handoff we cannot categorise is still a handoff.
 */
const HANDOFF_REASON = {
  emergency: 'clinical',
  overdose: 'clinical',
  adverse_reaction: 'clinical',
  paediatric: 'clinical',
  pregnancy: 'clinical',
  dosage: 'clinical',
  drug_interaction: 'clinical',
  symptoms: 'clinical',
  prescription: 'clinical',
  human_requested: 'customer_request',
  prompt_injection: 'unsupported',
  unreadable: 'unsupported',
  filter_error: 'error',
  assistant_unavailable: 'error',
  assistant_error: 'error',
  unverified_reply: 'low_confidence',
  max_iterations: 'low_confidence',
};

/**
 * Failures that are about our infrastructure rather than about the message.
 *
 * These are retried rather than escalated, and crucially they do NOT mute the
 * conversation — muting is for "a person is now handling this", and an
 * unreachable model is not that.
 */
const TRANSIENT_CATEGORIES = new Set([
  'assistant_unavailable',
  'assistant_error',
  'filter_error',
]);

/**
 * Start the warm-up clock on the first message this number ever sends.
 *
 * `is null` in the WHERE clause is what makes this safe to call after every
 * send: only the first one wins, so a number cannot be made "new" again by
 * reconnecting, re-pairing, or a later code path forgetting the order.
 *
 * Called from one place rather than at each of the three send sites, because
 * a fourth send site added later would silently not start the clock — and a
 * warm-up that never starts is indistinguishable from one that is working.
 */
async function markWarmupStarted(db, pharmacyId) {
  await db`
    update pharmacies
    set warmup_started_at = now()
    where id = ${pharmacyId} and warmup_started_at is null
  `;
}

const WORKER_ID = `${process.pid}@${require('node:os').hostname()}`;

let running = false;
let timer = null;

/**
 * Claim one job. `skip locked` lets several workers coexist without any of
 * them waiting on a row another has taken.
 */
async function claimJob(db) {
  const [job] = await db`
    update jobs
    set status = 'running',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = ${WORKER_ID},
        updated_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now()
      order by id
      for update skip locked
      limit 1
    )
    returning *
  `;
  return job || null;
}

async function succeed(db, job) {
  await db`update jobs set status = 'succeeded', updated_at = now() where id = ${job.id}`;
}

/**
 * Retry with backoff, or dead-letter once attempts are exhausted.
 *
 * 'dead' rather than deletion: a job that could not be processed is evidence
 * that a customer went unanswered, and that is precisely the thing worth
 * keeping.
 */
async function fail(db, job, err) {
  const message = String(err?.message || err).slice(0, 500);
  const exhausted = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(300, 2 ** job.attempts);

  await db`
    update jobs
    set status = ${exhausted ? 'dead' : 'queued'},
        last_error = ${message},
        run_after = now() + interval '${db.unsafe(String(delaySeconds))} seconds',
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = ${job.id}
  `;

  console.error(JSON.stringify({
    level: 'error',
    msg: exhausted ? 'job dead-lettered' : 'job failed, will retry',
    jobId: String(job.id),
    kind: job.kind,
    attempts: job.attempts,
    error: message,
  }));
}

/**
 * Reply to an inbound message — if policy allows.
 *
 * The outcome is recorded either way. A decision not to send is a fact staff
 * may need to explain to a customer, so it is written down rather than
 * inferred from an absence.
 */
async function processInbound(db, job) {
  const { messageId, conversationId } = job.payload || {};
  if (!messageId || !conversationId) {
    throw new Error(`process_inbound payload missing messageId/conversationId: ${JSON.stringify(job.payload)}`);
  }

  const [row] = await db`
    select m.id, m.body,
           conv.id as conversation_id, conv.mode, conv.context, conv.greeted_at,
           cust.id as customer_id, cust.wa_phone, cust.wa_jid, cust.display_name,
           ph.name as pharmacy_name, ph.reply_mode, ph.sending_paused,
           ph.bot_name, ph.menu_enabled, ph.welcome_note,
           ph.daily_reply_cap, ph.hourly_conversation_cap,
           ph.quiet_hours_enabled, ph.quiet_hours_start, ph.quiet_hours_end,
           ph.warmup_started_at, ph.warmup_enabled, ph.warmup_day1_limit, ph.warmup_days,
           wa.id as account_id, wa.status as account_status
    from messages m
    join conversations conv on conv.id = m.conversation_id
    join customers cust on cust.id = conv.customer_id
    join pharmacies ph on ph.id = m.pharmacy_id
    left join whatsapp_accounts wa on wa.pharmacy_id = m.pharmacy_id and wa.provider = 'baileys'
    where m.id = ${messageId} and m.pharmacy_id = ${job.pharmacy_id}
  `;

  if (!row) throw new Error(`message ${messageId} not found for pharmacy ${job.pharmacy_id}`);

  // A conversation a human has taken over must not be talked over. A handoff
  // the assistant can ignore is not a handoff.
  if (row.mode !== 'bot') {
    return { sent: false, reason: `conversation_mode:${row.mode}` };
  }

  // ---- "stop messaging me" is honoured before anything else ---------------
  //
  // Recorded even when this pharmacy would not have replied anyway, so the
  // request stands if the reply mode is widened later. Continuing to message
  // someone who asked you to stop is the clearest signal of a system worth
  // banning, and is wrong regardless of whether anyone is watching.
  if (isOptOutRequest(row.body)) {
    await db`
      insert into opt_outs (pharmacy_id, wa_phone, source_text)
      values (${job.pharmacy_id}, ${normalizeMsisdn(row.wa_phone, env.defaultCountryCode) || row.wa_phone},
              ${String(row.body).slice(0, 300)})
      on conflict (pharmacy_id, wa_phone) do nothing
    `;
    console.log(JSON.stringify({ level: 'info', msg: 'opt-out recorded', to: row.wa_phone }));
    return { sent: false, reason: 'opt_out_request' };
  }

  const normalisedPhone = normalizeMsisdn(row.wa_phone, env.defaultCountryCode) || row.wa_phone;

  const [allowlist, optOut, counts] = await Promise.all([
    db`select wa_phone from outbound_allowlist where pharmacy_id = ${job.pharmacy_id}`,
    db`select 1 from opt_outs where pharmacy_id = ${job.pharmacy_id} and wa_phone = ${normalisedPhone} limit 1`,
    db`
      select
        (select count(*)::int from messages
           where pharmacy_id = ${job.pharmacy_id} and direction = 'outbound'
             and created_at > now() - interval '24 hours') as replies_today,
        (select count(*)::int from messages
           where conversation_id = ${row.conversation_id} and direction = 'outbound'
             and created_at > now() - interval '1 hour') as replies_this_conversation_hour,
        (select count(*)::int from (
           select body from messages
           where conversation_id = ${row.conversation_id} and direction = 'outbound'
           order by id desc limit 3
         ) recent
         where recent.body = (
           select body from messages
           where conversation_id = ${row.conversation_id} and direction = 'outbound'
           order by id desc limit 1
         )) as identical_recent_replies
    `,
  ]);

  const decision = evaluateOutbound({
    replyMode: row.reply_mode,
    phone: row.wa_phone,
    allowlist: allowlist.map((r) => r.wa_phone),
    optedOut: optOut.length > 0,
    sendingPaused: row.sending_paused,
    limits: {
      dailyReplyCap: row.daily_reply_cap,
      hourlyConversationCap: row.hourly_conversation_cap,
      quietHoursEnabled: row.quiet_hours_enabled,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
    },
    counts: {
      repliesToday: counts[0].replies_today,
      repliesThisConversationHour: counts[0].replies_this_conversation_hour,
      identicalRecentReplies: counts[0].identical_recent_replies,
    },
    defaultCountryCode: env.defaultCountryCode,
  });

  if (!decision.send) {
    // A breach severe enough to suggest something is wrong stops ALL sending
    // for this pharmacy until a person looks. On an unofficial channel,
    // continuing at a slower rate is the wrong response to "this is unusual".
    if (decision.pause) {
      await db`
        update pharmacies
        set sending_paused = true,
            paused_reason = ${`Automatic: ${decision.reason}`},
            paused_at = now()
        where id = ${job.pharmacy_id} and sending_paused = false
      `;
      console.error(JSON.stringify({
        level: 'error',
        msg: 'SENDING PAUSED — conduct breach, needs a human',
        pharmacyId: job.pharmacy_id,
        reason: decision.reason,
      }));
    }
    console.log(JSON.stringify({
      level: 'info', msg: 'reply suppressed', to: row.wa_phone, reason: decision.reason,
    }));
    return { sent: false, reason: decision.reason };
  }

  // ---- new-number warm-up -------------------------------------------------
  //
  // Separate from the conduct gate above, and deliberately so. That one's
  // daily cap is a steady-state ceiling whose breach means "something is
  // wrong, stop and let a person look". This is a temporary, expected,
  // shrinking limit where hitting it is the system working — so it must not
  // pause the pharmacy, or every Door A number would trip its own circuit
  // breaker on day one for behaving exactly as designed.
  const warmup = evaluateWarmup({
    startedAt: row.warmup_started_at,
    enabled: row.warmup_enabled,
    day1Limit: row.warmup_day1_limit,
    warmupDays: row.warmup_days,
    // Reuses the count the conduct gate already fetched, rather than a
    // second trailing-24h query per message.
    sentToday: counts[0].replies_today,
  });

  if (!warmup.send) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'reply held by warm-up',
      to: row.wa_phone,
      day: warmup.day,
      limit: warmup.limit,
      sentToday: warmup.sentToday,
    }));
    return { sent: false, reason: warmup.reason };
  }

  if (!row.wa_jid) throw new Error(`customer has no wa_jid to reply to (message ${messageId})`);
  if (row.account_status !== 'connected') {
    throw new Error(`whatsapp account is ${row.account_status}, cannot send`);
  }

  // Recent turns, so "I want two" has something to refer back to. Fetched
  // oldest-first because that is the order a conversation happened in.
  // ---- greeting and menu --------------------------------------------------
  //
  // Sent AFTER the conduct gate, so it obeys the allowlist and rate limits
  // like anything else, and BEFORE the assistant, because a menu is a fixed
  // string and does not need a model.
  //
  // `greeted_at` rather than "is this the first message": history sync, a
  // re-pair, or a customer who wrote before the pharmacy went live all leave
  // prior messages in the thread, and any of them would otherwise make a
  // regular get greeted as a stranger — or never greeted at all.
  const menuOn = row.menu_enabled !== false;
  const wantsMenu = menuOn && isMenuRequest(row.body);
  const needsGreeting = menuOn && !row.greeted_at;

  if (wantsMenu || needsGreeting) {
    const text = buildMenu({
      pharmacyName: row.pharmacy_name,
      botName: row.bot_name,
      // WhatsApp's pushName — what the customer calls themselves. Used as a
      // greeting only, never as identity.
      customerName: row.display_name,
      welcomeNote: row.welcome_note,
      returning: wantsMenu && Boolean(row.greeted_at),
    });

    const sent = await sessionManager.sendText(row.account_id, row.wa_jid, text);
    await db.begin(async (tx) => {
      await tx`
        insert into messages
          (pharmacy_id, conversation_id, direction, author, body, provider_message_id, delivery_status)
        values
          (${job.pharmacy_id}, ${row.conversation_id}, 'outbound', 'assistant',
           ${text}, ${sent.providerMessageId}, 'sent')
      `;
      await tx`
        update conversations set greeted_at = now(), last_message_at = now()
        where id = ${row.conversation_id}
      `;
    });

    console.log(JSON.stringify({ level: 'info', msg: 'menu sent', to: row.wa_phone, returning: Boolean(row.greeted_at) }));
    await markWarmupStarted(db, job.pharmacy_id);
    return { sent: true, reason: wantsMenu ? 'menu_requested' : 'greeting' };
  }

  // A bare number is a menu choice. "I want 1 pack" is not, and parseSelection
  // deliberately refuses to read it as one.
  const choice = menuOn ? parseSelection(row.body, {
    pharmacyName: row.pharmacy_name, botName: row.bot_name,
  }) : null;

  // "Speak to the pharmacist" is the only option that is not a question for
  // the assistant. It replaced the spec's "health questions, symptoms &
  // advice", which the clinical filter would have refused anyway — so it goes
  // straight to a person rather than through a model that must decline.
  if (choice?.intent === 'pharmacist') {
    await db.begin(async (tx) => {
      await tx`
        insert into handoffs (pharmacy_id, conversation_id, reason, detail, triggered_by)
        values (${job.pharmacy_id}, ${row.conversation_id}, 'customer_request',
                'Chose "Speak to the pharmacist" from the menu.', 'customer')
      `;
      await tx`update conversations set mode = 'human', last_menu_choice = ${choice.intent} where id = ${row.conversation_id}`;
    });

    // Unlike a silent escalation, this one WAS asked for, so saying it is
    // happening is a promise the staff inbox can now actually keep.
    const ack = 'A pharmacist will reply here shortly. Please tell us what you need in the meantime.';
    const sent = await sessionManager.sendText(row.account_id, row.wa_jid, ack);
    await db`
      insert into messages
        (pharmacy_id, conversation_id, direction, author, body, provider_message_id, delivery_status)
      values
        (${job.pharmacy_id}, ${row.conversation_id}, 'outbound', 'system',
         ${ack}, ${sent.providerMessageId}, 'sent')
    `;
    await markWarmupStarted(db, job.pharmacy_id);
    return { sent: true, reason: 'menu:pharmacist' };
  }

  if (choice) {
    await db`update conversations set last_menu_choice = ${choice.intent} where id = ${row.conversation_id}`;
  }

  const history = (await db`
    select direction, body from messages
    where conversation_id = ${row.conversation_id} and id < ${messageId} and body is not null
    order by id desc limit 10
  `).reverse();

  const outcome = await respond({
    pharmacyId: job.pharmacy_id,
    pharmacyName: row.pharmacy_name,
    text: row.body,
    history,
    context: row.context || {},
    // Bound here, from the row the job resolved — never from anything the
    // model or the customer supplied. create_order writes against these, so
    // a model-chosen customerId would be an order placed on someone else's
    // account.
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    // For the staff alert, so it can say who ordered rather than just a number.
    customer: { display_name: row.display_name, wa_phone: row.wa_phone },
    botName: row.bot_name,
    // A menu choice is a bare digit, which tells the model nothing on its
    // own. Passed as a FACT about what was chosen, not as an instruction —
    // same discipline as conversation context, so nothing arriving from a
    // customer can become a directive by routing through here.
    menuBriefing: choice ? intentBriefing(choice.intent, { pharmacyName: row.pharmacy_name }) : null,
  });

  // ---- escalate -----------------------------------------------------------
  if (outcome.action === 'handoff') {
    // A HANDOFF AND AN OUTAGE ARE NOT THE SAME EVENT.
    //
    // "A pharmacist should answer this" is a decision about the message.
    // "We could not reach the model" is a fact about the network, and it says
    // nothing about whether the assistant could have handled it.
    //
    // Treating them alike meant a two-second DNS blip muted a conversation
    // permanently: mode went to 'human', the assistant never spoke again, and
    // at 5am nobody was watching the inbox to notice. The customer simply
    // stopped getting replies, with no error anywhere.
    //
    // So a transient failure is retried by the queue with backoff, and only
    // becomes a real handoff once the retries are exhausted — at which point
    // it genuinely does need a person.
    if (TRANSIENT_CATEGORIES.has(outcome.category) && job.attempts < job.max_attempts) {
      throw new Error(`Transient assistant failure (${outcome.category}): ${outcome.reason}`);
    }

    await db.begin(async (tx) => {
      await tx`
        insert into handoffs (pharmacy_id, conversation_id, reason, detail, triggered_by)
        values (${job.pharmacy_id}, ${row.conversation_id},
                ${HANDOFF_REASON[outcome.category] || 'unsupported'},
                ${`${outcome.category}: ${outcome.reason}`}, 'assistant')
      `;
      // Muting the assistant is the handoff. Without this it answers the
      // customer's NEXT message and talks over the pharmacist who is now
      // dealing with them.
      await tx`
        update conversations set mode = 'human' where id = ${row.conversation_id}
      `;
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'handed off to staff',
      to: row.wa_phone,
      category: outcome.category,
      reason: outcome.reason,
    }));
    // Deliberately silent to the customer. Telling them "a human will reply"
    // when no staff inbox exists yet would be a promise the product cannot
    // keep. The pharmacist sees it; that is what a handoff is for.
    return { sent: false, reason: `handoff:${outcome.category}` };
  }

  // ---- answer -------------------------------------------------------------
  const sent = await sessionManager.sendText(row.account_id, row.wa_jid, outcome.text);

  await db.begin(async (tx) => {
    await tx`
      insert into messages
        (pharmacy_id, conversation_id, direction, author, body, provider_message_id, delivery_status)
      values
        (${job.pharmacy_id}, ${row.conversation_id}, 'outbound', 'assistant',
         ${outcome.text}, ${sent.providerMessageId}, 'sent')
    `;
    if (outcome.contextUpdate) {
      // Merged, not replaced, so remembering a product does not forget
      // whatever else the conversation was carrying.
      await tx`
        update conversations
        set context = context || ${tx.json(outcome.contextUpdate)}
        where id = ${row.conversation_id}
      `;
    }
  });

  console.log(JSON.stringify({
    level: 'info', msg: 'assistant replied', to: row.wa_phone, toolCalls: outcome.toolResults.length,
  }));
  await markWarmupStarted(db, job.pharmacy_id);
  return { sent: true, reason: decision.reason };
}

const HANDLERS = { process_inbound: processInbound };

async function tick() {
  const db = getSql();
  let job;
  try {
    job = await claimJob(db);
  } catch (err) {
    // A database blip must not kill the loop; the next tick retries.
    console.error(JSON.stringify({ level: 'error', msg: 'job claim failed', error: err.message }));
    return false;
  }
  if (!job) return false;

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await fail(db, job, new Error(`no handler for job kind "${job.kind}"`));
    return true;
  }

  try {
    await handler(db, job);
    await succeed(db, job);
  } catch (err) {
    await fail(db, job, err);
  }
  return true;
}

/**
 * Return stock from holds nobody confirmed, and tell those customers.
 *
 * Throttled to once a minute rather than running every loop: this scans for
 * due orders, and the loop runs every couple of seconds. Held stock coming
 * back a minute late costs nothing; hammering the database for it costs
 * connections, which is the failure that already took this system down once.
 */
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60_000;

async function sweepExpiredHolds(db) {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = Date.now();

  const expired = await expireStaleHolds();
  for (const order of expired) {
    console.log(JSON.stringify({
      level: 'info', msg: 'reservation expired, stock returned',
      reference: order.reference, orderId: order.id,
    }));

    // Tell the customer. They were never promised the stock — only that the
    // request went to the pharmacy — so this reports an outcome rather than
    // breaking a promise. Best-effort: a failed send must not stop the next
    // order's stock from being released.
    try {
      const [target] = await db`
        select c.wa_jid, c.wa_phone, wa.id as account_id
        from orders o
        join customers c on c.id = o.customer_id
        left join whatsapp_accounts wa
          on wa.pharmacy_id = o.pharmacy_id and wa.provider = 'baileys' and wa.status = 'connected'
        where o.id = ${order.id}
      `;
      if (!target?.account_id) continue;

      const body = `Order ${order.reference} has expired because the pharmacy did not confirm it in time. `
        + 'Nothing has been charged. Please message us again if you still need it.';

      const sent = await sessionManager.sendText(
        target.account_id,
        target.wa_jid || `${target.wa_phone}@s.whatsapp.net`,
        body,
        { delay: false },
      );
      if (order.conversation_id) {
        await db`
          insert into messages (pharmacy_id, conversation_id, direction, author, body,
                                provider_message_id, delivery_status)
          values (${order.pharmacy_id}, ${order.conversation_id}, 'outbound', 'system', ${body},
                  ${sent.providerMessageId}, 'sent')
        `;
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'warn', msg: 'could not tell customer their hold expired',
        reference: order.reference, error: err.message,
      }));
    }
  }
}

function start() {
  if (running) return;
  running = true;

  const loop = async () => {
    if (!running) return;
    try {
      await sweepExpiredHolds(getSql());
      // Drain rather than sleeping between each job, so a burst is not
      // served at one message per poll interval.
      let worked = true;
      let guard = 0;
      while (worked && running && guard++ < 50) worked = await tick();
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'worker loop error', error: err.message }));
    }
    if (running) timer = setTimeout(loop, env.worker.pollIntervalMs);
  };

  loop();
  console.log(JSON.stringify({ level: 'info', msg: 'job worker started', workerId: WORKER_ID }));
}

function stop() {
  running = false;
  clearTimeout(timer);
}

module.exports = { start, stop, tick, HANDOFF_REASON };
