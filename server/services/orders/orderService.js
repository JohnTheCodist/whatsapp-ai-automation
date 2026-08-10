/**
 * Orders.
 *
 * THE RULE THAT MATTERS
 * The model supplies product ids and quantities. It does NOT supply prices.
 * Every price on an order is read from `products` here, server-side, at the
 * moment the order is created.
 *
 * This is not defensive tidiness. The assistant has already been observed
 * telling a customer "Done, I've set aside 3 packs" when nothing existed —
 * it will state whatever is plausible. If it could also state the price, a
 * hallucinated number would become a real order, a real total, and an
 * argument at the counter. The catalogue is the source of truth for money;
 * the model is a way of finding rows in it.
 *
 * WHAT AN ORDER MEANS
 * `pending` means the customer asked. It does not mean stock is held or that
 * the pharmacy has agreed — a person confirms that. The assistant must say
 * "I've sent this to the pharmacy", never "it's reserved", because until
 * someone behind the counter looks, nothing is.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');

/**
 * Reference alphabet, minus everything that is ambiguous out loud or in
 * handwriting: 0/O, 1/I/L, 5/S, 8/B. Counter staff read these back over a
 * phone line in a noisy shop.
 */
const REF_ALPHABET = '23467369ACDEFGHJKMNPQRTUVWXYZ'.replace(/(.)(?=.*\1)/g, '');

function generateReference() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

const MAX_QTY_PER_LINE = 100;
const MAX_LINES = 20;

/**
 * Create a pending order from what the customer asked for.
 *
 * @param {string} pharmacyId
 * @param {object} args
 * @param {string} args.customerId
 * @param {string} [args.conversationId]
 * @param {Array<{productId: string, quantity: number}>} args.items
 * @param {'pickup'|'delivery'} [args.fulfilment]
 * @param {string} [args.note]
 * @returns {Promise<{ok: boolean, order?: object, error?: string, code?: string}>}
 *
 * Returns a result object rather than throwing for business refusals: the
 * assistant needs to explain WHY to a customer, and an exception string is
 * not something it can safely paraphrase.
 */
async function createOrder(pharmacyId, { customerId, conversationId = null, items, fulfilment = 'pickup', note = null }) {
  assertPharmacyId(pharmacyId);

  if (!customerId) return { ok: false, code: 'NO_CUSTOMER', error: 'No customer on this conversation.' };
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'NO_ITEMS', error: 'An order needs at least one product.' };
  }
  if (items.length > MAX_LINES) {
    return { ok: false, code: 'TOO_MANY_LINES', error: `An order cannot have more than ${MAX_LINES} different products.` };
  }

  // Collapse duplicate lines before pricing, so "2 then 1 more of the same"
  // becomes 3 rather than two rows a human has to reconcile.
  const wanted = new Map();
  for (const raw of items) {
    const productId = String(raw?.productId || '').trim();
    const quantity = Number(raw?.quantity);

    if (!productId) return { ok: false, code: 'BAD_ITEM', error: 'An item was missing its product.' };
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, code: 'BAD_QUANTITY', error: 'Quantity must be a whole number of at least 1.' };
    }
    if (quantity > MAX_QTY_PER_LINE) {
      return {
        ok: false,
        code: 'QUANTITY_TOO_LARGE',
        // A wholesale-sized request through a chat assistant is exactly the
        // case a person should look at, not one to quietly accept.
        error: `${quantity} is more than this assistant can take in one order. A member of staff will need to help with that.`,
      };
    }
    wanted.set(productId, (wanted.get(productId) || 0) + quantity);
  }

  const db = getSql();
  const ids = [...wanted.keys()];

  // Scoped to the pharmacy: a product id from another tenant simply does not
  // resolve, so a leaked id cannot be ordered here.
  const products = await db`
    select id, name, price_kobo, stock_qty, stock_tracked, status
    from products
    where pharmacy_id = ${pharmacyId} and id = any(${ids})
  `;

  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  for (const [productId, quantity] of wanted) {
    const p = byId.get(productId);

    if (!p) {
      return { ok: false, code: 'UNKNOWN_PRODUCT', error: 'One of those products is not in this pharmacy\'s catalogue.' };
    }
    if (p.status !== 'active') {
      return { ok: false, code: 'PRODUCT_UNAVAILABLE', error: `${p.name} is not currently available.` };
    }
    // An unpriced product cannot be ordered. Not zero — unknown. Quoting it
    // as free is the worst possible interpretation of a missing value.
    if (p.price_kobo === null) {
      return {
        ok: false,
        code: 'NO_PRICE',
        error: `${p.name} has no price in the catalogue, so it cannot be ordered here. A member of staff can confirm the price.`,
      };
    }
    if (p.stock_tracked && (p.stock_qty ?? 0) < quantity) {
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        error: `There ${(p.stock_qty ?? 0) === 1 ? 'is' : 'are'} only ${p.stock_qty ?? 0} of ${p.name} in stock.`,
      };
    }

    lines.push({
      product_id: p.id,
      name_snapshot: p.name,
      unit_price_kobo: p.price_kobo,
      quantity,
      line_total_kobo: p.price_kobo * quantity,
    });
  }

  const totalKobo = lines.reduce((sum, l) => sum + l.line_total_kobo, 0);

  // Retry on reference collision. Random 6 characters over a 20-ish letter
  // alphabet collides rarely, but "rarely" across every pharmacy forever is
  // not never, and the unique constraint would surface it as a 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateReference();
    try {
      const order = await db.begin(async (tx) => {
        const [created] = await tx`
          insert into orders (pharmacy_id, customer_id, conversation_id, reference,
                              status, total_kobo, fulfilment, note)
          values (${pharmacyId}, ${customerId}, ${conversationId}, ${reference},
                  'pending', ${totalKobo}, ${fulfilment}, ${note})
          returning *
        `;

        await tx`
          insert into order_items ${tx(
            lines.map((l) => ({ ...l, order_id: created.id, pharmacy_id: pharmacyId })),
            'order_id', 'pharmacy_id', 'product_id', 'name_snapshot',
            'unit_price_kobo', 'quantity', 'line_total_kobo'
          )}
        `;

        await tx`
          insert into order_status_history (order_id, pharmacy_id, from_status, to_status, actor_type, note)
          values (${created.id}, ${pharmacyId}, null, 'pending', 'assistant', 'Created from a WhatsApp conversation.')
        `;

        return created;
      });

      return { ok: true, order: { ...order, items: lines } };
    } catch (err) {
      if (/unique/i.test(err.message) && /reference/i.test(err.message)) continue;
      throw err;
    }
  }

  return { ok: false, code: 'REFERENCE_COLLISION', error: 'Could not allocate an order reference. Please try again.' };
}

/** Staff-side status change, with history. */
const ALLOWED_TRANSITIONS = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['ready', 'cancelled', 'completed'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rejected: [],
};

async function updateStatus(pharmacyId, orderId, toStatus, { changedBy = null, note = null, actorType = 'staff' } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [order] = await db`
    select id, status from orders where id = ${orderId} and pharmacy_id = ${pharmacyId}
  `;
  if (!order) return { ok: false, code: 'NOT_FOUND', error: 'Order not found.' };

  const allowed = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowed.includes(toStatus)) {
    // Enumerated rather than free-for-all so a completed order cannot be
    // walked backwards into pending by a mis-click, silently rewriting what
    // the customer was told.
    return {
      ok: false,
      code: 'BAD_TRANSITION',
      error: `An order that is ${order.status} cannot become ${toStatus}.`,
      allowed,
    };
  }

  const updated = await db.begin(async (tx) => {
    const [row] = await tx`
      update orders set status = ${toStatus}, status_detail = ${note}, updated_at = now()
      where id = ${orderId} and pharmacy_id = ${pharmacyId}
      returning *
    `;
    await tx`
      insert into order_status_history (order_id, pharmacy_id, from_status, to_status, changed_by, actor_type, note)
      values (${orderId}, ${pharmacyId}, ${order.status}, ${toStatus}, ${changedBy}, ${actorType}, ${note})
    `;
    return row;
  });

  return { ok: true, order: updated, from: order.status };
}

async function listOrders(pharmacyId, { status = null, limit = 50 } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const rows = status
    ? await db`
        select o.*, c.wa_phone, c.display_name
        from orders o join customers c on c.id = o.customer_id
        where o.pharmacy_id = ${pharmacyId} and o.status = ${status}
        order by o.created_at desc limit ${limit}`
    : await db`
        select o.*, c.wa_phone, c.display_name
        from orders o join customers c on c.id = o.customer_id
        where o.pharmacy_id = ${pharmacyId}
        order by o.created_at desc limit ${limit}`;

  if (rows.length === 0) return [];

  const items = await db`
    select order_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo
    from order_items
    where pharmacy_id = ${pharmacyId} and order_id = any(${rows.map((r) => r.id)})
  `;
  const byOrder = new Map();
  for (const i of items) {
    if (!byOrder.has(i.order_id)) byOrder.set(i.order_id, []);
    byOrder.get(i.order_id).push(i);
  }

  return rows.map((o) => ({ ...o, items: byOrder.get(o.id) || [] }));
}

module.exports = { createOrder, updateStatus, listOrders, generateReference, ALLOWED_TRANSITIONS };
