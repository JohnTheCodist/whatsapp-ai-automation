/**
 * The Workflows route: what the assistant does on a pharmacy's behalf, made
 * visible without becoming editable.
 *
 * DATABASE-FREE ON PURPOSE. Every test here reads the protocol modules and
 * the router the same way the route does, so these run on an unconfigured
 * machine — which AGENTS.md calls the committed default. The one thing this
 * file cannot check without Postgres is per-tenant liveness, and that is
 * stated rather than faked.
 *
 * THE INCIDENT THIS CAME FROM, found 2026-10-12. With the engine invisible,
 * the dashboard drifted from it: `client/src/modules.js` advertised "Malaria
 * assessment" with `status: 'active'` while nigeriaMalariaAssessmentV1.js
 * says, in capitals on its second line, "DRAFT. NOT ACTIVE. NOT
 * PATIENT-FACING." Nobody lied — there was no screen, no endpoint, and no
 * test that could have noticed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_DIR = path.join(__dirname, '..', 'services', 'clinical', 'protocols');
const ROUTE_FILE = path.join(__dirname, '..', 'routes', 'protocols.js');

const router = require('../services/clinical/clinicalRouter');

/**
 * The module names in the route's SHIPPED list, and ONLY that list.
 *
 * Written first as `routeSource.includes(filename)`, which a mutation walked
 * straight through: the route's own header comment names
 * nigeriaMalariaAssessmentV1.js while explaining the drift it was built to
 * catch, so deleting that protocol from the list left the test matching the
 * prose. The same shape as GOLDEN-006, where a forbidden word appeared in a
 * comment inside the route being matched.
 */
function shippedModules() {
  const src = fs.readFileSync(ROUTE_FILE, 'utf8');
  const start = src.indexOf('const SHIPPED');
  const end = src.indexOf(']);', start);
  assert.ok(start > -1 && end > start, 'the SHIPPED list has been renamed or removed');
  const block = src.slice(start, end);
  return [...block.matchAll(/protocols\/([A-Za-z0-9]+)'/g)].map((m) => m[1]);
}

test('the router publishes the protocols it would consider, and they are real', () => {
  const list = router.listRoutableProtocols();
  assert.ok(Array.isArray(list), 'listRoutableProtocols must return an array');
  assert.ok(list.length > 0, 'no protocol is routable — the engine would be inert');

  for (const p of list) {
    assert.ok(p.slug, 'a routable protocol with no slug');
    // Semver-shaped, because the protocol service treats (slug, version) as
    // the identity and an encounter must keep meaning what it meant.
    assert.match(p.version, /^\d+\.\d+\.\d+$/, `${p.slug} has a malformed version`);
  }
});

test('every protocol the router can reach is one the screen lists', () => {
  // THE INVARIANT THAT MATTERS. A protocol that can ask a patient questions
  // and does not appear on this screen is the original defect in its worst
  // form: software acting in a pharmacy's name, invisibly.
  const shipped = shippedModules();
  for (const { slug } of router.listRoutableProtocols()) {
    const found = shipped.some((name) => {
      const mod = require(path.join(PROTOCOL_DIR, `${name}.js`));
      return mod.SLUG === slug;
    });
    assert.ok(found, `${slug} is routable but the screen would not show it`);
  }
});

test('the screen lists every protocol file that ships, including the drafts', () => {
  // A draft protocol is a decision somebody made for a clinical reason.
  // Hiding it leaves the screen implying the shelf is bare where it is in
  // fact stocked and switched off on purpose.
  const shipped = shippedModules();
  const files = fs.readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'no protocol files found — the path is wrong');

  for (const file of files) {
    assert.ok(
      shipped.includes(file.replace(/\.js$/, '')),
      `${file} ships but the Workflows screen does not list it`,
    );
  }
});

test('the malaria protocol is NOT routable, and that is pinned deliberately', () => {
  // Its own header: "DRAFT. NOT ACTIVE. NOT PATIENT-FACING... DELIBERATELY
  // LEFT IN `draft` AND IS NEVER ACTIVATED". The sidebar said otherwise for
  // months. If this ever fails, either the clinical decision changed — in
  // which case this test changes WITH it and the reason goes in the commit —
  // or a patient is about to be routed into a protocol nobody approved.
  const slugs = router.listRoutableProtocols().map((p) => p.slug);
  assert.ok(
    !slugs.includes('nigeria_malaria_assessment'),
    'the draft malaria protocol became routable',
  );

  const mal = require(path.join(PROTOCOL_DIR, 'nigeriaMalariaAssessmentV1.js'));
  assert.equal(mal.SLUG, 'nigeria_malaria_assessment');
  assert.match(mal.DEFINITION.name, /DRAFT/i, 'its name no longer says it is a draft');
});

test('two versions of one protocol can ship together and differ', () => {
  // fever v1 is intake-only: 7 questions, NO red flags. v2 is triage: 12
  // questions and 8 red flags. That difference is the whole argument for
  // showing the version on the card rather than only the name.
  const v1 = require(path.join(PROTOCOL_DIR, 'feverAssessmentV1.js')).DEFINITION;
  const v2 = require(path.join(PROTOCOL_DIR, 'feverAssessmentV2.js')).DEFINITION;

  assert.equal(v1.slug, v2.slug, 'these are meant to be the same protocol');
  assert.notEqual(v1.version, v2.version);
  assert.equal((v1.redFlags || []).length, 0, 'v1 was intake-only');
  assert.ok((v2.redFlags || []).length > 0, 'v2 is triage and must have red flags');
});

test('the route is read-only, because protocol content is governance', () => {
  // clinicalProtocolService.js: interpreting a protocol is "a later stage's
  // job, under clinical governance this module has no part in". A web form
  // that writes question sets is that change wearing a UI.
  const route = fs.readFileSync(ROUTE_FILE, 'utf8');
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    assert.ok(
      !route.includes(`router.${verb}(`),
      `the protocols route grew a ${verb.toUpperCase()} handler`,
    );
  }
});

test('the route reports being wired up and being live as SEPARATE facts', () => {
  // Three things: a file existing, the router knowing about it, and a
  // pharmacy having it switched on. Only the last means a patient will be
  // asked these questions tonight, and collapsing them is what let a draft
  // protocol be advertised as an active service.
  const route = fs.readFileSync(ROUTE_FILE, 'utf8');
  assert.match(route, /wiredUp:/, 'the code-level fact is gone');
  assert.match(route, /live:/, 'the per-tenant fact is gone');
  // And an unreadable configuration is reported as unknown rather than off.
  assert.match(route, /liveKnown/, 'the unreadable case has been collapsed into "off"');
});
