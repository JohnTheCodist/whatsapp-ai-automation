/**
 * Decide WHICH red-flag rules actually fire for one patient's collected facts.
 *
 * WHAT THIS REPLACES
 * Before this module, the only thing standing between "a protocol has red
 * flags configured" and "escalate urgently" was a non-empty list. There was
 * no evaluation step, because rules carried no trigger (see 0036). A
 * protocol with active flags escalated every turn; one without never
 * escalated at all.
 *
 * DETERMINISTIC, AND DELIBERATELY DUMB
 * A rule fires when the patient's own answer contains the value the rule
 * watches. No inference, no synonyms, no model. The patient ticked
 * "Fits or convulsions", so the convulsions rule fires — that is the whole
 * mechanism, and it is the whole mechanism on purpose: the question that
 * decides whether someone is told to go to hospital should be answerable by
 * reading twenty lines of code.
 *
 * FAILS CLOSED, BUT NOT LOUD
 * A rule with no trigger_concept is INERT — it never fires. That is the
 * opposite of the old behaviour and the right direction: a rule nobody has
 * finished configuring is not evidence of danger, and treating it as an
 * emergency trains staff to ignore emergencies. Such rules are reported via
 * `inert` so a reviewer can see them without a patient being escalated for
 * a configuration gap.
 */

const { getSql, assertPharmacyId } = require('../db');

/**
 * Does `factValue` contain `needle`?
 *
 * Multi-choice answers arrive as arrays, comma-joined strings, or a single
 * scalar depending on how they were recorded. Normalised here rather than at
 * every call site, because getting this wrong in one place means a danger
 * sign silently not firing.
 */
function containsValue(factValue, needle) {
  if (factValue === null || factValue === undefined) return false;
  const target = String(needle).trim().toLowerCase();
  if (!target) return false;

  const parts = Array.isArray(factValue)
    ? factValue
    : String(factValue).split(/[,;|]/);

  return parts.some((p) => String(p).trim().toLowerCase() === target);
}

/**
 * @param {Map<string, {value:any}>|object} factsByConcept
 * @returns {any} the recorded value for a concept, or undefined
 */
function readFact(factsByConcept, concept) {
  if (!factsByConcept) return undefined;
  const entry = factsByConcept instanceof Map
    ? factsByConcept.get(concept)
    : factsByConcept[concept];
  if (entry === undefined || entry === null) return undefined;
  // Facts are usually {value, source, ...}; tolerate a bare value too.
  return (typeof entry === 'object' && 'value' in entry) ? entry.value : entry;
}

/**
 * Evaluate every ACTIVE rule for a protocol against collected facts.
 *
 * @returns {Promise<{fired: object[], inert: object[], evaluated: number}>}
 *   `fired` is what handleTurn should escalate on. `inert` names rules that
 *   could not be evaluated, for surfacing to a reviewer — never to a patient.
 */
async function evaluateRedFlags(pharmacyId, protocolId, factsByConcept) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const rules = await db`
    select id, name, severity, action, trigger_concept, trigger_value, source_reference
    from protocol_red_flags
    where pharmacy_id = ${pharmacyId} and protocol_id = ${protocolId} and active = true
  `;

  const fired = [];
  const inert = [];

  for (const rule of rules) {
    if (!rule.trigger_concept || !rule.trigger_value) {
      inert.push({ id: rule.id, name: rule.name, reason: 'no_trigger_configured' });
      continue;
    }
    const value = readFact(factsByConcept, rule.trigger_concept);
    if (value === undefined) {
      // The screening question has not been answered yet. Not a firing, and
      // not a configuration problem — just information we do not have.
      continue;
    }
    if (containsValue(value, rule.trigger_value)) {
      fired.push({
        id: rule.id, name: rule.name, severity: rule.severity, action: rule.action,
        triggerConcept: rule.trigger_concept, triggerValue: rule.trigger_value,
        source: rule.source_reference || null,
      });
    }
  }

  // Most serious first, so a caller taking fired[0] gets the worst one.
  const RANK = { emergency: 3, urgent: 2, review: 1 };
  fired.sort((a, b) => (RANK[b.severity] || 0) - (RANK[a.severity] || 0));

  return { fired, inert, evaluated: rules.length };
}

module.exports = { evaluateRedFlags, containsValue, readFact };
