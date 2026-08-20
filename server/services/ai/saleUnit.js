/**
 * What a product is actually SOLD as — one tablet strip, one bottle, one
 * tube — derived from the catalogue's own `form` column rather than left for
 * the model to guess or, worse, adopted from whatever word the customer used.
 *
 * THE BUG THIS EXISTS TO FIX
 * A customer asked for "a sachet of paracetamol". The product's `form` in the
 * catalogue is `tablet`. The assistant replied "Paracetamol 500mg tablets at
 * ₦460 per sachet" — it had the correct unit sitting in the tool result
 * (`form: "tablet"`) and used the customer's wrong word instead, because
 * nothing forced it to prefer the catalogue's own fact over the sentence it
 * was replying to.
 *
 * A pharmacy attendant would never make this mistake — paracetamol comes as
 * tablets, full stop, and a customer who says "sachet" gets gently corrected,
 * not agreed with. This module is what lets the assistant do the same: it
 * turns the catalogue's `form` into the Nigerian pharmacy counter word for
 * that unit, so `saleUnit(product)` is always available as ground truth
 * alongside the price, and the prompt can require it be used.
 *
 * Deliberately NOT a clinical judgement — this says nothing about what a
 * product treats or how it should be used, only what one unit of it is
 * called at the till. That keeps it out of the territory clinicalFilter and
 * the "never invent a description" rule are guarding.
 */

/**
 * form (as imported, any case/spacing) -> the word a Nigerian pharmacy
 * counter uses for one sellable unit.
 *
 * Deliberately a closed list rather than a guess from the string. An unknown
 * form returns null and the caller falls back to "pack" — silently inventing
 * a new unit word for a form nobody taught this table is worse than being
 * generic about it.
 */
const UNIT_BY_FORM = {
  tablet: 'card',       // Nigerian pharmacy convention: tablets are sold by the card/strip, not loose
  tab: 'card',
  capsule: 'card',
  cap: 'card',
  syrup: 'bottle',
  suspension: 'bottle',
  solution: 'bottle',
  cream: 'tube',
  ointment: 'tube',
  gel: 'tube',
  injection: 'vial',
  ampoule: 'ampoule',
  vial: 'vial',
  sachet: 'sachet',
  powder: 'sachet',
  drops: 'bottle',
  spray: 'bottle',
  inhaler: 'inhaler',
  suppository: 'pack',
  patch: 'pack',
};

/**
 * Customer words that mean the SAME unit at a Nigerian counter.
 *
 * "Sachet" is the one that matters. A strip of tablets is called a sachet by
 * a great many customers here, and treating that as an error — which this
 * file previously did, instructing the assistant to "gently correct" them —
 * is the assistant being wrong about Nigerian usage while sounding certain.
 * It reads as a foreign product lecturing a customer about their own
 * vocabulary, over a distinction the pharmacy itself does not make.
 *
 * So these are synonyms, not mistakes. The assistant still STATES the price
 * in the catalogue's own unit, for consistency across a conversation — it
 * just no longer treats the customer's word as something to be put right.
 *
 * Only genuinely interchangeable words belong here. "Bottle" and "card" are
 * different things, and a customer who says bottle when the product is a
 * card DOES need telling, or they will arrive expecting a bottle.
 */
const UNIT_SYNONYMS = {
  card: ['sachet', 'satchet', 'sachets', 'strip', 'strips', 'pack', 'packet'],
  sachet: ['card', 'sachets', 'satchet', 'packet', 'pack'],
  bottle: ['btl', 'bottles'],
  tube: ['tubes'],
  vial: ['vials', 'ampoule'],
  pack: ['packet', 'packs'],
};

/**
 * Would a customer saying `spoken` reasonably mean a product sold by `unit`?
 * Case- and plural-tolerant, because this is matched against typed chat.
 */
function isUnitSynonym(spoken, unit) {
  if (!spoken || !unit) return false;
  const a = String(spoken).trim().toLowerCase();
  const b = String(unit).trim().toLowerCase();
  if (a === b) return true;
  return (UNIT_SYNONYMS[b] || []).includes(a);
}

/**
 * @param {string|null|undefined} form  a product's raw catalogue `form`
 * @returns {string|null} the counter word, or null if the form is unknown/absent
 */
function unitForForm(form) {
  if (!form || typeof form !== 'string') return null;
  const key = form.trim().toLowerCase();
  return UNIT_BY_FORM[key] || null;
}

/**
 * @param {{form?: string, pack_size?: string}} product
 * @returns {string} always a usable word — 'pack' when the form is unknown,
 *   so a reply is never left with no unit to say at all.
 */
function saleUnit(product) {
  return unitForForm(product?.form) || 'pack';
}

/**
 * Is the customer's own word for the unit actually wrong for this product?
 *
 * Used to decide whether the reply needs a gentle correction rather than a
 * silent substitution — "sachet" said about a tablet is worth naming, so the
 * customer learns what they are actually being sold, not just what it costs.
 *
 * @param {string} said     whatever unit word appeared in the customer's message
 * @param {object} product  the catalogue row
 * @returns {boolean}
 */
function isWrongUnit(said, product) {
  if (!said) return false;
  const truth = unitForForm(product?.form);
  if (!truth) return false; // nothing to correct against
  const s = said.trim().toLowerCase();
  // A few things count as the same claim even if the word differs -
  // "strip" and "card" are the same object in different regions, "tab" and
  // "tablet" name the same unit rather than disagreeing about it.
  const SYNONYMS = { strip: 'card', tabs: 'card', tablets: 'card', capsules: 'card', bottles: 'bottle', tubes: 'tube', vials: 'vial' };
  const normalised = SYNONYMS[s] || s;
  if (normalised === truth) return false;
  // Regional usage, checked against the shared table rather than duplicated
  // here — "sachet" for a card is standard Nigerian speech, not an error to
  // be put right. Keeping this in one place is what stops the two lists
  // drifting apart and the assistant correcting a word it accepts elsewhere.
  return !isUnitSynonym(normalised, truth);
}

module.exports = { saleUnit, unitForForm, isWrongUnit, isUnitSynonym, UNIT_BY_FORM, UNIT_SYNONYMS };
