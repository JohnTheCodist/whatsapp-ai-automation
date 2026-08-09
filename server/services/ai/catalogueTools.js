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
    async run(pharmacyId, args) {
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
    async run(pharmacyId) {
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
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Execute a tool the model asked for.
 *
 * `pharmacyId` comes from the request, never from the model's arguments —
 * even if the model invents a pharmacyId argument it is ignored, because it
 * is not read from `args` at any point.
 */
async function runTool(pharmacyId, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    return { error: `Unknown tool "${name}".` };
  }
  try {
    return await tool.run(pharmacyId, args || {});
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
