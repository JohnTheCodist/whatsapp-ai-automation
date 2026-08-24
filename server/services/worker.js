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
const { shouldClose, IDLE_HOURS } = require('./whatsapp/conversationPolicy');
// Every workflow_state write goes through this service — see conversationState.js
// for the transition matrix it enforces.
const { onAssistantReplied } = require('./whatsapp/conversationService');
const { raiseOrConsolidateHandoff } = require('./whatsapp/handoffService');
const { evaluateWarmup } = require('./whatsapp/warmupPolicy');
const { normalizeMsisdn } = require('./whatsapp/senderIdentity');
const { expireStaleHolds } = require('./orders/orderService');
const { escalationMessage, readEscalationAnswer } = require('./safety/escalationMessage');
const { sendAndRecordOutbound, insertOutboundMessage } = require('./whatsapp/outboundMessage');
const { CATEGORIES } = require('./whatsapp/communicationPolicy');
const { recordEvent } = require('./customers/customerEvents');
const { PATIENT_EVENTS } = require('./customers/patientEventTypes');
const { respond } = require('./ai/assistant');
const { screenMessage } = require('./safety/clinicalFilter');
const clinicalRouter = require('./clinical/clinicalRouter');
const { handleTurn, isClinicalWorkflowEnabled } = require('./clinical/clinicalWorkflow');
const { buildMenu, buildWelcome, isMenuRequest, isGreeting, parseSelection, intentBriefing } = require('./ai/menu');
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
/**
 * How long a job may sit in 'running' before another worker may take it.
 *
 * Longer than any legitimate job: the slowest path is an LLM turn (20s
 * timeout) plus a WhatsApp send (30s timeout) plus database work, so a real
 * job finishes well inside a minute. Five minutes means a reclaim is
 * genuinely a stuck worker, not a slow one — reclaiming too eagerly would
 * double-send a reply that was merely taking its time.
 */
const STALE_LOCK_MINUTES = 5;

/**
 * How long one job may take before the loop gives up on it.
 *
 * Generous, because a legitimate inbound turn can involve several model
 * round-trips plus a WhatsApp send. It is not a performance budget — it is
 * the line past which "slow" is indistinguishable from "hung", and a hung
 * job costs every LATER message for that pharmacy, not just its own.
 *
 * Comfortably above the send timeout (30s) and the LLM timeout, so a normal
 * inner failure surfaces as itself rather than as this.
 */
const JOB_TIMEOUT_MS = parseInt(process.env.WORKER_JOB_TIMEOUT_MS || '120000', 10);

/** The same idea for the periodic scans, which are much shorter. */
const SWEEP_TIMEOUT_MS = parseInt(process.env.WORKER_SWEEP_TIMEOUT_MS || '60000', 10);

/**
 * Bound a promise that might never settle.
 *
 * THE FAILURE THIS EXISTS FOR
 * The worker loop awaits its sweeps and its job handler, then reschedules
 * itself on the last line. A promise that REJECTS is fine — the catch runs
 * and the loop continues. A promise that never settles at all is fatal: the
 * loop never reaches setTimeout, no further tick is ever scheduled, and the
 * worker is dead while the process keeps happily serving HTTP. Nothing logs,
 * because nothing failed.
 *
 * Measured in production: one job left locked for 17 hours, an inbound
 * message queued behind it and never answered, and /api/health returning 200
 * the entire time. From the outside the assistant had simply stopped
 * replying.
 *
 * A rejection is recoverable; a hang is not. This converts the second into
 * the first.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms — treating as failed`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Give up on jobs whose worker never came back AND whose attempts are spent.
 *
 * claimJob reclaims an abandoned `running` job only while `attempts <
 * max_attempts`, which is right — a job that hangs repeatedly should stop
 * being retried. But nothing then finished the story: `fail()` only runs for
 * a job this process actually claimed, so when a worker dies mid-job on its
 * final attempt the row stays `running` forever. It is not reclaimable, not
 * dead, and not visible as a problem anywhere.
 *
 * That row is harmless to the queue itself — claimJob skips it — but it hides
 * the fact that a message was never processed, which is the part that matters
 * to the pharmacy.
 */
async function sweepAbandonedJobs(db) {
  const abandoned = await db`
    update jobs
    set status = 'dead',
        last_error = coalesce(last_error, '') ||
          ' [dead-lettered: worker never returned and attempts were exhausted]',
        updated_at = now()
    where status = 'running'
      and attempts >= max_attempts
      and locked_at < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
    returning id, kind, attempts, locked_by
  `;
  for (const j of abandoned) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'job dead-lettered — its worker never returned',
      jobId: j.id, kind: j.kind, attempts: j.attempts, lockedBy: j.locked_by,
    }));
  }
  return abandoned.length;
}

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
      -- Two kinds of claimable work:
      --   1. queued, due now — the ordinary case.
      --   2. RUNNING but abandoned. A worker that is killed mid-job, or that
      --      blocks forever inside one (a half-open WhatsApp socket did
      --      exactly this), leaves its row locked with no owner coming back.
      --      Nothing used to reclaim those: claimJob only ever looked at
      --      'queued', so a single stuck job silently ended every reply for
      --      that pharmacy — no error, no retry, no alert.
      --
      -- The attempts < max_attempts guard keeps the existing give-up rule
      -- intact, so a job that hangs repeatedly still dead-letters rather
      -- than being reclaimed forever.
      where (
        (status = 'queued' and run_after <= now())
        or (
          status = 'running'
          and locked_at < now() - make_interval(mins => ${STALE_LOCK_MINUTES})
          and attempts < max_attempts
        )
      )
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
/**
 * Is this inbound message from the pharmacy's own alert number?
 *
 * Compared on digits only. The two values reach the database by different
 * routes — notify_phone is typed into a settings form, wa_phone is derived
 * from a WhatsApp JID — so one may carry a +, spaces or a leading 0 that the
 * other does not, and a string compare would silently never match. A staff
 * number that fails to be recognised is not a quiet failure: it means the
 * pharmacist gets sold to by their own assistant.
 */
function phoneMatchesStaff(waPhone, notifyPhone) {
  if (!waPhone || !notifyPhone) return false;
  const digits = (s) => String(s).replace(/\D/g, '');
  const a = digits(waPhone);
  const b = digits(notifyPhone);
  if (!a || !b) return false;
  // Suffix match, because 2348036607553 and 08036607553 are the same phone
  // written two ways. Bounded to 9 digits so two short or malformed values
  // cannot collide into a false positive.
  const tail = (s) => s.slice(-9);
  return a === b || (a.length >= 9 && b.length >= 9 && tail(a) === tail(b));
}

/**
 * Is this inbound message from the pharmacy's own alert number?
 *
 * Phone match alone misses a real case: WhatsApp is migrating this account
 * to LID addressing (see senderIdentity.js), and a message addressed by LID
 * without the phone-number alt JID leaves wa_phone NULL — a real staff
 * reply that phoneMatchesStaff can never see, no matter how it is compared.
 * Falling through from there sends the reply to the sales assistant instead
 * of confirming or rejecting the order.
 *
 * notifyLid has no source of truth to resolve up front — there is no API
 * here for "what LID does this phone number have" — so it is learned
 * opportunistically: the first message that proves itself by phone AND
 * carries a LID teaches processInbound that LID for next time (see below).
 * Until it is learned, a LID-only reply from a brand-new staff number is
 * still missed once; every reply after the first phone-bearing one matches.
 */
function isStaffNumber(waPhone, waLid, notifyPhone, notifyLid) {
  if (phoneMatchesStaff(waPhone, notifyPhone)) return true;
  return Boolean(waLid && notifyLid && waLid === notifyLid);
}

/**
 * Staff acting on orders from their own WhatsApp.
 *
 * Deliberately narrow: it recognises order commands and otherwise says so.
 * It does NOT hand unrecognised text to the assistant, because the assistant
 * is a shop front and this person is not shopping — an unhandled "morning"
 * from the pharmacist should be a quiet hint about the commands, not a
 * product recommendation.
 */
async function handleStaffMessage(db, job, row) {
  const { parseStaffCommand, helpText } = require('./orders/staffCommands');
  const { updateStatus, listOrders } = require('./orders/orderService');

  const reply = async (body) => {
    if (!row.account_id || !row.wa_jid) return;
    // No delay: this is an internal exchange with the pharmacy's own staff,
    // not a customer reply that should look human-paced.
    await sessionManager.sendText(row.account_id, row.wa_jid, body, { delay: false })
      .catch((err) => console.error(JSON.stringify({
        level: 'warn', msg: 'staff reply failed', error: err.message,
      })));
  };

  // `let`, because a reference-less command ("1", "ok") is resolved into a
  // concrete one below once we know which order it can only have meant.
  let cmd = parseStaffCommand(row.body);

  if (!cmd) {
    await reply(`This number is set as ${row.pharmacy_name}'s alert line, so I don't sell to it.\n\n${helpText()}`);
    return { sent: true, reason: 'staff:not_a_command' };
  }

  if (cmd.kind === 'help') {
    await reply(helpText());
    return { sent: true, reason: 'staff:help' };
  }

  // "1", "ok", "reject" — an instruction with no order named.
  //
  // Resolved ONLY when there is exactly one order waiting, which is the
  // common case in a single-counter pharmacy and is unambiguous. With two or
  // more, this asks instead of guessing: the last order the system saw and
  // the last one the pharmacist read are different things, and picking the
  // wrong one confirms stock for the wrong customer.
  if (cmd.kind === 'needs_reference') {
    const pending = await listOrders(job.pharmacy_id, { status: 'pending', limit: 10 });

    if (pending.length === 0) {
      await reply('Nothing is waiting for a decision right now.');
      return { sent: true, reason: 'staff:nothing_pending' };
    }

    if (pending.length > 1) {
      const lines = pending.map((o) => {
        const items = (o.items || []).map((i) => `${i.quantity} x ${i.name_snapshot}`).join(', ');
        return `${o.reference} — ${items || 'no items'}`;
      });
      await reply(
        `${pending.length} orders are waiting, so I need to know which one:\n\n${lines.join('\n')}\n\n` +
        `Reply with the reference, e.g. "1 ${pending[0].reference}".`,
      );
      return { sent: true, reason: 'staff:ambiguous' };
    }

    cmd = { kind: 'act', action: cmd.action, reference: pending[0].reference.toUpperCase() };
  }

  if (cmd.kind === 'list') {
    const orders = await listOrders(job.pharmacy_id, { status: 'pending', limit: 10 });
    if (orders.length === 0) {
      await reply('Nothing waiting — every order has been dealt with.');
      return { sent: true, reason: 'staff:list_empty' };
    }
    const lines = orders.map((o) => {
      const items = (o.items || []).map((i) => `${i.quantity} x ${i.name_snapshot}`).join(', ');
      return `${o.reference} — ${items || 'no items'} — ₦${Number(o.total_kobo / 100).toLocaleString('en-NG')}`;
    });
    await reply(`${orders.length} waiting:\n\n${lines.join('\n')}\n\nReply e.g. "OK ${orders[0].reference}".`);
    return { sent: true, reason: 'staff:list' };
  }

  // ---- act on one named order ----
  const [order] = await db`
    select id, reference, status from orders
    where pharmacy_id = ${job.pharmacy_id} and upper(reference) = ${cmd.reference}
  `;
  if (!order) {
    await reply(`I can't find order ${cmd.reference} for this pharmacy. Send LIST to see what is waiting.`);
    return { sent: true, reason: 'staff:unknown_reference' };
  }

  // Goes through the same service the dashboard uses, so ALLOWED_TRANSITIONS,
  // the stock commit, the audit trail and the customer notification all
  // behave identically. A second path that "just updates the row" is how the
  // two surfaces drift until one of them is wrong.
  const result = await updateStatus(job.pharmacy_id, order.id, cmd.action, {
    actorType: 'staff',
    note: 'Actioned from WhatsApp',
  });

  if (!result.ok) {
    await reply(
      result.code === 'INSUFFICIENT_STOCK'
        ? `Could not confirm ${order.reference} — ${result.error}`
        : `Could not do that: ${result.error}`,
    );
    return { sent: true, reason: `staff:refused:${result.code}` };
  }

  // Telling the customer is the caller's job on this path — the dashboard
  // route does it in routes/orders.js, and skipping it here would mean an
  // order confirmed from WhatsApp left the customer waiting in silence.
  const notified = await notifyCustomerOfStatus(db, job.pharmacy_id, order.id, cmd.action);

  await reply(
    `${order.reference} is now ${cmd.action}.` +
    (notified ? ' The customer has been told.' : ' NOTE: the customer could NOT be messaged — please call them.'),
  );

  console.log(JSON.stringify({
    level: 'info', msg: 'order actioned from staff whatsapp',
    reference: order.reference, to: cmd.action, notified,
  }));
  return { sent: true, reason: `staff:${cmd.action}` };
}

/**
 * Tell the customer their order moved. Shared shape with routes/orders.js.
 *
 * Best-effort by design: the status change is a fact about the pharmacy's own
 * records and must not be rolled back because WhatsApp happened to be down.
 * The boolean is returned so staff can be told to phone instead.
 */
async function notifyCustomerOfStatus(db, pharmacyId, orderId, toStatus) {
  try {
    const { customerMessage } = require('./orders/orderMessages');
    const [target] = await db`
      select o.*, c.id as customer_id, c.wa_jid, c.wa_phone, o.conversation_id
      from orders o join customers c on c.id = o.customer_id
      where o.id = ${orderId} and o.pharmacy_id = ${pharmacyId}
    `;
    const body = target ? customerMessage(target, toStatus) : null;
    if (!body) return false;

    const [account] = await db`
      select id from whatsapp_accounts
      where pharmacy_id = ${pharmacyId} and provider = 'baileys' and status = 'connected'
      limit 1
    `;
    if (!account) return false;

    if (target.conversation_id) {
      await sendAndRecordOutbound(db, {
        pharmacyId, customerId: target.customer_id, conversationId: target.conversation_id,
        accountId: account.id, to: target.wa_jid || `${target.wa_phone}@s.whatsapp.net`,
        body, author: 'system', delay: false, category: CATEGORIES.ORDER_NOTIFICATION,
      });
    } else {
      await sessionManager.sendText(
        account.id, target.wa_jid || `${target.wa_phone}@s.whatsapp.net`, body, { delay: false },
      );
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'warn', msg: 'could not tell customer about staff action', error: err.message,
    }));
    return false;
  }
}

async function processInbound(db, job) {
  const { messageId, conversationId } = job.payload || {};
  if (!messageId || !conversationId) {
    throw new Error(`process_inbound payload missing messageId/conversationId: ${JSON.stringify(job.payload)}`);
  }

  const [row] = await db`
    select m.id, m.body,
           conv.id as conversation_id, conv.mode, conv.context, conv.last_menu_choice,
           cust.id as customer_id, cust.wa_phone, cust.wa_jid, cust.wa_lid, cust.display_name, cust.full_name,
           cust.onboarded_at, cust.customer_type,
           ph.name as pharmacy_name, ph.reply_mode, ph.sending_paused,
           ph.notify_phone, ph.notify_lid,
           (select phone from pharmacy_profile pp where pp.pharmacy_id = ph.id) as pharmacy_phone,
           ph.bot_name, ph.assistant_tone, ph.menu_enabled, ph.welcome_note,
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

  // ---- is this the pharmacy's own staff, not a customer? --------------
  //
  // Checked BEFORE everything else — before the mode gate, the opt-out
  // check, the conduct gate and the assistant. The staff number is not a
  // customer of the pharmacy, and every gate below this line is written on
  // the assumption that it is talking to one. Left to fall through, a
  // pharmacist replying "ok 97G-YX4" to an order alert would be answered by
  // the sales assistant, counted against the daily reply cap, and could in
  // principle be sold their own stock.
  //
  // Authorisation is the phone number itself. That is weak in the abstract —
  // but it is the same trust this system already places in notify_phone when
  // it SENDS a briefing there, which contains the customer's name, their
  // medicines and their complaint. A number trusted to receive all of that
  // is not made less trustworthy by being allowed to answer.
  if (isStaffNumber(row.wa_phone, row.wa_lid, row.notify_phone, row.notify_lid)) {
    // Learn the LID this reply proved itself under, so the NEXT one still
    // matches even if it carries no phone number at all — see isStaffNumber.
    // Only on a fresh phone match, and only when it disagrees with what is
    // already stored, so this stays a single cheap write on the rare message
    // that actually teaches us something rather than a write on every reply.
    if (row.wa_lid && row.wa_lid !== row.notify_lid && phoneMatchesStaff(row.wa_phone, row.notify_phone)) {
      await db`update pharmacies set notify_lid = ${row.wa_lid} where id = ${job.pharmacy_id}`;
    }
    return handleStaffMessage(db, job, row);
  }

  // A conversation a human has taken over must not be talked over. A handoff
  // the assistant can ignore is not a handoff.
  if (row.mode !== 'bot') {
    return { sent: false, reason: `conversation_mode:${row.mode}` };
  }

  // ---- did they answer "would you like a pharmacist?" ---------------------
  //
  // Handled before the assistant runs. A bare "yes" carries no meaning on its
  // own, and letting the model see it would produce "yes to what?" — to a
  // question it asked one message earlier.
  const pendingEscalation = row.context?.pending_escalation;
  if (pendingEscalation) {
    const answer = readEscalationAnswer(row.body);

    if (answer === true) {
      // NOT mode = 'human' here. The handoff row (and the WAITING_FOR_
      // PHARMACIST workflow state) was already raised when the question was
      // first flagged — this is the customer accepting an offer, not a
      // pharmacist accepting the conversation. Muting now would mean the
      // very next thing this reply invites ("They'll reply here") cannot
      // itself be answered if the customer has a follow-up before the
      // pharmacist gets to it. See conversationState.deriveOwnership.
      await db`
        update conversations
        set context = (coalesce(context, '{}'::jsonb) - 'pending_escalation')
        where id = ${row.conversation_id}
      `;
      const body = "I've passed you to our pharmacist. They'll reply here. I'm still here for anything else in the meantime.";
      await sendAndRecordOutbound(db, {
        pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
        accountId: row.account_id, to: row.wa_jid, body, author: 'system', category: CATEGORIES.TRANSACTIONAL,
      });
      return { sent: true, reason: 'escalation_accepted' };
    }

    if (answer === false) {
      // Declining closes the handoff: leaving it open would fill the staff
      // Inbox with people who said they did not want help, and the ones who
      // do want it would be lost among them.
      await db.begin(async (tx) => {
        await tx`
          update handoffs set resolved_at = now()
          where conversation_id = ${row.conversation_id} and resolved_at is null
        `;
        await tx`
          update conversations
          set context = (coalesce(context, '{}'::jsonb) - 'pending_escalation')
          where id = ${row.conversation_id}
        `;
      });
      const body = "No problem. I'm still here for prices, what we have in stock, and placing an order.";
      await sendAndRecordOutbound(db, {
        pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
        accountId: row.account_id, to: row.wa_jid, body, author: 'system', category: CATEGORIES.TRANSACTIONAL,
      });
      return { sent: true, reason: 'escalation_declined' };
    }

    // Neither yes nor no — they moved on, or asked something else. Drop the
    // question and treat this as an ordinary message rather than pressing
    // for an answer they have clearly decided not to give.
    await db`
      update conversations
      set context = (coalesce(context, '{}'::jsonb) - 'pending_escalation')
      where id = ${row.conversation_id}
    `;
  }

  // ---- "stop messaging me" is honoured before anything else ---------------
  //
  // Recorded even when this pharmacy would not have replied anyway, so the
  // request stands if the reply mode is widened later. Continuing to message
  // someone who asked you to stop is the clearest signal of a system worth
  // banning, and is wrong regardless of whether anyone is watching.
  if (isOptOutRequest(row.body)) {
    // `do update set opted_out_at = opt_outs.opted_out_at` is a no-op write
    // that still RETURNs the row either way — a plain `do nothing` would
    // return nothing on a repeat opt-out, and the event below needs this
    // row's own id as its idempotency key regardless of which branch fired.
    const [optOut] = await db`
      insert into opt_outs (pharmacy_id, wa_phone, source_text)
      values (${job.pharmacy_id}, ${normalizeMsisdn(row.wa_phone, env.defaultCountryCode) || row.wa_phone},
              ${String(row.body).slice(0, 300)})
      on conflict (pharmacy_id, wa_phone) do update set opted_out_at = opt_outs.opted_out_at
      returning id, opted_out_at
    `;
    // Cache write-through, by id rather than by phone match — opt_outs
    // above stays the source of truth conductPolicy actually enforces;
    // this column only exists so a dashboard list can filter/display
    // without a join. Keeping both in the same statement's neighbourhood
    // means there is exactly one place "someone opted out" happens.
    // Marketing is switched off explicitly as well as the channel-level
    // opt-out. Both matter: communication_status is what blocks sends today,
    // but leaving comm_marketing true would mean that if the customer ever
    // re-subscribes to the channel they are silently back on the promotions
    // list they never re-consented to.
    //
    // The other categories are deliberately NOT cleared. The channel-level
    // opt-out already blocks everything (see communicationPolicy's ordering),
    // and zeroing them would destroy the customer's actual preferences — so a
    // later opt-in would resurrect them as someone who wants nothing rather
    // than someone who wanted order updates.
    const [prev] = await db`
      update customers
      set communication_status = 'opted_out', comm_marketing = false
      where id = ${row.customer_id}
      returning (select comm_marketing from customers where id = ${row.customer_id}) as had_marketing
    `;

    // Consent history: what changed, who changed it, and in their own words.
    // "We never subscribed them to that" needs to be answerable months later.
    await db`
      insert into communication_preference_history
        (pharmacy_id, customer_id, preference, previous_state, new_state, source, reason)
      values
        (${job.pharmacy_id}, ${row.customer_id}, 'whatsapp', 'subscribed', 'opted_out',
         'customer', ${String(row.body).slice(0, 300)})
    `;

    await recordEvent(db, {
      pharmacyId: job.pharmacy_id, customerId: row.customer_id,
      eventType: PATIENT_EVENTS.COMMUNICATION_OPTED_OUT, occurredAt: optOut.opted_out_at, actorType: 'customer',
      entityType: 'opt_out', entityId: optOut.id,
    });
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
        -- LOOP DETECTION, BOUNDED IN TIME.
        --
        -- "recent" has to mean recent. Without the interval this looked at
        -- the last three outbound messages in the conversation FOREVER: once
        -- a bug made the assistant repeat itself three times, the count
        -- stayed at 3 for all eternity, tripping the breaker on every
        -- subsequent message and latching the pharmacy off permanently.
        -- Clearing sending_paused did nothing, because the very next inbound
        -- re-tripped it from the same historical rows.
        --
        -- That is the difference between a circuit breaker and a fuse. A
        -- breaker stops a live fault and then lets the system recover once
        -- the fault is gone; a fuse stays blown. This is meant to be a
        -- breaker.
        --
        -- 15 minutes: long enough to catch a genuine live loop (which fires
        -- within seconds), short enough that a fixed fault clears without a
        -- human resetting a flag by hand.
        (select count(*)::int from (
           select body from messages
           where conversation_id = ${row.conversation_id} and direction = 'outbound'
             and created_at > now() - interval '15 minutes'
           order by id desc limit 3
         ) recent
         where recent.body = (
           select body from messages
           where conversation_id = ${row.conversation_id} and direction = 'outbound'
             and created_at > now() - interval '15 minutes'
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
  // like anything else, and BEFORE the assistant, because both the welcome
  // and the menu are fixed strings and do not need a model.
  //
  // Gated on `onboarded_at` — a CUSTOMER fact (0028), never a conversation
  // one. Conversations now have a real lifecycle (see conversationPolicy):
  // any gap past IDLE_HOURS starts a new conversation row, and a flag stored
  // there would make a customer who has ordered a dozen times look brand new
  // the moment their thread ages out. onboarded_at persists across every
  // conversation a customer ever has, which is the whole point of it.
  const menuOn = row.menu_enabled !== false;
  const wantsMenu = menuOn && isMenuRequest(row.body);
  const isFirstContact = menuOn && !row.onboarded_at;
  // A bare "Good morning" from someone never onboarded gets the SHORT
  // welcome, not the full itemized menu — see buildWelcome's own comment for
  // why. Checked only when isFirstContact: a returning customer's greeting
  // never reaches this function at all, it goes straight to the AI below,
  // which already replies to small talk naturally.
  const isBareGreeting = isFirstContact && !wantsMenu && isGreeting(row.body);

  // Explicit "menu" always wins over a bare-greeting welcome — someone who
  // typed the word asked for the full list, not a one-line hello, even on
  // their very first message (Test B: first message IS "menu").
  if (wantsMenu) {
    const text = buildMenu({
      pharmacyName: row.pharmacy_name,
      botName: row.bot_name,
      customerName: row.display_name,
      welcomeNote: row.welcome_note,
      returning: Boolean(row.onboarded_at),
    });

    const sent = await sessionManager.sendText(row.account_id, row.wa_jid, text);
    await db.begin(async (tx) => {
      await insertOutboundMessage(tx, {
        pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
        providerMessageId: sent.providerMessageId, body: text, author: 'assistant',
        category: CATEGORIES.TRANSACTIONAL, eligibilityReason: 'REPLY_TO_CUSTOMER',
      });
      await tx`update conversations set last_message_at = now() where id = ${row.conversation_id}`;
      await tx`update customers set onboarded_at = coalesce(onboarded_at, now()) where id = ${row.customer_id}`;
    });

    console.log(JSON.stringify({ level: 'info', msg: 'menu sent', to: row.wa_phone, returning: Boolean(row.onboarded_at) }));
    await markWarmupStarted(db, job.pharmacy_id);
    return { sent: true, reason: 'menu_requested' };
  }

  if (isBareGreeting) {
    const text = buildWelcome({
      pharmacyName: row.pharmacy_name,
      botName: row.bot_name,
      // WhatsApp's pushName — what the customer calls themselves. Used as a
      // greeting only, never as identity.
      customerName: row.display_name,
      welcomeNote: row.welcome_note,
    });

    const sent = await sessionManager.sendText(row.account_id, row.wa_jid, text);
    await db.begin(async (tx) => {
      await insertOutboundMessage(tx, {
        pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
        providerMessageId: sent.providerMessageId, body: text, author: 'assistant',
        category: CATEGORIES.TRANSACTIONAL, eligibilityReason: 'REPLY_TO_CUSTOMER',
      });
      await tx`update conversations set last_message_at = now() where id = ${row.conversation_id}`;
      await tx`update customers set onboarded_at = now() where id = ${row.customer_id}`;
    });

    console.log(JSON.stringify({ level: 'info', msg: 'welcome sent', to: row.wa_phone }));
    await markWarmupStarted(db, job.pharmacy_id);
    return { sent: true, reason: 'greeting' };
  }

  // First-ever contact, but the message is a real request ("I need
  // paracetamol"), not small talk. Marked onboarded silently — no canned
  // message sent — so this decision does not fire again on their next
  // message, and execution falls straight through to the AI below so the
  // request is answered in THIS turn rather than deferred behind a menu
  // nobody asked for.
  if (isFirstContact) {
    await db`update customers set onboarded_at = now() where id = ${row.customer_id} and onboarded_at is null`;
  }

  // A bare number is a menu choice. "I want 1 pack" is not, and parseSelection
  // deliberately refuses to read it as one.
  //
  // ONLY before the customer has picked something this conversation.
  // Without this, a bare digit is reinterpreted as a fresh top-level menu
  // pick for the rest of the conversation's life — including while the
  // assistant is mid-flow and has itself just asked a numeric question
  // ("how many packs?"). Menu key 4 is "Speak to the pharmacist"; a
  // customer answering "4 tablets" got silently escalated to a human
  // instead of the assistant ever seeing "4" as an answer to its own
  // question. Once last_menu_choice is set, further digits are just text
  // and go to the assistant like anything else — "menu" (isMenuRequest,
  // checked earlier) still works at any point if they want to start over.
  const choice = menuOn && !row.last_menu_choice ? parseSelection(row.body, {
    pharmacyName: row.pharmacy_name, botName: row.bot_name,
  }) : null;

  // "Speak to the pharmacist" is the only option that is not a question for
  // the assistant. It replaced the spec's "health questions, symptoms &
  // advice", which the clinical filter would have refused anyway — so it goes
  // straight to a person rather than through a model that must decline.
  if (choice?.intent === 'pharmacist') {
    let raised;
    await db.begin(async (tx) => {
      raised = await raiseOrConsolidateHandoff(tx, {
        pharmacyId: job.pharmacy_id, conversationId: row.conversation_id, customerId: row.customer_id,
        reason: 'customer_request', category: 'human_requested',
        detail: 'Chose "Speak to the pharmacist" from the menu.',
        triggeredBy: 'customer', actorType: 'customer',
      });
      // last_menu_choice only — NOT mode. A human replies once a pharmacist
      // explicitly takes over (POST /takeover); asking for one is not that.
      // See conversationState.deriveOwnership for why this distinction is
      // the whole point of this ticket.
      await tx`update conversations set last_menu_choice = ${choice.intent} where id = ${row.conversation_id}`;
    });

    // Asking a second time while already pending gets a shorter, distinct
    // acknowledgement — repeating the full "a pharmacist will reply" promise
    // would read as the system having forgotten it already said this once.
    const ack = raised.isNew
      ? 'A pharmacist will reply here shortly. Please tell us what you need in the meantime.'
      : "You're already in the queue for a pharmacist — no need to ask again. I'm still here for anything else while you wait.";
    await sendAndRecordOutbound(db, {
      pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
      accountId: row.account_id, to: row.wa_jid, body: ack, author: 'system', category: CATEGORIES.TRANSACTIONAL,
    });
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

  // ---- clinical protocol engine ------------------------------------------
  //
  // Runs BEFORE respond(), because respond()'s first act is screenMessage(),
  // which hard-returns a handoff for any symptom description and so would
  // never let the engine see the message at all.
  //
  // This is a NARROWING, not a widening: every message routed here is one
  // the filter was already sending straight to a pharmacist. The engine asks
  // the protocol's approved triage questions first, then escalates with a
  // structured briefing instead of the bare "customer mentioned cough" the
  // pharmacist gets today. Anything the router declines falls through
  // untouched to exactly the path it takes now.
  const clinicalDecision = await clinicalRouter.route({
    pharmacyId: job.pharmacy_id,
    screening: screenMessage(row.body),
    text: row.body,
    context: row.context || {},
  }).catch(() => ({ route: false, reason: 'router_error' }));

  if (clinicalDecision.route && await isClinicalWorkflowEnabled(job.pharmacy_id)) {
    // Same reasoning as the assistant path below: the clinical engine takes
    // real time, and a patient describing a symptom into silence is the last
    // person who should be left wondering whether anyone is there.
    const stopClinicalTyping = sessionManager.startTyping(row.account_id, row.wa_jid);
    let turn;
    try {
      turn = await handleTurn(job.pharmacy_id, {
        conversationId: row.conversation_id,
        customerId: row.customer_id,
        protocolSlug: clinicalDecision.slug,
        patientMessage: row.body,
        answeringKey: clinicalDecision.answeringKey || null,
      });
    } finally {
      stopClinicalTyping();
    }

    // Remember which question is outstanding so the customer's NEXT message
    // ("3 days") is read as its answer rather than as a fresh question. On
    // any non-CONTINUE outcome the run is no longer awaiting input, so the
    // key is cleared — leaving a stale one would capture unrelated messages
    // into a finished assessment.
    const runContext = turn.outcome === 'CONTINUE' && turn.question
      ? { clinical_run: { slug: clinicalDecision.slug, awaiting_key: turn.question.key } }
      : { clinical_run: null };

    // SEND BEFORE RECORDING — the same discipline every other reply path in
    // this file follows (see outboundMessage.js's own header on why: "no
    // path here records MESSAGE_SENT for a send that didn't happen").
    //
    // This branch used to do the opposite. The transaction below — message
    // row written as delivery_status 'sent', conversation context moved to
    // "awaiting the patient's answer", onAssistantReplied clearing the
    // pharmacist queue — committed BEFORE the WhatsApp send was even
    // attempted, and a failed send was then swallowed into a console.error
    // instead of being allowed to fail the job. A dead socket meant every
    // observable record insisted the patient had been asked and the ball
    // was in their court, while they had received nothing and nothing was
    // ever retried — worse than a job stuck visibly `running`, because
    // nothing here ever surfaced as broken.
    //
    // Sending first and letting a genuine failure propagate (as every other
    // branch already does) means a bad send fails the job and the queue
    // retries it, instead of the failure vanishing into an internally
    // consistent lie.
    let sent = null;
    if (turn.patientMessage) {
      sent = await sessionManager.sendText(row.account_id, row.wa_jid, turn.patientMessage);
    }

    await db.begin(async (tx) => {
      await tx`
        update conversations
        set context = coalesce(context, '{}'::jsonb) || ${tx.json(runContext)}
        where id = ${row.conversation_id}
      `;
      if (turn.patientMessage) {
        await insertOutboundMessage(tx, {
          pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
          providerMessageId: sent.providerMessageId, body: turn.patientMessage, author: 'assistant',
          category: CATEGORIES.TRANSACTIONAL, eligibilityReason: 'REPLY_TO_CUSTOMER',
        });
      }
      // CONTINUE and RESOLVED both leave the ball with the customer — the
      // assistant asked something, or closed with safety-net advice and an
      // offer. REVIEW and URGENT have already raised a handoff inside
      // handleTurn, and marking those as "assistant replied" would take them
      // out of the pharmacist queue.
      if (turn.outcome === 'CONTINUE' || turn.outcome === 'RESOLVED') {
        await onAssistantReplied(tx, {
          pharmacyId: job.pharmacy_id, conversationId: row.conversation_id,
        });
      }
    });

    if (turn.patientMessage) {
      await markWarmupStarted(db, job.pharmacy_id);
    }

    console.log(JSON.stringify({
      level: 'info', msg: 'clinical protocol turn', to: row.wa_phone,
      protocol: clinicalDecision.slug, outcome: turn.outcome, reason: turn.reason,
      askedKey: turn.question?.key || null,
    }));
    return { sent: Boolean(turn.patientMessage), reason: `clinical:${turn.outcome}` };
  }

  // "typing…" for the part of the turn that actually takes time.
  //
  // respond() is where the seconds go — the model, plus any catalogue tool
  // calls it makes. sendText shows the indicator for its own pacing delay,
  // but that starts only once there is something to send, which is after
  // this. Without it the customer watches a silent chat through the whole
  // slow part and reasonably concludes the number is dead.
  //
  // Stopped in `finally`: a thrown assistant error must not leave the
  // pharmacy showing as permanently typing.
  const stopThinking = sessionManager.startTyping(row.account_id, row.wa_jid);
  let outcome;
  try {
    outcome = await respond({
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
    customer: {
      display_name: row.display_name,
      full_name: row.full_name,
      wa_phone: row.wa_phone,
      // Decides which price tier the catalogue tools return. Set once by the
      // trade QR code (0040) and never inferred here.
      customer_type: row.customer_type,
    },
    botName: row.bot_name,
    tone: row.assistant_tone,
    // A menu choice is a bare digit, which tells the model nothing on its
    // own. Passed as a FACT about what was chosen, not as an instruction —
    // same discipline as conversation context, so nothing arriving from a
    // customer can become a directive by routing through here.
    menuBriefing: choice ? intentBriefing(choice.intent, { pharmacyName: row.pharmacy_name }) : null,
    });
  } finally {
    stopThinking();
  }

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

    const escalation = escalationMessage(outcome.category, { pharmacyPhone: row.pharmacy_phone });

    let raised;
    await db.begin(async (tx) => {
      raised = await raiseOrConsolidateHandoff(tx, {
        pharmacyId: job.pharmacy_id, conversationId: row.conversation_id, customerId: row.customer_id,
        reason: HANDOFF_REASON[outcome.category] || 'unsupported', category: outcome.category,
        detail: `${outcome.category}: ${outcome.reason}`,
        triggeredBy: 'assistant', actorType: 'ai',
      });

      // NOT mode = 'human'. HANDOFF ≠ AI SILENCE — the assistant stays
      // available (within its safety boundaries; see the clinical filter
      // that produced `outcome.action === 'handoff'` in the first place)
      // until a pharmacist explicitly calls POST /:id/takeover. Muting here
      // used to mean a two-second clinical question froze a conversation
      // for however long the pharmacist queue took, even for "what time do
      // you close" asked five minutes later.
      //
      // Only the NEW-handoff, ask-permission case still writes anything to
      // context: pending_escalation exists so the customer's very next
      // message can be read as yes/no to an offer. A consolidated (repeat)
      // escalation does not re-ask, so it does not touch it — whatever
      // pending_escalation state already existed is left alone.
      if (raised.isNew && escalation.asksPermission) {
        await tx`
          update conversations
          set context = coalesce(context, '{}'::jsonb) || ${tx.json({
            pending_escalation: { category: outcome.category, asked_at: new Date().toISOString() },
          })}
          where id = ${row.conversation_id}
        `;
      }
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'handed off to staff',
      to: row.wa_phone,
      category: outcome.category,
      reason: outcome.reason,
      consolidated: !raised.isNew,
    }));

    // Tell a human, on their phone — but only for a genuinely NEW handoff.
    // A repeat clinical question while one is already open updates the SAME
    // handoff's detail (raiseOrConsolidateHandoff above) rather than paging
    // staff a second time about a conversation they already know is
    // waiting; §13's complaint is exactly a pharmacist receiving three
    // fragmented pings instead of one consolidated picture.
    //
    // Not awaited, and never allowed to throw: the handoff is already
    // recorded. A failed alert must not undo that, or a send error would
    // leave the customer un-escalated as well as un-notified.
    if (raised.isNew) {
      (async () => {
        const { buildBriefing } = require('./safety/consultationBriefing');
        const { alertStaffOfConsultation } = require('./orders/staffAlert');
        // Bounded, the same way the AI's own history load is (see
        // processInbound below). buildBriefing only needs the trigger message
        // and whatever came after it — before the conversation-close sweep
        // (0023) this conversation could hold days of unrelated traffic, and
        // even with sessions now segmented, an unbounded load stays a cost with
        // no benefit for what this actually renders.
        const history = (await db`
          select direction, body, created_at from messages
          where conversation_id = ${row.conversation_id} order by id desc limit 50
        `).reverse();
        const briefing = buildBriefing({
          category: outcome.category,
          requestedAt: new Date(),
          messages: history,
          context: row.context,
        });
        const r = await alertStaffOfConsultation(job.pharmacy_id, {
          briefing,
          customer: {
      display_name: row.display_name,
      full_name: row.full_name,
      wa_phone: row.wa_phone,
      // Decides which price tier the catalogue tools return. Set once by the
      // trade QR code (0040) and never inferred here.
      customer_type: row.customer_type,
    },
        });
        console.log(JSON.stringify({
          level: r.sent ? 'info' : 'warn', msg: 'consultation alert', sent: r.sent, reason: r.reason,
        }));
      })().catch((err) => console.error(JSON.stringify({
        level: 'error', msg: 'consultation alert threw', error: err.message,
      })));
    }

    // TELL THE CUSTOMER. A NEW handoff gets the full, named-reason message
    // (escalation.text) — the boundary explanation still matters the first
    // time. A CONSOLIDATED one gets a short "already reviewing" line instead
    // of repeating that full explanation, which is what Test 6 asks for:
    // acknowledge, do not guess, do not re-litigate the refusal.
    try {
      const ack = raised.isNew
        ? escalation.text
        : "A pharmacist is already reviewing this for you — I've added this to what they'll look at. "
          + "I don't want to guess on anything medication-related, but I'm still here for anything else.";
      if (!ack) return { sent: false, reason: `handoff:${outcome.category}` };
      await sendAndRecordOutbound(db, {
        pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
        accountId: row.account_id, to: row.wa_jid, body: ack, author: 'system', category: CATEGORIES.TRANSACTIONAL,
      });
      await markWarmupStarted(db, job.pharmacy_id);
    } catch (err) {
      // The handoff itself already succeeded and is what matters. A failed
      // acknowledgement must not roll it back, or a send error would leave
      // the pharmacist unaware of a customer who needs them.
      console.error(JSON.stringify({
        level: 'warn', msg: 'could not acknowledge handoff to customer', error: err.message,
      }));
    }

    return { sent: false, reason: `handoff:${outcome.category}`, consolidated: !raised.isNew };
  }

  // ---- answer -------------------------------------------------------------
  const sent = await sessionManager.sendText(row.account_id, row.wa_jid, outcome.text);

  await db.begin(async (tx) => {
    await insertOutboundMessage(tx, {
      pharmacyId: job.pharmacy_id, customerId: row.customer_id, conversationId: row.conversation_id,
      providerMessageId: sent.providerMessageId, body: outcome.text, author: 'assistant',
      category: CATEGORIES.TRANSACTIONAL, eligibilityReason: 'REPLY_TO_CUSTOMER',
    });
    if (outcome.contextUpdate) {
      // Merged, not replaced, so remembering a product does not forget
      // whatever else the conversation was carrying.
      await tx`
        update conversations
        set context = context || ${tx.json(outcome.contextUpdate)}
        where id = ${row.conversation_id}
      `;
    }
    // We answered, so the ball is with the customer. Inside the same
    // transaction as the outbound row: a thread recorded as replied-to but
    // still showing AI_HANDLING would sit in the inbox looking like work
    // nobody had picked up.
    await onAssistantReplied(tx, {
      pharmacyId: job.pharmacy_id, conversationId: row.conversation_id,
    });
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
    // Bounded. A handler that hangs — a half-open WhatsApp socket, a database
    // call that never returns — used to block the loop forever rather than
    // failing, which stopped every subsequent message for that pharmacy with
    // no error anywhere. A timeout makes it a normal retryable failure.
    await withTimeout(handler(db, job), JOB_TIMEOUT_MS, `job ${job.id} (${job.kind})`);
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

/**
 * Chase consultations nobody has picked up.
 *
 * Escalating, then silent: the first reminder after 15 minutes, then roughly
 * every 30, four in total. Bounded on purpose — an alert that repeats forever
 * is one staff learn to dismiss, and a dismissed alert is worse than none
 * because the pharmacy believes it is covered.
 *
 * Throttled at the call site, not in here — see the single gate in start()'s
 * loop. It used to check nothing of its own while a comment claimed it
 * shared the hold sweep's throttle; because the loop calls it unconditionally
 * regardless of that sweep's internal early-return, it ran on every poll
 * tick — every 2s by default, 30x more often than intended. Handoffs is a
 * small table, so nothing broke, but it is the same class of over-eager
 * polling that exhausted the pooler once already, just below the threshold
 * anyone noticed.
 */
const REMINDER_SCHEDULE_MINUTES = [15, 45, 75, 105];

/**
 * Close threads nobody has spoken in for a day.
 *
 * The closing half of conversationPolicy — resolveConversation decides where
 * a new INBOUND message lands, but nothing makes an idle thread stop being
 * "the active one" on its own; a customer's silence produces no event to
 * react to. This sweep is what actually sets status='closed', which is what
 * lets the NEXT message from that patient start a genuine new conversation
 * instead of extending a five-day-old one — the exact failure 0023 measured
 * in live data before this existed.
 *
 * shouldClose refuses on its own for the two cases that matter: a thread
 * still waiting on a pharmacist, and one a staff member is actively
 * handling. Both are re-checked here from real rows rather than trusted from
 * a stale read, since a handoff could resolve or a takeover could end
 * between one sweep and the next.
 */
async function sweepIdleConversations(db) {
  const candidates = await db`
    select id, pharmacy_id, customer_id, status, mode, last_message_at,
           exists(select 1 from handoffs h where h.conversation_id = c.id and h.resolved_at is null) as has_open_handoff
    from conversations c
    where status = 'open' and last_message_at < now() - interval '${db.unsafe(String(IDLE_HOURS))} hours'
    limit 200
  `;

  for (const c of candidates) {
    const decision = shouldClose({
      status: c.status, mode: c.mode, lastMessageAt: c.last_message_at, hasOpenHandoff: c.has_open_handoff,
    });
    if (!decision.close) continue;

    // workflow_state moves WITH status, because the two are not independent:
    // conversations_workflow_matches_status requires closed rows to be
    // 'resolved' or 'archived', exactly as it requires open rows to be one of
    // the open-ish states. Setting status alone produced an illegal pair, so
    // every close in this sweep was rejected by the constraint and the whole
    // batch aborted — silently, because the error was caught and logged by
    // the caller. Threads therefore never closed at all: the dashboard's
    // "waiting for a reply" count was reading days-old dead conversations
    // that this sweep believed it had already retired.
    //
    // 'resolved' rather than 'archived' — it is what every closed row in the
    // table already uses, and archived should mean a deliberate act, not the
    // ordinary end of a quiet conversation.
    await db`
      update conversations
      set status = 'closed',
          workflow_state = 'resolved',
          closed_at = now(),
          closed_reason = ${decision.reason}
      where id = ${c.id} and status = 'open'
    `;

    // CONVERSATION_RESOLVED exists in the registry precisely for this moment
    // — see 0017's note that it had no writer yet. This sweep is that writer.
    await recordEvent(db, {
      pharmacyId: c.pharmacy_id, customerId: c.customer_id,
      eventType: PATIENT_EVENTS.CONVERSATION_RESOLVED,
      actorType: 'system', entityType: 'conversation', entityId: c.id,
      metadata: { reason: decision.reason },
    });
  }
}

async function sweepUnhandledConsultations(db) {
  const due = await db`
    select h.id, h.pharmacy_id, h.conversation_id, h.category, h.requested_at,
           h.reminder_count, cust.display_name, cust.full_name, cust.wa_phone,
           cust.customer_type, conv.context
    from handoffs h
    join conversations conv on conv.id = h.conversation_id
    join customers cust on cust.id = conv.customer_id
    where h.resolved_at is null
      and h.reminder_count < ${REMINDER_SCHEDULE_MINUTES.length}
      and h.requested_at < now() - make_interval(mins =>
            (array[${db.unsafe(REMINDER_SCHEDULE_MINUTES.join(','))}])[h.reminder_count + 1])
    limit 10
  `;

  for (const h of due) {
    // Claimed before sending, so a slow send cannot let the next sweep pick
    // the same one up and double-message the pharmacist.
    const [claimed] = await db`
      update handoffs
      set reminder_count = reminder_count + 1, last_reminded_at = now()
      where id = ${h.id} and reminder_count = ${h.reminder_count}
      returning id
    `;
    if (!claimed) continue;

    try {
      const { buildBriefing } = require('./safety/consultationBriefing');
      const { alertStaffOfConsultation } = require('./orders/staffAlert');
      const history = (await db`
        select direction, body, created_at from messages
        where conversation_id = ${h.conversation_id} order by id desc limit 50
      `).reverse();
      const briefing = buildBriefing({
        category: h.category,
        requestedAt: h.requested_at,
        messages: history,
        context: h.context,
      });
      const r = await alertStaffOfConsultation(h.pharmacy_id, {
        briefing,
        customer: {
          display_name: h.display_name,
          full_name: h.full_name,
          wa_phone: h.wa_phone,
          customer_type: h.customer_type,
        },
        isReminder: true,
      });
      console.log(JSON.stringify({
        level: 'info', msg: 'consultation reminder', sent: r.sent, reason: r.reason,
        waiting: briefing.waiting, attempt: h.reminder_count + 1,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        level: 'warn', msg: 'consultation reminder failed', handoffId: h.id, error: err.message,
      }));
    }
  }
}

/**
 * Hand a conversation back to the assistant when the pharmacist who took it
 * has gone quiet — so the customer is never left messaging a number that
 * has silently stopped answering.
 *
 * TEN MINUTES, and why it is not shorter or longer
 * Short enough that a customer does not sit in silence wondering if anyone
 * is there; long enough that a pharmacist reading a history, checking a
 * shelf, or typing a careful clinical reply is not cut off mid-thought. The
 * clock resets on every staff reply (routes/conversations.js), so a
 * pharmacist actually working the thread never trips it — only one who has
 * genuinely walked away.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not resolve, cancel, or downgrade the handoff. The pharmacist is
 * still needed and the thread stays WAITING_FOR_PHARMACIST, still high
 * priority, still top of the inbox, still sending reminders. ONLY `mode`
 * returns to 'bot'. The resulting state — handoff PENDING, owner AI — is
 * precisely why those are two separate axes: the assistant resumes helping
 * without the escalation being forgotten.
 *
 * THE SAFETY ARGUMENT FOR LETTING THE ASSISTANT BACK IN
 * The question that caused the escalation is still one the assistant must
 * not answer — and it still cannot. The clinical filter runs before the
 * model on every inbound message, so if the customer repeats the clinical
 * question, it is refused and re-escalated exactly as it was the first
 * time. What the assistant regains is the ability to answer the ordinary
 * things ("what time do you close", "how much is paracetamol") that it was
 * always allowed to answer, and which the customer currently gets silence
 * for.
 */
const PHARMACIST_IDLE_TAKEBACK_MINUTES = 10;

async function sweepIdlePharmacistHandoffs(db) {
  const idle = await db`
    select h.id, h.pharmacy_id, h.conversation_id
    from handoffs h
    join conversations conv on conv.id = h.conversation_id
    where h.resolved_at is null
      and h.accepted_at is not null
      and conv.mode = 'human'
      and h.handoff_last_activity_at < now() - make_interval(mins => ${PHARMACIST_IDLE_TAKEBACK_MINUTES})
    limit 10
  `;

  for (const h of idle) {
    // Claimed by clearing the activity stamp in the same conditional update
    // that flips the mode — so a second sweep pass cannot pick the same
    // conversation up again and log a duplicate takeback.
    const [claimed] = await db`
      update handoffs set handoff_last_activity_at = null
      where id = ${h.id} and handoff_last_activity_at is not null
      returning id
    `;
    if (!claimed) continue;

    await db`update conversations set mode = 'bot' where id = ${h.conversation_id}`;

    console.log(JSON.stringify({
      level: 'info',
      msg: 'pharmacist idle — assistant resumed, handoff still open',
      conversationId: h.conversation_id,
      handoffId: h.id,
      idleMinutes: PHARMACIST_IDLE_TAKEBACK_MINUTES,
    }));
  }
}

async function sweepExpiredHolds(db) {
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

      if (order.conversation_id) {
        await sendAndRecordOutbound(db, {
          pharmacyId: order.pharmacy_id, customerId: order.customer_id, conversationId: order.conversation_id,
          accountId: target.account_id, to: target.wa_jid || `${target.wa_phone}@s.whatsapp.net`,
          body, author: 'system', delay: false, category: CATEGORIES.ORDER_NOTIFICATION,
        });
      } else {
        // No conversation to attach an outbound row to — still send, just
        // without a stored message or a timeline event. Matches the
        // original behaviour: the conditional was already load-bearing here.
        await sessionManager.sendText(
          target.account_id, target.wa_jid || `${target.wa_phone}@s.whatsapp.net`, body, { delay: false },
        );
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
      // ONE gate for all FOUR periodic scans, checked once rather than
      // (claimed but not actually) per-sweep. Each previously managed its own
      // timing, or in sweepUnhandledConsultations' case claimed to share one
      // it never actually checked — it ran on every poll tick, 30x more often
      // than the 60s the comment promised. A single check here is the only
      // version of "shared throttle" that is actually shared.
      if (Date.now() - lastSweepAt >= SWEEP_INTERVAL_MS) {
        lastSweepAt = Date.now();
        // Each sweep gets its OWN catch, not one around the block. Holds,
        // consultations, idle conversations and the pharmacist idle-takeback
        // are unrelated safety nets — sweepExpiredHolds used to be the one
        // exception, uncaught, so a bad order row threw before the other
        // three ever ran. Rare, but the takeback sweep is what stops a
        // customer being stranded when a pharmacist walks away, and having
        // an unrelated stock-hold failure able to silently suppress it for
        // another 60s (repeatedly, if the fault persisted) was exactly the
        // "one failure cascades into unrelated failures" shape this session
        // spent most of a day chasing elsewhere.
        // Every sweep is BOUNDED as well as caught. The catch handles a
        // sweep that fails; the timeout handles one that never returns at
        // all, which is the case that used to kill the loop — these are
        // sequential awaits, so a single hung query meant the sweeps below
        // it never ran and the reschedule at the bottom was never reached.
        const sweeps = [
          ['expired holds', sweepExpiredHolds],
          ['consultation', sweepUnhandledConsultations],
          ['conversation close', sweepIdleConversations],
          ['pharmacist idle takeback', sweepIdlePharmacistHandoffs],
          ['abandoned jobs', sweepAbandonedJobs],
        ];
        for (const [name, fn] of sweeps) {
          await withTimeout(fn(getSql()), SWEEP_TIMEOUT_MS, `${name} sweep`)
            .catch((err) => console.error(JSON.stringify({
              level: 'error', msg: `${name} sweep failed`, error: err.message,
            })));
        }
      }
      // Drain rather than sleeping between each job, so a burst is not
      // served at one message per poll interval.
      let worked = true;
      let guard = 0;
      while (worked && running && guard++ < 50) worked = await tick();
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'worker loop error', error: err.message }));
    } finally {
      // In `finally`, not after the catch. Every await inside the try is now
      // bounded, so this is reachable on any path — but putting the
      // reschedule here means even an unforeseen throw between the catch and
      // the end of the block cannot silently retire the worker. The loop
      // stopping is the one failure that produces no symptom except silence.
      if (running) timer = setTimeout(loop, env.worker.pollIntervalMs);
    }
  };

  loop();
  console.log(JSON.stringify({ level: 'info', msg: 'job worker started', workerId: WORKER_ID }));
}

function stop() {
  running = false;
  clearTimeout(timer);
}

module.exports = {
  start, stop, tick, HANDOFF_REASON,
  // Exported for tests. The sweep is the only place the idle-takeback rule
  // lives, and it is worth proving against a real database rather than
  // waiting ten minutes of wall clock for the loop to call it.
  sweepIdlePharmacistHandoffs, PHARMACIST_IDLE_TAKEBACK_MINUTES,
  // Exported for tests. This is the whole "is this the pharmacy's own staff"
  // decision, pure and DB-free, and worth proving directly rather than only
  // through a full processInbound run.
  isStaffNumber,
};
