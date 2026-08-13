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
const { categoriesFor } = require('./needVocabulary');
const { alertStaffOfNewOrder } = require('../orders/staffAlert');
const { saleUnit } = require('./saleUnit');
const { isGroundedIn, splitName } = require('../customers/customerName');
const { recordEvent } = require('../customers/customerEvents');
const { PATIENT_EVENTS } = require('../customers/patientEventTypes');

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
    // The word for ONE sellable unit of this product — 'card' for tablets,
    // 'bottle' for syrup, 'tube' for cream, and so on (saleUnit.js). Always
    // use THIS word when stating a price, never the customer's own word for
    // the unit. A customer asking for "a sachet of paracetamol" was once told
    // the price "per sachet" for a product whose form is tablet, because the
    // model echoed their word instead of the catalogue's.
    sale_unit: saleUnit(row),
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
    name: 'browse_category',
    description:
      'List what this pharmacy stocks for a need, when the customer asks broadly rather than for one '
      + 'named product — "what do you have for malaria", "something for pain", "your best antimalarial". '
      + 'Returns real products with prices, the pharmacy\'s own description of each, and which ones the '
      + 'pharmacy recommends. Present these as options; do NOT rank them by how well they work.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description:
            'What the customer is looking for, in their words — e.g. "malaria", "pain", "cough", '
            + '"vitamins". Matched against product categories and names.',
        },
      },
      required: ['need'],
    },
    async run(ctx, args) {
      const { pharmacyId } = ctx;
      assertPharmacyId(pharmacyId);
      const need = String(args?.need || '').trim();
      if (!need) return { products: [], note: 'No need was given.' };

      const db = getSql();
      // "pain" must find the shelf labelled "Analgesic". Without this the
      // feature works only for categories whose clinical name happens to be
      // the everyday one, and an empty result looks like an empty shop.
      const terms = categoriesFor(need);

      // Ordered by the pharmacy's own pick first, then by what actually
      // sells, then price. Every one of those is a fact this system holds —
      // none of them is a claim about which medicine works better.
      const rows = await db`
        select p.id, p.name, p.generic_name, p.strength, p.form, p.pack_size,
               p.category, p.price_kobo, p.stock_qty, p.stock_tracked,
               p.description, p.is_featured,
               (select count(*)::int from order_items oi
                  join orders o on o.id = oi.order_id
                 where oi.product_id = p.id
                   and o.status in ('confirmed','ready','completed')
                   and o.created_at > now() - interval '90 days') as times_bought
        from products p
        where p.pharmacy_id = ${pharmacyId}
          and p.status = 'active'
          and p.price_kobo is not null
          and exists (
            select 1 from unnest(${terms}::text[]) as t(term)
            where p.category ilike '%' || t.term || '%'
               or p.name ilike '%' || t.term || '%'
               or coalesce(p.generic_name,'') ilike '%' || t.term || '%'
          )
          and (p.stock_tracked = false or coalesce(p.stock_qty,0) > 0)
        order by p.is_featured desc, times_bought desc, p.price_kobo
        -- Four, not six. Given six the model reads out all six as a price
        -- list, which is what a database does, not what a counter assistant
        -- does. Someone asking "what do you have for pain" wants to be helped
        -- to a decision, and a wall of options is the opposite of that.
        -- Ordering already puts the pharmacy's pick first, so the ones cut
        -- are the ones nobody chose to highlight.
        limit 4
      `;

      return {
        need,
        match_count: rows.length,
        products: rows.map((r) => ({
          ...presentProduct(r),
          // The pharmacy's words, or nothing. Never a description written here.
          description: r.description || null,
          // Something TRUE to say when the pharmacy has written nothing.
          //
          // Asked for pain, the model produced "Good for everyday pain
          // relief" and "A trusted basic option" for products whose
          // description was NULL — invented efficacy claims, despite the
          // prompt forbidding exactly that. Telling a model not to fill a
          // gap does not work; removing the gap does. This is assembled
          // only from catalogue columns, so it states what the product IS
          // and never what it does.
          factual_summary: [
            r.generic_name,
            r.strength,
            r.form,
            r.pack_size ? `pack of ${r.pack_size}` : null,
          ].filter(Boolean).join(', ') || null,
          pharmacy_recommends: r.is_featured,
          times_bought_90d: r.times_bought,
        })),
        note: rows.length === 0
          ? `This pharmacy has nothing in stock matching "${need}". Use ask_pharmacist if the customer still wants something.`
          : 'Offer these as options with their prices. You may say which the PHARMACY recommends, or which '
            + 'customers buy most — both are facts. You may NOT say which works better, which is stronger, '
            + 'or which is right for this person. '
            + 'For the line about each product use `description` if present, otherwise `factual_summary`, '
            + 'otherwise say only the name and price. Do NOT write your own words about what a medicine is '
            + 'good for, treats, helps with or relieves — not even a mild one.',
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
    name: 'save_customer_name',
    description:
      'Save the customer\'s full name, after THEY have told you what it is in their own message. '
      + 'Call this only when create_order refused with NEEDS_CUSTOMER_NAME and the customer has just '
      + 'replied with their name. Pass exactly the name they typed — do not add a surname they did not '
      + 'give, do not use their WhatsApp profile name, and do not guess. After it succeeds, call '
      + 'create_order again.',
    parameters: {
      type: 'object',
      properties: {
        full_name: {
          type: 'string',
          description: 'The name exactly as the customer just wrote it, e.g. "John Adeyemi" or "John".',
        },
      },
      required: ['full_name'],
    },
    async run(ctx, args) {
      const { pharmacyId, customerId, customerText } = ctx;
      assertPharmacyId(pharmacyId);
      if (!customerId) return { saved: false, error: 'No customer on this conversation.' };

      const proposed = String(args?.full_name || '');

      // THE GUARD. A model asked for a name always produces one, and the
      // plausible wrong answers are the dangerous ones: the WhatsApp display
      // name, an invented surname that makes "John" look complete, or a name
      // from an earlier unrelated sentence. Any of those ends up printed on a
      // package, so a name that does not appear in what the customer actually
      // typed is refused here regardless of what the model returned.
      if (!isGroundedIn(proposed, customerText)) {
        return {
          saved: false,
          error: 'That name does not appear in what the customer just wrote. Ask them to type their name, and pass exactly what they type. Never supply a name they did not give.',
        };
      }

      const { firstName, lastName, fullName } = splitName(proposed);
      if (!fullName) return { saved: false, error: 'That is not a usable name. Ask the customer again.' };

      const db = getSql();
      const [updated] = await db`
        update customers
        set first_name = ${firstName}, last_name = ${lastName}, full_name = ${fullName},
            name_verified = true, name_source = 'customer_provided', name_updated_at = now()
        where id = ${customerId} and pharmacy_id = ${pharmacyId}
        returning id, full_name
      `;
      if (!updated) return { saved: false, error: 'Could not save that name.' };

      // Timeline event. Non-fatal: the name is saved either way, and a
      // failed event must not make the assistant re-ask for a name it has.
      try {
        await recordEvent(db, {
          pharmacyId, customerId, eventType: PATIENT_EVENTS.CUSTOMER_NAME_CAPTURED,
          actorType: 'customer', entityType: 'customer', entityId: customerId,
          metadata: { fullName },
          // Keyed on the name itself, so a later correction records a second
          // event rather than being swallowed as a duplicate of the first.
          idempotencyKey: `customer_name:${customerId}:${fullName.toLowerCase()}`,
        });
      } catch (err) {
        console.error(JSON.stringify({ level: 'warn', msg: 'name captured but event not recorded', error: err.message }));
      }

      return {
        saved: true,
        full_name: fullName,
        note: 'Name saved. Now call create_order again to send the order to the pharmacy.',
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
