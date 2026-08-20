/**
 * Decide whether an inbound WhatsApp message should go to the protocol
 * engine instead of the ordinary assistant path.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * worker.js is the busiest file in the codebase and already carries the
 * menu, the escalation flow, the handoff consolidation and the reply path.
 * Putting complaint-matching inline there would bury a clinical routing
 * decision inside transport code. This keeps worker.js's new branch to a
 * single call whose answer is a plain object, and keeps the matching rules
 * somewhere a reviewer can read end to end.
 *
 * THE SAFETY SHAPE OF THIS FILE
 * Routing to the protocol engine is only ever a NARROWING of what the old
 * path would have done. Every complaint this file matches is one the
 * clinical filter was already going to hand to a pharmacist — so the engine
 * either asks structured triage questions first and then escalates with a
 * briefing, or (once evidence is approved) answers within the safety gate.
 * There is no message that reaches the engine which would previously have
 * been answered freely by the model.
 *
 * WHAT IS DELIBERATELY NOT ROUTED
 * emergency, overdose, adverse_reaction, dosage, drug_interaction,
 * paediatric, pregnancy, clinical_comparison, prescription,
 * prompt_injection, unreadable, filter_error — every one of these still
 * hard-blocks to a pharmacist exactly as before. Only `symptoms` is
 * eligible, and only when the text matches a protocol that is actually
 * installed and active. A rash, a stomach ulcer, chest pain: no protocol,
 * no routing, unchanged behaviour.
 */

const { getSql, assertPharmacyId } = require('../db');

/**
 * The only screening category eligible for protocol routing.
 *
 * `human_requested` is deliberately excluded even though it is clinical-ish:
 * a customer who asks for a person gets a person, and running them through
 * a questionnaire first would be a worse experience and a broken promise.
 */
const ROUTABLE_CATEGORY = 'symptoms';

/**
 * Complaint phrases per protocol slug, longest-first within each list.
 *
 * Sourced from each protocol's own DEFINITION.presentingComplaints rather
 * than restated here, so a protocol's vocabulary lives with the protocol and
 * cannot drift from what this router believes it covers.
 */
function loadCandidates() {
  const mods = [
    require('./protocols/feverAssessmentV2'),
    require('./protocols/coughAssessmentV1'),
    require('./protocols/soreThroatAssessmentV1'),
  ];
  return mods.map((m) => ({
    slug: m.SLUG,
    version: m.VERSION,
    // Longest phrases first so "cough and fever" is considered before
    // "cough" — a more specific match should win over a substring of itself.
    phrases: [...(m.DEFINITION.presentingComplaints || [])]
      .map((p) => p.toLowerCase())
      .sort((a, b) => b.length - a.length),
  }));
}

let CANDIDATES = null;

/**
 * Is this a shopping question rather than a complaint?
 *
 * THE LINE THIS PROTECTS, quoting clinicalFilter's own header: "Naming a
 * product or a category is commerce. Describing symptoms, or asking what to
 * take, is clinical."
 *
 * Complaint phrases are matched as substrings, so "do you sell cough syrup"
 * contains "cough" and would otherwise drag a customer shopping for linctus
 * into a full cough assessment. That is a worse experience than the old
 * behaviour and loses a sale, so the guard matters commercially as well as
 * clinically.
 *
 * Applied ONLY on the unflagged path — see route(). If the clinical filter
 * already decided a message describes symptoms, that judgement stands and
 * this guard does not get to overturn it: "I have a cough, do you have
 * syrup?" is a person with a cough.
 */
const COMMERCE_PATTERNS = [
  /\b(do|are) you (have|sell|stock|carry)\b/i,
  /\b(is|are)\b.{0,20}\b(available|in stock)\b/i,
  /\b(price|cost|how much is|how much for|what.{0,10}cost)\b/i,
  /\b(i want to |i wan |can i )?(buy|order|purchase|get)\b.{0,30}\b(syrup|tablet|capsule|drug|medicine|medication)\b/i,
  /\b(syrup|tablets?|capsules?|sachets?)\b.{0,15}\b(price|cost|available)\b/i,
];

function looksLikeCommerce(text) {
  if (typeof text !== 'string') return false;
  return COMMERCE_PATTERNS.some((re) => re.test(text));
}

/**
 * Which protocol, if any, does this message look like?
 *
 * Substring matching on a normalised string. Deliberately simple and
 * deterministic: no model, no scoring, no network. A miss costs nothing —
 * the message falls through to exactly the behaviour it has today — so the
 * cheap rule is the right one, and a reviewer can predict its output by
 * reading it.
 *
 * @returns {{slug:string, version:string, matched:string}|null}
 */
function matchProtocol(text) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 1000) return null;

  if (!CANDIDATES) CANDIDATES = loadCandidates();

  let best = null;
  for (const c of CANDIDATES) {
    for (const phrase of c.phrases) {
      if (!t.includes(phrase)) continue;
      // Across protocols, the longest matched phrase wins. "cough and fever"
      // (cough protocol) beats "fever" (fever protocol) because it is the
      // more specific description of what the customer actually said.
      if (!best || phrase.length > best.matched.length) {
        best = { slug: c.slug, version: c.version, matched: phrase };
      }
      break;
    }
  }
  return best;
}

/**
 * Is this protocol installed AND active for this pharmacy right now?
 *
 * Checked against the database rather than assumed from the module existing
 * on disk. A protocol that has been retired, or was never installed for this
 * tenant, must not be routed to — and a draft one (nigeria_malaria) must
 * never be reachable from a live message.
 */
async function isProtocolLive(pharmacyId, slug) {
  assertPharmacyId(pharmacyId);
  try {
    const db = getSql();
    const [row] = await db`
      select id from clinical_protocols
      where pharmacy_id = ${pharmacyId} and slug = ${slug} and status = 'active'
      limit 1
    `;
    return Boolean(row);
  } catch {
    // Cannot confirm the protocol is live => do not route. An unreadable
    // configuration is not permission to start a clinical workflow.
    return false;
  }
}

/**
 * The routing decision for one inbound message.
 *
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {object} args.screening   the clinicalFilter result for this text
 * @param {string} args.text
 * @param {object} [args.context]   conversations.context
 * @returns {Promise<{route:boolean, slug?:string, answeringKey?:string|null, reason:string}>}
 */
async function route({ pharmacyId, screening, text, context = {} }) {
  const active = context?.clinical_run;

  // ---- already mid-assessment? continue it -------------------------------
  //
  // Checked BEFORE the screening category, and this ordering is the whole
  // reason mid-assessment answers work at all. "3 days" or "yes" does not
  // match any symptom pattern, so the filter returns allow:true and the old
  // path would send it to the model as a fresh, contextless question. Once a
  // run is open, its answers belong to it.
  if (active?.slug && active?.awaiting_key) {
    if (await isProtocolLive(pharmacyId, active.slug)) {
      return {
        route: true, slug: active.slug,
        answeringKey: active.awaiting_key,
        reason: 'continuing_open_assessment',
      };
    }
    // The protocol was retired mid-conversation. Fall through to normal
    // handling rather than answering against a protocol that is no longer
    // approved.
    return { route: false, reason: 'open_run_protocol_no_longer_active' };
  }

  // ---- a more serious category always wins -------------------------------
  //
  // Checked BEFORE the complaint match, so "I have a cough and I took too
  // many tablets" is an overdose, not a cough assessment. Every non-routable
  // category keeps its existing straight-to-pharmacist behaviour untouched.
  if (screening?.allow === false && screening.category !== ROUTABLE_CATEGORY) {
    return { route: false, reason: `category_not_routable:${screening.category}` };
  }

  // ---- does this look like a complaint we have a protocol for? -----------
  //
  // Deliberately NOT gated on the filter having flagged the message. The
  // filter's `symptoms` regexes need a fairly explicit construction ("I have
  // X", "my belle dey run"); plenty of real complaints miss them — "my throat
  // is scratchy", "coughing at night", "feeling hot since morning" — and used
  // to reach the model, which by its own system prompt cannot answer a
  // clinical question and so produced a bare handoff with no assessment.
  //
  // Matching the protocol's OWN complaint vocabulary is a stronger and more
  // reviewable signal than the generic regexes, so a match routes on its own.
  // This is still a narrowing of model freedom, not a widening: these
  // messages now get structured triage instead of an unstructured refusal,
  // and the recommendation gate remains the only thing that can produce
  // clinical guidance.
  const match = matchProtocol(text);
  if (!match) {
    // No protocol covers this. If the filter flagged it, it hard-blocks to a
    // pharmacist as before; if it did not, the ordinary assistant path
    // handles it. Either way: unchanged behaviour.
    return { route: false, reason: 'no_protocol_for_this_complaint' };
  }

  // A shopping question that happens to contain a symptom word is commerce,
  // not a complaint — but only the filter gets to make that call when it has
  // already flagged the message as symptoms. See looksLikeCommerce.
  if (screening?.allow !== false && looksLikeCommerce(text)) {
    return { route: false, reason: 'product_question_not_a_complaint' };
  }
  if (!await isProtocolLive(pharmacyId, match.slug)) {
    return { route: false, reason: `protocol_not_active:${match.slug}` };
  }

  return {
    route: true, slug: match.slug, answeringKey: null,
    matched: match.matched,
    reason: screening?.allow === false
      ? 'matched_presenting_complaint'
      : 'matched_presenting_complaint_unflagged',
  };
}

module.exports = { route, matchProtocol, isProtocolLive, ROUTABLE_CATEGORY };
