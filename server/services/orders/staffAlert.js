/**
 * Tell a staff member a new order has arrived.
 *
 * THE ONE PLACE THIS SYSTEM INITIATES CONTACT
 * Everything else here is strictly reactive — every message ever sent is a
 * reply to someone who wrote first, and that fact is what the whole channel
 * risk argument rests on. This breaks that rule deliberately and narrowly:
 * one known number, configured by hand by the pharmacy, at the rate real
 * orders arrive. That is not outreach, and it must never become a pattern
 * that grows.
 *
 * It is opt-in (`notify_on_new_order`) and the number is explicit
 * (`notify_phone`), never inferred from any number we happen to know. A
 * pharmacy that has not set one gets no alert rather than a guess.
 *
 * FAILURE IS NON-FATAL. The order already exists and stock is already held.
 * An alert that could not be delivered must not roll any of that back — it
 * is reported instead, so staff can be told their alerting is broken rather
 * than silently trusting it.
 */

const { getSql, assertPharmacyId } = require('../db');
const { sessionManager } = require('../whatsapp/sessionManager');
const { normalizeMsisdn } = require('../whatsapp/senderIdentity');
const { env } = require('../../config/env');

const money = (kobo) => `₦${Number(kobo / 100).toLocaleString('en-NG')}`;

/**
 * Everything an alert needs before it can be sent: an opted-in number, a
 * readable one, and a live socket. Shared so a second alert type cannot
 * quietly skip one of the three checks.
 *
 * @returns {Promise<{ok:false, reason:string} | {ok:true, to:string, accountId:string, pharmacy:object}>}
 */
async function resolveAlertTarget(pharmacyId, db) {
  const [pharmacy] = await db`
    select notify_phone, notify_on_new_order, name
    from pharmacies where id = ${pharmacyId}
  `;
  if (!pharmacy) return { ok: false, reason: 'pharmacy_not_found' };
  if (!pharmacy.notify_phone) return { ok: false, reason: 'no_notify_phone' };

  const to = normalizeMsisdn(pharmacy.notify_phone, env.defaultCountryCode);
  if (!to) return { ok: false, reason: 'notify_phone_unreadable' };

  const [account] = await db`
    select id from whatsapp_accounts
    where pharmacy_id = ${pharmacyId} and provider = 'baileys' and status = 'connected'
    limit 1
  `;
  if (!account) return { ok: false, reason: 'not_connected' };

  return { ok: true, to, accountId: account.id, pharmacy };
}

/**
 * Someone is waiting on a pharmacist.
 *
 * Higher stakes than the order alert this file was built for: an unread
 * order costs a sale, an unread clinical question leaves a person with a
 * symptom waiting. One went unanswered for 46 hours before there was any
 * screen showing it, and a badge on a dashboard nobody has open is not a
 * notification.
 *
 * Deliberately NOT gated on notify_on_new_order — that switch is about
 * orders, and a pharmacy that turned off order pings has not asked to stop
 * hearing about clinical escalations.
 */
async function alertStaffOfConsultation(pharmacyId, { briefing, customer = {}, isReminder = false }) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const target = await resolveAlertTarget(pharmacyId, db);
  if (!target.ok) return { sent: false, reason: target.reason };

  const who = customer.display_name || customer.wa_phone || 'A customer';

  // The customer's own words, exactly as buildBriefing collected them — NOT
  // a paraphrase. See this module's sibling, consultationBriefing.js, for
  // why: a pharmacist acts clinically on what they read here, and an
  // AI-summarised "patient wants X" line risks quietly turning what someone
  // actually said into something close but wrong. `said` was already being
  // computed (and tested) but never rendered anywhere — the WhatsApp alert
  // showed only the single trigger line. This is the fuller picture, still
  // entirely their own sentences, just more of them.
  const conversation = briefing.said?.length
    ? briefing.said.map((s) => `"${s}"`)
    : (briefing.trigger ? [`"${briefing.trigger}"`] : []);

  const lines = [
    isReminder
      ? `STILL WAITING — ${briefing.headline}`
      : (briefing.urgent ? `URGENT — ${briefing.headline}` : `Someone needs a pharmacist — ${briefing.headline}`),
    '',
    `${who}, waiting ${briefing.waiting}`,
    conversation.length ? '' : null,
    conversation.length ? 'What they said:' : null,
    ...conversation,
    // Already-known structured context, not inferred from the text above —
    // same "assembled, not summarised" rule.
    briefing.discussed ? `\nAlso discussed: ${briefing.discussed}` : null,
    briefing.unansweredSince > 0
      ? `\n${briefing.unansweredSince} further message${briefing.unansweredSince > 1 ? 's' : ''} since, unanswered.`
      : null,
    '',
    'Open the Consultations tab to reply.',
  ].filter((l) => l !== null);

  try {
    const sent = await sessionManager.sendText(
      target.accountId, `${target.to}@s.whatsapp.net`, lines.join('\n'), { delay: false },
    );
    return { sent: true, reason: 'ok', providerMessageId: sent.providerMessageId };
  } catch (err) {
    return { sent: false, reason: `send_failed:${err.message}` };
  }
}

/**
 * @param {string} pharmacyId
 * @param {object} order  as returned by createOrder, including `items`
 * @returns {Promise<{sent: boolean, reason: string}>}
 */
async function alertStaffOfNewOrder(pharmacyId, order, customer = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const target = await resolveAlertTarget(pharmacyId, db);
  if (!target.ok) return { sent: false, reason: target.reason };
  if (!target.pharmacy.notify_on_new_order) return { sent: false, reason: 'alerts_disabled' };

  const to = target.to;
  const account = { id: target.accountId };

  const lines = [
    `New order ${order.reference}`,
    '',
    ...(order.items || []).map((i) => `${i.quantity} x ${i.name_snapshot}`),
    '',
    `Total ${money(order.total_kobo)}`,
    // full_name is what the customer told the pharmacy when asked;
    // display_name is whatever they set on their own phone. A reservation
    // labelled "John's iPhone" helps nobody at the counter, so the confirmed
    // name wins wherever staff act on it.
    customer.full_name || customer.display_name || customer.wa_phone
      ? `For ${customer.full_name || customer.display_name || customer.wa_phone}`
      : null,
    '',
    // Says plainly what has and has not happened. A staff member reading this
    // on their phone needs to know the stock is already off the shelf, and
    // that the customer has NOT been told it is theirs yet.
    // The action, right here in the alert.
    //
    // This used to end "Confirm in the dashboard", which put the decision on
    // a screen the pharmacist would have to stop and log into — so orders
    // sat unconfirmed while the customer waited, even though the person who
    // could clear them had already read the message. Replying is now the
    // shortest path, and the reference is included so the instruction still
    // works when a second order arrives before they answer.
    'The customer has NOT been told yet.',
    '',
    `Reply  1  to confirm & mark ready`,
    `       2  to reject`,
    `(or "1 ${order.reference}" if more than one is waiting)`,
  ].filter((l) => l !== null);

  try {
    const sent = await sessionManager.sendText(
      account.id,
      `${to}@s.whatsapp.net`,
      lines.join('\n'),
      // No human-latency delay: this is an internal alert to the pharmacy's
      // own staff, not a customer reply, and the point of it is speed.
      { delay: false },
    );
    return { sent: true, reason: 'ok', providerMessageId: sent.providerMessageId };
  } catch (err) {
    return { sent: false, reason: `send_failed:${err.message}` };
  }
}

module.exports = { alertStaffOfNewOrder, alertStaffOfConsultation };
