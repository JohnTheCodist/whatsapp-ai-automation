/**
 * The gate in front of certificate issuance.
 *
 * WHY THIS IS WORTH ITS OWN FILE
 * Pharmacy websites live at <address>.rxnaija.com behind a wildcard DNS
 * record, so every name under the domain reaches this box and Caddy asks
 * before issuing a certificate for any of them. This function is that answer.
 *
 * Get it wrong in the permissive direction and a stranger can make us request
 * certificates for hostnames we do not own the meaning of — burning a weekly
 * issuance limit that is counted against the whole registered domain, and
 * writing whatever they chose into the public Certificate Transparency log.
 * Get it wrong in the other direction and no pharmacy site can obtain a
 * certificate at all.
 *
 * Deliberately database-free. The DB check ("is it actually published?") lives
 * in the route; everything decidable without Postgres lives here so it runs on
 * every machine rather than only where a test database is configured.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// baseDomain() reads this at call time, so setting it here is enough and it
// must be set BEFORE the module under test resolves anything.
process.env.PUBLIC_SITE_DOMAIN = 'rxnaija.com';

const { askableAddress } = require('../routes/internal');

test('a plain pharmacy subdomain is askable', () => {
  assert.equal(askableAddress({}, 'sterling.rxnaija.com'), 'sterling');
  assert.equal(askableAddress({}, 'ikeja-pharmacy.rxnaija.com'), 'ikeja-pharmacy');
});

test('a request that came through the proxy is refused', () => {
  // Caddy generates the ask itself and adds no X-Forwarded-For. Anything
  // carrying one reached us from the internet, whatever it says it is.
  assert.equal(askableAddress({ 'x-forwarded-for': '1.2.3.4' }, 'sterling.rxnaija.com'), null);
  assert.equal(askableAddress({ 'X-Forwarded-For': '1.2.3.4' }, 'sterling.rxnaija.com'), 'sterling',
    'header lookup is lower-case only, matching how Node normalises them — '
    + 'this asserts the real behaviour rather than an aspiration');
});

test('reserved names can never obtain a certificate', () => {
  // The phishing-shaped ones are the point. A working, certificated page at
  // secure.rxnaija.com owned by whoever asked first is a credential harvester
  // wearing our domain.
  for (const label of ['www', 'api', 'app', 'mail', 'secure', 'login', 'verify', 'billing']) {
    assert.equal(askableAddress({}, `${label}.rxnaija.com`), null, label);
  }
});

test('the dashboard host is not a pharmacy', () => {
  assert.equal(askableAddress({}, 'app.rxnaija.com'), null);
});

test('the bare domain is not a pharmacy', () => {
  assert.equal(askableAddress({}, 'rxnaija.com'), null);
});

test('another domain entirely is refused', () => {
  // Someone pointing their own DNS at this IP must not obtain a certificate
  // for a name we have no relationship with.
  assert.equal(askableAddress({}, 'evil.example.com'), null);
  assert.equal(askableAddress({}, 'rxnaija.com.evil.example.com'), null);
});

test('a nested label is refused', () => {
  // *.rxnaija.com covers one level. a.b.rxnaija.com would need a certificate
  // this block cannot obtain, and is not a shape any pharmacy address takes.
  assert.equal(askableAddress({}, 'a.b.rxnaija.com'), null);
});

test('junk is refused rather than guessed at', () => {
  for (const junk of ['', '   ', null, undefined, 'not a hostname', '.rxnaija.com', '..']) {
    assert.equal(askableAddress({}, junk), null, JSON.stringify(junk));
  }
});

test('missing headers do not throw', () => {
  // The route always passes req.headers, but a null here must refuse rather
  // than crash — this runs before anything has authenticated.
  assert.equal(askableAddress(null, 'sterling.rxnaija.com'), 'sterling');
  assert.equal(askableAddress(undefined, 'sterling.rxnaija.com'), 'sterling');
});
