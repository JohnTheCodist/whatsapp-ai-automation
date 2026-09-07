/**
 * Endpoints Caddy calls. Not people, and not the dashboard.
 *
 * WHY THIS EXISTS
 * Pharmacy websites live at <address>.rxnaija.com, which needs a certificate
 * per subdomain. Caddy can issue those on demand, but a wildcard DNS record
 * means ANY hostname under the domain resolves to this box — so without a
 * gate, a stranger requesting `whatever.rxnaija.com` makes us ask Let's
 * Encrypt for a certificate. Repeat that a few dozen times and the weekly
 * issuance limit for the entire registered domain is gone, taking real
 * pharmacies with it.
 *
 * Caddy's answer is to ask first. Before issuing, it calls this endpoint with
 * ?domain=<hostname> and only proceeds on a 200. So this route is the thing
 * standing between a wildcard DNS record and a denial-of-service on our own
 * certificates.
 *
 * WHY IT ANSWERS ONLY FOR PUBLISHED SITES
 * A certificate is a public, permanent, logged artefact — every one issued is
 * written to Certificate Transparency, where anyone can read it. Issuing for
 * an address that exists but has not been published would put the name of a
 * pharmacy's unlaunched site into a public log. The 404 on publicSite.js is
 * careful not to distinguish "no such address" from "not published"; this
 * must be careful about the same thing, for a longer-lived reason.
 *
 * MUST NOT BE REACHABLE FROM THE INTERNET
 * The answer reveals whether an address is published, which the public site
 * deliberately refuses to say. Two layers keep it private:
 *
 *   1. deploy/Caddyfile answers /api/internal/* with 404 on both public site
 *      blocks. Caddy's own call does not pass through them — it dials
 *      localhost:4000 directly — so it is unaffected.
 *   2. The check below. Every request that reached us through the proxy
 *      carries X-Forwarded-For; a call Caddy generates itself does not. A
 *      request with that header did not come from Caddy's certificate
 *      machinery, whatever it claims.
 *
 * Neither is sufficient alone: (1) is a config file somebody could reorganise,
 * and (2) is a header a future proxy might not set. Together a single mistake
 * does not expose it.
 */

const express = require('express');
const { asyncRoute } = require('../middleware/errorHandler');
const { addressFromHost, getPublishedSite } = require('../services/website/publicSite');

const router = express.Router();

const TEXT = 'text/plain; charset=utf-8';
const OK = 'ok\n';

/** Caddy reads the status code and nothing else; the body is for humans curling it. */
function deny(res) {
  return res.status(403).type('text/plain; charset=utf-8').send('no\n');
}

/**
 * Everything that can be decided WITHOUT touching the database.
 *
 * Split out and exported so it can be tested directly. This is the part
 * that decides whether a stranger can make us request a certificate, and a
 * check that can only be exercised through a live Postgres is a check that
 * does not run on most people's machines.
 *
 * @returns {string|null} the pharmacy address, or null to refuse outright
 */
/**
 * Hostnames this deployment serves itself, which are NOT pharmacy addresses.
 *
 * 2026-09-07, and this cost an outage. A wildcard site block matches every
 * name under the domain — including app.rxnaija.com. Caddy therefore asked
 * this endpoint before serving the DASHBOARD, and the answer was no, because
 * `app` is in RESERVED. RESERVED exists to stop a pharmacy CLAIMING that name;
 * it was never meant to say "do not serve it". Caddy aborted the handshake and
 * the dashboard went dark, while pharmacy subdomains carried on working.
 *
 * The lesson is narrow and worth stating: refusing to issue a certificate is
 * not the same act as refusing to route a request, and a list written for the
 * second question gave a catastrophic answer to the first.
 *
 * Empty by default. A deployment that fronts nothing but pharmacy sites needs
 * no entries; ours needs the dashboard.
 */
function ownHosts() {
  return String(process.env.TLS_ASK_EXTRA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function askableAddress(headers, domain) {
  // Arrived through the proxy, so it came from the internet rather than
  // from Caddy's own certificate machinery, whatever it claims to be.
  if (headers && headers['x-forwarded-for']) return null;

  // Same rules as the address validator, so a reserved name — www, api,
  // secure, login — can never obtain a certificate on this domain even if
  // DNS points it straight here.
  return addressFromHost(String(domain || ''));
}

router.get('/tls-ask', asyncRoute(async (req, res) => {
  if (req.headers['x-forwarded-for']) return deny(res);

  const domain = String(req.query?.domain || '').trim().toLowerCase();

  // Our own hostnames first. They are not pharmacy addresses and will never
  // be found in pharmacy_websites, so asking the database about them would
  // answer no and take the dashboard offline — which is exactly what
  // happened before this branch existed.
  if (ownHosts().includes(domain)) return res.type(TEXT).send(OK);

  const address = askableAddress(req.headers, domain);
  if (!address) return deny(res);

  const site = await getPublishedSite(address);
  if (!site) return deny(res);

  return res.type('text/plain; charset=utf-8').send('ok\n');
}));

module.exports = router;
module.exports.askableAddress = askableAddress;
module.exports.ownHosts = ownHosts;
