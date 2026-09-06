/**
 * Serving a published pharmacy website to the public.
 *
 * THE ONLY PLACE IN THIS CODEBASE WITH NO SESSION, so it gets the tightest
 * contract of anything here:
 *
 *   - it resolves an address to at most one row
 *   - it filters on status = 'published'
 *   - it selects published_html and nothing else — never site_data, never
 *     published_data, never a column belonging to the tenant
 *   - it accepts no pharmacy id, in any form, from the request
 *
 * There is no assertPharmacyId call below and that is deliberate rather than
 * an omission: there is no tenant context to assert. The address IS the
 * identifier, it is unique at the database level, and the query cannot be
 * widened by anything a visitor sends.
 *
 * ONE INDEXED READ PER PAGE VIEW. This process shares a pool capped at 15
 * connections with every pharmacy's live WhatsApp socket, so a public page
 * that did more work than this would let website traffic degrade messaging.
 * Any future change here that adds a join, a second query, or a per-request
 * render is a regression regardless of how much nicer it reads.
 */

const crypto = require('node:crypto');
const { getSql } = require('../db');

const ADDRESS_SHAPE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  // Same shape the address validator enforces on the way in. Anything else
  // cannot match a stored row, so it is rejected before touching the
  // database rather than after.
  if (!ADDRESS_SHAPE.test(value)) return null;
  if (value.includes('--')) return null;
  return value;
}

/**
 * The base domain pharmacy subdomains hang off, e.g. `rxnaija.com`.
 *
 * UNSET BY DEFAULT, and while it is unset the host branch below is dead code
 * and only `/p/<address>` resolves. That is deliberate: subdomains need a
 * wildcard DNS record and a wildcard TLS certificate, neither of which is
 * confirmed for this deployment — `render.yaml` does not even name a custom
 * domain. Setting this variable before those exist would produce a hostname
 * that resolves nowhere, which is worse than the path form that works today.
 */
const baseDomain = () => (process.env.PUBLIC_SITE_DOMAIN || '').trim().toLowerCase();

/**
 * Extract a pharmacy's address from a hostname.
 *
 * `ikeja-pharmacy.rxnaija.com` → `ikeja-pharmacy`, and only for a single
 * label directly under the base domain. `a.b.rxnaija.com` returns null rather
 * than guessing — a nested label is not an address this system ever issues,
 * and treating it as one would let a wildcard certificate cover a name
 * nobody claimed.
 *
 * PURE and exported, so every branch is testable without DNS.
 */
function addressFromHost(hostname, domain = baseDomain()) {
  if (!domain || typeof hostname !== 'string') return null;
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').split(':')[0];
  if (host === domain) return null;              // the dashboard itself
  if (!host.endsWith(`.${domain}`)) return null; // a different domain entirely
  const label = host.slice(0, -(domain.length + 1));
  if (label.includes('.')) return null;          // nested: not ours

  // A RESERVED NAME NEVER RESOLVES TO A PHARMACY, even though no pharmacy can
  // hold one — the lookup would simply find nothing and 404.
  //
  // Rejecting it here is not belt and braces. `www.rxnaija.com` is the
  // marketing site, and `api.`, `app.` and `mail.` are or will be real hosts
  // on this domain. Letting them through means every request to them takes a
  // database round trip to discover it is not a pharmacy, and — worse — that
  // the day one of those hostnames is pointed at this service, it starts
  // answering with a 404 page about pharmacy websites instead of whatever it
  // is meant to be. Same list the address validator refuses on the way in, so
  // the two can never disagree.
  const { RESERVED } = require('./webAddress');
  if (RESERVED.has(label)) return null;

  return normalizeKey(label);
}

/**
 * Work out which site a request is asking for.
 *
 * ONE FUNCTION, TWO SHAPES, AND THE HANDLER NEVER LEARNS WHICH IT GOT.
 *
 * The host is checked FIRST. When subdomains are switched on, a request to
 * `ikeja-pharmacy.rxnaija.com/p/other-pharmacy` must serve Ikeja's site —
 * the hostname is the stronger claim, and letting a path override it would
 * mean one pharmacy's domain could serve another's page.
 *
 * Returns a lowercased address or null. Never throws: this runs on
 * unauthenticated traffic, including whatever a scanner sends.
 */
function resolveSiteKey(req) {
  const fromHost = addressFromHost(req?.hostname);
  if (fromHost) return fromHost;
  return normalizeKey(req?.params?.slug);
}

/**
 * The published page for an address, or null.
 *
 * `status = 'published'` is in the WHERE clause rather than checked after the
 * read, so an unpublished or draft site is not merely hidden — it is never
 * loaded into this process at all.
 */
async function getPublishedSite(address) {
  if (!address) return null;
  const db = getSql();
  const [row] = await db`
    select pharmacy_id, published_html
      from pharmacy_websites
     where subdomain = ${address}
       and status = 'published'
       and published_html is not null
  `;
  // pharmacy_id is read so a page view can be counted against the right
  // pharmacy. It is used server-side only and never reaches the response —
  // the visitor gets HTML and nothing else.
  return row || null;
}

/**
 * Where a tracked click should actually go.
 *
 * THE DESTINATION IS RESOLVED FROM THE PHARMACY'S OWN RECORD, and nothing in
 * the request contributes to it. That is what stops `/p/<address>/go/...`
 * being an open redirect: there is no parameter saying where to go, so there
 * is nothing to tamper with. A `?m=` message is carried through into the
 * wa.me query string, but the host and the number are ours.
 *
 * Returns null for an unpublished site, an unknown kind, or a pharmacy that
 * has no such contact detail — the route then 404s rather than redirecting
 * somewhere arbitrary.
 */
async function getClickTarget(address, kind, message) {
  if (!address) return null;
  const db = getSql();
  const [row] = await db`
    select w.pharmacy_id,
           p.public_whatsapp_number,
           pr.phone,
           pr.maps_url
      from pharmacy_websites w
      join pharmacies p on p.id = w.pharmacy_id
      left join pharmacy_profile pr on pr.pharmacy_id = w.pharmacy_id
     where w.subdomain = ${address}
       and w.status = 'published'
  `;
  if (!row) return null;

  let destination = null;
  if (kind === 'whatsapp') {
    const digits = String(row.public_whatsapp_number ?? '').replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      const text = String(message ?? '').trim().slice(0, 160);
      destination = `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
    }
  } else if (kind === 'phone') {
    const digits = String(row.phone ?? '').replace(/[^\d+]/g, '');
    if (digits.length >= 7) destination = `tel:${digits}`;
  } else if (kind === 'directions') {
    const url = String(row.maps_url ?? '').trim();
    // Re-checked here even though the profile validated it on the way in:
    // this is the value a visitor is about to be redirected to, and a
    // redirect is exactly where a `javascript:` would matter.
    if (/^https?:\/\//i.test(url)) destination = url;
  }

  return destination ? { pharmacyId: row.pharmacy_id, destination } : null;
}

/**
 * A weak ETag over the rendered page.
 *
 * Weak, because the comparison this needs is "is this byte-for-byte the page
 * you already have", and a strong validator would imply guarantees about
 * range requests that a generated document does not need. sha1 is a content
 * fingerprint here, not a security primitive — nothing trusts it to be
 * unforgeable, it only has to change when the page does.
 */
function etagFor(html) {
  return `W/"${crypto.createHash('sha1').update(html).digest('base64url')}"`;
}

/**
 * How long a published page may be considered fresh.
 *
 * 60 seconds bounds how stale a republish can be while removing almost all of
 * the database load from repeat views. Not `no-cache`: a pharmacy brochure
 * page is public and read-heavy, and treating it as uncacheable would put
 * every refresh, every crawler and every shared link back on the pooler that
 * the WhatsApp sockets are using.
 */
const MAX_AGE_SECONDS = 60;
const SHARED_MAX_AGE_SECONDS = 300;

/**
 * The published page's Content-Security-Policy.
 *
 * `default-src 'none'` then an allowance per thing the page actually uses.
 * `script-src 'none'` is the important one: these pages contain no JavaScript
 * at all, so the entire stored-XSS class is unreachable rather than defended
 * against. The JSON-LD block is `application/ld+json`, which is data and not
 * script, and is unaffected.
 *
 * `frame-ancestors 'none'` — nobody frames a pharmacy's website. Clickjacking
 * a page whose main control opens WhatsApp with a prefilled message is a real
 * attack, not a theoretical one.
 *
 * BUILT PER CALL rather than frozen at module load, because the storage
 * origin comes from configuration. A hardcoded host would be a stale
 * allowance the first time the Supabase project changes, and a stale
 * allowance in a CSP fails silently: the page renders, the pharmacy's logo
 * does not, and the only trace is a console warning nobody is looking at.
 */
function publicCsp() {
  const { storageOrigin } = require('./assetStore');
  const origin = storageOrigin();
  return [
    "default-src 'none'",
    // Uploaded logos and hero images live in object storage, which is a
    // different origin from the page. Without this they are blocked.
    `img-src 'self' data:${origin ? ` ${origin}` : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

module.exports = {
  resolveSiteKey,
  addressFromHost,
  baseDomain,
  getPublishedSite,
  getClickTarget,
  etagFor,
  publicCsp,
  MAX_AGE_SECONDS,
  SHARED_MAX_AGE_SECONDS,
};
