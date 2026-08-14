/**
 * Pharmacist queue for things the catalogue could not supply.
 *
 *   GET  /api/requests              open questions, oldest first
 *   GET  /api/requests/demand       what customers keep asking for
 *   POST /api/requests/:id/suggest  { productId, note } -> message the customer
 *   POST /api/requests/:id/decline  { note }            -> message the customer
 *
 * BOTH ANSWERS REACH THE CUSTOMER. A decline is not a dead end to be left
 * unsaid — the customer asked a question and is waiting. Telling them plainly
 * that the pharmacy cannot supply it lets them go elsewhere, which is a better
 * outcome for them than silence and a better one for the pharmacy than being
 * remembered as the shop that ignored them.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getSql, assertPharmacyId } = require('../services/db');
const { sendAndRecordOutbound } = require('../services/whatsapp/outboundMessage');
const { CATEGORIES } = require('../services/whatsapp/communicationPolicy');
const {
  listOpen, suggestAlternative, declineRequest, unmetDemand,
} = require('../services/orders/requestService');

const router = express.Router();

const money = (kobo) => `₦${Number(kobo / 100).toLocaleString('en-NG')}`;

/**
 * Send the pharmacist's answer to the customer and record it.
 *
 * Returns the outcome rather than throwing: the pharmacist's decision is
 * already saved, and a send failure must not make it look un-taken. They are
 * told the message did not go out so they can call instead.
 */
async function messageCustomer(db, pharmacyId, conversationId, body) {
  const [target] = await db`
    select c.id as customer_id, c.wa_jid, c.wa_phone, wa.id as account_id
    from conversations conv
    join customers c on c.id = conv.customer_id
    left join whatsapp_accounts wa
      on wa.pharmacy_id = conv.pharmacy_id and wa.provider = 'baileys' and wa.status = 'connected'
    where conv.id = ${conversationId} and conv.pharmacy_id = ${pharmacyId}
  `;
  if (!target?.account_id) return { sent: false, reason: 'not_connected' };

  try {
    await sendAndRecordOutbound(db, {
      pharmacyId, customerId: target.customer_id, conversationId,
      accountId: target.account_id, to: target.wa_jid || `${target.wa_phone}@s.whatsapp.net`,
      body, author: 'staff', category: CATEGORIES.TRANSACTIONAL,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({ requests: await listOpen(req.pharmacyId) });
  } catch (err) { next(err); }
});

router.get('/demand', requireAuth, async (req, res, next) => {
  try {
    res.json({ demand: await unmetDemand(req.pharmacyId, { days: Number(req.query.days) || 30 }) });
  } catch (err) { next(err); }
});

/** Products a pharmacist can pick from, for the suggestion box. */
router.get('/catalogue-search', requireAuth, async (req, res, next) => {
  try {
    assertPharmacyId(req.pharmacyId);
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ products: [] });

    const db = getSql();
    const rows = await db`
      select id, name, generic_name, strength, form, pack_size, price_kobo, stock_qty, stock_tracked
      from products
      where pharmacy_id = ${req.pharmacyId} and status = 'active'
        and price_kobo is not null
        and (name ilike ${'%' + q + '%'} or generic_name ilike ${'%' + q + '%'})
      order by name limit 15
    `;
    res.json({
      products: rows.map((p) => ({
        ...p,
        price: p.price_kobo / 100,
        in_stock: p.stock_tracked ? (p.stock_qty ?? 0) > 0 : null,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/:id/suggest', requireAuth, requireRole('owner', 'pharmacist'), async (req, res, next) => {
  try {
    const { productId, note } = req.body || {};
    if (!productId) {
      return res.status(400).json({ error: 'Pick a product from your catalogue.', code: 'NO_PRODUCT' });
    }

    const { request, product } = await suggestAlternative(req.pharmacyId, req.params.id, {
      productId,
      note,
      userId: req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000' ? req.user.id : null,
    });

    // The pharmacist's words are quoted, not paraphrased, and attributed to
    // them. Rewriting a clinical statement is authoring one, and the whole
    // reason a human is in this loop is that the assistant must not.
    const lines = [
      `We don't have ${request.requested_text} at the moment.`,
      '',
      request.pharmacist_note
        ? `Our pharmacist suggests ${product.name} — "${request.pharmacist_note}"`
        : `Our pharmacist suggests ${product.name} instead.`,
      '',
      `It's ${money(product.price_kobo)}. Would you like me to add it to your order?`,
    ];
    const body = lines.join('\n');

    const db = getSql();
    const delivery = await messageCustomer(db, req.pharmacyId, request.conversation_id, body);

    // So the assistant can resolve "yes please" next turn without the
    // customer having to name the product again.
    await db`
      update conversations
      set context = coalesce(context, '{}'::jsonb) || ${db.json({
        pending_suggestion: {
          request_id: request.id,
          product_id: product.id,
          product_name: product.name,
          price_naira: product.price_kobo / 100,
        },
        last_product_name: product.name,
        last_product_id: product.id,
      })}
      where id = ${request.conversation_id}
    `;

    res.json({ ok: true, request, product: { id: product.id, name: product.name }, delivery });
  } catch (err) {
    if (/not found|already|no price|out of stock|not active|catalogue/i.test(err.message)) {
      return res.status(409).json({ error: err.message, code: 'CANNOT_SUGGEST' });
    }
    next(err);
  }
});

router.post('/:id/decline', requireAuth, requireRole('owner', 'pharmacist'), async (req, res, next) => {
  try {
    const { note } = req.body || {};
    const { request } = await declineRequest(req.pharmacyId, req.params.id, {
      note,
      userId: req.user?.id && req.user.id !== '00000000-0000-0000-0000-000000000000' ? req.user.id : null,
    });

    const body = [
      `I'm sorry — we can't supply ${request.requested_text} at the moment.`,
      request.pharmacist_note ? `\n${request.pharmacist_note}` : '',
      '\nIs there anything else I can help you with?',
    ].join('');

    const db = getSql();
    const delivery = await messageCustomer(db, req.pharmacyId, request.conversation_id, body);
    res.json({ ok: true, request, delivery });
  } catch (err) {
    if (/not found|already/i.test(err.message)) {
      return res.status(409).json({ error: err.message, code: 'CANNOT_DECLINE' });
    }
    next(err);
  }
});

module.exports = router;
