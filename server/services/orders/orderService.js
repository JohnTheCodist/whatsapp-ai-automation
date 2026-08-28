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
 * `pending` holds NOTHING. A request sitting in the queue has not been
 * looked at by anyone, and stock should not move on the strength of a
 * WhatsApp message alone — a pharmacist confirming against the physical
 * shelf is the actual moment the pharmacy commits.
 *
 * Stock is decremented, atomically, the first time a human moves an order
 * OUT of `pending` (to `confirmed`, or straight to `ready` — the dashboard
 * now offers pending orders a single button that does both at once, so one
 * click both commits the stock and tells the customer it is ready). The
 * conditional UPDATE that makes this race-safe moved with it: see
 * commitStock and its call site in updateStatus. Two customers can both have
 * a PENDING order for the last pack — nothing is at stake until a human acts
 * on one of them, and whichever is confirmed first wins the stock; the other
 * fails at confirm time with a clear reason, not silently at order time.
 */

const crypto = require('node:crypto');
const { getSql, assertPharmacyId } = require('../db');
const { recordEvent, orderEventType } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');
const { checkLine } = require('./orderLimits');

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

// Replaced by orderLimits.js — the ceiling is now a share of stock, not a
// constant unrelated to what the pharmacy has. See that file's header.
const MAX_LINES = 20;

/**
 * How recently an open cart must have been touched for re-ordering something
 * already on it to be treated as a possible double-tap rather than a genuine
 * second helping.
 *
 * Ten minutes, and the reason it is not shorter or longer: a mis-send or a
 * repeated "1" happens within seconds to a couple of minutes, while a
 * customer coming back later in the same conversation to add another pack is
 * making a real decision that should not be second-guessed. Ten covers the
 * mistake comfortably without turning ordinary top-ups into an interrogation.
 */
const DUPLICATE_CONFIRM_MINUTES = 10;

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
async function createOrder(pharmacyId, {
  customerId, conversationId = null, items, fulfilment = 'pickup', note = null,
  // Set only once the customer has actually said to add more of something
  // already on their order. Defaults to false so the safe path — ask — is
  // what happens when a caller says nothing.
  allowDuplicate = false,
}) {
  assertPharmacyId(pharmacyId);

  if (!customerId) return { ok: false, code: 'NO_CUSTOMER', error: 'No customer on this conversation.' };
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'NO_ITEMS', error: 'An order needs at least one product.' };
  }
  if (items.length > MAX_LINES) {
    return { ok: false, code: 'TOO_MANY_LINES', error: `An order cannot have more than ${MAX_LINES} different products.` };
  }

  // ---- the pharmacy needs a name before it holds stock for someone --------
  //
  // Deterministic and HERE, not in the calling tool. Whether a customer has
  // given their name is a business rule, and a model deciding it would mean
  // the rule holds only as often as the prompt is obeyed. Putting it in the
  // service also means a future caller — a staff-created order, an API — gets
  // the same gate without having to remember it exists.
  //
  // Checked after the item validation above so a customer with no name still
  // hears "we don't stock that" before being asked who they are: being asked
  // for your name and THEN told the thing is unavailable is a worse
  // conversation than the other order.
  //
  // display_name (the WhatsApp pushName) deliberately does NOT satisfy this.
  // It is whatever the customer set on their own phone and is regularly a
  // device name, a shop name, or an emoji — not something to put on a package.
  const nameCheck = getSql();
  const [named] = await nameCheck`
    select full_name, customer_type from customers where id = ${customerId} and pharmacy_id = ${pharmacyId}
  `;
  if (!named?.full_name) {
    return {
      ok: false,
      code: 'NEEDS_CUSTOMER_NAME',
      error: 'Before sending this to the pharmacy, ask the customer for their full name, then call save_customer_name.',
    };
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
    // The quantity check used to live here, against a fixed 100. It cannot:
    // the limit now depends on stock and price, and neither is known until
    // the product is read below. Moved rather than duplicated — two places
    // deciding what is too much is how a customer gets told a number that the
    // next check disagrees with, which is exactly the "I can send 135 / I
    // cannot send 135" contradiction this replaces.
    wanted.set(productId, (wanted.get(productId) || 0) + quantity);
  }

  const db = getSql();
  const ids = [...wanted.keys()];

  // Which price this order is written at.
  //
  // Derived HERE from the customer record, for the same reason the name gate
  // above is: it is a business rule, and a caller passing the tier in is a
  // caller that can pass the wrong one. The assistant quoted this customer a
  // tier; the order must commit at that same tier or the pharmacy sees a
  // total that does not match what the customer was told.
  const wholesale = named.customer_type === 'wholesale';

  // Scoped to the pharmacy: a product id from another tenant simply does not
  // resolve, so a leaked id cannot be ordered here.
  const products = await db`
    select id, name, stock_qty, stock_tracked, status,
           case when ${wholesale} then wholesale_price_kobo else price_kobo end as price_kobo
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
        // Two different facts, told apart on purpose. A trade account hitting
        // this has NOT found an unpriced product — the pharmacy simply has not
        // put that item on its trade list, and the retail price it does have
        // is not the price this customer is entitled to. Falling back to it
        // would put a retail figure on a trade invoice.
        error: wholesale
          ? `${p.name} has no wholesale price, so it cannot be ordered here. A member of staff can confirm a price for it.`
          : `${p.name} has no price in the catalogue, so it cannot be ordered here. A member of staff can confirm the price.`,
      };
    }
    // How much of the shelf one order may take, and whether the money on it
    // needs a person. Both need the product row, which is why this is here
    // and not up with the payload validation.
    //
    // BEFORE the insufficient-stock check below, deliberately. Asking for
    // 5,000 from a shelf of 135 would otherwise be told "there are only 135
    // in stock" — so the customer asks for 135 and is told "up to 33". Two
    // refusals to learn one number, which is the exact behaviour being fixed.
    // The limit answers both questions at once, and covers the empty shelf
    // itself when max is 0.
    const limit = checkLine({
      quantity,
      stockQty: p.stock_qty,
      stockTracked: p.stock_tracked,
      unitPriceKobo: p.price_kobo,
    });

    if (!limit.ok && limit.action === 'reduce') {
      // The NUMBER, every time. Saying only "that is too many" is what sent a
      // customer guessing 205, then 135, then 100 — and had the assistant
      // offer 135 and then refuse it, because nothing in the conversation knew
      // what the limit actually was.
      //
      // Three different situations, and the wording has to match which one it
      // is. "We keep the rest on the shelf" is TRUE when a share is being
      // withheld and FALSE when the cap is simply everything in stock — and a
      // reassuring sentence that is not true is worse than a blunt one.
      const shelfHasMore = p.stock_tracked && limit.max < (p.stock_qty ?? 0);
      const error = limit.max === 0
        ? `${p.name} is out of stock, so it cannot be ordered right now.`
        : shelfHasMore
          ? `I can put through up to ${limit.max} of ${p.name} in one order — we keep the rest on the shelf for people coming into the shop. Would you like ${limit.max}?`
          : `There ${limit.max === 1 ? 'is' : 'are'} only ${limit.max} of ${p.name} in stock. Would you like ${limit.max}?`;

      return {
        ok: false,
        // The code follows the REASON, not the mechanism. A customer asking
        // for more than exists has hit a stock problem, and callers keyed on
        // INSUFFICIENT_STOCK — including a test written before this rule —
        // are right to expect that answer rather than a limit error.
        code: shelfHasMore ? 'QUANTITY_TOO_LARGE' : 'INSUFFICIENT_STOCK',
        error,
        maxQuantity: limit.max,
      };
    }

    if (!limit.ok && limit.action === 'review') {
      return {
        ok: false,
        code: 'NEEDS_STAFF_REVIEW',
        // NOT a refusal, and the wording must not read as one. A pharmacy
        // that turns away a large order because a chat assistant has a rule
        // has lost a real sale — the request is fine, it just should not be
        // committed by an assistant without a person seeing it.
        error: `That is a large order, so I will pass it to a member of staff to confirm with you directly rather than sending it through myself.`,
        needsHandoff: true,
        valueKobo: limit.valueKobo,
      };
    }

    // Kept even though the limit above already caps quantity at stock: stock
    // is read once and the shelf can move underneath it. Not relied on either
    // way — the real guard is the conditional UPDATE inside the transaction
    // below. This exists so the common case gets a sentence about stock
    // rather than a constraint error.
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
      // Not a column — stripped before insert. Kept on the returned line so
      // a caller can tell which items will actually commit stock later.
      _stock_tracked: p.stock_tracked,
    });
  }

  const totalKobo = lines.reduce((sum, l) => sum + l.line_total_kobo, 0);

  // ---- fold into an already-open cart, rather than starting a second one --
  //
  // "Anything else?" -> customer names another product -> that is still the
  // SAME shopping trip. Without this, every follow-up item became its own
  // order: a customer who picked three things over one conversation left
  // staff three references to separately confirm and reconcile, for what
  // was, to the customer, one request.
  //
  // Scoped to `pending` only. Once a pharmacist has acted (confirmed,
  // rejected, readied), that order is no longer just a conversation between
  // the customer and the assistant — folding a new item into it silently
  // would change something a human already looked at. A pharmacist-owned
  // order gets left alone; the next item starts a fresh one, exactly like
  // today.
  if (conversationId) {
    const merged = await db.begin(async (tx) => {
      // Locked so two rapid-fire messages in the same conversation cannot
      // both see "no open cart" and each start their own.
      const [openCart] = await tx`
        select id, updated_at,
               (updated_at > now() - make_interval(mins => ${DUPLICATE_CONFIRM_MINUTES})) as recently_touched
        from orders
        where pharmacy_id = ${pharmacyId} and conversation_id = ${conversationId} and status = 'pending'
        order by created_at desc
        limit 1
        for update
      `;
      if (!openCart) return null;

      const existingLines = await tx`
        select id, product_id, quantity, line_total_kobo from order_items
        where order_id = ${openCart.id} and pharmacy_id = ${pharmacyId}
      `;
      const byProduct = new Map(existingLines.map((l) => [l.product_id, l]));

      // ---- the double-tap guard ------------------------------------------
      //
      // Re-ordering something that is ALREADY on the open cart, moments after
      // putting it there, is far more often a mistake than an intention: a
      // customer taps send twice, or repeats "1" because the first reply was
      // slow. Silently doubling the quantity is the one outcome nobody wants
      // — they collect two cards, or a pharmacist reserves stock against a
      // number the customer never meant.
      //
      // So within the window this REFUSES and hands the decision back to the
      // customer, rather than guessing either way. Deliberate top-ups still
      // work: the assistant sets allowDuplicate once the customer has
      // actually said to add more, which is exactly the confirmation this is
      // asking for.
      //
      // Bounded by time on purpose. An hour later in a long conversation,
      // "and another paracetamol" is a normal second helping and asking
      // about it would be pedantic — outside the window it merges as before.
      if (!allowDuplicate && openCart.recently_touched) {
        const clashes = lines
          .filter((line) => byProduct.has(line.product_id))
          .map((line) => ({
            productId: line.product_id,
            name: line.name_snapshot,
            alreadyOnOrder: byProduct.get(line.product_id).quantity,
            askedToAdd: line.quantity,
            combined: byProduct.get(line.product_id).quantity + line.quantity,
          }));

        // Returned rather than thrown: nothing has been written yet, so the
        // transaction closes cleanly and the caller turns this into a
        // question instead of an error.
        if (clashes.length > 0) return { duplicates: clashes, reference: null };
      }

      // Same product ordered twice in one trip adds to the existing line
      // rather than duplicating the row — "2 more paracetamol" reads as one
      // line of 5, not two lines of 2 and 3 a pharmacist has to add up.
      for (const line of lines) {
        const existingLine = byProduct.get(line.product_id);
        if (existingLine) {
          await tx`
            update order_items
            set quantity = ${existingLine.quantity + line.quantity},
                line_total_kobo = ${existingLine.line_total_kobo + line.line_total_kobo}
            where id = ${existingLine.id}
          `;
        } else {
          await tx`
            insert into order_items ${tx(
              { ...line, order_id: openCart.id, pharmacy_id: pharmacyId },
              'order_id', 'pharmacy_id', 'product_id', 'name_snapshot',
              'unit_price_kobo', 'quantity', 'line_total_kobo'
            )}
          `;
        }
      }

      const [updated] = await tx`
        update orders set total_kobo = total_kobo + ${totalKobo}, updated_at = now()
        where id = ${openCart.id}
        returning *
      `;

      const [history] = await tx`
        insert into order_status_history (order_id, pharmacy_id, from_status, to_status, actor_type, note)
        values (${openCart.id}, ${pharmacyId}, 'pending', 'pending', 'assistant',
                ${`Added ${lines.length} item${lines.length === 1 ? '' : 's'} from the same conversation.`})
        returning id, changed_at
      `;
      await recordEvent(tx, {
        pharmacyId, customerId, eventType: PATIENT_EVENTS.ORDER_ITEMS_ADDED,
        occurredAt: history.changed_at, actorType: 'ai',
        entityType: 'order_status_history', entityId: history.id,
        metadata: {
          orderId: openCart.id, reference: updated.reference,
          addedTotalKobo: totalKobo, addedItemCount: lines.length,
        },
      });

      const allItems = await tx`
        select product_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo
        from order_items where order_id = ${openCart.id} and pharmacy_id = ${pharmacyId}
        order by id
      `;

      return { order: updated, items: allItems };
    });

    if (merged && merged.duplicates) {
      // A question, not a failure. The shape matches every other business
      // refusal in this module so the assistant reads it the same way, but
      // the payload carries the numbers it needs to ask a precise question:
      // "you already have 1 on this order — make it 2?"
      const [first] = merged.duplicates;
      return {
        ok: false,
        code: 'DUPLICATE_ITEM',
        duplicates: merged.duplicates,
        error: merged.duplicates.length === 1
          ? `${first.name} is already on this order (${first.alreadyOnOrder}). `
            + `Ask whether to make it ${first.combined}, or leave it at ${first.alreadyOnOrder}.`
          : 'Some of those are already on this order. Ask whether to increase the quantities or leave them as they are.',
      };
    }

    if (merged) {
      return { ok: true, merged: true, order: { ...merged.order, items: merged.items } };
    }
  }

  // Retry on reference collision. Random 6 characters over a 20-ish letter
  // alphabet collides rarely, but "rarely" across every pharmacy forever is
  // not never, and the unique constraint would surface it as a 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateReference();
    try {
      const order = await db.begin(async (tx) => {
        // NO stock touched here. The pre-check above (`p.stock_qty <
        // quantity`) already caught the obvious case for a good error
        // message; it is deliberately not atomic and not relied on for
        // correctness — see the module header. The real guard now lives in
        // commitStock, run once a human moves this order out of `pending`.
        const [created] = await tx`
          insert into orders (pharmacy_id, customer_id, conversation_id, reference,
                              status, total_kobo, fulfilment, note,
                              stock_held, reserved_until)
          values (${pharmacyId}, ${customerId}, ${conversationId}, ${reference},
                  'pending', ${totalKobo}, ${fulfilment}, ${note},
                  false, null)
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
      // No stock hold happens in this transaction any more, so the only
      // failure left to retry on is a reference collision.
      if (/unique/i.test(err.message) && /reference/i.test(err.message)) continue;
      throw err;
    }
  }

  return { ok: false, code: 'REFERENCE_COLLISION', error: 'Could not allocate an order reference. Please try again.' };
}

/**
 * Change or remove a line on an order the pharmacy has not acted on yet.
 *
 * WHY `pending` IS THE HARD BOUNDARY
 * While an order is pending, nothing has happened in the physical world: no
 * stock has been decremented (commitStock runs on the first exit from
 * pending), no pharmacist has agreed to supply anything, and the customer has
 * been told only that their request was sent. Editing it is therefore free —
 * it is still just a conversation about what they want.
 *
 * The moment a human clicks confirm or ready, that stops being true. Stock has
 * left the shelf, a person has committed the pharmacy, and the customer has
 * been told it is reserved or ready to collect. Silently rewriting the
 * contents then would mean a pharmacist picking items against a list that
 * changed after they read it — so this refuses, and the customer is directed
 * to a person who can actually undo those things. That refusal is the whole
 * safety property of this function, not a limitation to work around.
 *
 * Removing every line CANCELS the order rather than leaving an empty one: an
 * order with no items is not a smaller order, it is a customer who changed
 * their mind, and staff should see that plainly.
 *
 * @param {object} changes
 * @param {string} changes.productId  the line to change
 * @param {number} changes.quantity   new quantity; 0 removes the line
 */
async function amendPendingOrder(pharmacyId, orderId, { productId, quantity }) {
  assertPharmacyId(pharmacyId);
  if (!productId) return { ok: false, code: 'BAD_ITEM', error: 'Which product should change?' };

  // A MISSING quantity must never mean zero. Number(null), Number(undefined
  // via ''), and Number([]) all coerce to 0, and 0 here means "delete this
  // line" — so a model that simply omitted the field would silently remove
  // an item the customer never asked to remove. Removal has to be an
  // explicit 0, which is exactly what the tool schema asks for.
  if (quantity === null || quantity === undefined || quantity === '') {
    return {
      ok: false,
      code: 'BAD_QUANTITY',
      error: 'Say how many of it they want, or 0 to take it off the order.',
    };
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 0) {
    return { ok: false, code: 'BAD_QUANTITY', error: 'Quantity must be a whole number, or 0 to remove the item.' };
  }
  // The quantity ceiling is checked inside the transaction below, once the
  // product's stock is known. It cannot be done here against a constant: the
  // limit is a share of what is on the shelf, and this function does not know
  // what that is yet.

  const db = getSql();

  try {
    return await db.begin(async (tx) => {
      // Locked so a pharmacist confirming at this exact moment cannot slip
      // between the status check and the write — without this, an amend and a
      // confirm can interleave and the order gets edited after commitStock
      // already counted the old quantities off the shelf.
      const [order] = await tx`
        select id, status, reference, total_kobo from orders
        where id = ${orderId} and pharmacy_id = ${pharmacyId}
        for update
      `;
      if (!order) return { ok: false, code: 'NOT_FOUND', error: 'Order not found.' };

      if (order.status !== 'pending') {
        return {
          ok: false,
          code: 'ALREADY_ACTIONED',
          error: order.status === 'cancelled' || order.status === 'rejected'
            ? `Order ${order.reference} is already ${order.status}, so there is nothing to change.`
            : `Order ${order.reference} has already been ${order.status} by the pharmacy, so it cannot be changed here. `
              + 'A member of staff can still help with it.',
          status: order.status,
          reference: order.reference,
        };
      }

      const [line] = await tx`
        select id, name_snapshot, unit_price_kobo, quantity, line_total_kobo
        from order_items
        where order_id = ${orderId} and pharmacy_id = ${pharmacyId} and product_id = ${productId}
      `;
      if (!line) {
        return { ok: false, code: 'NOT_ON_ORDER', error: 'That product is not on this order.' };
      }

      // Raising a quantity is subject to the same shelf-share rule as adding
      // one. Without this, "change it to 500" walks straight past the limit
      // that "order 500" was refused by — the customer just has to phrase it
      // as an amendment.
      //
      // Only when going UP: reducing a line, or removing it with 0, can never
      // take more of the shelf than is already committed.
      if (qty > line.quantity) {
        const [stockRow] = await tx`
          select stock_qty, stock_tracked from products
          where id = ${line.product_id} and pharmacy_id = ${pharmacyId}
        `;
        const limit = checkLine({
          quantity: qty,
          stockQty: stockRow?.stock_qty,
          stockTracked: stockRow?.stock_tracked ?? false,
          unitPriceKobo: line.unit_price_kobo,
        });
        if (!limit.ok) {
          return limit.action === 'review'
            ? {
              ok: false,
              code: 'NEEDS_STAFF_REVIEW',
              error: 'That is a large order, so a member of staff will confirm it with you directly.',
              needsHandoff: true,
            }
            : {
              ok: false,
              code: 'QUANTITY_TOO_LARGE',
              error: limit.max === 0
                ? `${line.name_snapshot} is out of stock, so the quantity cannot be raised.`
                : `I can put through up to ${limit.max} of ${line.name_snapshot} in one order — we keep the rest on the shelf for people coming into the shop.`,
              maxQuantity: limit.max,
            };
        }
      }

      // Priced from the LINE's own stored unit price, never recomputed from
      // the catalogue. The customer was quoted this figure when the item was
      // added; a price change since then must not silently reprice an order
      // they already agreed to.
      const newLineTotal = line.unit_price_kobo * qty;

      if (qty === 0) {
        await tx`delete from order_items where id = ${line.id}`;
      } else {
        await tx`
          update order_items set quantity = ${qty}, line_total_kobo = ${newLineTotal}
          where id = ${line.id}
        `;
      }

      const [{ count: remaining, total: newTotal }] = await tx`
        select count(*)::int as count, coalesce(sum(line_total_kobo), 0)::bigint as total
        from order_items where order_id = ${orderId} and pharmacy_id = ${pharmacyId}
      `;

      // Nothing left on it. An empty order is a cancelled one — see the
      // header. Goes through the same 'cancelled' status every other
      // cancellation uses, so the inbox and the timeline read consistently.
      const becameEmpty = remaining === 0;
      const [updated] = await tx`
        update orders
        set total_kobo = ${newTotal},
            status = ${becameEmpty ? 'cancelled' : 'pending'},
            status_detail = ${becameEmpty ? 'Customer removed every item before the pharmacy confirmed it.' : null},
            updated_at = now()
        where id = ${orderId} and pharmacy_id = ${pharmacyId}
        returning *
      `;

      const note = becameEmpty
        ? `Customer removed the last item (${line.name_snapshot}); order cancelled.`
        : qty === 0
          ? `Customer removed ${line.name_snapshot}.`
          : `Customer changed ${line.name_snapshot} from ${line.quantity} to ${qty}.`;

      const [history] = await tx`
        insert into order_status_history (order_id, pharmacy_id, from_status, to_status, actor_type, note)
        values (${orderId}, ${pharmacyId}, 'pending', ${becameEmpty ? 'cancelled' : 'pending'}, 'assistant', ${note})
        returning id, changed_at
      `;
      await recordEvent(tx, {
        pharmacyId, customerId: updated.customer_id,
        eventType: becameEmpty
          ? orderEventType('pending', 'cancelled', 'assistant')
          : PATIENT_EVENTS.ORDER_ITEMS_AMENDED,
        occurredAt: history.changed_at, actorType: 'ai',
        entityType: 'order_status_history', entityId: history.id,
        metadata: {
          orderId, reference: updated.reference,
          productId, fromQuantity: line.quantity, toQuantity: qty,
          totalKobo: Number(newTotal),
        },
      });

      const items = await tx`
        select product_id, name_snapshot, unit_price_kobo, quantity, line_total_kobo
        from order_items where order_id = ${orderId} and pharmacy_id = ${pharmacyId}
        order by id
      `;

      return {
        ok: true,
        cancelled: becameEmpty,
        removed: qty === 0,
        order: { ...updated, items },
      };
    });
  } catch (err) {
    throw err;
  }
}

/**
 * Staff-side status change, with history.
 *
 * `ready` is reachable directly from `pending` as well as from `confirmed` —
 * the dashboard's pending queue now offers ONE button that confirms and
 * marks ready in the same click, so a pharmacist is not sending the customer
 * two separate "your order is..." messages for what is, in practice, a
 * single decision. `confirmed` stays a legal stop of its own for any order
 * already sitting there, or a caller that wants the two steps kept apart.
 */
const ALLOWED_TRANSITIONS = {
  pending: ['confirmed', 'ready', 'rejected', 'cancelled'],
  confirmed: ['ready', 'cancelled', 'completed'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rejected: [],
};

/** Statuses where the pharmacy is no longer going to supply the order. */
const RELEASES_STOCK = new Set(['rejected', 'cancelled']);

/**
 * The first exit from `pending` that commits the pharmacy to supplying the
 * order — this is now the moment stock actually leaves the shelf. Both
 * targets are listed because the dashboard can reach either one directly
 * from `pending` (see ALLOWED_TRANSITIONS); whichever happens first is the
 * one that commits stock, and it must never happen twice for one order.
 */
const COMMITS_STOCK_FROM_PENDING = new Set(['confirmed', 'ready']);

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

/**
 * Atomically decrement stock for every tracked line on this order — the same
 * conditional-UPDATE guard that used to run at order creation (see the
 * module header), moved to the first transition out of `pending`.
 *
 * Returns a result object rather than throwing for the ordinary case: a
 * pharmacist confirming a pack that is already gone is a business outcome
 * updateStatus's caller must report, not a crash.
 *
 * @param {object} tx  must be a transaction — a failed line has to roll back
 *   every line already decremented in this same call.
 */
async function commitStock(tx, pharmacyId, orderId) {
  const items = await tx`
    select oi.product_id, oi.quantity, oi.name_snapshot, p.stock_tracked
    from order_items oi
    join products p on p.id = oi.product_id and p.pharmacy_id = ${pharmacyId}
    where oi.order_id = ${orderId} and oi.pharmacy_id = ${pharmacyId}
  `;

  let heldAnything = false;
  for (const line of items) {
    // Untracked products commit nothing — the pharmacy is not counting them,
    // so there is no number to decrement and nothing to restore later.
    if (!line.stock_tracked) continue;

    const [held] = await tx`
      update products
      set stock_qty = stock_qty - ${line.quantity}, updated_at = now()
      where id = ${line.product_id}
        and pharmacy_id = ${pharmacyId}
        and stock_tracked = true
        and stock_qty >= ${line.quantity}
      returning id
    `;

    if (!held) {
      // The caller is inside a transaction and must roll back on this
      // result — every line committed above in this same call rolls back
      // with it, so a multi-line order never half-commits.
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        error: `Someone already took the last ${line.name_snapshot}. It is no longer available.`,
      };
    }
    heldAnything = true;
  }

  return { ok: true, heldAnything };
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

  try {
    const updated = await db.begin(async (tx) => {
      // Stock commits HERE — the first time a human moves this order out of
      // `pending` — not at creation. See the module header for why, and
      // commitStock for the race-safety guard that moved here with it.
      let justCommitted = false;
      if (order.status === 'pending' && COMMITS_STOCK_FROM_PENDING.has(toStatus)) {
        const commit = await commitStock(tx, pharmacyId, orderId);
        if (!commit.ok) {
          // Thrown, not returned: this is inside db.begin, and only a throw
          // rolls the transaction back. Caught below, outside the
          // transaction, and turned back into the same result shape every
          // other business refusal in this module uses.
          const err = new Error(commit.error);
          err.businessRefusal = commit;
          throw err;
        }
        justCommitted = commit.heldAnything;
      }

      // Stock goes back when the pharmacy is no longer supplying it. Not on
      // `completed` — that stock genuinely left the shelf with the customer.
      if (RELEASES_STOCK.has(toStatus)) {
        await releaseStock(tx, pharmacyId, orderId);
      }

      const [row] = await tx`
        update orders set status = ${toStatus}, status_detail = ${note},
               -- OR, not overwrite: stays true once set (confirmed -> ready
               -- must not forget stock already committed at confirmed), and
               -- becomes true the moment this transition is the one that
               -- just committed it.
               stock_held = stock_held OR ${justCommitted},
               -- Nothing is ever held while pending any more, so there is
               -- no countdown to preserve or clear here — always null.
               reserved_until = null,
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
  } catch (err) {
    if (err.businessRefusal) return err.businessRefusal;
    throw err;
  }
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
  createOrder, amendPendingOrder, updateStatus, listOrders, generateReference,
  expireStaleHolds, releaseStock, commitStock,
  ALLOWED_TRANSITIONS, RELEASES_STOCK, COMMITS_STOCK_FROM_PENDING,
};
