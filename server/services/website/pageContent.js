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

const { esc, waHref, telHref, mapsHref } = require('./blocks/render');
const { navPages, breadcrumbsFor } = require('./pages');

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

/** The site header: brand, then one level of navigation. */
function header(ctx, pages, currentPath) {
  const name = esc(ctx.pharmacy?.name || 'Pharmacy');
  const links = navPages(pages).map((p) => {
    const current = p.path === currentPath ? ' aria-current="page"' : '';
    return `<a href="${esc(p.path)}"${current}>${esc(p.nav)}</a>`;
  }).join('');
  return `<header class="rx-block rx-pharmacy-header"><div class="rx-header-inner">`
    + `<a class="rx-brand-name" href="/">${name}</a>`
    + `<nav class="rx-nav" aria-label="Main">${links}</nav>`
    + `</div></header>`;
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
  const items = faqs.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('');
  return `<section class="rx-block rx-narrow"><h2>Common questions</h2>${items}</section>`;
}

/** Cards linking to real crawlable URLs. Used by /services/ and /health/. */
function cardGrid(items) {
  const cards = items.map((item) => {
    const desc = item.description ? `<p>${esc(item.description)}</p>` : '';
    return `<a class="rx-service" href="${esc(item.path)}"><h3>${esc(item.label || item.nav)}</h3>${desc}</a>`;
  }).join('');
  return `<section class="rx-block"><div class="rx-grid">${cards}</div></section>`;
}

/** The footer: NAP again, because it is the last thing a visitor scrolls to. */
function footer(ctx, year) {
  const name = esc(ctx.pharmacy?.name || 'Pharmacy');
  const line = addressLine(ctx.profile);
  const addr = line ? `<p class="rx-footer-address">${esc(line)}</p>` : '';
  return `<footer class="rx-block rx-pharmacy-footer">`
    + `<p class="rx-footer-name">${name}</p>${addr}`
    + `<p class="rx-footer-legal">© ${esc(String(year || new Date().getUTCFullYear()))} ${name}. `
    + `This website provides general information about our pharmacy and is not medical advice.</p>`
    + `</footer>`;
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

  const open = (intro) => {
    parts.push(`<section class="rx-block rx-narrow"><h1>${esc(page.h1)}</h1>`
      + (intro ? `<p class="rx-lede">${esc(intro)}</p>` : '') + `</section>`);
  };

  if (page.kind === 'about') {
    open(null);
    parts.push(`<section class="rx-block rx-narrow"><p>${esc(String(p.description).replace(/\s+/g, ' ').trim())}</p></section>`);
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
  } else {
    open(null);
  }

  parts.push(footer(ctx, year));
  return parts.filter(Boolean).join('\n');
}

module.exports = {
  renderPageBody, SERVICE_COPY, header, breadcrumbs, hoursSection, addressSection, cardGrid,
};
