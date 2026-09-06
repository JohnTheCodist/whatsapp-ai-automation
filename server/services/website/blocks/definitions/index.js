/**
 * Every block definition, in one list.
 *
 * ADDING A BLOCK IS: a definition in one of these files (or a new file), and
 * one entry here. Nothing else in the system is touched — not the registry,
 * not the validator, not the renderer's dispatch, not the schema, not the
 * API. registry.test.js asserts the shape of whatever turns up in this array,
 * so a definition missing a field fails the suite rather than a pharmacy.
 *
 * Grouped by what the block is FOR rather than one file per block: a reader
 * looking for "how do the WhatsApp CTAs work" finds all three together, and
 * they genuinely share the rule that none of them stores a URL.
 */

module.exports = [
  ...require('./chrome'),      // header, footer
  ...require('./actions'),     // hero, whatsappCta, pharmacistCta
  ...require('./content'),     // about, services, reviews
  ...require('./practical'),   // openingHours, location, contact
];
