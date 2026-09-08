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

const { esc, waHref, telHref, mapsHref, assetsOfKind } = require('./blocks/render');
const { renderBlock } = require('./blocks');
const { serviceIcon } = require('./blocks/icons');
const { navPages, breadcrumbsFor } = require('./pages');
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

/**
 * Breadcrumbs as an ordered list.
 *
 * The last item is not a link. Linking the page you are already on is the
 * commonest breadcrumb mistake and it gives a crawler a self-referential edge
 * that means nothing.
 */
function breadcrumbs(pages, path) {
  const trail = breadcrumbsFor(pages, path);
  if (!trail.length) return '';
  const items = trail.map((c, i) => {
    const last = i === trail.length - 1;
    const label = esc(c.label);
    return `<li>${last ? `<span aria-current="page">${label}</span>` : `<a href="${esc(c.path)}">${label}</a>`}</li>`;
  }).join('');
  return `<nav class="rx-block rx-narrow" aria-label="Breadcrumb"><ol class="rx-crumbs">${items}</ol></nav>`;
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
  return parts.length ? `<div class="rx-cta-row">${parts.join('')}</div>` : '';
}

/** Opening hours as a description list. Omitted entirely when unset. */
function hoursSection(profile, heading = 'Opening hours') {
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
  return `<section class="rx-block rx-narrow"><h2>${esc(heading)}</h2><div class="rx-hours">${rows}</div></section>`;
}

/** Address block with a maps link when one is set. */
function addressSection(ctx, heading = 'Where to find us') {
  const line = addressLine(ctx.profile);
  if (!line) return '';
  const map = ctx.profile?.maps_url
    ? `<p><a class="rx-btn rx-btn-outline" href="${esc(mapsHref(ctx.profile.maps_url, ctx))}">Open in Google Maps</a></p>`
    : '';
  const landmark = ctx.profile?.landmark
    ? `<p class="rx-landmark">${esc(ctx.profile.landmark)}</p>` : '';
  return `<section class="rx-block rx-narrow"><h2>${esc(heading)}</h2>`
    + `<address class="rx-address">${esc(line)}</address>${landmark}${map}</section>`;
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
 * The footer — the same block the home page uses, for the reason in header().
 *
 * The hand-built one here emitted its children straight into the section, so
 * it never got the shell's max-width and sat flush against the viewport edge
 * on a wide screen while every other section was centred. One footer, one
 * alignment.
 */
function footer(ctx, year, pages) {
  return renderBlock({ type: 'pharmacy.footer', version: 1, props: {} }, {
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
    + (heading ? `<h2 class="rx-narrow">${esc(heading)}</h2>` : '')
    + `<div class="rx-photo-grid">${imgs}</div></section>`;
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
  return `<section class="rx-block rx-narrow">${blocks.join('')}</section>`;
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
  const parts = [header(ctx, allPages, page.path), breadcrumbs(allPages, page.path)];

  /**
   * The page head.
   *
   * Left-aligned inside the SAME shell every other section uses, rather than
   * centred in its own 44rem column. Mixed alignment down one page is the
   * thing that reads as "unstructured" — the eye keeps re-finding the left
   * edge. The measure is applied to the lede alone, which is the only part
   * that needs one.
   */
  const open = (intro) => {
    parts.push(`<section class="rx-block rx-page-head"><div>`
      + `<span class="rx-eyebrow">${esc(page.nav || name)}</span>`
      + `<h1>${esc(page.h1)}</h1>`
      + (intro ? `<p class="rx-lede">${esc(intro)}</p>` : '')
      + `</div></section>`);
  };

  if (page.kind === 'about') {
    open(null);
    parts.push(`<section class="rx-block rx-narrow"><p>${esc(String(p.description).replace(/\s+/g, ' ').trim())}</p></section>`);
    // Eager on the first one: on an About page the photograph is the point,
    // it is above the fold, and lazy-loading the thing a visitor came to look
    // at makes the page feel slower than it is.
    parts.push(photoSection(ctx, { kinds: ['hero', 'gallery'], limit: 4, eager: true }));
    parts.push(addressSection(ctx));
    parts.push(hoursSection(p));
    parts.push(ctaRow(ctx, `Hello ${name}`));
  } else if (page.kind === 'services') {
    open(area ? `What we can help with at our pharmacy in ${area}.` : 'What we can help with.');
    const services = allPages.filter((x) => x.kind === 'service');
    parts.push(cardGrid(services));
    parts.push(ctaRow(ctx, `Hello ${name}, I have a question about your services`));
  } else if (page.kind === 'service') {
    const copy = SERVICE_COPY[page.slug] || null;
    open(area ? `${page.label} at ${name} in ${area}.` : `${page.label} at ${name}.`);
    // The pharmacy's own words first, then generic procedure only when the
    // service is one we can identify.
    if (page.description) {
      parts.push(`<section class="rx-block rx-narrow"><p>${esc(page.description)}</p></section>`);
    }
    if (copy) {
      parts.push(`<section class="rx-block rx-narrow"><h2>What this involves</h2><p>${esc(copy.involves)}</p>`
        + `<h2>What to expect</h2><p>${esc(copy.expect)}</p></section>`);
    }
    parts.push(hoursSection(p, 'When you can come in'));
    parts.push(addressSection(ctx));
    parts.push(ctaRow(ctx, `Hello ${name}, I would like to ask about ${page.label}`));
    if (copy) parts.push(faqSection(copy.faqs));
    // Contextual internal links, not a link farm.
    const others = allPages.filter((x) => x.kind === 'service' && x.path !== page.path).slice(0, 4);
    if (others.length) {
      parts.push(`<section class="rx-block rx-narrow"><h2>Other services</h2>`
        + `<ul>${others.map((o) => `<li><a href="${esc(o.path)}">${esc(o.label)}</a></li>`).join('')}</ul></section>`);
    }
  } else if (page.kind === 'location') {
    open(area ? `${name} is a community pharmacy in ${area}.` : `How to find ${name}.`);
    // Somebody about to travel wants to recognise the shopfront when they get
    // there. A photograph does that better than any amount of prose about
    // landmarks.
    parts.push(photoSection(ctx, {
      kinds: ['gallery', 'hero'], limit: 6, heading: 'What to look for', eager: true,
    }));
    parts.push(addressSection(ctx, 'Our address'));
    parts.push(hoursSection(p));
    const services = allPages.filter((x) => x.kind === 'service');
    if (services.length) {
      parts.push(`<section class="rx-block rx-narrow"><h2>What we offer here</h2>`
        + `<ul>${services.map((s) => `<li><a href="${esc(s.path)}">${esc(s.label)}</a></li>`).join('')}</ul></section>`);
    }
    parts.push(ctaRow(ctx, `Hello ${name}, I would like directions`));
  } else if (page.kind === 'contact') {
    open(`How to reach ${name}.`);
    parts.push(ctaRow(ctx, `Hello ${name}`));
    parts.push(addressSection(ctx));
    parts.push(hoursSection(p));
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
        '<section class="rx-block rx-narrow">'
        + `<h2>${esc(section.heading)}</h2>` + paras
        + '</section>',
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
  return parts.filter(Boolean).join('\n');
}

module.exports = {
  renderPageBody, SERVICE_COPY, header, breadcrumbs, hoursSection, addressSection, cardGrid,
};
