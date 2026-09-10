/**
 * The body of every generated page that is not the home page.
 *
 * The home page is composed by the owner out of blocks. These are not: they
 * are derived entirely from the business profile, which is what lets a
 * pharmacy gain /services/blood-pressure-check/ by ticking a box rather than
 * by laying out a page.
 *
 * NOTHING HERE INVENTS A FACT ABOUT A PHARMACY. Every address, phone number,
 * opening time and service name is read from the profile, and a section whose
 * data is missing is omitted rather than filled with a plausible sentence.
 * The one thing this file does supply is generic, operational description of
 * what a common service involves — "a blood pressure check takes a few
 * minutes and is done in the pharmacy" — and that is deliberately restricted
 * to procedure, never to clinical advice, never to who should have one, and
 * never to what a result means.
 *
 * A service the pharmacy typed itself and which matches nothing in the
 * catalogue gets ONLY the pharmacy's own words. Writing generic copy about a
 * service we cannot identify would be inventing a description of a real
 * healthcare service, which is the failure mode this file exists to avoid.
 *
 * SEMANTIC AND SCRIPT-FREE. One h1, section headings in order, real <nav>,
 * <address> and <ol> for breadcrumbs. Published pages carry `script-src
 * 'none'`, so nothing here may depend on JavaScript — which is also why they
 * are fast.
 */

const { esc, waHref, telHref, mapsHref, whatsappUrl, assetsOfKind } = require('./blocks/render');
const { renderBlock } = require('./blocks');
// Drawn once, in the block that already needed them for the location cards.
const {
  groupedHours, mapEmbedSrc, PIN_ICON, PHONE_ICON, CLOCK_ICON,
} = require('./blocks/definitions/practical');
const { whatsappGlyph } = require('./blocks/icons');
const { serviceIcon } = require('./blocks/icons');
const { navPages } = require('./pages');
const { bylineFor, GENERAL_DISCLAIMER } = require('./health');

/**
 * Operational descriptions for services we can identify.
 *
 * PROCEDURE ONLY. What happens, roughly how long it takes, what to bring.
 * Nothing about symptoms, thresholds, readings, medicines or whether someone
 * should have the service — those are clinical judgements, they belong to a
 * pharmacist in person, and a website that offers them has quietly become a
 * source of medical advice.
 */
const SERVICE_COPY = {
  'prescription-refills': {
    involves: 'Bring your prescription or tell us what you usually take. We check what we have in stock, prepare it, and let you know when it is ready to collect.',
    expect: 'You can send your request on WhatsApp before you travel, so you are not waiting at the counter.',
    faqs: [
      ['Do I need to bring my old pack?', 'It helps. The pack shows exactly what you were dispensed last time, which makes it faster to confirm.'],
      ['Can I ask before I come?', 'Yes. Message us on WhatsApp and we will tell you whether we have it before you make the trip.'],
    ],
  },
  'blood-pressure-check': {
    involves: 'A cuff is placed on your upper arm and a reading is taken while you sit still. It takes a few minutes and happens in the pharmacy.',
    expect: 'You are told your reading and it can be written down for you to keep or show your doctor.',
    faqs: [
      ['How long does it take?', 'Usually only a few minutes, though you may be asked to sit quietly first.'],
      ['Do I need an appointment?', 'Message us on WhatsApp to check the best time to come in.'],
    ],
  },
  'blood-glucose-testing': {
    involves: 'A small drop of blood is taken from a fingertip and read by a meter in the pharmacy.',
    expect: 'You are given the reading and it can be recorded for you to take to your doctor.',
    faqs: [
      ['Should I eat beforehand?', 'It depends what the test is for. Ask us on WhatsApp before you come and we will tell you.'],
      ['How long does it take?', 'A few minutes.'],
    ],
  },
  'medication-counselling': {
    involves: 'A pharmacist goes through your medicines with you: what each one is for, how and when to take it, and what to do about anything you are unsure of.',
    expect: 'A conversation rather than a transaction. Bring your medicines or a list of them.',
    faqs: [
      ['What should I bring?', 'Whatever you are currently taking, including anything bought without a prescription.'],
      ['Is it private?', 'Ask when you arrive and we will find a suitable place to talk.'],
    ],
  },
  'health-screening': {
    involves: 'A set of routine checks carried out in the pharmacy. Which checks are included depends on what we offer — ask us before you come.',
    expect: 'Your results are explained and written down for you.',
    faqs: [
      ['What is included?', 'Message us on WhatsApp and we will tell you exactly what we can check.'],
    ],
  },
};

/** A day-of-week ordering for opening hours, so output is stable. */
const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

/** "12 Allen Avenue, Ikeja, Lagos" — omitting whatever is not set. */
function addressLine(profile) {
  return [profile?.address_line, profile?.city, profile?.state]
    .filter(Boolean).join(', ');
}

function areaOf(profile) {
  return [profile?.city, profile?.state].filter(Boolean).join(', ');
}

/**
 * Colours the pharmacy's own name gold where a generated page's heading
 * happens to END WITH it ("About {name}", "Contact {name}") — a suffix
 * match, not an always-append the way the homepage hero's showcase layout
 * does it. These headings are computed per page kind (some end with the
 * name, some do not — "Find us in {area}" never does) and an owner can
 * override any of them with their own text that may not either, so this has
 * to degrade gracefully: no match, no highlight, the heading renders exactly
 * as it already did.
 */
function highlightTrailingFact(heading, facts) {
  const text = String(heading ?? '');
  for (const fact of facts) {
    if (!fact) continue;
    const idx = text.length - fact.length;
    if (idx < 0 || text.slice(idx) !== fact) continue;
    return `${esc(text.slice(0, idx))}<span class="rx-name-accent">${esc(fact)}</span>`;
  }
  return esc(text);
}

/**
 * The small badge over a generated page's heading, on Metro.
 *
 * Per page kind, because one line cannot be right on all of them — the
 * reference's own About and Services pages carry different ones. Generic
 * phrasing on purpose: none of these asserts anything a pharmacy would have
 * to be able to back up, which is what lets them be written here at all
 * rather than asked for. An unlisted kind falls back to the page's own name
 * in the navigation, which is always accurate.
 */
const METRO_PAGE_BADGE = Object.freeze({
  about: 'Your Community Pharmacy',
  services: 'Comprehensive Care',
  service: 'Comprehensive Care',
  location: 'Come And See Us',
  contact: "We're Here for You",
  healthIndex: 'Health Information',
});

/**
 * Metro's own wording for a generated page's <h1>, where the reference's is
 * warmer than the derived one.
 *
 * THE VISIBLE HEADING ONLY. The page's <title>, its meta description and its
 * breadcrumb still read "Contact {name}" — those are read in a search result,
 * where the plain form is the one somebody actually typed, and a heading
 * written for the page is the wrong string to put there.
 *
 * Each of these still ENDS with the pharmacy's own name, so the accent below
 * lands on a fact rather than on whichever words looked important. An owner's
 * own heading override still wins over all of it.
 */
const METRO_PAGE_HEADING = Object.freeze({
  contact: (name) => `Get in Touch with ${name}`,
});

/**
 * The page kinds whose Metro head carries a call to action.
 *
 * Not every page: the head is a place to act on a page that is ASKING for
 * something (here is what we do — talk to us), and noise at the top of one
 * that is answering a question. Each of these pages already ends with the
 * same call; repeating it above the fold is the point of a landing page,
 * not an accident.
 */
const METRO_HEAD_CTA = new Set(['services']);

/**
 * The site header — THE SAME BLOCK THE HOME PAGE USES, not a copy of it.
 *
 * This file used to build its own: a brand link and a <nav>, and nothing
 * else. That was survivable while the two happened to look alike and stopped
 * being survivable the moment the header grew a mobile disclosure — the home
 * page had a menu on a phone and every generated page had NO NAVIGATION AT
 * ALL below 768px, because the nav it emitted is the one the stylesheet
 * hides at that width. Nothing failed; the pages simply became unreachable
 * from each other on the device most customers use.
 *
 * Delegating removes the class of bug rather than that instance of it. The
 * header and footer are defined once, in the block registry, and every page
 * on the site is chrome-identical by construction.
 */
function header(ctx, pages, currentPath) {
  return renderBlock({ type: 'pharmacy.header', version: 1, props: {} }, {
    ...ctx,
    // The block falls back to the site's real pages when the owner has set
    // no navigation of their own; sitePages is how it learns them.
    sitePages: ctx.sitePages || navPages(pages),
    currentPath,
  });
}

/** Phone and WhatsApp buttons, only for the numbers the pharmacy actually has. */
function ctaRow(ctx, message) {
  const wa = ctx.profile?.whatsapp_phone || ctx.pharmacy?.public_whatsapp_number;
  const parts = [];
  if (wa) {
    parts.push(`<a class="rx-btn rx-btn-wa" href="${esc(waHref(wa, message, ctx))}">Message us on WhatsApp</a>`);
  }
  if (ctx.profile?.phone) {
    parts.push(`<a class="rx-btn rx-btn-outline" href="${esc(telHref(ctx.profile.phone, ctx))}">Call ${esc(ctx.profile.phone)}</a>`);
  }
  // WRAPPED IN A SECTION, and that is a fix rather than a flourish. This
  // returned a bare <div> that every caller pushed straight into the page's
  // top level, so it inherited neither the shell's max-width nor the gutter:
  // the "Call …" button rendered flush against the left edge of the viewport,
  // clipped, below content that was correctly inset. Every generated page had
  // it, on the one control the page exists to be tapped.
  return parts.length
    ? `<section class="rx-block rx-narrow"><div class="rx-cta-row">${parts.join('')}</div></section>`
    : '';
}

/**
 * Address and opening hours, side by side.
 *
 * They are the two halves of one question — where is it, and when can I go —
 * and somebody deciding whether to set off now needs both in one glance.
 * Stacked, they were a full section apart with nothing between them, and on a
 * desktop each occupied a 44rem column with the other half of the page empty.
 * Falls back to whichever one exists: a pharmacy with no hours set still gets
 * a sensible single column rather than an empty box beside its address.
 */
function visitSplit(ctx, profile, { addressHeading = 'Where to find us', hoursHeading = 'Opening hours' } = {}) {
  const address = addressSection(ctx, addressHeading, { wrap: false });
  const hours = hoursSection(profile, hoursHeading, { wrap: false });
  if (!address && !hours) return '';
  if (!address || !hours) {
    return `<section class="rx-block rx-narrow">${address || hours}</section>`;
  }
  return `<section class="rx-block"><div class="rx-split">`
    + `<div>${address}</div><div>${hours}</div></div></section>`;
}

/**
 * A row of cross-links as chips.
 *
 * Replaces a bare <ul> of underlined links. A bulleted list of blue links at
 * the foot of a page reads as a directory index rather than as part of a
 * designed page, and these lists are short — four services, three articles.
 * Chips give them a shape and a tap target without pretending each one is a
 * card with something to say.
 */
function chipList(heading, items) {
  if (!items?.length) return '';
  const chips = items.map((i) =>
    `<a class="rx-chip" href="${esc(i.path)}">${esc(i.label || i.nav)}</a>`).join('');
  return `<section class="rx-block rx-narrow"><h2>${esc(heading)}</h2>`
    + `<div class="rx-chips">${chips}</div></section>`;
}

/** Opening hours as a description list. Omitted entirely when unset. */
/**
 * `wrap:false` returns the contents WITHOUT the surrounding section, so the
 * same builder can be dropped into a layout — the location page puts the
 * address and the hours in one two-column split, and a nested <section
 * class="rx-block"> inside another would bring its own page padding and
 * shell width with it.
 */
function hoursSection(profile, heading = 'Opening hours', { wrap = true } = {}) {
  const hours = Array.isArray(profile?.opening_hours) ? profile.opening_hours : [];
  if (!hours.length) return '';
  const byDay = new Map(hours.map((h) => [h.day, h]));
  const rows = DAYS.map(([key, label]) => {
    const h = byDay.get(key);
    if (!h) return '';
    const when = h.closed ? 'Closed' : `${esc(h.open)} – ${esc(h.close)}`;
    return `<div class="rx-hours-row"><span>${label}</span><span>${when}</span></div>`;
  }).filter(Boolean).join('');
  if (!rows) return '';
  const inner = `<div class="rx-panel"><h2>${esc(heading)}</h2><div class="rx-hours">${rows}</div></div>`;
  return wrap ? `<section class="rx-block rx-narrow">${inner}</section>` : inner;
}

/** Address block with a maps link when one is set. */
function addressSection(ctx, heading = 'Where to find us', { wrap = true } = {}) {
  const line = addressLine(ctx.profile);
  if (!line) return '';
  const map = ctx.profile?.maps_url
    ? `<p><a class="rx-btn rx-btn-outline" href="${esc(mapsHref(ctx.profile.maps_url, ctx))}">Open in Google Maps</a></p>`
    : '';
  const landmark = ctx.profile?.landmark
    ? `<p class="rx-landmark">${esc(ctx.profile.landmark)}</p>` : '';
  const inner = `<div class="rx-panel"><h2>${esc(heading)}</h2>`
    + `<address class="rx-address">${esc(line)}</address>${landmark}${map}</div>`;
  return wrap ? `<section class="rx-block rx-narrow">${inner}</section>` : inner;
}

/** FAQ list. Plain headings and paragraphs — no JavaScript accordions. */
function faqSection(faqs) {
  if (!faqs?.length) return '';
  // Each question is its own bounded panel rather than a run of h3/p down the
  // page — a reader scanning for one answer needs to see where each begins
  // and ends. Still plain headings and paragraphs underneath: no accordion,
  // because an accordion needs JavaScript this page will never have, and a
  // hidden answer is one a search engine may not credit either.
  const items = faqs.map(([q, a]) => `<div class="rx-panel"><h3>${esc(q)}</h3><p>${esc(a)}</p></div>`).join('');
  return `<section class="rx-block rx-narrow"><h2>Common questions</h2>`
    + `<div class="rx-panels">${items}</div></section>`;
}

/**
 * Cards linking to real crawlable URLs. Used by /services/ and /health/.
 *
 * ACTUAL CARDS, not ruled rows. The home page lists services as hairline rows
 * because they sit inside a longer page and a wall of boxes there would be
 * noise; an index page is nothing BUT the list, so the list has to carry the
 * page. Each card takes the same drawn mark the home page uses, so a service
 * looks like itself in both places.
 *
 * `withIcon` is off for health articles — they are not services and the
 * service icon set says nothing true about them.
 */
function cardGrid(items, { withIcon = true } = {}) {
  const cards = items.map((item) => {
    const label = item.label || item.nav;
    const mark = withIcon
      ? `<span class="rx-card-mark">${serviceIcon(item.name || label)}</span>`
      : '';
    const desc = item.description ? `<p>${esc(item.description)}</p>` : '';
    return `<a class="rx-card" href="${esc(item.path)}">${mark}`
      + `<span class="rx-card-body"><span class="rx-card-title">${esc(label)}</span>${desc}</span>`
      + `<span class="rx-card-go" aria-hidden="true">→</span></a>`;
  }).join('');
  return `<section class="rx-block"><div class="rx-cards">${cards}</div></section>`;
}

/**
 * The words under a card's heading: the service's own, with the meta lead-in
 * taken off the front.
 *
 * pages.js builds each service page's description to be read in a search
 * result — "Vaccinations at Ikeja Family Pharmacy in Ikeja, Lagos. <whatever
 * the owner wrote>". That is right in a <meta> tag and a stutter under a
 * heading that already says "Vaccinations". Only that one exact, known
 * lead-in is removed; what is left is the owner's own sentence, or the
 * catalogue summary, never a rewrite of either. A service with nothing but
 * the lead-in gets no paragraph at all rather than an invented one.
 */
function serviceBlurb(item, name, area) {
  const label = item.label || item.nav;
  const lead = `${label} at ${name}${area ? ` in ${area}` : ''}.`;
  const text = String(item.description || '').trim();
  return (text.startsWith(lead) ? text.slice(lead.length) : text).trim();
}

/**
 * The same services, as centred cards under a soft blob mark — Metro's
 * Services page only.
 *
 * SAME LINKS, SAME FACTS, SAME ICON MATCHER as cardGrid above: each card
 * still goes to that service's own page, still shows only the name and
 * description already on the profile, and still takes its mark from
 * serviceIcon(), so a service looks like itself here and in the home page's
 * grid. Only the arrangement differs.
 *
 * The heading deliberately does NOT repeat the page's own <h1>. The
 * reference says "Pharmacy Services" here, directly under a hero that also
 * says services — which reads as a stutter on a page whose h1 is already
 * "Pharmacy services in {area}".
 */
function metroServiceCards(items, name, area) {
  const cards = items.map((item, i) => {
    const label = item.label || item.nav;
    const blurb = serviceBlurb(item, name, area);
    const desc = blurb ? `<p>${esc(blurb)}</p>` : '';
    // Alternating tone is rhythm, not meaning — the same as the homepage
    // tiles. Nothing about a service decides which colour it gets.
    const tone = i % 2 === 0 ? 'rx-svc-blob--a' : 'rx-svc-blob--b';
    return `<li><a class="rx-svc-card" href="${esc(item.path)}">`
      + `<span class="rx-svc-blob ${tone}">${serviceIcon(item.name || label)}</span>`
      + `<h3>${esc(label)}</h3>${desc}</a></li>`;
  }).join('');

  return '<section class="rx-block">'
    + '<div class="rx-head rx-head--center"><span class="rx-eyebrow rx-eyebrow--pill">What We Offer</span>'
    + '<h2>How We Can Help</h2></div>'
    + `<ul class="rx-svc-cards">${cards}</ul></section>`;
}

/**
 * The four ways to reach the pharmacy, as cards — Metro's contact page only.
 *
 * ONE CARD PER THING THE PHARMACY ACTUALLY HAS. Each is dropped whole when
 * the fact behind it is not on file, so a pharmacy with no address published
 * gets three cards rather than a card with a heading over a blank.
 *
 * The reference has an Email card. This does not, because pharmacy_profile
 * has no email column — see the pharmacy.contact block's own note on the same
 * point. A card headed "Email us" above nothing, or above an address someone
 * guessed, is worse than one card fewer. When that column exists this gains
 * a fifth card and no other change.
 *
 * The reference's Phone card also carries a fax number, for the same reason
 * it is missing here.
 *
 * The closed days come from the owner's own opening hours and are never
 * inferred: a day they have not filled in is simply absent, not asserted to
 * be a day they are shut.
 */
function metroContactCards(ctx, p) {
  const tel = telHref(p.phone, ctx);
  const wa = waHref(ctx.pharmacy?.public_whatsapp_number, null, ctx);
  const address = addressLine(p);
  const hours = groupedHours(p?.opening_hours || []);

  const card = (icon, heading, body, action) =>
    ({ icon, heading, body, action: action || '' });

  const link = (href, label, external) => `<a class="rx-contact-go" href="${esc(href)}"${
    external ? ' rel="noopener noreferrer" target="_blank"' : ''}>${esc(label)}</a>`;

  const cards = [
    address ? card(PIN_ICON, 'Visit Us', `<address class="rx-contact-lines">${esc(address)}</address>`,
      p?.maps_url ? link(mapsHref(p.maps_url, ctx), 'Get Directions') : '') : null,
    tel ? card(PHONE_ICON, 'Call Us', `<p class="rx-contact-lines">${esc(p.phone)}</p>`,
      link(tel, 'Call Now')) : null,
    wa ? card(whatsappGlyph({ size: 20 }), 'Message Us',
      '<p class="rx-contact-lines">Send us a message and we will reply here.</p>',
      link(wa, 'Open WhatsApp', true)) : null,
    hours.length ? card(CLOCK_ICON, 'Opening Hours', `<ul class="rx-contact-lines rx-contact-hours">${
      hours.map((r) => `<li${r.value === 'Closed' ? ' class="rx-closed"' : ''}>`
        + `<span>${esc(r.label)}:</span> <span>${esc(r.value)}</span></li>`).join('')
    }</ul>`) : null,
  ].filter(Boolean);

  if (!cards.length) return '';

  // Alternating top rules, the same rhythm the service cards use: position in
  // the row, never anything about the card's own contents.
  const items = cards.map((c, i) => `<li class="rx-contact-card rx-contact-card--${i % 2 === 0 ? 'a' : 'b'}">`
    + `<span class="rx-contact-mark">${c.icon}</span>`
    + `<h2>${esc(c.heading)}</h2>${c.body}${c.action}</li>`).join('');

  return `<section class="rx-block"><ul class="rx-contact-cards">${items}</ul></section>`;
}

/**
 * A message box beside the map — the last section of Metro's contact page.
 *
 * THE FORM IS A GET TO wa.me, AND THAT IS THE ENTIRE MECHANISM. Its one
 * field is named "text", which is the parameter wa.me already takes, so
 * submitting it opens WhatsApp addressed to the pharmacy with the visitor's
 * words typed in. No script, no endpoint of ours, nothing stored anywhere,
 * and no new place for a stranger's data to sit — the message goes to the
 * number the pharmacy already answers, which is the whole product.
 *
 * That is why there is no Name, Phone or Email field, which the reference
 * has: WhatsApp already carries who is writing, and a form can only pass ONE
 * value as "text" without script to join them. Fields that go nowhere are
 * worse than fields that are not there. There are no Privacy Policy or Terms
 * links under it either, for the reason the footer has none.
 *
 * The heading only offers to be visited when there is somewhere to visit.
 */
function metroReachSection(ctx, p, area) {
  const action = whatsappUrl(ctx.pharmacy?.public_whatsapp_number);
  const mapSrc = mapEmbedSrc(p);
  if (!action && !mapSrc) return '';

  const form = action
    ? '<form class="rx-reach-form" method="get" target="_blank" rel="noopener noreferrer" '
      + `action="${esc(action)}">`
      + '<label class="rx-reach-label" for="rx-reach-text">Write your message</label>'
      + '<textarea id="rx-reach-text" name="text" rows="7" '
      + 'placeholder="Hello, I would like to ask about&#8230;"></textarea>'
      + '<button class="rx-btn rx-btn-wa" type="submit">Send on WhatsApp</button>'
      + '<p class="rx-reach-note">This opens WhatsApp with your message ready to send. '
      + 'Nothing is saved on this page.</p>'
      + '</form>'
    : '';

  const map = mapSrc
    ? `<div class="rx-reach-map"><iframe src="${esc(mapSrc)}" loading="lazy" `
      + 'referrerpolicy="no-referrer-when-downgrade" title="Map"></iframe></div>'
    : '';

  const heading = map ? 'Send Us a Message or Visit Us' : 'Send Us a Message';
  const sub = map && area
    ? `Message us on WhatsApp, or come and find us in ${area}.`
    : 'Message us on WhatsApp and we will reply there.';

  return '<section class="rx-block rx-reach-band">'
    + '<div class="rx-head rx-head--center"><span class="rx-eyebrow rx-eyebrow--pill">Get In Touch</span>'
    + `<h2>${esc(heading)}</h2><p>${esc(sub)}</p></div>`
    + `<div class="rx-reach">${form}${map}</div></section>`;
}

/**
 * The owner's OWN FAQ, exactly as it renders on their home page.
 *
 * Rendered by the block itself rather than re-implemented here, so the two
 * cannot drift apart and so every rule the block already enforces still
 * holds — most importantly that nothing renders at all until the owner has
 * written real questions and real answers. A seeded "Do you accept
 * insurance?" answered "Yes" would be this website inventing a policy on a
 * real pharmacy's behalf, which is the one thing it must never do.
 */
function ownerFaqSection(ctx) {
  if (!ctx.siteFaq) return '';
  return renderBlock({ type: 'pharmacy.faq', version: 1, props: ctx.siteFaq }, ctx);
}

/**
 * The footer — the same block the home page uses, for the reason in header().
 *
 * The hand-built one here emitted its children straight into the section, so
 * it never got the shell's max-width and sat flush against the viewport edge
 * on a wide screen while every other section was centred. One footer, one
 * alignment.
 */
function footer(ctx, year, pages) {
  // The owner's own footer props where the site has them, so this footer is
  // byte-identical to the home page's. With none — an editor preview, a test
  // fixture — the block's own defaults and `from` bindings still fill it in,
  // exactly as they did when this passed {} unconditionally.
  return renderBlock({ type: 'pharmacy.footer', version: 1, props: ctx.footerProps || {} }, {
    ...ctx,
    sitePages: ctx.sitePages || navPages(pages || []),
    year: year ?? ctx.year,
  });
}

/**
 * Photographs of the pharmacy.
 *
 * A real photograph of the shop is the strongest trust signal a small local
 * business can put on a page, and it is what a stranger deciding whether to
 * walk in actually looks at.
 *
 * ALT TEXT IS GENERATED, NOT INVENTED. We know these are photographs of this
 * pharmacy in this place, so that is exactly what the alt says. It does not
 * claim to know what is IN the picture — "our clean, modern dispensary" would
 * be a description of an image nobody here has seen, written by software, on
 * a real business's website. Letting the owner describe each photo would be
 * better still, and is why this is a comment rather than a cleverer sentence.
 *
 * width and height are emitted whenever known, so the browser reserves the
 * space before the bytes arrive. Without them the text jumps as each photo
 * loads, which is measured directly as Cumulative Layout Shift.
 *
 * Everything after the first photo is lazy. It is below the fold on a phone,
 * and loading it eagerly spends a Nigerian customer's data on something they
 * may never scroll to.
 */
function photoSection(ctx, { kinds = ['gallery'], limit = 6, heading = null, eager = false } = {}) {
  const seen = new Set();
  const photos = [];
  for (const kind of kinds) {
    for (const photo of assetsOfKind(ctx, kind)) {
      if (seen.has(photo.id) || photos.length >= limit) continue;
      seen.add(photo.id);
      photos.push(photo);
    }
  }
  if (!photos.length) return '';

  const name = ctx.pharmacy?.name || 'Pharmacy';
  const area = areaOf(ctx.profile);
  const alt = area ? `${name}, ${area}` : name;

  const imgs = photos.map((photo, i) => {
    const dims = photo.width && photo.height
      ? ` width="${photo.width}" height="${photo.height}"`
      : '';
    const loading = i === 0 && eager ? 'eager' : 'lazy';
    return `<img class="rx-photo" src="${esc(photo.url)}" alt="${esc(alt)}"${dims}`
      + ` loading="${loading}" decoding="async">`;
  }).join('');

  return '<section class="rx-block">'
    // NOT .rx-narrow. That class is `max-width:44rem; margin-inline:auto`,
    // which CENTRES whatever carries it — so this heading sat ~140px inboard
    // of the h1 above it and the photographs below it, and the page looked
    // like it had been assembled by two different people. .rx-narrow belongs
    // on a section, where the surrounding rule left-aligns its children; on a
    // bare heading it just centres it.
    + (heading ? `<h2>${esc(heading)}</h2>` : '')
    + `<div class="rx-photo-grid">${imgs}</div></section>`;
}

/** A plain check mark for the story chips — decorative, claims nothing itself. */
const CHECK_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
/** A target and a rising arrow — decorative marks for mission and vision. */
const TARGET_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>';
const RISE_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/></svg>';

/**
 * "Our mission" and "Our vision", side by side.
 *
 * ENTIRELY THE OWNER'S OWN WORDS, and nothing at all without them. A mission
 * statement is the one thing on a pharmacy's website that cannot be written
 * for them even generically: it is a claim about what THIS business is for.
 * So there is no default, no seeded example and no AI-written text reaching
 * the page unread — these come from content.pageCopy['/about/'], the same
 * channel the About page's heading and intro already use, written in the
 * dashboard and saved deliberately.
 *
 * One card or two: a pharmacy that has written only a mission gets a mission
 * card and no empty second column.
 */
function missionVisionSection(copy, metro) {
  const cards = [
    { key: 'mission', title: 'Our Mission', icon: TARGET_SVG, text: copy?.mission },
    { key: 'vision', title: 'Our Vision', icon: RISE_SVG, text: copy?.vision },
  ].filter((c) => c.text);
  if (!cards.length) return '';

  const items = cards.map((c) => `<div class="rx-mv-card rx-mv-card--${c.key}">`
    + `<span class="rx-mv-mark">${c.icon}</span>`
    + `<h2>${esc(c.title)}</h2><p>${esc(c.text)}</p></div>`).join('');

  return `<section class="rx-block${metro ? ' rx-mv--metro' : ''}">`
    + `<div class="rx-mv-grid">${items}</div></section>`;
}

/**
 * "Why choose us" — the pharmacy's own reasons, beside a standing offer to
 * answer questions.
 *
 * THE REASONS ARE THE OWNER'S, and there are none by default: "minimal wait
 * times" and "free delivery" are promises about how one specific pharmacy
 * runs, so the whole band stays off the page until somebody has written at
 * least one (see the `whyUs` prop in blocks/definitions/content.js).
 *
 * The card beside them is the exception, and only because it claims nothing
 * about this pharmacy that is not already true and already on the page: it
 * offers the same WhatsApp (or phone) route every other section here offers,
 * and renders at all only when there is a real number behind it.
 *
 * Each reason's mark comes from serviceIcon(), the same name-to-icon
 * matcher the services grid uses, so "Free Delivery" draws the delivery
 * mark without the owner choosing an icon — and an unrecognised phrase
 * simply gets the general one rather than a wrong one.
 */
function whyChooseSection(ctx, name, whyUs, metro) {
  const items = (Array.isArray(whyUs) ? whyUs : []).filter((w) => w?.title);
  if (!items.length) return '';

  const wa = waHref(ctx?.pharmacy?.public_whatsapp_number, `Hello ${name}, I have a question`, ctx);
  const tel = wa ? '' : telHref(ctx?.profile?.phone, ctx);
  const action = wa
    ? `<a class="rx-btn rx-btn-solid" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">Message us on WhatsApp</a>`
    : (tel ? `<a class="rx-btn rx-btn-solid" href="${esc(tel)}">Call ${esc(ctx.profile.phone)}</a>` : '');

  const list = items.map((w) => `<div class="rx-why-item">`
    + `<span class="rx-why-mark">${serviceIcon(w.title)}</span>`
    + `<div><h3>${esc(w.title)}</h3>${w.text ? `<p>${esc(w.text)}</p>` : ''}</div>`
    + `</div>`).join('');

  const aside = action
    ? '<aside class="rx-why-card"><h3>Have Questions?</h3>'
      + '<p>Our pharmacists are ready to help you.</p>'
      + `${action}</aside>`
    : '';

  return `<section class="rx-block rx-why${metro ? ' rx-why--metro' : ''}">`
    + `<div class="rx-why-grid"><div><h2>Why Choose ${esc(name)}?</h2>`
    + `<div class="rx-why-items">${list}</div></div>${aside}</div></section>`;
}

/**
 * "Our story" — the pharmacy's own words beside its own photograph.
 *
 * REPLACES the description panel and the photo grid on Metro's About page
 * rather than adding to them: the same two facts (the owner's description,
 * the owner's leading photo) laid out as one section instead of two stacked
 * ones. Nothing extra is asked of the pharmacy and nothing is invented —
 * with neither a description nor a photo on file there is no section at all.
 *
 * THE TRUST CHIPS ARE THE OWNER'S OWN, TYPED ONCE. They are the same
 * `highlights` list from the homepage's About block (see
 * blocks/definitions/content.js, which seeds none of them for exactly this
 * reason — "Bilingual Staff" is a claim about one specific pharmacy). They
 * arrive already extracted, so this file still receives only derived facts
 * and never the whole site_data.
 *
 * The heading names the pharmacy's real area and nothing else; "with Pride"
 * is generic sentiment, the same bar as the page's own lede, not a claim
 * about awards, years or standing. With no area on file it says "our
 * community" rather than guessing one.
 */
function storySection(ctx, profile, area, highlights) {
  const paragraphs = String(profile?.description ?? '')
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);
  const [photo] = [...assetsOfKind(ctx, 'hero'), ...assetsOfKind(ctx, 'gallery')];
  if (!paragraphs.length && !photo) return '';

  const name = ctx?.pharmacy?.name || 'The pharmacy';
  const alt = area ? `${name}, ${area}` : name;
  const dims = photo?.width && photo?.height ? ` width="${photo.width}" height="${photo.height}"` : '';
  const media = photo
    ? '<div class="rx-story-media"><div class="rx-story-frame">'
      + `<img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="eager" fetchpriority="high" decoding="async">`
      + '</div></div>'
    : '';

  // Alternating tone is rhythm, not meaning — the colour says nothing about
  // which point matters more, the same way the services tiles alternate.
  const chips = (Array.isArray(highlights) ? highlights : [])
    .map((h) => h?.text)
    .filter(Boolean)
    .map((text, i) => `<span class="rx-story-chip ${i % 2 === 0 ? 'rx-story-chip--a' : 'rx-story-chip--b'}">`
      + `${CHECK_SVG}${esc(text)}</span>`)
    .join('');

  const copy = '<div class="rx-story-copy">'
    + '<span class="rx-eyebrow rx-eyebrow--pill">Our Story</span>'
    + `<h2>Serving ${esc(area || 'our community')} with <span class="rx-heading-accent">Pride</span></h2>`
    + paragraphs.map((t) => `<p>${esc(t)}</p>`).join('')
    + (chips ? `<div class="rx-story-chips">${chips}</div>` : '')
    + '</div>';

  return `<section class="rx-block"><div class="rx-story-grid">${media}${copy}</div></section>`;
}

/**
 * Author and reviewer, or nothing at all.
 *
 * A missing byline renders as an absence. There is no "reviewed by our team"
 * fallback, because a vague attribution is still an attribution and a reader
 * cannot tell it from a real one.
 */
function bylineSection(article) {
  const by = bylineFor(article);
  const bits = [];
  if (by?.author) bits.push(`<p>Written by ${esc(by.author)}</p>`);
  if (by?.reviewer) {
    const when = by.reviewedAt ? ` on ${esc(by.reviewedAt)}` : '';
    bits.push(`<p>Medically reviewed by ${esc(by.reviewer)}${when}</p>`);
  }
  if (article?.updatedAt) bits.push(`<p>Last updated ${esc(article.updatedAt)}</p>`);
  if (!bits.length) return '';
  return `<section class="rx-block rx-narrow rx-byline">${bits.join('')}</section>`;
}

/**
 * The "when to seek care" block.
 *
 * Rendered as its own section on every article, and never merged into the
 * prose above it. The single most useful thing a health page can do for
 * somebody who is worried is tell them plainly when to stop reading a website.
 */
function seekCareSection(seekCare) {
  if (!seekCare?.items?.length) return '';
  const items = seekCare.items.map((i) => `<li>${esc(i)}</li>`).join('');
  return `<section class="rx-block rx-narrow rx-seek-care">`
    + `<h2>${esc(seekCare.heading || 'When to seek care')}</h2>`
    + (seekCare.intro ? `<p>${esc(seekCare.intro)}</p>` : '')
    + `<ul>${items}</ul>`
    + (seekCare.closing ? `<p>${esc(seekCare.closing)}</p>` : '')
    + `</section>`;
}

/**
 * Related services and related articles.
 *
 * Contextual rather than a link farm: an article about blood pressure links to
 * the blood pressure check this pharmacy actually offers, and only if it
 * offers it. A link to a service page that does not exist would be a broken
 * link generated on purpose.
 */
function relatedSection(article, allPages) {
  const byPath = new Map(allPages.map((x) => [x.path, x]));
  const services = (article.relatedServices || [])
    .map((slug) => byPath.get(`/services/${slug}/`))
    .filter(Boolean);
  const articles = (article.relatedArticles || [])
    .map((slug) => byPath.get(`/health/${slug}/`))
    .filter(Boolean);

  const blocks = [];
  if (services.length) {
    blocks.push(`<h2>How this pharmacy can help</h2><ul>`
      + services.map((s) => `<li><a href="${esc(s.path)}">${esc(s.label)}</a></li>`).join('')
      + `</ul>`);
  }
  if (articles.length) {
    blocks.push(`<h2>Related reading</h2><ul>`
      + articles.map((a) => `<li><a href="${esc(a.path)}">${esc(a.nav)}</a></li>`).join('')
      + `</ul>`);
  }
  if (!blocks.length) return '';
  return `<section class="rx-block rx-narrow"><div class="rx-panel">${blocks.join('')}</div></section>`;
}

/**
 * The body for one generated page.
 *
 * @param {object} page   the page from pages.js
 * @param {object[]} allPages  every page, for navigation and breadcrumbs
 * @param {object} ctx    { pharmacy, profile, ... } as blocks/render expects
 */
function renderPageBody(page, allPages, ctx, { year } = {}) {
  const p = ctx.profile || {};
  const area = areaOf(p);
  const name = ctx.pharmacy?.name || 'our pharmacy';
  const parts = [header(ctx, allPages, page.path)];

  /**
   * The owner's own wording for THIS page, or nothing.
   *
   * NOT for 'health' pages, even though ctx.pageCopy is keyed by path and
   * nothing here would stop it matching one — checked explicitly rather than
   * left to whatever the caller happens to send. A health article's heading
   * and intro are reviewed clinical copy (see health.js), and a generic
   * rewrite channel meant for "What we can help with at our pharmacy in
   * Ikeja" must not become a second way to edit that.
   */
  const override = page.kind === 'health' ? {} : (ctx.pageCopy?.[page.path] || {});

  /**
   * The page head.
   *
   * Left-aligned inside the SAME shell every other section uses, rather than
   * centred in its own 44rem column. Mixed alignment down one page is the
   * thing that reads as "unstructured" — the eye keeps re-finding the left
   * edge. The measure is applied to the lede alone, which is the only part
   * that needs one.
   *
   * `intro` is the GENERATED default; override.heading/override.intro, when
   * the owner has written either, win. Falling back per-field rather than
   * all-or-nothing means writing a custom intro does not require also
   * retyping the heading.
   */
  /**
   * The single button in a Metro page head.
   *
   * The SAME number ctaRow resolves, in the same order, so the button at the
   * top of a page and the one at the bottom can never lead somewhere
   * different. Labelled for what it actually does — the reference says
   * "Schedule a Visit", which would promise an appointment system no
   * pharmacy here has. Nothing at all when there is no number to reach.
   */
  const headCta = () => {
    const wa = p.whatsapp_phone || ctx.pharmacy?.public_whatsapp_number;
    if (wa) {
      return `<div class="rx-cta-row"><a class="rx-btn rx-btn-wa" href="${esc(waHref(wa, `Hello ${name}`, ctx))}">`
        + 'Message us on WhatsApp</a></div>';
    }
    if (p.phone) {
      return `<div class="rx-cta-row"><a class="rx-btn rx-btn-wa" href="${esc(telHref(p.phone, ctx))}">`
        + `Call ${esc(p.phone)}</a></div>`;
    }
    return '';
  };

  const open = (intro) => {
    const metroHeading = ctx.templateId === 'metro'
      ? METRO_PAGE_HEADING[page.kind]?.(name)
      : null;
    const heading = override.heading || metroHeading || page.h1;
    const lede = override.intro || intro;

    // METRO'S OWN PAGE-HEAD: a coloured band instead of the plain default —
    // see the block-level version of this same idea in blocks/definitions
    // for the homepage hero/services. Every other template's generated pages
    // are completely unaffected: ctx.templateId is only ever 'metro' for a
    // pharmacy that actually chose this template.
    if (ctx.templateId === 'metro') {
      const badge = METRO_PAGE_BADGE[page.kind] || page.nav || name;
      // The pharmacy's own NAME or its own AREA, whichever the generated
      // heading happens to end with — "About {name}", "Find us in {area}".
      // Both are facts already on the profile, so the highlight lands on
      // something true rather than on whichever words looked important.
      // A heading that ends with neither (an owner's own override, most
      // often) renders plainly, exactly as it would have anyway.
      const headingHtml = highlightTrailingFact(heading, [ctx?.pharmacy?.name, area]);
      const cta = METRO_HEAD_CTA.has(page.kind) ? headCta() : '';
      parts.push(`<section class="rx-block rx-page-head rx-page-head--metro"><div>`
        + `<span class="rx-eyebrow rx-eyebrow--outline">${esc(badge)}</span>`
        + `<h1>${headingHtml}</h1>`
        + (lede ? `<p class="rx-lede">${esc(lede)}</p>` : '')
        + cta
        + `</div></section>`);
      return;
    }

    parts.push(`<section class="rx-block rx-page-head"><div>`
      + `<span class="rx-eyebrow">${esc(page.nav || name)}</span>`
      + `<h1>${esc(heading)}</h1>`
      + (lede ? `<p class="rx-lede">${esc(lede)}</p>` : '')
      + `</div></section>`);
  };

  if (page.kind === 'about') {
    // Metro's About page carries a real subheading even with no pageCopy
    // override — every other template's About page still opens with NO
    // lede at all, exactly as before this existed. The line itself is
    // generic aspiration, not a claim about this specific pharmacy (no
    // hours, no certifications, no headcount) — the same bar every other
    // piece of seeded copy in this file already holds to — and the area
    // clause is dropped entirely rather than guessed when none is on file.
    const metroIntro = ctx.templateId === 'metro'
      ? (area
        ? `More than just a pharmacy — we are here for the ${area} community, built on trust and care.`
        : 'More than just a pharmacy — built on trust and care.')
      : null;
    open(metroIntro);
    if (ctx.templateId === 'metro') {
      // ONE section instead of two: storySection() carries the description
      // AND the leading photograph, so pushing the panel and the grid as
      // well would print the same words and the same picture twice.
      parts.push(storySection(ctx, p, area, ctx.aboutHighlights));
    } else {
      parts.push(`<section class="rx-block rx-narrow"><div class="rx-panel"><p>${esc(String(p.description).replace(/\s+/g, ' ').trim())}</p></div></section>`);
      // Eager on the first one: on an About page the photograph is the point,
      // it is above the fold, and lazy-loading the thing a visitor came to look
      // at makes the page feel slower than it is.
      parts.push(photoSection(ctx, { kinds: ['hero', 'gallery'], limit: 4, eager: true }));
    }
    // Below the story, on every template — the cards render only once the
    // owner has actually written a mission or a vision, so no template
    // gains a section it did not have until someone types something.
    parts.push(missionVisionSection(override, ctx.templateId === 'metro'));
    parts.push(whyChooseSection(ctx, name, ctx.aboutWhyUs, ctx.templateId === 'metro'));
    parts.push(visitSplit(ctx, p));
    parts.push(ctaRow(ctx, `Hello ${name}`));
  } else if (page.kind === 'services') {
    open(area ? `What we can help with at our pharmacy in ${area}.` : 'What we can help with.');
    const services = allPages.filter((x) => x.kind === 'service');
    parts.push(ctx.templateId === 'metro' ? metroServiceCards(services, name, area) : cardGrid(services));
    // Metro's reference puts the pharmacy's own FAQ on this page, under the
    // services — someone deciding whether to come in has just read what is
    // on offer and is now asking the practical questions. Their own
    // questions, from their own home page; nothing when they have written
    // none.
    if (ctx.templateId === 'metro') parts.push(ownerFaqSection(ctx));
    parts.push(ctaRow(ctx, `Hello ${name}, I have a question about your services`));
  } else if (page.kind === 'service') {
    const copy = SERVICE_COPY[page.slug] || null;
    open(area ? `${page.label} at ${name} in ${area}.` : `${page.label} at ${name}.`);
    // The pharmacy's own words first, then generic procedure only when the
    // service is one we can identify.
    if (page.description) {
      parts.push(`<section class="rx-block rx-narrow"><div class="rx-panel"><p>${esc(page.description)}</p></div></section>`);
    }
    if (override.about) {
      // The owner's own paragraph REPLACES the canned procedure text
      // entirely, rather than sitting alongside it — a page should say one
      // thing about what a service involves, not the generic version and
      // then the owner's correction to it.
      parts.push(`<section class="rx-block rx-narrow"><div class="rx-panel"><h2>About this service</h2><p>${esc(override.about)}</p></div></section>`);
    } else if (copy) {
      parts.push(`<section class="rx-block rx-narrow"><div class="rx-panel"><h2>What this involves</h2><p>${esc(copy.involves)}</p>`
        + `<h2>What to expect</h2><p>${esc(copy.expect)}</p></div></section>`);
    }
    parts.push(visitSplit(ctx, p, { hoursHeading: 'When you can come in' }));
    parts.push(ctaRow(ctx, `Hello ${name}, I would like to ask about ${page.label}`));
    if (copy) parts.push(faqSection(copy.faqs));
    // Contextual internal links, not a link farm.
    const others = allPages.filter((x) => x.kind === 'service' && x.path !== page.path).slice(0, 4);
    parts.push(chipList('Other services', others));
  } else if (page.kind === 'location') {
    open(area ? `${name} is a community pharmacy in ${area}.` : `How to find ${name}.`);
    // Somebody about to travel wants to recognise the shopfront when they get
    // there. A photograph does that better than any amount of prose about
    // landmarks.
    parts.push(photoSection(ctx, {
      kinds: ['gallery', 'hero'], limit: 6, heading: 'What to look for', eager: true,
    }));
    // ADDRESS AND HOURS SIDE BY SIDE, not stacked. They answer the two halves
    // of one question — where is it, and when can I go — and a visitor
    // deciding whether to set off now needs both in one glance. Stacked, the
    // hours sat a full section below the address with nothing between them,
    // which is what made this page read as a list of fragments.
    parts.push(visitSplit(ctx, p, { addressHeading: 'Our address' }));
    parts.push(chipList('What we offer here', allPages.filter((x) => x.kind === 'service')));
    parts.push(ctaRow(ctx, `Hello ${name}, I would like directions`));
  } else if (page.kind === 'contact') {
    // Metro opens with the reference's invitation rather than the plain
    // derived line. Deliberately NOT the reference's own "need to schedule a
    // consultation?" — that asserts a service this pharmacy may not offer,
    // and the head of their contact page is the last place to promise one.
    // Asking about a prescription and asking what is in stock are things
    // anybody can do at any pharmacy, so both are safe to write here.
    const metroContactIntro = area
      ? `Have a question about your prescription, or want to know whether we have something in stock? Reach out to our team in ${area} today.`
      : 'Have a question about your prescription, or want to know whether we have something in stock? Reach out to our team today.';
    open(ctx.templateId === 'metro' ? metroContactIntro : `How to reach ${name}.`);
    if (ctx.templateId === 'metro') {
      // The cards carry their own call, phone and WhatsApp buttons, so the
      // ctaRow above them would be the same two links a second time — and
      // the address and hours they already show are exactly what visitSplit
      // renders. One of each, not two.
      parts.push(metroContactCards(ctx, p));
      parts.push(metroReachSection(ctx, p, area));
    } else {
      parts.push(ctaRow(ctx, `Hello ${name}`));
      parts.push(visitSplit(ctx, p));
    }
  } else if (page.kind === 'healthIndex') {
    open('General health information, written for our customers.');
    const articles = allPages.filter((x) => x.kind === 'health');
    // No icons: a health article is not a service, and the service marks
    // would be claiming a correspondence that does not exist.
    parts.push(cardGrid(articles.map((a) => ({
      path: a.path, label: a.nav, description: a.description,
    })), { withIcon: false }));
    parts.push(ctaRow(ctx, `Hello ${name}`));
  } else if (page.kind === 'health') {
    const article = page.article || {};
    open(article.intro || null);

    // Sections in the order they were written. h2 for each, so the heading
    // hierarchy under the single h1 stays flat and correct.
    for (const section of article.sections || []) {
      const paras = (section.paragraphs || [])
        .map((t) => `<p>${esc(t)}</p>`).join('');
      parts.push(
        '<section class="rx-block rx-narrow"><div class="rx-panel">'
        + `<h2>${esc(section.heading)}</h2>` + paras
        + '</div></section>',
      );
    }

    // Before the byline and the links, not buried under them. Someone who
    // is frightened should reach this without scrolling past a call to
    // action.
    parts.push(seekCareSection(article.seekCare));
    parts.push(relatedSection(article, allPages));
    parts.push(ctaRow(ctx, `Hello ${name}, I have a question`));
    parts.push(bylineSection(article));

    // The disclaimer is not optional and not configurable. Every health page
    // carries it, in the same words, because a page that explains a
    // condition has to say plainly what it is not.
    parts.push(
      '<section class="rx-block rx-narrow rx-disclaimer"><p>'
      + esc(GENERAL_DISCLAIMER) + '</p></section>',
    );
  } else {
    open(null);
  }

  parts.push(footer(ctx, year, allPages));

  // A TIGHTER RHYTHM THAN THE HOME PAGE, and the wrapper is how the stylesheet
  // knows which it is looking at. The home page is five or six large blocks,
  // where a 6rem gap between sections is the composition. These pages are a
  // dozen short ones — a heading, an address, a list of hours — and the same
  // gap put a screen and a half of empty paper between two lines of text.
  // Same tokens, one step down.
  const [head, ...rest] = parts.filter(Boolean);
  const body = rest.slice(0, -1).join('\n');
  return [head, `<div class="rx-page">${body}</div>`, rest[rest.length - 1]].join('\n');
}

module.exports = {
  renderPageBody, SERVICE_COPY, header, hoursSection, addressSection, cardGrid,
};
