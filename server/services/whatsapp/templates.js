/**
 * The global message templates, as code.
 *
 * WHY TEMPLATES EXIST AT ALL
 * On the official WhatsApp API a business may only send free-form text within
 * 24 hours of the customer's last message. Outside that window every message
 * must be a template approved in advance by Meta. This is not a Twilio rule
 * and cannot be worked around — it is the difference between a channel that
 * answers people and one that broadcasts at them.
 *
 * Almost everything this system sends proactively falls outside that window:
 * an order confirmed an hour later, a pickup alert the next morning, a hold
 * expiring overnight. Those are the ones that need to be here.
 *
 * WHY THE WORDING IS SHARED AND THE APPROVAL IS NOT
 * One set of templates, submitted on behalf of every pharmacy. But Meta
 * reviews each pharmacy's COPY separately, so approval state is per-pharmacy
 * and lives in the whatsapp_templates table — never here. This file is what
 * we ask for; that table is what we got.
 *
 * WHAT THESE ARE NOT ALLOWED TO BE
 * A template is fixed text with numbered variables. It cannot carry the
 * assistant's prose, cannot be assembled per message, and must not be used to
 * smuggle free-form content into a slot — Meta rejects that, and rightly.
 * Anything genuinely conversational belongs INSIDE the 24-hour window, where
 * no template is needed.
 *
 * WRITING RULES THAT KEEP THESE APPROVABLE
 *   - Say who is writing. A message from an unnamed sender reads as spam to a
 *     reviewer and to a customer.
 *   - No marketing in a UTILITY template. "While you're here, see our offers"
 *     turns a transactional template into a marketing one and gets it
 *     rejected, or worse, approved and then flagged on quality.
 *   - Never start or end with a variable. Meta rejects templates whose text
 *     could be entirely substituted, because it cannot review what it cannot
 *     see.
 *   - No consecutive variables, for the same reason.
 */

/**
 * Categories, as the provider means them.
 *
 * UTILITY covers a transaction the customer already initiated — their order,
 * their collection, their request. MARKETING is anything they did not ask for
 * and requires separate opt-in. Mislabelling marketing as utility is the
 * single fastest way to lose template privileges for every pharmacy at once,
 * so nothing here is MARKETING and adding one should be a deliberate decision
 * rather than a convenient category on an existing template.
 */
const CATEGORY = Object.freeze({
  UTILITY: 'UTILITY',
  MARKETING: 'MARKETING',
});

/**
 * Every template this system may send, keyed by our own stable name.
 *
 * `key` is ours and permanent — it is what the database and the send path
 * refer to. The provider's id for a template is theirs, changes per pharmacy,
 * and is recorded in whatsapp_templates.provider_template_id.
 *
 * `variables` documents each {{n}} in order. It exists so a caller cannot
 * quietly pass the wrong thing into slot 2: the numbers carry no meaning at
 * the call site, and "{{1}} is ready" tells a reader nothing about what {{1}}
 * should be.
 */
const TEMPLATES = Object.freeze([
  {
    key: 'order_confirmed',
    category: CATEGORY.UTILITY,
    language: 'en',
    // {{1}} pharmacy name, {{2}} order reference, {{3}} total
    body:
      'Hello from {{1}}. Your order {{2}} is confirmed. '
      + 'Total: {{3}}. We will let you know as soon as it is ready to collect.',
    variables: ['pharmacyName', 'orderReference', 'totalNaira'],
    sentWhen: 'Staff confirm a pending order, usually minutes to hours after it was placed.',
  },
  {
    key: 'order_ready',
    category: CATEGORY.UTILITY,
    language: 'en',
    // {{1}} pharmacy name, {{2}} order reference
    body:
      'Hello from {{1}}. Your order {{2}} is ready for collection. '
      + 'Please come with your order number.',
    variables: ['pharmacyName', 'orderReference'],
    sentWhen: 'Staff mark an order ready — very often the next morning, so nearly always outside the window.',
  },
  {
    key: 'order_rejected',
    category: CATEGORY.UTILITY,
    language: 'en',
    // {{1}} pharmacy name, {{2}} order reference
    //
    // Deliberately does NOT carry a reason variable. A refusal reason is
    // written by a pharmacist in their own words and belongs in a free-form
    // reply inside the window; squeezing it into a template slot would mean
    // either truncating a clinical explanation or letting arbitrary prose
    // through a reviewed template. The message says a person will explain,
    // and a person does.
    body:
      'Hello from {{1}}. We are sorry — we cannot supply order {{2}} at the moment. '
      + 'Please reply here and a member of staff will help you.',
    variables: ['pharmacyName', 'orderReference'],
    sentWhen: 'Staff reject an order.',
  },
  {
    key: 'hold_expiring',
    category: CATEGORY.UTILITY,
    language: 'en',
    // {{1}} pharmacy name, {{2}} order reference, {{3}} how long is left
    body:
      'Hello from {{1}}. We are still holding the items for order {{2}}, '
      + 'but the hold ends in {{3}}. Reply here to confirm you still want them.',
    variables: ['pharmacyName', 'orderReference', 'timeRemaining'],
    sentWhen: 'A stock hold is close to expiring — by definition long after the customer last wrote.',
  },
  {
    key: 'pharmacist_replied',
    category: CATEGORY.UTILITY,
    language: 'en',
    // {{1}} pharmacy name
    //
    // A NOTIFICATION, not the answer itself. The pharmacist's actual words
    // are clinical advice and must reach the customer verbatim — which a
    // template cannot do, since the text is fixed at approval time. So this
    // reopens the conversation, and the real answer follows inside the window
    // where it can be sent exactly as written.
    body:
      'Hello from {{1}}. Our pharmacist has answered your question. '
      + 'Reply here to read it and to ask anything else.',
    variables: ['pharmacyName'],
    sentWhen: 'A pharmacist answers a handoff after the customer\'s 24-hour window has closed.',
  },
]);

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

/** Every template, for the submit-on-activation path. */
function allTemplates() {
  return TEMPLATES;
}

function getTemplate(key) {
  return BY_KEY.get(key) || null;
}

/**
 * Fill a template's variables in the order it declares them.
 *
 * Takes a NAMED object rather than an array on purpose. `['Fedoahs', 'ABC-123']`
 * is impossible to check at a call site and silently wrong if two variables
 * are swapped — which, for order reference and total, means telling somebody
 * their order costs ABC-123. Named values can be verified; positions cannot.
 *
 * Returns the positional array the provider APIs want, so the ordering rule
 * lives here once instead of at every call site.
 */
function fillVariables(key, values) {
  const template = getTemplate(key);
  if (!template) throw new Error(`Unknown template "${key}".`);

  return template.variables.map((name) => {
    const v = values?.[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      // Refused rather than sent with a gap. An approved template with an
      // empty slot reads as "Your order  is ready" — which looks broken to
      // the customer and counts against the pharmacy's quality rating.
      throw new Error(`Template "${key}" needs a value for "${name}".`);
    }
    return String(v);
  });
}

module.exports = { TEMPLATES, CATEGORY, allTemplates, getTemplate, fillVariables };
