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
 * WHAT AN ORDER MEANS — TWO STAGES
 * `pending` DOES hold stock (0010), so a second customer cannot be sold the
 * same pack while the pharmacist decides. It does NOT mean the pharmacy has
 * agreed. Those are different facts and the customer is told only the second
 * one: the assistant says "I've sent this to the pharmacy", never "it's
 * reserved", until a human confirms. replyValidator enforces that.
 *
 * Holding without promising is the whole design. Holding at confirmation
 * would let the pharmacist confirm a pack already gone; promising at
 * creation would commit the pharmacy to something nobody approved.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordEvent, orderEventType } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

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

  const [settings] = await db`
    select reservation_hold_minutes from pharmacies where id = ${pharmacyId}
  `;
  const holdMinutes = settings?.reservation_hold_minutes ?? 120;

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
    // Checked here for a good error message, but NOT relied on — the real
    // guard is the conditional UPDATE inside the transaction below. Between
    // this read and that write, another customer can take the last pack.
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
      // Not a column — stripped before insert. Tells the hold loop whether
      // this product has a stock number to decrement at all.
      _stock_tracked: p.stock_tracked,
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
        // ---- hold the stock, atomically -------------------------------
        //
        // `and stock_qty >= quantity` in the WHERE clause is the actual
        // concurrency guard. The read above is only for a good error
        // message; between it and here, another customer can take the last
        // pack. Postgres evaluates this condition and the decrement in one
        // statement, so exactly one of two racing orders can win.
        //
        // Untracked products hold nothing — the pharmacy is not counting
        // them, so there is no number to decrement and nothing to restore
        // later.
        let heldAnything = false;
        for (const line of lines) {
          if (!line._stock_tracked) continue;

          const [held] = await tx`
            update products
            set stock_qty = stock_qty - ${line.quantity}, updated_at = now()
            where id = ${line.product_id}
              and pharmacy_id = ${pharmacyId}
              and stock_tracked = true
              and stock_qty >= ${line.quantity}
            returning id, stock_qty
          `;

          if (!held) {
            // Someone took it while this order was being built. Aborting the
            // transaction rolls back every hold placed above it, so a
            // multi-line order never half-reserves.
            const err = new Error(`RACE_LOST:${line.name_snapshot}`);
            err.raceLost = line.name_snapshot;
            throw err;
          }
          heldAnything = true;
        }

        const [created] = await tx`
          insert into orders (pharmacy_id, customer_id, conversation_id, reference,
                              status, total_kobo, fulfilment, note,
                              stock_held, reserved_until)
          values (${pharmacyId}, ${customerId}, ${conversationId}, ${reference},
                  'pending', ${totalKobo}, ${fulfilment}, ${note},
                  ${heldAnything},
                  ${heldAnything ? tx`now() + (${holdMinutes} || ' minutes')::interval` : null})
          returning *
        `;

        await tx`
          insert into order_items ${tx(
            lines.map(({ _stock_tracked, ...l }) => ({ ...l, order_id: created.id, pharmacy_id: pharmacyId })),
            'order_id', 'pharmacy_id', 'product_id', 'name_snapshot',
            'unit_price_kobo', 'quantity', 'line_total_kobo'
          )}
        `;

        const [history] = await tx`
          insert into order_status_history (order_id, pharmacy_id, from_status, to_status, actor_type, note)
          values (${created.id}, ${pharmacyId}, null, 'pending', 'assistant', 'Created from a WhatsApp conversation.')
          returning id, changed_at
        `;
        await recordEvent(tx, {
          pharmacyId, customerId, eventType: PATIENT_EVENTS.ORDER_CREATED,
          occurredAt: history.changed_at, actorType: 'ai',
          entityType: 'order_status_history', entityId: history.id,
          metadata: { orderId: created.id, reference, totalKobo, itemCount: lines.length },
        });

        return created;
      });

      return { ok: true, order: { ...order, items: lines } };
    } catch (err) {
      if (err.raceLost) {
        // Another customer took it mid-transaction. Every hold this order
        // placed was rolled back with it, so nothing is stranded.
        return {
          ok: false,
          code: 'INSUFFICIENT_STOCK',
          error: `Someone just took the last ${err.raceLost}. It is no longer available.`,
        };
      }
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

/** Statuses where the pharmacy is no longer going to supply the order. */
const RELEASES_STOCK = new Set(['rejected', 'cancelled']);

/**
 * Return held units to the shelf. Exactly once.
 *
 * `and stock_released = false` is the guard, checked inside the same
 * statement that sets the flag. Double-restoring would inflate stock — a
 * wrong number in the direction that causes overselling, which is the
 * failure a customer experiences at the counter rather than in a log.
 *
 * @param {object} tx  must be a transaction — the flag and the increments
 *   have to land together or neither.
 */
async function releaseStock(tx, pharmacyId, orderId) {
  const [claimed] = await tx`
    update orders set stock_released = true
    where id = ${orderId} and pharmacy_id = ${pharmacyId}
      and stock_held = true and stock_released = false
    returning id
  `;
  // Already released, or never held anything. Either way, nothing to do —
  // and crucially, no error: a second cancel is not a failure.
  if (!claimed) return 0;

  const restored = await tx`
    update products p
    set stock_qty = p.stock_qty + oi.quantity, updated_at = now()
    from order_items oi
    where oi.order_id = ${orderId}
      and oi.product_id = p.id
      and p.pharmacy_id = ${pharmacyId}
      and p.stock_tracked = true
    returning p.id
  `;
  return restored.length;
}

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
    // Stock goes back when the pharmacy is no longer supplying it. Not on
    // `completed` — that stock genuinely left the shelf with the customer.
    if (RELEASES_STOCK.has(toStatus)) {
      await releaseStock(tx, pharmacyId, orderId);
    }

    const [row] = await tx`
      update orders set status = ${toStatus}, status_detail = ${note},
             -- A confirmed order is not on a countdown any more; the hold
             -- became a commitment the moment a person agreed to it.
             reserved_until = ${toStatus === 'pending' ? tx`reserved_until` : null},
             updated_at = now()
      where id = ${orderId} and pharmacy_id = ${pharmacyId}
      returning *
    `;
    const [history] = await tx`
      insert into order_status_history (order_id, pharmacy_id, from_status, to_status, changed_by, actor_type, note)
      values (${orderId}, ${pharmacyId}, ${order.status}, ${toStatus}, ${changedBy}, ${actorType}, ${note})
      returning id, changed_at
    `;
    // actorType here is exactly what the caller passed to updateStatus
    // (defaults to 'staff') — not upgraded to 'pharmacist', since orderService
    // itself does not distinguish a pharmacist from any other staff member
    // making the change. Claiming that distinction here would assert
    // something the calling code never actually knew.
    await recordEvent(tx, {
      pharmacyId, customerId: row.customer_id,
      eventType: orderEventType(order.status, toStatus, actorType),
      occurredAt: history.changed_at,
      actorType, actorId: changedBy,
      entityType: 'order_status_history', entityId: history.id,
      metadata: { orderId, reference: row.reference, fromStatus: order.status, toStatus },
    });
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

/**
 * Return stock from pending orders nobody acted on.
 *
 * WHY THIS EXISTS
 * A hold with no deadline is inventory the pharmacy cannot sell to the person
 * standing at the counter. One abandoned WhatsApp conversation would silently
 * remove a pack from the shelf permanently — and the pharmacist would have no
 * way to discover why their stock count is wrong.
 *
 * Runs across ALL pharmacies, so it takes no pharmacyId and is deliberately
 * not exported through any tenant-scoped path. Every write below is still
 * bounded to the order's own pharmacy_id.
 *
 * @returns {Promise<Array<{id, reference, pharmacy_id, conversation_id}>>}
 *   the expired orders, so the caller can tell each customer.
 */
async function expireStaleHolds({ limit = 50 } = {}) {
  const db = getSql();

  const due = await db`
    select id, reference, pharmacy_id, conversation_id, customer_id
    from orders
    where status = 'pending'
      and stock_held = true
      and stock_released = false
      and reserved_until is not null
      and reserved_until < now()
    order by reserved_until
    limit ${limit}
  `;

  const expired = [];
  for (const order of due) {
    // One transaction per order rather than one for the batch: a single
    // problem order must not block every other pharmacy's stock from coming
    // back.
    try {
      await db.begin(async (tx) => {
        await releaseStock(tx, order.pharmacy_id, order.id);
        await tx`
          update orders
          set status = 'cancelled',
              status_detail = 'Expired — the pharmacy did not confirm in time.',
              reserved_until = null,
              updated_at = now()
          where id = ${order.id} and status = 'pending'
        `;
        const [history] = await tx`
          insert into order_status_history (order_id, pharmacy_id, from_status, to_status, actor_type, note)
          values (${order.id}, ${order.pharmacy_id}, 'pending', 'cancelled', 'system',
                  'Hold expired before anyone confirmed it.')
          returning id, changed_at
        `;
        // actor_type='system' here is what makes orderEventType read this as
        // ORDER_HOLD_EXPIRED rather than a generic ORDER_CANCELLED — nobody
        // decided to cancel this, the clock ran out.
        await recordEvent(tx, {
          pharmacyId: order.pharmacy_id, customerId: order.customer_id,
          eventType: orderEventType('pending', 'cancelled', 'system'),
          occurredAt: history.changed_at, actorType: 'system',
          entityType: 'order_status_history', entityId: history.id,
          metadata: { orderId: order.id, reference: order.reference },
        });
      });
      expired.push(order);
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', msg: 'could not expire order hold',
        orderId: order.id, error: err.message,
      }));
    }
  }
  return expired;
}

module.exports = {
  createOrder, updateStatus, listOrders, generateReference,
  expireStaleHolds, releaseStock, ALLOWED_TRANSITIONS, RELEASES_STOCK,
};
