/**
 * The only way facts enter a reply.
 *
 * The model has no catalogue knowledge to hallucinate from. It cannot recall
 * that this pharmacy stocks Augmentin, because it was never told — every
 * price, every stock level, every opening time arrives as a tool result or
 * does not exist. That is layer 1 of hallucination prevention (§7), and it is
 * structural rather than a request in a prompt.
 *
 * TENANT BINDING
 * `pharmacyId` is NOT a tool parameter. It is bound server-side by the runner
 * and does not appear in the schema the model sees, so there is no argument
 * for a prompt injection to set. A customer can talk the model into ASKING
 * for another pharmacy's catalogue; they cannot make the SQL return it.
 *
 * WHY SQL AND NOT VECTORS
 * A catalogue is a few thousand structured rows and the question is "do you
 * have X". Trigram matching over name and generic is exact about what it
 * matched and why. Embeddings would happily rank "Panadol Advance" as a near
 * neighbour of "Panadol Extra" — in a pharmacy that is not a ranking
 * imperfection, it is a different product at a different price.
 */

const { getSql, assertPharmacyId } = require('../db');
const { createOrder } = require('../orders/orderService');
const { alertStaffOfNewOrder } = require('../orders/staffAlert');

/** Kobo -> naira, for anything a human will read. */
function naira(kobo) {
  return kobo === null || kobo === undefined ? null : kobo / 100;
}

/**
 * Shape a product for the model.
 *
 * `price` is null when unknown, NEVER 0 — those are different claims, and a
 * model shown 0 will cheerfully quote "it's free". Stock is likewise a
 * three-state answer: a number, or "not tracked", never a silent zero.
 */
function presentProduct(row) {
  return {
    id: row.id,
    name: row.name,
    generic_name: row.generic_name,
    strength: row.strength,
    form: row.form,
    pack_size: row.pack_size,
    category: row.category,
    price_naira: naira(row.price_kobo),
    price_known: row.price_kobo !== null,
    stock_tracked: row.stock_tracked,
    stock_qty: row.stock_tracked ? row.stock_qty : null,
    in_stock: row.stock_tracked ? (row.stock_qty ?? 0) > 0 : null,
  };
}

const TOOLS = [
  {
    name: 'find_products',
    description:
      'Search this pharmacy\'s catalogue by product name or generic name. Use this for any question '
      + 'about whether a product is available, what it costs, or how much stock there is. '
      + 'Returns an empty list if nothing matches — that means the pharmacy does not stock it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The product the customer asked about, e.g. "Augmentin" or "vitamin c".',
        },
      },
      required: ['query'],
    },
    async run(ctx, args) {
      const { pharmacyId } = ctx;
      assertPharmacyId(pharmacyId);
      const query = String(args?.query || '').trim();
      if (!query) return { products: [], note: 'No search term given.' };

      const db = getSql();
      // Trigram similarity, with a plain ILIKE arm so an exact substring
      // always wins regardless of how short the query is.
      const rows = await db`
        select id, name, generic_name, strength, form, pack_size, category,
               price_kobo, stock_qty, stock_tracked,
               greatest(
                 similarity(name, ${query}),
                 similarity(coalesce(generic_name, ''), ${query})
               ) as score
        from products
        where pharmacy_id = ${pharmacyId}
          and status = 'active'
          and (
            name ilike ${'%' + query + '%'}
            or generic_name ilike ${'%' + query + '%'}
            or similarity(name, ${query}) > 0.25
            or similarity(coalesce(generic_name, ''), ${query}) > 0.25
          )
        order by (name ilike ${'%' + query + '%'}) desc, score desc, name
        limit 8
      `;

      return {
        query,
        match_count: rows.length,
        products: rows.map(presentProduct),
        // Said explicitly so the model does not fill the silence itself.
        note: rows.length === 0
          ? `No product matching "${query}" is in this pharmacy's catalogue. Do not guess whether they stock it.`
          : null,
      };
    },
  },

  {
    name: 'get_pharmacy_info',
    description:
      'Get this pharmacy\'s address, opening hours, phone number and whether they deliver. '
      + 'Use for questions like "where are you?", "are you open?" or "do you deliver?".',
    parameters: { type: 'object', properties: {} },
    async run(ctx) {
      const { pharmacyId } = ctx;
      assertPharmacyId(pharmacyId);
      const db = getSql();
      const [row] = await db`
        select p.name,
               pr.address_line, pr.city, pr.state, pr.landmark, pr.phone,
               pr.opening_hours, pr.delivers, pr.delivery_note, pr.extra_info
        from pharmacies p
        left join pharmacy_profile pr on pr.pharmacy_id = p.id
        where p.id = ${pharmacyId}
      `;
      if (!row) return { note: 'Pharmacy details are not available.' };

      const known = {};
      if (row.address_line || row.city) {
        known.address = [row.address_line, row.landmark, row.city, row.state].filter(Boolean).join(', ');
      }
      if (row.phone) known.phone = row.phone;
      if (Array.isArray(row.opening_hours) && row.opening_hours.length > 0) {
        known.opening_hours = row.opening_hours;
      }
      known.delivers = row.delivers;
      if (row.delivery_note) known.delivery_note = row.delivery_note;
      if (row.extra_info) known.extra_info = row.extra_info;

      // Naming what is missing matters as much as returning what is present.
      // Without this the model invents plausible opening hours.
      const missing = [];
      if (!known.address) missing.push('address');
      if (!known.opening_hours) missing.push('opening hours');
      if (!known.phone) missing.push('phone number');

      return {
        pharmacy_name: row.name,
        ...known,
        unknown_fields: missing,
        note: missing.length
          ? `The pharmacy has not provided: ${missing.join(', ')}. Say you will check rather than guessing.`
          : null,
      };
    },
  },
  {
    name: 'ask_pharmacist',
    description:
      'Ask the pharmacy staff whether they can supply something the catalogue does not have, or can '
      + 'suggest an alternative. Use this when find_products found nothing (or the product is out of '
      + 'stock) AND the customer still wants it. Do NOT suggest an alternative medicine yourself — '
      + 'only a pharmacist may decide what substitutes for what. After calling this, tell the customer '
      + 'you have asked the pharmacist and will come back to them.',
    parameters: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: 'What the customer asked for, in their words, e.g. "ibucap" or "cough syrup for a child".',
        },
      },
      required: ['product'],
    },
    async run(ctx, args) {
      const { pharmacyId, conversationId, customerId } = ctx;
      assertPharmacyId(pharmacyId);

      if (!conversationId || !customerId) {
        return { asked: false, error: 'This conversation cannot raise a request right now.' };
      }
      const product = String(args?.product || '').trim();
      if (!product) return { asked: false, error: 'No product was named.' };

      const { openRequest } = require('../orders/requestService');
      const { request, created } = await openRequest(pharmacyId, {
        conversationId, customerId, requestedText: product,
      });

      return {
        asked: true,
        already_pending: !created,
        request_id: request.id,
        note:
          'A pharmacist has been asked and will answer shortly. Tell the customer you have checked with '
          + 'the pharmacist and will come back to them. Do NOT suggest a substitute yourself, do not '
          + 'guess what they might offer, and do not promise a timeframe.',
      };
    },
  },

  {
    name: 'create_order',
    description:
      'Send an order to the pharmacy for a customer who has said they want to buy specific products. '
      + 'Only call this AFTER the customer has confirmed what they want and how many. '
      + 'You must have found each product with find_products first — use the exact product id it returned. '
      + 'This does NOT reserve stock or confirm anything: it puts the order in front of pharmacy staff, '
      + 'who decide. Tell the customer their order has been sent to the pharmacy and someone will confirm it. '
      + 'Never tell them it is reserved, held, or confirmed.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The products the customer agreed to buy.',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'The id returned by find_products. Never invent one.' },
              quantity: { type: 'integer', description: 'How many, as a whole number of at least 1.' },
            },
            required: ['product_id', 'quantity'],
          },
        },
        fulfilment: {
          type: 'string',
          enum: ['pickup', 'delivery'],
          description: 'Pickup unless the customer explicitly asked for delivery.',
        },
        note: { type: 'string', description: 'Anything the customer asked to pass on. Optional.' },
      },
      required: ['items'],
    },
    async run(ctx, args) {
      const { pharmacyId, customerId, conversationId } = ctx;
      assertPharmacyId(pharmacyId);

      // Note what is NOT in the schema above: price, and total. The model
      // supplies ids and quantities only. Every figure on the order is read
      // from the catalogue inside createOrder, because a model that will
      // say "I've set aside 3 packs" when nothing exists will equally
      // confidently state a price that is wrong.
      const items = Array.isArray(args?.items) ? args.items.map((i) => ({
        productId: String(i?.product_id || ''),
        quantity: Number(i?.quantity),
      })) : [];

      const result = await createOrder(pharmacyId, {
        customerId,
        conversationId,
        items,
        fulfilment: args?.fulfilment === 'delivery' ? 'delivery' : 'pickup',
        note: args?.note ? String(args.note).slice(0, 500) : null,
      });

      if (!result.ok) {
        // Returned as a refusal the model can read out, not an exception.
        // The customer needs to hear why — "only 2 left" is useful, a stack
        // trace is not.
        return { created: false, reason: result.error, code: result.code };
      }

      // Alert staff, but never let a failed alert fail the order. The order
      // exists and stock is already held; throwing here would tell the
      // customer their request failed when it did not.
      alertStaffOfNewOrder(pharmacyId, result.order, ctx.customer || {})
        .then((r) => console.log(JSON.stringify({
          level: r.sent ? 'info' : 'warn', msg: 'staff order alert', sent: r.sent, reason: r.reason,
        })))
        .catch((err) => console.error(JSON.stringify({
          level: 'error', msg: 'staff order alert threw', error: err.message,
        })));

      return {
        created: true,
        reference: result.order.reference,
        status: 'pending',
        total_naira: naira(result.order.total_kobo),
        items: result.order.items.map((l) => ({
          name: l.name_snapshot,
          quantity: l.quantity,
          unit_price_naira: naira(l.unit_price_kobo),
          line_total_naira: naira(l.line_total_kobo),
        })),
        note:
          'The order has been sent to the pharmacy and is awaiting their confirmation. '
          + 'Give the customer the reference. Stock is held internally, but the customer must NOT '
          + 'be told it is reserved — only a pharmacist confirming makes that true.',
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Execute a tool the model asked for.
 *
 * `pharmacyId` comes from the request, never from the model's arguments —
 * even if the model invents a pharmacyId argument it is ignored, because it
 * is not read from `args` at any point.
 */
async function runTool(ctx, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { error: `Unknown tool "${name}".` };
  }
  // Accepts a bare id as well as a context object so a caller that only has
  // a pharmacy — a test, a future admin path — does not have to fabricate a
  // customer to look up a price.
  const context = typeof ctx === 'string' ? { pharmacyId: ctx } : (ctx || {});
  try {
    return await tool.run(context, args || {});
  } catch (err) {
    // Returned as data rather than thrown: the loop should be able to tell
    // the customer something went wrong, not crash mid-conversation.
    return { error: `Tool "${name}" failed: ${err.message}` };
  }
}

/** The schema shown to the model. Note the absence of pharmacyId. */
function toolSchemas() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

module.exports = { TOOLS, runTool, toolSchemas, presentProduct, naira };
