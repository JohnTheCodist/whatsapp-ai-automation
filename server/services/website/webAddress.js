/**
 * The web address a pharmacy publishes at.
 *
 * THIS VALUE IS PERMANENT IN PRACTICE. It goes on flyers, on a shop window,
 * into a WhatsApp broadcast, and into Google's index. Changing it later
 * breaks every one of those, so it is validated hard on the way in and the
 * product treats it as a decision rather than a setting.
 *
 * ONE VALUE, TWO FUTURE SHAPES. Today it resolves as `rxnaija.com/p/<value>`;
 * when wildcard DNS and TLS are confirmed it also resolves as
 * `<value>.rxnaija.com`. That is why the rules below are DNS label rules even
 * though nothing needs them to be yet — an address that is legal as a path
 * but illegal as a hostname would have to be taken away from a pharmacy
 * later, which is exactly the outcome this file exists to prevent.
 *
 * NOT pharmacies.slug. That column is generated from the pharmacy's name with
 * a random suffix on collision, has never been checked against a reserved
 * list, and services/pharmacies.js documents it as "a convenience, not an
 * identifier". Reusing it here would make a value that was never designed to
 * be seen into the most public thing the pharmacy has.
 */

/**
 * Names that must never belong to a pharmacy.
 *
 * THREE SEPARATE HAZARDS, deliberately in one list because the answer is the
 * same for all of them:
 *
 *   1. INFRASTRUCTURE. `www`, `mail`, `mx`, `ns1` — a pharmacy holding one of
 *      these breaks mail or DNS for the whole domain once subdomains exist.
 *   2. OUR OWN SURFACE. `api`, `app`, `admin`, `dashboard`, `p` — these are
 *      paths and hosts this product already uses or will. `p` in particular
 *      is the prefix of the public route itself.
 *   3. PHISHING-SHAPED. `login`, `signin`, `secure`, `verify`, `account`,
 *      `billing` — a real, working page at `secure.rxnaija.com` controlled by
 *      whoever signed up first is a credential-harvesting site with our
 *      certificate on it. This is the category people forget.
 */
const RESERVED = new Set([
  // infrastructure
  'www', 'mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'mx', 'ftp',
  'ns', 'ns1', 'ns2', 'dns', 'cdn', 'static', 'assets', 'media', 'img', 'images',
  'files', 'localhost', 'autoconfig', 'autodiscover',
  // ours
  'api', 'app', 'apps', 'admin', 'administrator', 'dashboard', 'portal', 'console',
  'p', 'pdf', 'webhooks', 'webhook', 'download', 'downloads', 'status', 'health',
  'staging', 'stage', 'dev', 'test', 'testing', 'demo', 'sandbox', 'preview',
  'internal', 'private', 'system', 'root', 'rxnaija', 'support', 'help', 'docs', 'doc',
  // phishing-shaped
  'login', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'auth', 'oauth',
  'secure', 'security', 'verify', 'verification', 'account', 'accounts',
  'billing', 'pay', 'payment', 'payments', 'checkout', 'wallet', 'password', 'reset',
  // catch-alls people expect to exist
  'about', 'contact', 'blog', 'news', 'shop', 'store', 'legal', 'terms', 'privacy',
  'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noc', 'security-txt',
]);

const MIN = 3;
const MAX = 40;

/**
 * Validate and normalise a proposed address.
 *
 * Rules, each with a reason:
 *   - lowercase a–z, 0–9 and hyphen only. A DNS label allows nothing else,
 *     and a path that a hostname could not carry is a trap for later.
 *   - must start and end alphanumeric. A leading or trailing hyphen is
 *     illegal in a hostname and invisible in print.
 *   - no consecutive hyphens. Not illegal, but `city--pharmacy` and
 *     `city-pharmacy` are indistinguishable when read aloud over a phone,
 *     which is how half of these will be shared.
 *   - not `xn--…`. That prefix is reserved for punycode; a literal one lets
 *     an address claim to be an internationalised domain it is not.
 *   - not all digits. Reads as an identifier or an address, not a business.
 *   - 3–40 characters. 63 is the DNS limit; 40 is what fits on a flyer.
 *
 * @returns {{ok:true, value:string} | {ok:false, code:string, error:string}}
 */
function normalizeWebAddress(input) {
  if (typeof input !== 'string') {
    return { ok: false, code: 'INVALID_ADDRESS', error: 'A web address is required' };
  }

  const value = input.trim().toLowerCase();

  if (value.length < MIN) {
    return { ok: false, code: 'INVALID_ADDRESS', error: `Your web address must be at least ${MIN} characters` };
  }
  if (value.length > MAX) {
    return { ok: false, code: 'INVALID_ADDRESS', error: `Your web address must be ${MAX} characters or fewer` };
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    return {
      ok: false,
      code: 'INVALID_ADDRESS',
      error: 'Use only lowercase letters, numbers and hyphens',
    };
  }
  if (!/^[a-z0-9]/.test(value) || !/[a-z0-9]$/.test(value)) {
    return { ok: false, code: 'INVALID_ADDRESS', error: 'Your web address must start and end with a letter or number' };
  }
  if (value.includes('--')) {
    return { ok: false, code: 'INVALID_ADDRESS', error: 'Your web address cannot contain two hyphens in a row' };
  }
  if (value.startsWith('xn-')) {
    return { ok: false, code: 'INVALID_ADDRESS', error: 'Your web address cannot begin with "xn-"' };
  }
  if (/^\d+$/.test(value)) {
    return { ok: false, code: 'INVALID_ADDRESS', error: 'Your web address cannot be only numbers' };
  }
  if (RESERVED.has(value)) {
    // Deliberately does not say WHY a particular name is reserved. "secure is
    // reserved because it would look like a login page" is a hint worth not
    // giving; "that one is taken, try another" is all an honest pharmacy
    // needs.
    return { ok: false, code: 'ADDRESS_RESERVED', error: `"${value}" is not available. Try another.` };
  }

  return { ok: true, value };
}

/**
 * A first suggestion, derived from the pharmacy's name.
 *
 * Only ever a SUGGESTION the owner can overwrite — it is not applied
 * silently. Returns null when the name reduces to something unusable, so the
 * form asks rather than proposing "pharmacy".
 */
function suggestWebAddress(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');

  const checked = normalizeWebAddress(base);
  return checked.ok ? checked.value : null;
}

module.exports = { normalizeWebAddress, suggestWebAddress, RESERVED, MIN, MAX };
