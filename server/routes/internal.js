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
  const address = askableAddress(req.headers, req.query?.domain);
  if (!address) return deny(res);

  const site = await getPublishedSite(address);
  if (!site) return deny(res);

  return res.type('text/plain; charset=utf-8').send('ok\n');
}));

module.exports = router;
module.exports.askableAddress = askableAddress;
