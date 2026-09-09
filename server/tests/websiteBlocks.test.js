/**
 * The website block contract.
 *
 * NOTHING HERE NEEDS A DATABASE, and that is the point. The block contract is
 * what turns a pharmacy's stored data into HTML on the public internet, so it
 * is the last place in this repository that should be protected by a suite
 * which skips when TEST_DATABASE_URL is unset. Every test in this file runs
 * on a laptop with nothing configured.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const blocks = require('../services/website/blocks');
const { validateShape } = require('../services/website/blocks/types');
const types = require('../services/website/blocks/types');
const { editorManifest } = require('../services/website/blocks/editorManifest');
const templates = require('../services/website/templates');

/** The eleven blocks Phase 2 committed to. */
const REQUIRED = [
  'pharmacy.header', 'pharmacy.hero', 'pharmacy.whatsappCta', 'pharmacy.openingHours',
  'pharmacy.about', 'pharmacy.services', 'pharmacy.location', 'pharmacy.contact',
  'pharmacy.reviews', 'pharmacy.pharmacistCta', 'pharmacy.footer',
];

/** A pharmacy with everything filled in, for the inheritance tests. */
const CTX = Object.freeze({
  pharmacy: { name: 'Ikeja Family Pharmacy', public_whatsapp_number: '2348012345678' },
  profile: {
    phone: '08012345678',
    address_line: '12 Allen Avenue',
    city: 'Ikeja',
    state: 'Lagos',
    landmark: 'Opposite the GTBank',
    maps_url: 'https://maps.google.com/?q=ikeja',
    description: 'Family run since 2014.\n\nOpen six days a week.',
    services: [{ name: 'Prescriptions', description: 'Dispensed by a pharmacist.', icon: 'pill' }],
    opening_hours: [
      { day: 'mon', open: '08:00', close: '20:00', closed: false },
      { day: 'sun', open: null, close: null, closed: true },
    ],
  },
  assets: new Map(),
  year: 2026,
});

// =====================================================================
// REGISTRY
// =====================================================================

test('every block the phase committed to is registered', () => {
  const registered = blocks.blockIds();
  for (const id of REQUIRED) {
    assert.ok(registered.includes(id), `${id} must be registered`);
  }
});

test('block ids are unique, because a site stores the id and trusts it to mean one thing', () => {
  const ids = blocks.DEFINITIONS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every block declares an explicit integer version', () => {
  for (const d of blocks.DEFINITIONS) {
    assert.ok(Number.isInteger(d.version), `${d.id} version must be a whole number`);
    assert.ok(d.version >= 1, `${d.id} version must be at least 1`);
  }
});

test('every block carries the metadata the builder and the editor both need', () => {
  for (const d of blocks.DEFINITIONS) {
    assert.equal(typeof d.name, 'string', `${d.id}.name`);
    assert.ok(d.name.length > 0, `${d.id}.name must not be empty`);
    assert.equal(typeof d.description, 'string', `${d.id}.description`);
    assert.equal(typeof d.category, 'string', `${d.id}.category`);
    assert.equal(typeof d.props, 'object', `${d.id}.props`);
    assert.equal(typeof d.responsive, 'object', `${d.id}.responsive`);
    assert.equal(typeof d.editor, 'object', `${d.id}.editor`);
    assert.equal(typeof d.a11y, 'string', `${d.id}.a11y`);
    assert.equal(typeof d.render, 'function', `${d.id}.render`);
  }
});

test('every list prop is bounded', () => {
  // An unbounded list is an unbounded page and an unbounded jsonb column.
  for (const d of blocks.DEFINITIONS) {
    for (const [name, spec] of Object.entries(d.props)) {
      if (spec.type !== 'list') continue;
      assert.ok(Number.isInteger(spec.max), `${d.id}.${name} must declare a max`);
      assert.equal(typeof spec.of, 'object', `${d.id}.${name} must declare item fields`);
    }
  }
});

/**
 * THE STRUCTURAL SECURITY GUARANTEE.
 *
 * The published page has no HTML sanitiser, and does not need one, because
 * there is no prop type that can carry markup. This test is what stops that
 * being quietly undone: adding an `html` or `richtext` type to the contract
 * would reopen the entire class of injection bugs the architecture was chosen
 * to eliminate, and it should fail loudly here rather than pass review as a
 * convenience.
 */
test('no prop type exists that could carry HTML', () => {
  const declared = Object.keys(types.VALIDATORS);
  for (const forbidden of ['html', 'richtext', 'markdown', 'raw']) {
    assert.ok(!declared.includes(forbidden),
      `a "${forbidden}" prop type would give arbitrary markup a route into published pages`);
  }
});

test('every prop in every block uses a type the validator knows', () => {
  const known = new Set(Object.keys(types.VALIDATORS));
  for (const d of blocks.DEFINITIONS) {
    for (const [name, spec] of Object.entries(d.props)) {
      assert.ok(known.has(spec.type), `${d.id}.${name} has unknown type ${spec.type}`);
    }
  }
});

test('a binding names a root that actually exists', () => {
  // A typo like `profle.phone` renders an empty section forever and nothing
  // ever says why.
  for (const d of blocks.DEFINITIONS) {
    for (const [name, spec] of Object.entries(d.props)) {
      if (!spec.from) continue;
      assert.match(spec.from, /^(pharmacy|profile)\./, `${d.id}.${name} binds to an unknown root`);
    }
  }
});

// =====================================================================
// VALIDATION
// =====================================================================

test('a valid block passes and comes back with its version made explicit', () => {
  const r = blocks.validateBlock({ type: 'pharmacy.hero', props: { heading: 'Open late' } });
  assert.equal(r.ok, true);
  assert.equal(r.value.version, 1, 'an absent version must be filled in, never left undefined');
  assert.equal(r.value.props.heading, 'Open late');
});

test('an unknown block type is rejected', () => {
  const r = blocks.validateBlock({ type: 'pharmacy.notARealBlock', props: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_BLOCK');
});

test('a block version that is not registered is rejected rather than falling back', () => {
  // Falling back to the latest version would silently re-render an old site
  // with new markup — the exact thing versioning exists to prevent.
  const r = blocks.validateBlock({ type: 'pharmacy.hero', version: 99, props: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_BLOCK_VERSION');
});

test('an unknown prop is rejected by name, not silently dropped', () => {
  const r = blocks.validateBlock({ type: 'pharmacy.hero', props: { headnig: 'typo' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_BLOCK_PROPS');
  assert.match(r.error, /headnig/, 'the error must name the offending key');
});

test('a prop of the wrong type is rejected', () => {
  for (const props of [{ heading: 42 }, { heading: [] }, { heading: {} }, { image: 'not-a-uuid' }]) {
    const r = blocks.validateBlock({ type: 'pharmacy.hero', props });
    assert.equal(r.ok, false, `${JSON.stringify(props)} must be rejected`);
  }
});

test('text that looks like HTML is rejected at save time', () => {
  for (const heading of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'Hello <b>there</b>',
    '</h1><script>x</script>',
  ]) {
    const r = blocks.validateBlock({ type: 'pharmacy.hero', props: { heading } });
    assert.equal(r.ok, false, `${heading} must be rejected`);
  }
});

test('ordinary pharmacy copy containing angle brackets still saves', () => {
  // A validator that refuses "<500 naira" is one people work around.
  const r = blocks.validateBlock({
    type: 'pharmacy.hero',
    props: { subheading: 'Pain relief from <500 naira, 6 days a week' },
  });
  assert.equal(r.ok, true, r.error);
});

test('an unsafe URL scheme is rejected', () => {
  for (const secondaryCtaUrl of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example.com',
  ]) {
    const r = blocks.validateBlock({ type: 'pharmacy.hero', props: { secondaryCtaUrl } });
    assert.equal(r.ok, false, `${secondaryCtaUrl} must be rejected`);
  }
});

test('a real https URL is accepted', () => {
  const r = blocks.validateBlock({
    type: 'pharmacy.hero',
    props: { secondaryCtaUrl: 'https://maps.google.com/?q=ikeja' },
  });
  assert.equal(r.ok, true, r.error);
});

test('an invalid WhatsApp number is rejected', () => {
  for (const phoneNumber of ['', '123', 'not-a-number', '2348012345678901234', '+234 (801) abc']) {
    const r = blocks.validateBlock({ type: 'pharmacy.whatsappCta', props: { phoneNumber } });
    assert.equal(r.ok, false, `${JSON.stringify(phoneNumber)} must be rejected`);
  }
});

test('a phone number a person would actually type is normalised to digits', () => {
  for (const input of ['+234 801 234 5678', '+2348012345678', '234-801-234-5678', '(234) 8012345678']) {
    const r = blocks.validateBlock({ type: 'pharmacy.whatsappCta', props: { phoneNumber: input } });
    assert.equal(r.ok, true, `${input}: ${r.error}`);
    assert.equal(r.value.props.phoneNumber, '2348012345678');
  }
});

test('list items are validated by the same rules as block props', () => {
  const bad = blocks.validateBlock({
    type: 'pharmacy.services',
    props: { services: [{ name: 'Delivery', notAField: 'x' }] },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /notAField/);

  const injected = blocks.validateBlock({
    type: 'pharmacy.reviews',
    props: { reviews: [{ name: 'A', text: '<script>alert(1)</script>' }] },
  });
  assert.equal(injected.ok, false, 'injection inside a list item must be caught too');
});

test('a list longer than its bound is rejected', () => {
  const services = Array.from({ length: 13 }, (_, i) => ({ name: `Service ${i}` }));
  const r = blocks.validateBlock({ type: 'pharmacy.services', props: { services } });
  assert.equal(r.ok, false);
});

test('validateShape rejects a non-object rather than coercing it', () => {
  for (const bad of ['x', 42, [], null]) {
    const r = validateShape({ a: { type: 'text' } }, bad, 'p');
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

// =====================================================================
// RENDERING
// =====================================================================

test('every registered block renders without throwing on empty props', () => {
  // A public page must not 500 because a pharmacy left a section blank.
  for (const d of blocks.DEFINITIONS) {
    const html = blocks.renderBlock({ type: d.id, version: d.version, props: {} }, CTX);
    assert.equal(typeof html, 'string', `${d.id} must return a string`);
  }
});

test('every registered block renders without throwing on an empty pharmacy', () => {
  const bare = { pharmacy: {}, profile: {}, assets: new Map() };
  for (const d of blocks.DEFINITIONS) {
    const html = blocks.renderBlock({ type: d.id, version: d.version, props: {} }, bare);
    assert.equal(typeof html, 'string', `${d.id} must survive a pharmacy with no profile`);
  }
});

test('rendering is deterministic — the same input always produces the same HTML', () => {
  // published_html is a cache. A renderer that varied would churn it on every
  // republish and make any diff meaningless.
  const site = { blocks: blocks.DEFINITIONS.map((d) => ({ type: d.id, version: d.version, props: {} })) };
  assert.equal(blocks.renderSite(site, CTX), blocks.renderSite(site, CTX));
});

test('opening hours render in weekday order regardless of stored order', () => {
  const shuffled = {
    ...CTX,
    profile: {
      ...CTX.profile,
      opening_hours: [
        { day: 'wed', open: '09:00', close: '17:00' },
        { day: 'mon', open: '08:00', close: '20:00' },
      ],
    },
  };
  const html = blocks.renderBlock({ type: 'pharmacy.openingHours', version: 1, props: {} }, shuffled);
  assert.ok(html.indexOf('Monday') < html.indexOf('Wednesday'), 'Monday must come first');
});

/**
 * THE ESCAPING GUARANTEE.
 *
 * Validation refuses tag-like text at save time, but the renderer must not
 * depend on that — data can reach it from an older block version, a
 * migration, or a future admin tool that did not go through today's
 * validator. So this test bypasses validation entirely and renders hostile
 * values directly, which is the only way to prove the render path is safe on
 * its own.
 */
test('the renderer escapes hostile text even when validation is bypassed', () => {
  const hostile = '<script>alert(1)</script>';
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: hostile } },
    CTX,
  );
  assert.ok(!html.includes('<script>'), 'a raw script tag must never reach the output');
  assert.ok(html.includes('&lt;script&gt;'), 'it must appear escaped instead');
});

test('a hostile value cannot break out of an attribute', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.header', version: 1, props: { pharmacyName: '" onload="alert(1)' } },
    { ...CTX, assets: new Map([['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { storage_path: 'p/logo.png' }]]) },
  );
  assert.ok(!html.includes('onload="alert'), 'the attribute must not be escapable');
  assert.ok(html.includes('&quot;'), 'the quote must be escaped');
});

test('ampersands are escaped once, not twice', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Mum & baby care' } },
    CTX,
  );
  assert.ok(html.includes('Mum &amp; baby care'));
  assert.ok(!html.includes('&amp;amp;'), 'double-escaping would display the entity to visitors');
});

test('the WhatsApp link is built from parts and always points at wa.me', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.whatsappCta', version: 1, props: { phoneNumber: '2348012345678', message: 'Hi there' } },
    CTX,
  );
  assert.match(html, /href="https:\/\/wa\.me\/2348012345678\?text=Hi%20there"/);
});

test('a block with no WhatsApp number renders nothing rather than a dead button', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.whatsappCta', version: 1, props: {} },
    { pharmacy: {}, profile: {}, assets: new Map() },
  );
  assert.equal(html, '');
});

test('contact renders only the details that exist', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.contact', version: 1, props: {} },
    { pharmacy: {}, profile: { phone: '08012345678' }, assets: new Map() },
  );
  assert.match(html, /Phone/);
  assert.ok(!html.includes('Email'), 'an absent email must not render an empty row');
  assert.ok(!html.includes('WhatsApp'), 'an absent WhatsApp number must not render an empty row');
});

test('location never publishes the pharmacy’s coordinates', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: {} },
    { ...CTX, profile: { ...CTX.profile, latitude: 6.6018, longitude: 3.3515 } },
  );
  assert.ok(!html.includes('6.6018'), 'latitude is operational data, not website copy');
  assert.ok(!html.includes('3.3515'), 'longitude is operational data, not website copy');
});

test('reviews are never fabricated by a default', () => {
  const html = blocks.renderBlock({ type: 'pharmacy.reviews', version: 1, props: {} }, CTX);
  assert.equal(html, '', 'an empty reviews block must render nothing at all');
});

// =====================================================================
// LAYOUT VARIANTS — what makes one template read differently from another
// =====================================================================

const CTX_WITH_PHOTO = Object.freeze({
  ...CTX,
  assets: new Map([
    ['11111111-1111-1111-1111-111111111111', { kind: 'hero', width: 1200, height: 900, storage_path: 'shop.jpg' }],
  ]),
});

test('the centred hero is a full-bleed band on the SECTION, not just its inner column', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast help', layout: 'centered' } },
    CTX,
  );
  // The modifier class must sit beside rx-pharmacy-hero on the same element —
  // see stylesheet.js's comment on exactly why one level deeper is a bug (it
  // was, once, in this branch).
  assert.match(html, /class="rx-block rx-pharmacy-hero rx-hero--centered"/);
  assert.ok(!html.includes('rx-hero-media'), 'centred never uses the side-by-side media wrapper');
});

test('the centred hero uses a photo as a dimmed background, not a side-by-side picture', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast help', layout: 'centered' } },
    CTX_WITH_PHOTO,
  );
  assert.match(html, /<img class="rx-hero-bg"/);
  assert.ok(!html.includes('rx-hero-media'), 'a photo must not push centred back into the split shape');
});

test('the framed hero only applies when there is a photo to frame', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Considered care', layout: 'framed' } },
    CTX,
  );
  assert.ok(!html.includes('rx-hero--framed'), 'nothing to frame with no photo');
  assert.match(html, /rx-hero--type/, 'falls back to the same typographic centre as split with no photo');
});

test('the framed hero insets the photo once one exists', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Considered care', layout: 'framed' } },
    CTX_WITH_PHOTO,
  );
  assert.match(html, /rx-hero--framed/);
  assert.match(html, /rx-hero-media/);
});

test('the showcase hero only applies when there is a photo', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast care', layout: 'showcase' } },
    CTX,
  );
  assert.ok(!html.includes('rx-hero--showcase'), 'nothing to showcase with no photo');
  assert.match(html, /rx-hero--type/, 'falls back to the same typographic centre as split with no photo');
});

test('the showcase hero states how many days a week the pharmacy is open, never "open now"', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast care', layout: 'showcase' } },
    CTX_WITH_PHOTO,
  );
  assert.match(html, /rx-hero--showcase/);
  // CTX's profile sets two days: one open (mon), one explicitly closed (sun).
  assert.match(html, /1 Day a Week/);
  assert.ok(!/open now/i.test(html), 'a statically-published page must never claim a live status');
});

test('the showcase hero always appends the pharmacy\'s real, bound name after the heading, highlighted', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast, Friendly Care at', layout: 'showcase' } },
    CTX_WITH_PHOTO,
  );
  assert.match(html, /<h1>Fast, Friendly Care at <span class="rx-hero-highlight">Ikeja Family Pharmacy<\/span><\/h1>/);
});

test('every other hero layout leaves the heading exactly as typed, with no name appended', () => {
  for (const layout of [undefined, 'split', 'centered', 'framed']) {
    const html = blocks.renderBlock(
      { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast, Friendly Care at', layout } },
      CTX_WITH_PHOTO,
    );
    assert.match(html, /<h1>Fast, Friendly Care at<\/h1>/, `layout ${layout}`);
    assert.ok(!html.includes('rx-hero-highlight'), `layout ${layout} must not append a name`);
  }
});

test('the showcase hero omits the badge entirely with no opening hours set, rather than inventing one', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'Fast care', layout: 'showcase' } },
    { ...CTX_WITH_PHOTO, profile: { ...CTX_WITH_PHOTO.profile, opening_hours: [] } },
  );
  assert.match(html, /rx-hero--showcase/, 'the layout itself still applies');
  assert.ok(!html.includes('rx-hero-badge'), 'no hours means no claim about hours');
});

test('an unset hero layout renders exactly as "split" does — the default is backward compatible', () => {
  const unset = blocks.renderBlock({ type: 'pharmacy.hero', version: 1, props: { heading: 'X' } }, CTX_WITH_PHOTO);
  const explicit = blocks.renderBlock(
    { type: 'pharmacy.hero', version: 1, props: { heading: 'X', layout: 'split' } },
    CTX_WITH_PHOTO,
  );
  assert.equal(unset, explicit);
});

test('services\' "rows" layout reuses the index page\'s own card, not a new component', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'Prescriptions' }], layout: 'rows' } },
    CTX,
  );
  assert.match(html, /class="rx-cards"/);
  assert.match(html, /class="rx-card"/);
  assert.ok(!html.includes('rx-service-grid'), 'rows must not also emit the photo-card grid');
});

test('services with no layout set still renders the photo-card grid', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'Prescriptions' }] } },
    CTX,
  );
  assert.match(html, /rx-service-grid/);
});

test('services\' "tiles" layout alternates the icon chip colour and marks no card as a photo card', () => {
  const html = blocks.renderBlock(
    {
      type: 'pharmacy.services',
      version: 1,
      props: { services: [{ name: 'Prescriptions' }, { name: 'Consultations' }, { name: 'Delivery' }], layout: 'tiles' },
    },
    CTX,
  );
  assert.match(html, /rx-service-tile rx-tile-a/);
  assert.match(html, /rx-service-tile rx-tile-b/);
  assert.ok(!html.includes('rx-service-grid'), 'tiles must not also emit the photo-card grid');
  assert.ok(!html.includes('rx-cards'), 'tiles must not also emit the rows list');
});

test('services\' "band" style colours the section, and the eyebrow becomes a solid pill', () => {
  const html = blocks.renderBlock(
    {
      type: 'pharmacy.services',
      version: 1,
      props: { services: [{ name: 'Prescriptions' }], layout: 'tiles', style: 'band', eyebrow: 'Our Services' },
    },
    CTX,
  );
  assert.match(html, /class="rx-block rx-pharmacy-services rx-services--band"/);
  assert.match(html, /<span class="rx-eyebrow">Our Services<\/span>/);
});

test('services without "band" style carries no colour-band class, even with an eyebrow set', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'Prescriptions' }], layout: 'tiles', eyebrow: 'Our Services' } },
    CTX,
  );
  assert.ok(!html.includes('rx-services--band'));
});

test('a heading and its accent are two independent props, not a split of one string', () => {
  const withAccent = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'X' }], heading: 'Comprehensive', headingAccent: 'Care for You' } },
    CTX,
  );
  assert.match(withAccent, /<h2>Comprehensive <span class="rx-heading-accent">Care for You<\/span><\/h2>/);

  const withoutAccent = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'X' }], heading: 'What we offer' } },
    CTX,
  );
  assert.match(withoutAccent, /<h2>What we offer<\/h2>/);
  assert.ok(!withoutAccent.includes('rx-heading-accent'));
});

test('about renders no trust highlights by default, and only real ones once the owner adds them', () => {
  const bare = blocks.renderBlock({ type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.' } }, CTX);
  assert.ok(!bare.includes('rx-about-highlights'), 'nothing invented in place of the owner\'s own trust points');

  const withHighlights = blocks.renderBlock(
    {
      type: 'pharmacy.about',
      version: 1,
      props: { description: 'We are a pharmacy.', highlights: [{ text: 'Bilingual Staff' }, { text: '' }, { text: 'Free Delivery' }] },
    },
    CTX,
  );
  assert.match(withHighlights, /<li><span class="rx-check"[^>]*>.*?<\/span>Bilingual Staff<\/li>/);
  assert.match(withHighlights, /Free Delivery/);
  // The blank entry must be dropped, not rendered as an empty row.
  assert.equal((withHighlights.match(/<li>/g) || []).length, 2);
});

test('about\'s directions button appears only with a real maps link AND a template that opted in', () => {
  const noButtonLabel = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.' } },
    CTX,
  );
  assert.ok(!noButtonLabel.includes('rx-btn-solid'), 'a template that never set buttonLabel gets no button');

  const withButton = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.', buttonLabel: 'Get Directions' } },
    CTX,
  );
  assert.match(withButton, /rx-btn-solid/);
  assert.match(withButton, /Get Directions/);

  const noMapsUrl = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.', buttonLabel: 'Get Directions' } },
    { ...CTX, profile: { ...CTX.profile, maps_url: null } },
  );
  assert.ok(!noMapsUrl.includes('rx-btn-solid'), 'a button pointed nowhere must not render even if a label was set');
});

test('about\'s framed media style and flip:false both apply only with a second photo present', () => {
  // About takes the SECOND photo (the hero has already taken the first) —
  // CTX_WITH_PHOTO only has one, correctly leaving About in its no-photo
  // prose branch; this test needs two.
  const ctxTwoPhotos = {
    ...CTX,
    assets: new Map([
      ['11111111-1111-1111-1111-111111111111', { kind: 'hero', width: 1200, height: 900, storage_path: 'a.jpg' }],
      ['22222222-2222-2222-2222-222222222222', { kind: 'gallery', width: 800, height: 600, storage_path: 'b.jpg' }],
    ]),
  };
  const framed = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.', mediaStyle: 'framed', flip: false } },
    ctxTwoPhotos,
  );
  assert.match(framed, /rx-split-media--framed/);
  assert.ok(!framed.includes('rx-split--flip'), 'flip:false must not carry the flip class');

  const defaultFlip = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.' } },
    ctxTwoPhotos,
  );
  assert.match(defaultFlip, /rx-split--flip/, 'an unset flip must keep the existing default behaviour');
  assert.ok(!defaultFlip.includes('rx-split-media--framed'));
});

test('about\'s "tint" style carries its own class; the default carries none', () => {
  const tinted = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.', style: 'tint' } },
    CTX,
  );
  assert.match(tinted, /class="rx-block rx-pharmacy-about rx-pharmacy-about--tint"/);

  const plain = blocks.renderBlock(
    { type: 'pharmacy.about', version: 1, props: { description: 'We are a pharmacy.' } },
    CTX,
  );
  assert.ok(!plain.includes('rx-pharmacy-about--tint'));
});

test('a services subheading or eyebrow centres the section head; heading alone does not', () => {
  const plain = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'X' }], heading: 'What we offer' } },
    CTX,
  );
  assert.ok(!plain.includes('rx-head--center'));

  const withSub = blocks.renderBlock(
    { type: 'pharmacy.services', version: 1, props: { services: [{ name: 'X' }], heading: 'What we offer', subheading: 'A short line.' } },
    CTX,
  );
  assert.match(withSub, /rx-head--center/);
});

test('the pharmacist CTA\'s "statement" variant carries its own modifier class', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Ask us', variant: 'statement' } },
    CTX,
  );
  assert.match(html, /rx-pharmacistCta--statement/);
});

test('the plain pharmacist CTA (the default) carries no statement class', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Ask us' } },
    CTX,
  );
  assert.ok(!html.includes('rx-pharmacistCta--statement'));
});

test('pharmacist CTA\'s "phone" ctaType calls the pharmacy\'s own real number, never buttonLabel', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Transfer today', ctaType: 'phone', buttonLabel: 'Ignored' } },
    CTX,
  );
  assert.match(html, /href="tel:08012345678"/);
  assert.match(html, /Call 08012345678/);
  assert.ok(!html.includes('Ignored'), 'buttonLabel must not leak into the phone button\'s text');
  assert.ok(!html.includes('rx-btn-wa') || !html.includes('wa.me'), 'phone mode must not also build a WhatsApp link');
});

test('pharmacist CTA\'s "phone" ctaType renders no button — never a dead one — with no phone on the profile', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { ctaType: 'phone' } },
    { ...CTX, profile: { ...CTX.profile, phone: null } },
  );
  assert.ok(!html.includes('rx-btn'), 'no phone means no button, though the heading/description defaults may still show');

  const bothMissing = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: '', description: '', ctaType: 'phone' } },
    { ...CTX, profile: { ...CTX.profile, phone: null } },
  );
  assert.equal(bothMissing, '', 'with no copy AND no working button, the section renders nothing at all');
});

test('pharmacist CTA\'s default ctaType (whatsapp) is unchanged by adding the phone option', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Ask us', buttonLabel: 'Ask a pharmacist', message: 'Hi' } },
    CTX,
  );
  assert.match(html, /wa\.me/);
  assert.match(html, /Ask a pharmacist/);
});

test('pharmacist CTA\'s "banner" layout is a horizontal strip, never narrowed like the stacked default', () => {
  const banner = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Transfer today', ctaType: 'phone', layout: 'banner' } },
    CTX,
  );
  assert.match(banner, /class="rx-block rx-pharmacy-pharmacistCta rx-pharmacistCta--banner"/);
  assert.match(banner, /rx-pharmacistCta-banner-inner/);
  assert.ok(!banner.includes('rx-narrow'));

  const stacked = blocks.renderBlock(
    { type: 'pharmacy.pharmacistCta', version: 1, props: { heading: 'Transfer today', ctaType: 'phone' } },
    CTX,
  );
  assert.match(stacked, /rx-narrow/);
  assert.ok(!stacked.includes('rx-pharmacistCta--banner'));
});

test('FAQ renders nothing without at least one real question and answer', () => {
  const empty = blocks.renderBlock({ type: 'pharmacy.faq', version: 1, props: {} }, CTX);
  assert.equal(empty, '');

  const partial = blocks.renderBlock(
    { type: 'pharmacy.faq', version: 1, props: { faqs: [{ question: 'Do you deliver?' }] } },
    CTX,
  );
  assert.equal(partial, '', 'a question with no answer must not render either');
});

test('FAQ renders each real question as a native details/summary disclosure, needing no JavaScript', () => {
  const html = blocks.renderBlock(
    {
      type: 'pharmacy.faq',
      version: 1,
      props: {
        eyebrow: 'Common Questions',
        faqs: [
          { question: 'Do you offer delivery?', answer: 'Yes, within Ikeja.' },
          { question: 'Do you take insurance?', answer: 'Ask us on WhatsApp.' },
        ],
      },
    },
    CTX,
  );
  assert.equal((html.match(/<details class="rx-faq-item">/g) || []).length, 2);
  assert.match(html, /<summary>Do you offer delivery\?/);
  assert.match(html, /Yes, within Ikeja\./);
  assert.match(html, /<span class="rx-eyebrow rx-eyebrow--outline">Common Questions<\/span>/);
});

test('location\'s "cards" layout builds the map from the pharmacy\'s own address fields, never from mapsUrl', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { layout: 'cards', phoneCtaLabel: 'Call Us Now' } },
    CTX,
  );
  assert.match(html, /class="rx-visit-map"><iframe src="[^"]*maps\.google\.com\/maps\?q=12%20Allen%20Avenue/);
  // CTX's own mapsUrl is a plain https://maps.google.com/?q=ikeja link, not
  // an embeddable one — the query string proves the embed used the address
  // fields, not that URL passed through unchanged.
  assert.ok(!html.includes('output=embed">https://maps.google.com/?q=ikeja'));
});

test('location\'s "cards" layout colours each card by what it IS, not by its position', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { layout: 'cards', phoneCtaLabel: 'Call Us Now' } },
    CTX,
  );
  assert.match(html, /rx-visit-card rx-visit-card--address/);
  assert.match(html, /rx-visit-card rx-visit-card--phone/);
  assert.match(html, /rx-visit-card rx-visit-card--hours/);
  assert.match(html, /Call Us Now/);
});

test('location\'s "cards" layout groups consecutive identical days into one range, never merging a gap', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { layout: 'cards' } },
    {
      ...CTX,
      profile: {
        ...CTX.profile,
        opening_hours: [
          { day: 'mon', open: '10:00', close: '18:00', closed: false },
          { day: 'tue', open: '10:00', close: '18:00', closed: false },
          { day: 'wed', open: '10:00', close: '18:00', closed: false },
          { day: 'thu', open: '10:00', close: '18:00', closed: false },
          { day: 'fri', open: '10:00', close: '18:00', closed: false },
          { day: 'sat', closed: true },
          { day: 'sun', closed: true },
        ],
      },
    },
  );
  assert.match(html, /Mon – Fri/);
  assert.match(html, /10:00 am – 6:00 pm/);
  assert.match(html, /Sat – Sun/);
  assert.match(html, /rx-visit-hours-closed">Closed/);
});

test('location\'s "cards" layout omits the phone card with no phone, and the whole section with nothing at all', () => {
  const noPhone = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { layout: 'cards' } },
    { ...CTX, profile: { ...CTX.profile, phone: null } },
  );
  assert.ok(!noPhone.includes('rx-visit-card--phone'));
  assert.match(noPhone, /rx-visit-card--address/, 'address and hours must still render');

  const nothing = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { layout: 'cards' } },
    { ...CTX, profile: { address_line: null, city: null, state: null, phone: null, opening_hours: [] } },
  );
  assert.equal(nothing, '');
});

test('an unset location layout renders exactly as "split" did before "cards" existed', () => {
  const unset = blocks.renderBlock({ type: 'pharmacy.location', version: 1, props: {} }, CTX);
  const explicit = blocks.renderBlock({ type: 'pharmacy.location', version: 1, props: { layout: 'split' } }, CTX);
  assert.equal(unset, explicit);
  assert.ok(!unset.includes('rx-visit-grid'));
});

test('Modern, Premium and Metro actually request the layouts that differentiate them', () => {
  // A test, not just a code review, so a future edit that quietly drops the
  // layout override back to the shared default fails loudly instead of
  // shipping templates that look the same as each other again.
  const modernHero = templates.getTemplate('modern').seed.blocks.find((b) => b.type === 'pharmacy.hero');
  const modernServices = templates.getTemplate('modern').seed.blocks.find((b) => b.type === 'pharmacy.services');
  assert.equal(modernHero.props.layout, 'centered');
  assert.equal(modernServices.props.layout, 'rows');

  const premiumHero = templates.getTemplate('premium').seed.blocks.find((b) => b.type === 'pharmacy.hero');
  const premiumCta = templates.getTemplate('premium').seed.blocks.find((b) => b.type === 'pharmacy.pharmacistCta');
  assert.equal(premiumHero.props.layout, 'framed');
  assert.equal(premiumCta.props.variant, 'statement');

  const metroHero = templates.getTemplate('metro').seed.blocks.find((b) => b.type === 'pharmacy.hero');
  assert.equal(metroHero.props.layout, 'showcase');

  // Professional and Family are the baseline hero — no override, so they
  // stay whatever the shared default is rather than pinning a value here
  // that would need updating every time the default itself changed.
  const proHero = templates.getTemplate('professional').seed.blocks.find((b) => b.type === 'pharmacy.hero');
  const familyHero = templates.getTemplate('family').seed.blocks.find((b) => b.type === 'pharmacy.hero');
  assert.equal(proHero.props.layout, undefined);
  assert.equal(familyHero.props.layout, undefined);
});

// =====================================================================
// INHERITANCE — the anti-divergence mechanism
// =====================================================================

test('a bound prop with nothing stored inherits from the pharmacy profile', () => {
  const html = blocks.renderBlock({ type: 'pharmacy.location', version: 1, props: {} }, CTX);
  assert.match(html, /12 Allen Avenue/);
  assert.match(html, /Ikeja/);
});

test('an explicitly stored value overrides the profile, and only then', () => {
  const html = blocks.renderBlock(
    { type: 'pharmacy.location', version: 1, props: { city: 'Surulere' } },
    CTX,
  );
  assert.match(html, /Surulere/, 'a deliberate override must win');
  assert.ok(!html.includes('Ikeja,'), 'and must replace the inherited value, not sit beside it');
});

test('changing the profile changes the rendered page with no edit to the site', () => {
  // This is the requirement that a website cannot claim different opening
  // hours than the profile the assistant answers from.
  const site = { blocks: [{ type: 'pharmacy.contact', version: 1, props: {} }] };
  const before = blocks.renderSite(site, CTX);
  const after = blocks.renderSite(site, {
    ...CTX, profile: { ...CTX.profile, phone: '08099999999' },
  });
  assert.match(before, /08012345678/);
  assert.match(after, /08099999999/);
  assert.notEqual(before, after);
});

// =====================================================================
// TEMPLATE COMPOSITION
// =====================================================================

test('every template seed validates against the block registry', () => {
  for (const t of templates.TEMPLATES) {
    const r = templates.validateTemplate(t);
    assert.equal(r.ok, true, `template ${t.id}: ${r.error}`);
  }
});

test('every template block states an explicit version', () => {
  for (const t of templates.TEMPLATES) {
    for (const [i, block] of t.seed.blocks.entries()) {
      assert.ok(Number.isInteger(block.version), `${t.id}.blocks[${i}] must pin a block version`);
    }
  }
});

/**
 * THE ANTI-DUPLICATION INVARIANT.
 *
 * A template must not seed any prop that declares a `from` binding. Doing so
 * would hand every new pharmacy a hardcoded copy of a field that is supposed
 * to be inherited — and from that moment their website and their profile
 * could disagree, which is precisely the failure the brief names.
 *
 * This is a structural check rather than a spot check: it holds for templates
 * 4 through 10 as they are added, without anyone remembering the rule.
 */
test('no template hardcodes a value that should be inherited from the profile', () => {
  for (const t of templates.TEMPLATES) {
    for (const [i, block] of t.seed.blocks.entries()) {
      const def = blocks.getBlock(block.type, block.version);
      for (const name of Object.keys(block.props || {})) {
        assert.ok(!def.props[name].from,
          `${t.id}.blocks[${i}] sets "${name}", which is inherited from ${def.props[name].from}. `
          + 'Templates must not seed pharmacy data — leave it out and it inherits.');
      }
    }
  }
});

test('a template renders end to end from a pharmacy profile alone', () => {
  const seed = templates.cloneSeed('professional');
  const html = blocks.renderSite(seed, CTX);
  assert.match(html, /Ikeja Family Pharmacy/, 'the pharmacy name must reach the page');
  assert.match(html, /wa\.me\/2348012345678/, 'the WhatsApp CTA must reach the page');
  assert.match(html, /12 Allen Avenue/, 'the address must reach the page');
  assert.match(html, /Monday/, 'opening hours must reach the page');
  assert.ok(!html.includes('<script'), 'a rendered template must contain no script tag');
});

test('cloneSeed hands back an independent copy', () => {
  const a = templates.cloneSeed('professional');
  const b = templates.cloneSeed('professional');
  a.blocks[1].props.heading = 'mutated';
  assert.notEqual(b.blocks[1].props.heading, 'mutated');
  assert.notEqual(templates.getTemplate('professional').seed.blocks[1].props.heading, 'mutated');
});

// =====================================================================
// EDITOR ADAPTER BOUNDARY
// =====================================================================

test('the editor manifest is derived from the registry, block for block', () => {
  const manifest = editorManifest();
  assert.equal(manifest.blocks.length, blocks.DEFINITIONS.length,
    'the editor must not see more or fewer blocks than the renderer knows');
  for (const entry of manifest.blocks) {
    assert.ok(blocks.getBlock(entry.id, entry.version), `${entry.key} must exist in the registry`);
  }
});

test('the manifest never ships a renderer or a default to the client', () => {
  for (const entry of editorManifest().blocks) {
    assert.equal(entry.render, undefined, 'the client must never decide what HTML a block produces');
    assert.equal(entry.defaults, undefined, 'defaults are applied server-side at render');
  }
});

test('a dragged block seeds no props, so every bound field inherits immediately', () => {
  for (const entry of editorManifest().blocks) {
    assert.deepEqual(entry.content.props, {},
      `${entry.key} must insert empty, or it would copy pharmacy data into the block`);
    assert.equal(entry.content.type, entry.id);
    assert.ok(Number.isInteger(entry.content.version));
  }
});

test('no editor input kind accepts markup', () => {
  const { INPUT_KIND } = require('../services/website/blocks/editorManifest');
  for (const kind of Object.values(INPUT_KIND)) {
    assert.ok(!['richtext', 'html', 'wysiwyg'].includes(kind),
      `an editor offering a "${kind}" field would let an owner type markup into a published page`);
  }
});

// =====================================================================
// TEST SAFETY — the guard added after a suite reached production
// =====================================================================

test('a test database target must be unmistakably a test target', () => {
  const { testTargetKind } = require('./helpers/testDb');
  const saved = process.env.RXNAIJA_ALLOW_REMOTE_TEST_DB;
  delete process.env.RXNAIJA_ALLOW_REMOTE_TEST_DB;

  try {
    // Accepted: loopback, or named for testing.
    assert.equal(testTargetKind('postgres://u:p@127.0.0.1:55432/rxnaija_test').ok, true);
    assert.equal(testTargetKind('postgres://u:p@localhost:5432/anything').ok, true);
    assert.equal(testTargetKind('postgres://u:p@db.example.com:5432/rxnaija_test').ok, true);

    // Refused: a remote database with no test signal at all. This is the
    // staging-or-second-production case the identity check cannot catch.
    const remote = testTargetKind('postgresql://postgres.abcdefgh:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres');
    assert.equal(remote.ok, false, 'a remote production-shaped database must be refused');

    // Fails closed on junk, like databaseIdentity does.
    for (const junk of ['', 'not-a-url', undefined, null]) {
      assert.equal(testTargetKind(junk).ok, false, `${JSON.stringify(junk)} must be refused`);
    }

    // The documented second-Supabase-project route, and it must be explicit.
    process.env.RXNAIJA_ALLOW_REMOTE_TEST_DB = 'true';
    assert.equal(
      testTargetKind('postgresql://postgres.abcdefgh:pw@aws-0-eu-west-3.pooler.supabase.com:6543/postgres').ok,
      true,
      'an explicit override must still be possible, or people work around the guard',
    );
  } finally {
    if (saved === undefined) delete process.env.RXNAIJA_ALLOW_REMOTE_TEST_DB;
    else process.env.RXNAIJA_ALLOW_REMOTE_TEST_DB = saved;
  }
});
