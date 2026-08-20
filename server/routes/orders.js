/**
 * Orders — the staff side.
 *
 *   GET  /api/orders             queue, pending first
 *   GET  /api/orders/:id         one order with its history
 *   POST /api/orders/:id/status  confirm / reject / ready / complete / cancel
 *
 * A status change here is the thing the customer is actually waiting for, so
 * it also messages them. An order confirmed in a dashboard the customer
 * cannot see is not confirmed as far as they are concerned.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { listOrders, updateStatus } = require('../services/orders/orderService');
const { sendAndRecordOutbound } = require('../services/whatsapp/outboundMessage');
const { CATEGORIES } = require('../services/whatsapp/communicationPolicy');
const { sessionManager } = require('../services/whatsapp/sessionManager');
// One copy of the customer-facing wording, shared with the staff WhatsApp
// path in worker.js — see orderMessages.js for why it is not defined here.
const { customerMessage } = require('../services/orders/orderMessages');
const { evaluateAndStore } = require('../services/clinical/conditionProfileService');

const router = express.Router();

const naira = (kobo) => (kobo === null || kobo === undefined ? null : kobo / 100);


router.get('/', requireAuth, async (req, res, next) => {
  try {
    const status = req.query.status || null;
    const orders = await listOrders(req.pharmacyId, { status });

    const db = getSql();
    const [counts] = await db`
      select
        count(*) filter (where status = 'pending')::int   as pending,
        count(*) filter (where status = 'confirmed')::int as confirmed,
        count(*) filter (where status = 'ready')::int     as ready,
        count(*)::int as total
      from orders where pharmacy_id = ${req.pharmacyId}
    `;

    res.json({
      counts,
      orders: orders.map((o) => ({
        ...o,
        total_naira: naira(o.total_kobo),
        items: o.items.map((i) => ({
          ...i,
          unit_price_naira: naira(i.unit_price_kobo),
          line_total_naira: naira(i.line_total_kobo),
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const db = getSql();

    const [order] = await db`
      select o.*, c.wa_phone, c.display_name
      from orders o join customers c on c.id = o.customer_id
      where o.id = ${req.params.id} and o.pharmacy_id = ${req.pharmacyId}
    `;
    if (!order) return res.status(404).json({ error: 'Order not found.', code: 'NOT_FOUND' });

    const [items, history] = await Promise.all([
      db`select * from order_items where order_id = ${order.id} and pharmacy_id = ${req.pharmacyId}`,
      db`select from_status, to_status, actor_type, note, changed_at
         from order_status_history where order_id = ${order.id} order by changed_at asc`,
    ]);

    res.json({ ...order, total_naira: naira(order.total_kobo), items, history });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const toStatus = String(req.body?.status || '').trim();
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;

    const result = await updateStatus(req.pharmacyId, req.params.id, toStatus, {
      changedBy: req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000' ? req.user.id : null,
      note,
      actorType: 'staff',
    });

    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).json(result);
    }

    // Tell the customer. Best-effort and non-fatal: the status change is a
    // fact about the pharmacy's own records and must not be rolled back
    // because WhatsApp happened to be disconnected. The failure is reported
    // so staff know to call instead of assuming it was delivered.
    let notified = false;
    let notifyError = null;
    const body = customerMessage(result.order, toStatus);

    if (body) {
      try {
        const db = getSql();
        const [target] = await db`
          select c.id as customer_id, c.wa_jid, c.wa_phone, o.conversation_id
          from orders o join customers c on c.id = o.customer_id
          where o.id = ${req.params.id} and o.pharmacy_id = ${req.pharmacyId}
        `;
        const [account] = await db`
          select id from whatsapp_accounts
          where pharmacy_id = ${req.pharmacyId} and provider = 'baileys' and status = 'connected'
          limit 1
        `;

        if (account && target) {
          if (target.conversation_id) {
            await sendAndRecordOutbound(db, {
              pharmacyId: req.pharmacyId, customerId: target.customer_id, conversationId: target.conversation_id,
              accountId: account.id, to: target.wa_jid || `${target.wa_phone}@s.whatsapp.net`,
              body, author: 'system', delay: false, category: CATEGORIES.ORDER_NOTIFICATION,
            });
          } else {
            // No conversation to attach an outbound row to — genuinely rare,
            // since every order in this system originates from one. Still
            // send, just without a stored message or timeline event, same
            // shape as the equivalent branch in worker.js's hold-expiry sweep.
            await sessionManager.sendText(
              account.id, target.wa_jid || `${target.wa_phone}@s.whatsapp.net`, body, { delay: false },
            );
          }
          notified = true;
        } else {
          notifyError = 'WhatsApp is not connected.';
        }
      } catch (err) {
        notifyError = err.message;
      }
    }

    // A completed order is the point the pharmacy actually dispensed the
    // medicine — real purchase evidence, not a pending request that might
    // still be rejected. Re-evaluate this customer's condition profile now
    // rather than waiting for someone to hit the API by hand.
    //
    // Best-effort and non-fatal, same reasoning as the customer message
    // above: the order already completed and must not be undone because the
    // condition engine hit a snag. A failure here is logged, not surfaced to
    // the pharmacist as an order problem.
    if (toStatus === 'completed') {
      evaluateAndStore(req.pharmacyId, result.order.customer_id).catch((err) => {
        console.error(JSON.stringify({
          level: 'warn', msg: 'condition evaluation failed after order completion',
          orderId: req.params.id, error: err.message,
        }));
      });
    }

    res.json({
      ok: true,
      order: { ...result.order, total_naira: naira(result.order.total_kobo) },
      from: result.from,
      customerNotified: notified,
      notifyError,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
