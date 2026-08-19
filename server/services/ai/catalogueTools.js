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
const { createOrder, amendPendingOrder } = require('../orders/orderService');
const { subgroupsFor, isRefusedNeed } = require('./therapeuticNeed');
const { resolveClinicalProduct } = require('../clinical/clinicalProductResolver');
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
 * The stored canonical digits (234801...) -> "+234 801 234 5678".
 *
 * Storage stays a plain digit string, the same convention as wa_phone —
 * comparable and de-duplicable without normalising on every read. Display
 * is the one place that has to look like a phone number to a person reading
 * it on WhatsApp, so the grouping happens here and nowhere else.
 */
function formatPhoneForDisplay(digits) {
  if (!digits) return null;
  const cc = digits.slice(0, 3);
  const rest = digits.slice(3);
  if (rest.length !== 10) return `+${digits}`; // unexpected length: show raw rather than mis-group it
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
}

/**
 * Shape a product for the model.
 *
 * `price` is null when unknown, NEVER 0 — those are different claims, and a
 * model shown 0 will cheerfully quote "it's free". Stock is likewise a
 * three-state answer: a number, or "not tracked", never a silent zero.
 */
/**
 * A catalogue row's NAFDAC therapeutic subgroup, or null.
 *
 * Memoised because resolveClinicalProduct parses the name and walks the
 * in-memory registry, and a browse can ask about a few hundred rows at once.
 * Keyed on the fields the resolver actually reads, so two rows naming the
 * same medicine share one answer. The NAFDAC dataset is immutable for the
 * life of the process, so a cached answer cannot go stale.
 *
 * Returns null for 'Other' as well as for no match: 'Other' is a real NAFDAC
 * value meaning "unclassified", and treating it as a shelf would let an
 * unrelated grab bag answer a specific request.
 */
const subgroupCache = new Map();
const SUBGROUP_CACHE_MAX = 5000;

function subgroupForProduct(row) {
  const key = [row.name, row.generic_name, row.brand_name, row.strength, row.form]
    .map((v) => (v == null ? '' : String(v))).join('|').toLowerCase();
  if (subgroupCache.has(key)) return subgroupCache.get(key);

  let subgroup = null;
  try {
    const resolved = resolveClinicalProduct({
      source_product_name: row.name,
      generic_name: row.generic_name,
      brand: row.brand_name,
      strength: row.strength,
      form: row.form,
    });
    const value = resolved?.therapeutic_subgroup || null;
    subgroup = value && String(value).toLowerCase() !== 'other' ? value : null;
  } catch {
    // A registry miss must never break a product search — the text match
    // below still stands on its own.
    subgroup = null;
  }

  // Bounded, so a pharmacy with a very large catalogue cannot grow this
  // without limit over a long-running process.
  if (subgroupCache.size >= SUBGROUP_CACHE_MAX) subgroupCache.clear();
  subgroupCache.set(key, subgroup);
  return subgroup;
}

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
    name: 'contact_pharmacy',
    description:
      'Give the customer a direct phone number to reach the pharmacy team. LAST RESORT ONLY — call this after '
      + 'you have already tried find_products, browse_category, get_pharmacy_info, ask_pharmacist or a '
      + 'pharmacist handoff, and none of them could help. Do NOT use this as a substitute for a pharmacist '
      + 'handoff on a clinical question — if a pharmacist needs to review something, that handoff is still '
      + 'the primary action; you may mention this number ALONGSIDE it, never instead of it. Do NOT use this '
      + 'for routine "are you open" or "where are you" questions — get_pharmacy_info already answers those.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['automation_limit', 'customer_requested_direct_contact'],
          description:
            'automation_limit: you have tried what you can and cannot resolve this. '
            + 'customer_requested_direct_contact: they explicitly asked for a phone number or to call.',
        },
      },
      required: ['reason'],
    },
    // GROUNDING, THE SAME DISCIPLINE AS EVERY PRICE IN THIS FILE
    // The number is read fresh from pharmacy_profile on every call, never
    // from anything cached in the conversation or the prompt. A pharmacy
    // with no number configured gets `available: false` and an explicit
    // instruction not to guess — the same shape as find_products returning
    // no match. §11's rule ("never invent a number") is enforced here by
    // there being no code path that returns anything but a real, current
    // database value or an honest absence.
    async run(ctx, args) {
      const { pharmacyId, conversationId, customerId } = ctx;
      assertPharmacyId(pharmacyId);

      const reason = ['automation_limit', 'customer_requested_direct_contact'].includes(args?.reason)
        ? args.reason
        : 'automation_limit';

      const db = getSql();
      const [row] = await db`
        select phone from pharmacy_profile where pharmacy_id = ${pharmacyId}
      `;

      if (!row?.phone) {
        return {
          available: false,
          note: 'No contact phone number is configured for this pharmacy. Do NOT invent, guess or substitute '
            + 'one — tell the customer you cannot provide a direct number right now, and use the pharmacist '
            + 'handoff instead if the situation calls for one.',
        };
      }

      // Audited specifically because this is the moment automation is
      // conceding a limit, not because a phone number was merely mentioned —
      // see PATIENT_EVENTS.PHARMACY_CONTACT_PROVIDED for why get_pharmacy_info
      // does NOT also fire this.
      if (conversationId) {
        await recordEvent(db, {
          pharmacyId, customerId,
          eventType: PATIENT_EVENTS.PHARMACY_CONTACT_PROVIDED,
          actorType: 'ai',
          entityType: 'conversation', entityId: conversationId,
          metadata: { reason },
          // Timestamped, the same reason as customerCrm.js's tag events: the
          // default key is (eventType, entityType, entityId), and entityId
          // here is the CONVERSATION — the same one across every escalation
          // within it. Automation can hit its limit more than once in one
          // thread (§17's whole point is counting HOW OFTEN), and the
          // default key would silently collapse a second escalation into a
          // no-op, undercounting exactly what this event exists to measure.
          idempotencyKey: `pharmacy_contact_provided:${conversationId}:${Date.now()}`,
        });
      }

      return {
        available: true,
        phone: formatPhoneForDisplay(row.phone),
        note: 'Tell the customer plainly that they can call the pharmacy directly on this number. State the '
          + 'number exactly as given here — do not reformat it.',
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

      // A red-flag complaint must not be answered with a shelf, however the
      // sentence is built. clinicalFilter catches most of these before the
      // model is ever asked, but it ALLOWS "chest pain" — verified directly —
      // so refusing here too is what stops "pain" resolving to painkillers
      // for a possible cardiac event. See therapeuticNeed's own header.
      if (isRefusedNeed(need)) {
        return {
          need,
          products: [],
          refused: true,
          note: 'This reads as a symptom or an emergency, not a request for a kind of product. '
            + 'Do NOT search the catalogue or suggest a medicine for it. Hand this to a pharmacist, '
            + 'and if it sounds urgent say plainly that they should seek immediate care.',
        };
      }

      const db = getSql();
      // "pain" must find the shelf labelled "Analgesic". Without this the
      // feature works only for categories whose clinical name happens to be
      // the everyday one, and an empty result looks like an empty shop.
      const terms = categoriesFor(need);

      // NAFDAC's controlled vocabulary, as a SECOND route to the same shelf.
      //
      // The text match below can only find what the catalogue happens to
      // say. A customer asking for "blood pressure medicine" against a row
      // called "Amlodipine 10mg" with category "Cardio" matches nothing —
      // no string in that row resembles the request. NAFDAC knows
      // amlodipine's subgroup is Hypertension, so resolving the PRODUCT
      // through the registry finds it where text matching cannot.
      const wantedSubgroups = subgroupsFor(need);

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

      // ---- second route: NAFDAC therapeutic subgroup -----------------------
      //
      // Runs only when the text match left room, and only when the need
      // resolved to a controlled subgroup. Text matching is the more precise
      // signal — it matched the pharmacy's own words — so it keeps priority
      // and this fills the remainder. For "blood pressure medicine" against a
      // catalogue that says "Amlodipine 10mg / Cardio", the text match finds
      // nothing and this route is the whole answer.
      const bySubgroup = [];
      if (rows.length < 4 && wantedSubgroups.length > 0) {
        const seen = new Set(rows.map((r) => r.id));
        // NO times_bought here, deliberately. That column is a correlated
        // count over order_items, and this query is a wide catalogue scan
        // rather than the tight text-filtered one above — running it per row
        // across 400 products made this the slowest query in the tool and it
        // timed out against the pooler on first run. The 90-day sales figure
        // is a nicety for ordering, not something this route needs; the
        // pharmacy's own pick and price still order it.
        const candidates = await db`
          select p.id, p.name, p.generic_name, p.brand_name, p.strength, p.form, p.pack_size,
                 p.category, p.price_kobo, p.stock_qty, p.stock_tracked,
                 p.description, p.is_featured
          from products p
          where p.pharmacy_id = ${pharmacyId}
            and p.status = 'active'
            and p.price_kobo is not null
            and (p.stock_tracked = false or coalesce(p.stock_qty,0) > 0)
          order by p.is_featured desc, p.price_kobo
          -- Bounded: this is resolved row-by-row against the registry in
          -- process, so it must not be able to walk an unbounded catalogue.
          limit 400
        `;
        for (const c of candidates) {
          if (seen.has(c.id)) continue;
          const subgroup = subgroupForProduct(c);
          if (subgroup && wantedSubgroups.includes(subgroup)) {
            bySubgroup.push({ ...c, times_bought: 0, _matched_subgroup: subgroup });
            if (rows.length + bySubgroup.length >= 4) break;
          }
        }
      }

      const matched = [...rows, ...bySubgroup];

      return {
        need,
        // What the request was understood to mean, in NAFDAC's own controlled
        // vocabulary. Reported so a wrong answer is debuggable: "we searched
        // Hypertension" is checkable, "it found nothing" is not.
        therapeutic_subgroups: wantedSubgroups,
        match_count: matched.length,
        products: matched.map((r) => ({
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
        note: matched.length === 0
          ? `This pharmacy has nothing in stock matching "${need}". Use ask_pharmacist if the customer still wants something.`
          : 'Offer these as options with their prices. You may say which the PHARMACY recommends, or which '
            + 'customers buy most — both are facts. You may NOT say which works better, which is stronger, '
            + 'or which is right for this person. '
            + 'For the line about each product use `description` if present, otherwise `factual_summary`, '
            + 'otherwise say only the name and price. Do NOT write your own words about what a medicine is '
            + 'good for, treats, helps with or relieves — not even a mild one. '
            // The closing step of the intended flow. These are options from a
            // shelf, chosen by matching a request to a category — not a
            // recommendation for this person, and the reply must not let a
            // customer mistake one for the other.
            + 'Close by offering the pharmacist: these are what the pharmacy stocks for that need, and which '
            + 'one suits them is a pharmacist\'s call. Say it naturally, once — not as a disclaimer.',
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
    name: 'get_order_history',
    description:
      'Look up this customer\'s past orders with this pharmacy. Use this whenever they ask about '
      + 'something they bought before — "what did I order last time", "the usual", "same as before", '
      + 'or when their history matters for what happens next. Returns their most recent orders with '
      + 'what was in each. Do NOT answer a question about past orders from anything said earlier in '
      + 'this conversation or from your own memory — always call this tool. If it returns no orders, '
      + 'say so plainly; do not guess what they might have bought before.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many recent orders to return. Defaults to 5, capped at 10.',
        },
      },
    },
    // THE RULE THIS TOOL EXISTS TO ENFORCE (Segment 1 §1: AI memory is not
    // the database)
    //
    // Without this tool, "what did I buy last time?" has exactly two possible
    // sources: the current conversation's own recent turns (which vanish the
    // moment the thread rolls over, or were never there if the customer is
    // asking about something from weeks ago), or the model inventing a
    // plausible-sounding answer. Both are unacceptable for the same reason
    // every other fact in this system is grounded: a wrong medicine name in
    // "you bought Amoxicillin last time" is not a stylistic slip, it is
    // fabricated medical history.
    //
    // So this tool is the ONLY sanctioned path to that fact. It queries the
    // orders table scoped to (pharmacyId, customerId) — never trusts
    // anything the model or customer supplied as an identifier — and returns
    // exactly what is in the database. If the database has nothing, the tool
    // says so explicitly rather than returning an empty list the model might
    // read as "check elsewhere".
    async run(ctx, args) {
      const { pharmacyId, customerId } = ctx;
      assertPharmacyId(pharmacyId);

      // No customerId means no verified identity yet (e.g. very first
      // message before resolution completes) — there is nothing to look up,
      // and returning an empty list here must not be misread as "this
      // customer has never ordered", so this is worded as a distinct case.
      if (!customerId) {
        return { orders: [], note: 'This customer is not yet identified — no history to retrieve.' };
      }

      const limit = Math.min(Math.max(parseInt(args?.limit, 10) || 5, 1), 10);

      const db = getSql();
      // customer_id AND pharmacy_id both in the WHERE — belt and braces
      // alongside ctx being server-bound. A customer_id alone would still be
      // correct today (ids are UUIDs scoped per pharmacy already), but this
      // is the same tenant-guard discipline as every other query in this
      // file, and it costs nothing to keep it explicit here too.
      const orders = await db`
        select id, reference, status, total_kobo, created_at
        from orders
        where pharmacy_id = ${pharmacyId} and customer_id = ${customerId}
        order by created_at desc
        limit ${limit}
      `;

      if (orders.length === 0) {
        return { orders: [], note: 'This customer has no previous orders with this pharmacy. Do not invent any.' };
      }

      const items = await db`
        select order_id, name_snapshot, quantity, unit_price_kobo, line_total_kobo
        from order_items
        where order_id in ${db(orders.map((o) => o.id))}
        order by order_id
      `;
      const itemsByOrder = new Map();
      for (const it of items) {
        if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
        itemsByOrder.get(it.order_id).push({
          // name_snapshot, not products.name — what they actually received,
          // frozen at order time. A catalogue rename since then must not
          // silently rewrite what this order says was bought.
          name: it.name_snapshot,
          quantity: it.quantity,
          unit_price_naira: naira(it.unit_price_kobo),
          line_total_naira: naira(it.line_total_kobo),
        });
      }

      return {
        orders: orders.map((o) => ({
          reference: o.reference,
          status: o.status,
          total_naira: naira(o.total_kobo),
          placed_at: o.created_at,
          items: itemsByOrder.get(o.id) || [],
        })),
        note: 'Every field above is from this pharmacy\'s own records. State it as fact; do not embellish '
          + 'or add anything not shown here.',
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
      + 'Never tell them it is reserved, held, or confirmed. '
      + 'IF THE CUSTOMER ALREADY HAS A PENDING ORDER IN THIS CONVERSATION (for example, you asked "anything '
      + 'else?" and they named another product): call this tool again with just the new item(s). It '
      + 'automatically folds into their existing order rather than creating a second one — you do not need '
      + 'to track this yourself or ask the customer to confirm a new reference. Read the response\'s '
      + '`addedToExistingOrder` field to know which happened.',
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
        confirm_add_to_existing: {
          type: 'boolean',
          description:
            'Leave this out unless you are answering a DUPLICATE_ITEM refusal. If an item is already on '
            + 'the customer\'s open order, this tool refuses and tells you the quantities. Ask the customer '
            + 'whether they meant to add more — they may have sent the same message twice by mistake. Only '
            + 'if they say yes, call again with confirm_add_to_existing: true. If they say no, do not call '
            + 'this tool at all: their order already has what they wanted.',
        },
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
        allowDuplicate: args?.confirm_add_to_existing === true,
      });

      if (!result.ok) {
        // A duplicate is a QUESTION, not a failure, and is passed back with
        // the numbers rather than as prose the model would have to parse out
        // of a sentence. Marked needsConfirmation so it cannot be read as
        // "the order failed" and reported to the customer as one.
        if (result.code === 'DUPLICATE_ITEM') {
          return {
            created: false,
            needsConfirmation: true,
            code: result.code,
            duplicates: result.duplicates,
            reason: result.error,
          };
        }
        // Returned as a refusal the model can read out, not an exception.
        // The customer needs to hear why — "only 2 left" is useful, a stack
        // trace is not.
        return { created: false, reason: result.error, code: result.code };
      }

      // Staff already got an alert for this reference when the cart was
      // first created. Paging them again for every extra item added in the
      // same conversation would mean three alerts for one shopping trip —
      // they will see the updated total when they open the order.
      if (!result.merged) {
        // Alert staff, but never let a failed alert fail the order. The
        // order exists; throwing here would tell the customer their request
        // failed when it did not.
        alertStaffOfNewOrder(pharmacyId, result.order, ctx.customer || {})
          .then((r) => console.log(JSON.stringify({
            level: r.sent ? 'info' : 'warn', msg: 'staff order alert', sent: r.sent, reason: r.reason,
          })))
          .catch((err) => console.error(JSON.stringify({
            level: 'error', msg: 'staff order alert threw', error: err.message,
          })));
      }

      return {
        created: true,
        // Also true for a merge — this call did not fail, it just landed on
        // the existing cart instead of opening a new one. The model reads
        // this field to decide whether to say "your order" or "I've added
        // that to your order".
        addedToExistingOrder: Boolean(result.merged),
        reference: result.order.reference,
        status: 'pending',
        // The FULL cart, not just what this call added — a customer asking
        // "what's my order status" mid-conversation needs the whole picture,
        // and the model has no other way to see items folded in earlier.
        total_naira: naira(result.order.total_kobo),
        items: result.order.items.map((l) => ({
          name: l.name_snapshot,
          quantity: l.quantity,
          unit_price_naira: naira(l.unit_price_kobo),
          line_total_naira: naira(l.line_total_kobo),
        })),
        note: result.merged
          ? 'This was added to the customer\'s existing pending order (same reference) rather than starting a '
            + 'new one — they asked for something else in the same conversation. Read back the FULL item list '
            + 'above with the updated total, using the same reference as before. Do not say a new order was '
            + 'created.'
          : 'The order has been sent to the pharmacy and is awaiting their confirmation. '
            + 'Give the customer the reference. Stock is held internally, but the customer must NOT '
            + 'be told it is reserved — only a pharmacist confirming makes that true.',
      };
    },
  },

  {
    name: 'change_order_item',
    description:
      'Change how many of a product is on the customer\'s CURRENT order, or remove it, when they change '
      + 'their mind before the pharmacy has confirmed it ("actually make that 2", "take the vitamin C off", '
      + '"I don\'t need the folic acid any more"). '
      + 'Use the product id from find_products or from the order you just read back. '
      + 'Set quantity to 0 to remove the item entirely; removing the last item cancels the order. '
      + 'This only works while the order is still awaiting the pharmacy. Once staff have confirmed or '
      + 'prepared it, this refuses and tells you so — pass that on and offer a person, do not try again. '
      + 'You do not need the order reference: it finds the customer\'s open order in this conversation.',
    parameters: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          description: 'The id of the product already on the order. Never invent one.',
        },
        quantity: {
          type: 'integer',
          description: 'The NEW total quantity for this item (not a difference). 0 removes it.',
        },
      },
      required: ['product_id', 'quantity'],
    },
    async run(ctx, args) {
      const { pharmacyId, conversationId } = ctx;
      assertPharmacyId(pharmacyId);

      if (!conversationId) {
        return { changed: false, reason: 'There is no active conversation to find an order in.' };
      }

      const db = getSql();
      // The order is found from the CONVERSATION, never from anything the
      // model supplied. A model-chosen order id would be an edit to whatever
      // order it happened to name — including another customer's.
      const [open] = await db`
        select id from orders
        where pharmacy_id = ${pharmacyId} and conversation_id = ${conversationId} and status = 'pending'
        order by created_at desc
        limit 1
      `;
      if (!open) {
        return {
          changed: false,
          reason: 'There is no order awaiting the pharmacy in this conversation. '
            + 'If they already had one confirmed, a member of staff has to change it.',
        };
      }

      const result = await amendPendingOrder(pharmacyId, open.id, {
        productId: String(args?.product_id || ''),
        quantity: args?.quantity,
      });

      if (!result.ok) {
        // A refusal the model can read out, same discipline as create_order.
        return { changed: false, reason: result.error, code: result.code };
      }

      if (result.cancelled) {
        return {
          changed: true,
          orderCancelled: true,
          reference: result.order.reference,
          note: 'That was the last item, so the whole order has been cancelled and the pharmacy will see that. '
            + 'Confirm this plainly to the customer and offer to help if they want something else.',
        };
      }

      return {
        changed: true,
        removed: Boolean(result.removed),
        reference: result.order.reference,
        status: 'pending',
        total_naira: naira(result.order.total_kobo),
        // The FULL remaining order, so the reply can read back what they now
        // have rather than only what changed.
        items: result.order.items.map((l) => ({
          product_id: l.product_id,
          name: l.name_snapshot,
          quantity: l.quantity,
          unit_price_naira: naira(l.unit_price_kobo),
          line_total_naira: naira(l.line_total_kobo),
        })),
        note: 'The order was updated and still has the SAME reference — it has not been re-sent or duplicated. '
          + 'Read back the remaining items and the new total. It is still awaiting the pharmacy\'s '
          + 'confirmation; do not say it is reserved or ready.',
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
