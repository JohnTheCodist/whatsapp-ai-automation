/**
 * The greeting and menu.
 *
 * TWO LABELS IN THE ORIGINAL SPEC WERE CHANGED, DELIBERATELY.
 *
 * "Ask {bot} — health questions, symptoms & advice" is not something this
 * product can offer. The clinical filter refuses symptom and dosage questions
 * before the model ever sees them, by design and for good reason. Advertising
 * that capability on the front door would invite exactly the messages that
 * get refused, and the customer's reward for tapping the option they were
 * offered would be a deflection. The option survives — routed straight to a
 * pharmacist, and labelled as what it actually is.
 *
 * "Reserve your medication" has the same problem one layer down. An order is
 * PENDING until staff confirm it; nothing is held. "Reserved" is the precise
 * word the reply validator blocks the assistant from saying, and putting it
 * in the menu would be the product making the promise instead.
 *
 * The rule both changes follow: the menu is a contract. Every option has to
 * be something that actually happens.
 *
 * Pure. No database, no model, no clock.
 */

/**
 * @param {object} p
 * @param {string} p.pharmacyName
 * @param {string} [p.botName]
 * @returns {Array<{key: string, title: string, blurb: string, intent: string}>}
 */
function menuItems({ pharmacyName, botName }) {
  const bot = botName || pharmacyName || 'the pharmacy';
  return [
    {
      key: '1',
      title: 'Check a medicine',
      blurb: 'Price, and whether it is in stock',
      intent: 'product_enquiry',
    },
    {
      key: '2',
      title: 'Browse what we stock',
      blurb: 'OTC medicines and wellness items',
      intent: 'browse',
    },
    {
      key: '3',
      // NOT "reserve". An order is pending until staff confirm it, and the
      // menu must not promise what the order flow explicitly refuses to say.
      title: 'Request medicine for pickup',
      blurb: `Send a request — ${pharmacyName} confirms before anything is set aside`,
      intent: 'order',
    },
    {
      key: '4',
      // The original spec put symptoms and advice under the assistant. This
      // is the same option, pointed at the person who is allowed to answer.
      title: 'Speak to the pharmacist',
      blurb: 'Symptoms, dosage, prescriptions, or anything medical',
      intent: 'pharmacist',
    },
    {
      key: '5',
      title: 'Something else',
      blurb: `Opening hours, address, delivery, or a person from ${pharmacyName}`,
      intent: 'other',
    },
  ];
}

/**
 * The welcome message.
 *
 * `customerName` is WhatsApp's pushName, which is whatever the customer chose
 * to call themselves. It is frequently an emoji, a nickname, or a business
 * name — so it is used as a greeting and never as an identity.
 */
/** The "Hi, I'm Ada from Sterling Pharmacy" opening line, shared by both the
 * welcome and the menu so the two never drift into introducing the bot
 * differently depending on which one fires first. */
function introLines({ pharmacyName, botName, customerName, welcomeNote }) {
  const bot = botName || pharmacyName || 'the pharmacy';
  const name = cleanName(customerName);
  const lines = [name ? `Hi ${name} — I'm ${bot} from ${pharmacyName}.` : `Hi, I'm ${bot} from ${pharmacyName}.`];
  if (welcomeNote) lines.push(welcomeNote);
  return lines;
}

function buildMenu({ pharmacyName, botName, customerName, welcomeNote, returning = false }) {
  const lines = [];

  if (returning) {
    lines.push('Here are the options again.');
  } else {
    lines.push(...introLines({ pharmacyName, botName, customerName, welcomeNote }));
    lines.push('What would you like to do today?');
  }

  lines.push('');
  for (const item of menuItems({ pharmacyName, botName })) {
    lines.push(`*${item.key}.* ${item.title}`);
    lines.push(`     _${item.blurb}_`);
  }
  lines.push('');
  // Said plainly, because a menu that only accepts numbers trains people to
  // stop typing what they actually want — which is the thing the assistant is
  // good at.
  lines.push('Reply with a number, or just type your question.');
  lines.push('Type *menu* any time to see this again.');

  return lines.join('\n');
}

/**
 * The FIRST-EVER message a genuinely new customer sees — deliberately short.
 *
 * The full itemized menu is a contract offering eight specific things; a
 * stranger who just said "Good morning" has not asked for that list, and
 * dumping it on them is the exact behaviour this function exists to replace.
 * They get a warm line and a pointer to *menu*, then decide for themselves
 * what to do next — which is what lets "I need paracetamol" on the very next
 * message go straight to the AI instead of through a menu they never wanted.
 *
 * Sent at most ONCE per customer, ever — see customers.onboarded_at (0028).
 * Never sent to a returning customer regardless of how long the gap since
 * their last message; that decision is made by the caller before this
 * function is reached at all, not by anything in here.
 */
function buildWelcome({ pharmacyName, botName, customerName, welcomeNote }) {
  const lines = introLines({ pharmacyName, botName, customerName, welcomeNote });
  lines.push('How may I assist you today?');
  lines.push('You can also type *menu* any time to see what I can help with.');
  return lines.join('\n');
}

/**
 * WhatsApp push names are user-controlled. Strip anything that would read
 * badly in a greeting, and give up rather than produce something odd —
 * "Hi 👑!" is worse than "Hi.".
 */
const HONORIFICS = new Set([
  'dr', 'doc', 'mr', 'mrs', 'ms', 'miss', 'master', 'prof', 'professor',
  'engr', 'engineer', 'arc', 'barr', 'esq',
  'alhaji', 'alhaja', 'hajia', 'chief', 'pastor', 'rev', 'reverend',
  'evang', 'evangelist', 'bishop', 'imam', 'sir', 'madam', 'mallam',
]);

function cleanName(pushName) {
  if (typeof pushName !== 'string') return null;

  // Walk the tokens rather than taking the first blindly. "J. Daniel" is a
  // very common way to write a name here, and the first token strips to a
  // single letter — greeting someone "Hi J." reads worse than not greeting
  // them at all, while "Hi Daniel" is exactly right.
  const tokens = pushName.trim().split(/[\s,|·—-]+/).filter(Boolean);

  for (const token of tokens) {
    // Titles are a name for a category of person, not for this person.
    // "Hi Dr" and "Hi Alhaji" both read as a mistake. The Nigerian ones are
    // here because they turn up in push names constantly.
    if (HONORIFICS.has(token.toLowerCase().replace(/[^\p{L}]/gu, ''))) continue;
    // Letters and marks only, so emoji and decoration fall away.
    const stripped = token.replace(/[^\p{L}\p{M}'’]/gu, '');
    if (stripped.length >= 2 && stripped.length <= 20) {
      // Plenty of people set their push name in caps. "Hi ADEOLA" reads as
      // shouting. Only fold a token that is entirely uppercase, so genuine
      // internal capitals — McDonald, OBrien — survive intact.
      const body = stripped === stripped.toUpperCase() ? stripped.toLowerCase() : stripped.slice(1);
      const rest = stripped === stripped.toUpperCase() ? body.slice(1) : body;
      return stripped.charAt(0).toUpperCase() + rest;
    }
  }
  return null;
}

/** Does this message ask for the menu? */
function isMenuRequest(text) {
  if (typeof text !== 'string') return false;
  return /^\s*(menu|main menu|options|help|start|0)\s*$/i.test(text.trim());
}

/**
 * Is this message NOTHING BUT a greeting — "Good morning", "Hi", "Hey there"
 * — with no actual request in it?
 *
 * Deliberately whole-message, same discipline as isMenuRequest above. "Hi, do
 * you have paracetamol" is not a bare greeting; it is a request that happens
 * to open politely, and forcing it through a canned welcome instead of the
 * AI would mean the customer has to say hello twice to get an answer. Only
 * the pure case — nothing here but the greeting itself, optionally with
 * trailing punctuation or an emoji — gets the short first-contact reply.
 *
 * Only matters for a customer who has never been onboarded (worker.js gates
 * on that first). A returning customer's "Good morning" is never routed
 * through this at all — it goes straight to the AI, which already replies
 * to small talk naturally without this function's involvement.
 */
function isGreeting(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim()
    // Trailing emoji/punctuation stripped before matching — "Hi 👋!" is
    // still a bare greeting, just a decorated one.
    .replace(/[\s!.,?👋🙏🙂😊✨]+$/u, '')
    // Collapse "Good  morning" (a real thing people type) to one space, so
    // the pattern below only has to know about one gap width, not guess how
    // many someone's thumb produced.
    .replace(/\s+/g, ' ');
  return /^(hi|hello|hey|hiya|yo|howdy|sup|good\s?morning|good\s?afternoon|good\s?evening|good\s?day|morning|afternoon|evening)$/i
    .test(trimmed);
}

/**
 * Resolve a menu selection.
 *
 * Bare numbers ONLY. "1" is a choice; "I want 1 pack of Panadol" is not, and
 * treating it as one would hijack an ordinary sentence into a menu jump.
 */
function parseSelection(text, { pharmacyName, botName } = {}) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^[1-9]$/.test(trimmed)) return null;
  return menuItems({ pharmacyName, botName }).find((i) => i.key === trimmed) || null;
}

/**
 * What the assistant is told after a menu choice.
 *
 * Facts, not instructions — the same discipline conversation context follows,
 * so nothing a customer types can become a directive by passing through here.
 */
function intentBriefing(intent, { pharmacyName }) {
  switch (intent) {
    case 'product_enquiry':
      return 'The customer chose "Check a medicine". Ask which one, then look it up.';
    case 'browse':
      return 'The customer chose "Browse what we stock". Ask what kind of thing they need, then search the catalogue. Do not list the whole catalogue.';
    case 'order':
      return 'The customer chose "Request medicine for pickup". Find out what and how many, confirm the price, then send the request to the pharmacy.';
    case 'other':
      return `The customer chose "Something else". Answer opening hours, address or delivery from ${pharmacyName}'s details if you can, and offer a person if you cannot.`;
    default:
      return null;
  }
}

module.exports = {
  buildMenu, buildWelcome, menuItems, isMenuRequest, isGreeting, parseSelection, intentBriefing, cleanName,
};
