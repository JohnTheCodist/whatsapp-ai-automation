/**
 * Count one conversation, once, the first time the assistant answers in it.
 *
 * WHAT THIS IS NOT
 * It is not a charge. Nobody is billed per conversation — the pilot is a
 * flat ₦5,000/month or ₦50,000/year with no limit. This records what a
 * conversation WOULD cost at an internal reference price so that the next
 * pricing decision is made from evidence instead of instinct. The pharmacy
 * never sees it; usage_records has RLS enabled with no client policy.
 *
 * WHY IT COUNTS THE SAME UNIT WHATSAPP DOES
 * A conversation, not a message. Charging per message would price the
 * assistant's helpfulness: a reply that asks a clarifying question would
 * cost the pharmacy more than one that guessed. The conversation is also the
 * unit the pharmacy already understands from their own WhatsApp bill.
 *
 * WHY THE FIRST ASSISTANT REPLY IS THE TRIGGER
 * Three candidates, and only one is defensible:
 *
 *   inbound message   would bill for spam, wrong numbers, and every "hi"
 *                     the assistant never answered
 *   conversation row  created before anyone knows whether it was served
 *   first assistant reply   the moment we actually did something
 *
 * Staff replies and system messages are excluded. A pharmacist typing by
 * hand is not the assistant working, and counting it would mean the meter
 * measured the product least when the product worked worst.
 *
 * THIS MUST NEVER BREAK A REPLY.
 * It runs inside the outbound-message transaction, which is the one place a
 * customer's answer becomes real. Metering is bookkeeping; a bookkeeping
 * failure that swallowed a pharmacy's reply would be an absurd trade. Hence
 * `on conflict do nothing` and no error thrown for the ordinary duplicate
 * case — see recordConversationUsage.
 */

const { NOTIONAL_CONVERSATION_KOBO } = require('./plans');

/**
 * @param {object} sql  postgres.js instance or an OPEN TRANSACTION. Passed in
 *   rather than fetched, so this lands atomically with the message row it
 *   belongs to: a counted conversation that has no message, or a message
 *   that was never counted, are both states nobody could explain later.
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.conversationId
 * @param {string} args.author        only 'assistant' is metered
 * @param {Date}   [args.periodStart] the pharmacy's current billing period
 * @returns {Promise<boolean>} true if this call was the one that counted it
 */
async function recordConversationUsage(sql, {
  pharmacyId, conversationId, author, periodStart = null,
}) {
  // Only the assistant. A pharmacist replying by hand costs us nothing to
  // generate, and a system acknowledgement is not a service delivered.
  if (author !== 'assistant') return false;
  if (!pharmacyId || !conversationId) return false;

  // `on conflict do nothing` against idx_usage_one_per_conversation is the
  // whole idempotency story, and it is enforced by the database rather than
  // by a read-then-write here. A read-then-write would race: two replies
  // sent in the same second by two workers would both see no row and both
  // insert, and the meter would quietly double-count exactly the busy
  // conversations it most needs to get right.
  const rows = await sql`
    insert into usage_records (pharmacy_id, conversation_id, notional_cost_kobo, period_start)
    values (${pharmacyId}, ${conversationId}, ${NOTIONAL_CONVERSATION_KOBO}, ${periodStart})
    on conflict (conversation_id) do nothing
    returning id
  `;

  return rows.length > 0;
}

/**
 * What we have spent serving this pharmacy since `since`.
 *
 * Read-only, and internal. Summed from the stamped per-row cost rather than
 * multiplying a count by today's reference price — the price is a modelling
 * assumption that will change, and multiplying would silently rewrite every
 * past month the moment it did.
 */
async function usageSince(sql, pharmacyId, since) {
  const [row] = await sql`
    select
      count(*)::int as conversations,
      coalesce(sum(notional_cost_kobo), 0)::bigint as notional_kobo
    from usage_records
    where pharmacy_id = ${pharmacyId}
      and (${since}::timestamptz is null or created_at >= ${since})
  `;
  return {
    conversations: row?.conversations ?? 0,
    notionalKobo: Number(row?.notional_kobo ?? 0),
  };
}

module.exports = { recordConversationUsage, usageSince };
