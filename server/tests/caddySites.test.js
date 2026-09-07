/**
 * scripts/generate-caddy-sites.js — what may be written into a Caddy config.
 *
 * WHY THIS FILE EXISTS
 * Pharmacy web addresses are chosen by pharmacy owners, stored in a database
 * column, and then written verbatim into /etc/caddy/pharmacy-sites.conf. That
 * makes this the one place in the codebase where a user-supplied string
 * becomes part of the web server's configuration.
 *
 * A value containing a brace or a newline is not a malformed hostname. It is
 * a new Caddy site block, authored by whoever signed up — able to claim a
 * hostname, obtain a certificate for it, and proxy it wherever it likes. The
 * blast radius is the whole box, not one pharmacy.
 *
 * normalizeWebAddress already runs when the address is chosen. partition()
 * runs it again on the way out, and the two are redundant on purpose: input
 * validation protects the value going in, this protects the file being
 * written, and the day someone adds a bulk import or an admin override only
 * one of them is still standing.
 *
 * Database-free by construction: partition() is a pure function over strings.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { partition } = require('../../scripts/generate-caddy-sites');

test('ordinary addresses are accepted', () => {
  const { good, rejected } = partition(['naspaa', 'ikeja-family', 'sterling24']);
  assert.deepEqual(good, ['naspaa', 'ikeja-family', 'sterling24']);
  assert.deepEqual(rejected, []);
});

test('a value that would open a new site block is refused', () => {
  // The attack this file exists for. Written unescaped into the config, this
  // closes the pharmacy's block and opens one for a hostname of the author's
  // choosing, pointed anywhere.
  const payload = 'mine}\nadmin.rxnaija.com {\n\treverse_proxy 10.0.0.9:80\n}\n#';
  const { good, rejected } = partition([payload]);
  assert.deepEqual(good, []);
  assert.deepEqual(rejected, [payload]);
});

test('newlines and braces are refused on their own', () => {
  for (const bad of ['a\nb', 'a{b', 'a}b', 'a b', 'a\tb', 'a\rb', 'a"b', "a'b", 'a#b']) {
    const { good } = partition([bad]);
    assert.deepEqual(good, [], JSON.stringify(bad));
  }
});

test('a dot is refused, so no address can climb the hostname', () => {
  // "evil.com" would render as evil.com.rxnaija.com, which is merely wrong.
  // The dangerous shape is anything that changes what the label means.
  for (const bad of ['evil.com', 'a.b', '.leading', 'trailing.']) {
    const { good } = partition([bad]);
    assert.deepEqual(good, [], bad);
  }
});

test('a value that only NORMALISES to something valid is still refused', () => {
  // This is the subtle one. "NASPAA" normalises to "naspaa", which is a
  // perfectly good hostname — but it is not the address the pharmacy was
  // given, and writing it would serve a name nobody printed while the one on
  // the flyer answered nothing. The rule is survives-unchanged, not
  // can-be-repaired.
  for (const bad of ['NASPAA', ' naspaa', 'naspaa ', 'Naspaa']) {
    const { good, rejected } = partition([bad]);
    assert.deepEqual(good, [], bad);
    assert.deepEqual(rejected, [bad]);
  }
});

test('reserved names never reach the config', () => {
  // Same list the address validator refuses on the way in, so the two cannot
  // disagree. secure/login/verify matter most: a real certificated page at
  // secure.rxnaija.com is a credential harvester wearing our domain.
  for (const bad of ['www', 'api', 'app', 'mail', 'secure', 'login', 'verify', 'admin']) {
    const { good } = partition([bad]);
    assert.deepEqual(good, [], bad);
  }
});

test('junk types do not throw', () => {
  // These come out of a database column, so null is a real possibility even
  // though the query filters it. A crash here stops every pharmacy site being
  // regenerated, not just the bad row.
  const { good, rejected } = partition([null, undefined, '', 42, {}, []]);
  assert.deepEqual(good, []);
  assert.equal(rejected.length, 6);
});

test('one bad row does not discard the good ones', () => {
  // A generator that refused to write anything because a single address was
  // malformed would take every OTHER pharmacy offline to punish one row.
  const { good, rejected } = partition(['naspaa', 'bad}value', 'ikeja-family']);
  assert.deepEqual(good, ['naspaa', 'ikeja-family']);
  assert.deepEqual(rejected, ['bad}value']);
});
