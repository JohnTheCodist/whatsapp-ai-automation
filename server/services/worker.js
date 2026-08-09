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
const { normalizeMsisdn } = require('./whatsapp/senderIdentity');
const { respond } = require('./ai/assistant');
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
           conv.id as conversation_id, conv.mode, conv.context,
           cust.wa_phone, cust.wa_jid, cust.display_name,
           ph.name as pharmacy_name, ph.reply_mode, ph.sending_paused,
           ph.daily_reply_cap, ph.hourly_conversation_cap,
           ph.quiet_hours_enabled, ph.quiet_hours_start, ph.quiet_hours_end,
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

  if (!row.wa_jid) throw new Error(`customer has no wa_jid to reply to (message ${messageId})`);
  if (row.account_status !== 'connected') {
    throw new Error(`whatsapp account is ${row.account_status}, cannot send`);
  }

  // Recent turns, so "I want two" has something to refer back to. Fetched
  // oldest-first because that is the order a conversation happened in.
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
  });

  // ---- escalate -----------------------------------------------------------
  if (outcome.action === 'handoff') {
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

function start() {
  if (running) return;
  running = true;

  const loop = async () => {
    if (!running) return;
    try {
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
