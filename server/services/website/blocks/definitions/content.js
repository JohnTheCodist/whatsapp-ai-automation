/**
 * Editorial blocks — what the pharmacy says about itself.
 *
 * About and Services bind to pharmacy_profile.description and .services,
 * which 0049 added for exactly this. Those two columns carry a warning in
 * that migration and it is repeated here because it is easy to undo by
 * accident: they are WEBSITE COPY and are deliberately NOT part of the
 * assistant's context. Wiring them into the assistant is a separate change
 * with its own clinical review.
 */

const { esc, section, assetsOfKind, mapsHref } = require('../render');
const { serviceIcon } = require('../icons');
const { servicePhotoFor } = require('../servicePhotos');

/** A plain circular checkmark — decorative, carries no claim of its own. */
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ARROW_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const CHEVRON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const about = {
  id: 'pharmacy.about',
  version: 1,
  name: 'About the pharmacy',
  description: 'A short introduction to the business.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    description: { type: 'text', max: 1200, from: 'profile.description' },
    // A short list of trust points the OWNER types — "Accepting Major
    // Insurance Plans", "Bilingual Staff" — never seeded with an example,
    // for the same reason `reviews` below defaults to an empty list: each
    // one is a specific factual claim about THIS pharmacy, and a template
    // default a new owner never noticed and never typed would publish a
    // claim ("we take insurance") that may not even be true for them.
    highlights: {
      type: 'list',
      max: 6,
      of: { text: { type: 'text', max: 80, required: true } },
    },
    // Shown only once there is a real maps_url to send someone to — see
    // render(). Optional even then: a template opts in by setting this,
    // rather than every About section growing a button it never had.
    buttonLabel: { type: 'text', max: 40 },
    // 'framed' insets the photo in a bordered card instead of letting it
    // bleed to the split's own edge — see render() and the matching CSS.
    mediaStyle: { type: 'enum', values: ['plain', 'framed'] },
    // Whether the photo sits first (mirrored, desktop only) or second in
    // the visual order — independent of DOM order, which always keeps the
    // words before the picture for a phone and for a screen reader.
    flip: { type: 'boolean' },
    // A soft background wash behind the whole section, plus a short accent
    // rule under the heading — see the matching CSS for both.
    style: { type: 'enum', values: ['plain', 'tint'] },
  },

  // NO DEFAULT HIGHLIGHTS, for the reason in the props comment above — an
  // empty list renders nothing until the owner writes something true.
  defaults: { heading: 'About us', highlights: [], mediaStyle: 'plain', flip: true, style: 'plain' },
  responsive: { layout: 'prose' },

  editor: { label: 'About the pharmacy', singleton: false, removable: true, draggable: true, icon: 'text' },

  a11y: 'Paragraphs are split on blank lines so the text is not one unbroken wall for a screen reader.',

  render(props, ctx = {}) {
    if (!props.description) return '';

    // Paragraphs from blank lines. This is the one place a renderer turns
    // owner text into structure, and it is safe precisely because the split
    // happens on the ESCAPED value's source — each paragraph is escaped
    // individually, so no amount of newline arrangement can produce a tag.
    const paragraphs = String(props.description)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`)
      .join('');

    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';

    const highlightItems = (Array.isArray(props.highlights) ? props.highlights : [])
      .filter((h) => h?.text);
    const highlights = highlightItems.length
      ? `<ul class="rx-about-highlights">${highlightItems.map((h) =>
        `<li><span class="rx-check" aria-hidden="true">${CHECK_SVG}</span>${esc(h.text)}</li>`).join('')}</ul>`
      : '';

    // Real only when the pharmacy has actually set a maps link AND a
    // template has opted into showing the button — never a bare "Get
    // Directions" that goes nowhere.
    const directions = mapsHref(ctx?.profile?.maps_url, ctx);
    const button = (directions && props.buttonLabel)
      ? `<a class="rx-btn rx-btn-solid" href="${esc(directions)}" rel="noopener noreferrer" target="_blank">`
        + `${esc(props.buttonLabel)} ${ARROW_SVG}</a>`
      : '';

    const className = props.style === 'tint' ? 'rx-pharmacy-about--tint' : undefined;

    // THE SECOND PHOTOGRAPH, not the first. The hero has already taken the
    // pharmacy's leading image; About takes the next one so the two are not
    // the same picture twice. With only one photo uploaded, this section
    // stays prose — which is a composition, not a gap.
    const photos = [...assetsOfKind(ctx, 'hero'), ...assetsOfKind(ctx, 'gallery')];
    const photo = photos[1] || null;

    if (!photo) {
      return section(this.id, `<div class="rx-prose">${heading}${paragraphs}${highlights}${button}</div>`, { className });
    }

    const place = [ctx?.profile?.city, ctx?.profile?.state].filter(Boolean).join(', ');
    const alt = place
      ? `${ctx?.pharmacy?.name || 'The pharmacy'}, ${place}`
      : (ctx?.pharmacy?.name || '');
    const dims = photo.width && photo.height ? ` width="${photo.width}" height="${photo.height}"` : '';

    // flip (the default, true) puts the photograph on the LEFT at desktop
    // width while leaving the copy first in the DOM — so the alternation
    // reads as a designed rhythm on a wide screen and the reading order on a
    // phone is still heading, then words, then picture. flip:false keeps it
    // on the right instead, in both DOM and visual order.
    const splitClass = props.flip === false ? 'rx-split' : 'rx-split rx-split--flip';
    const mediaClass = props.mediaStyle === 'framed' ? 'rx-split-media rx-split-media--framed' : 'rx-split-media';
    return section(this.id, `<div class="${splitClass}">`
      + `<div class="rx-split-copy">${heading}${paragraphs}${highlights}${button}</div>`
      + `<div class="${mediaClass}"><img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="lazy" decoding="async" /></div>`
      + `</div>`, { className });
  },
};

const services = {
  id: 'pharmacy.services',
  version: 1,
  name: 'Services',
  description: 'What the pharmacy offers — dispensing, testing, delivery.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    // The trailing part of the heading, styled differently (see render()) —
    // an independent prop rather than a guess at which words of `heading`
    // to style, the same reasoning the hero's own highlighted name uses.
    // Optional: with nothing set, `heading` alone is the whole H2, exactly
    // as it always was.
    headingAccent: { type: 'text', max: 60 },
    // A small label above the heading — off by default, since no template
    // before Metro used one; see render() for what it becomes under `band`.
    eyebrow: { type: 'text', max: 60 },
    subheading: { type: 'text', max: 240 },
    services: {
      type: 'list',
      max: 12,
      from: 'profile.services',
      of: {
        name: { type: 'text', max: 80, required: true },
        description: { type: 'text', max: 300 },
        // An icon NAME from a fixed set, never a URL or an SVG. That keeps
        // the icon set something the renderer controls and stops this prop
        // becoming a way to embed markup.
        icon: { type: 'enum', values: ['pill', 'syringe', 'delivery', 'test', 'advice', 'baby', 'heart'] },
      },
    },
    // 'rows' reuses the compact icon-and-text row already built for the
    // /services/ index page; 'tiles' is a third shape — see render() below.
    layout: { type: 'enum', values: ['cards', 'rows', 'tiles'] },
    // 'band' paints the whole section in the primary colour, cards included
    // — see render()'s className and the CSS for why the cards need no
    // override of their own to still read as white tiles over it.
    style: { type: 'enum', values: ['plain', 'band'] },
  },

  defaults: { heading: 'What we offer', layout: 'cards', style: 'plain' },
  responsive: { layout: 'grid', columns: { base: 1, 640: 2, 1024: 3 } },

  editor: { label: 'Services', singleton: false, removable: true, draggable: true, icon: 'grid' },

  a11y: 'A real <ul>, so a screen reader announces how many services there are before reading them.',

  render(props) {
    const list = props.services || [];
    if (!list.length) return '';

    const eyebrow = props.eyebrow ? `<span class="rx-eyebrow">${esc(props.eyebrow)}</span>` : '';
    // headingAccent is a SEPARATE prop, not a guess at which words of
    // `heading` to style — see the props comment above.
    const headingHtml = props.heading
      ? props.headingAccent
        ? `${esc(props.heading)} <span class="rx-heading-accent">${esc(props.headingAccent)}</span>`
        : esc(props.heading)
      : '';
    const subheading = props.subheading ? `<p>${esc(props.subheading)}</p>` : '';
    const centered = Boolean(props.eyebrow || props.subheading);
    const head = (headingHtml || eyebrow || subheading)
      ? `<div class="rx-head${centered ? ' rx-head--center' : ''}">${eyebrow}`
        + `${headingHtml ? `<h2>${headingHtml}</h2>` : ''}${subheading}</div>`
      : '';

    // ROWS: the exact compact row already built for the /services/ index
    // page — .rx-cards/.rx-card, not a new component — for a template whose
    // hero has already made the page's one big visual statement and does not
    // need a second one immediately below it.
    if (props.layout === 'rows') {
      const items = list.map((s) => {
        const desc = s.description ? `<p>${esc(s.description)}</p>` : '';
        return `<div class="rx-card"><span class="rx-card-mark">${serviceIcon(s.name, s.icon)}</span>`
          + `<span class="rx-card-body"><span class="rx-card-title">${esc(s.name)}</span>${desc}</span></div>`;
      }).join('');
      return section(this.id, `${head}<div class="rx-cards">${items}</div>`);
    }

    // TILES: a small icon CHIP over a title and description, in a card of
    // its own — a third shape, between the big photo-led CARDS below and the
    // compact icon-and-text ROWS above. The chip's colour alternates blue/
    // gold purely as rhythm down the grid; it says nothing about the
    // service itself, the same way the icon SHAPE never has.
    if (props.layout === 'tiles') {
      const items = list.map((s, i) => {
        const desc = s.description ? `<p>${esc(s.description)}</p>` : '';
        const tone = i % 2 === 0 ? 'rx-tile-a' : 'rx-tile-b';
        return `<li class="rx-service-tile ${tone}">`
          + `<span class="rx-service-tile-icon">${serviceIcon(s.name, s.icon)}</span>`
          + `<h3>${esc(s.name)}</h3>${desc}</li>`;
      }).join('');
      const className = props.style === 'band' ? 'rx-services--band' : undefined;
      return section(this.id, `${head}<ul class="rx-service-tiles">${items}</ul>`, { className });
    }

    // CARDS (the default). EVERY service gets a real visual, not only the
    // ones with an explicit icon set — a photo where one exists and can be
    // shown honestly (see servicePhotos.js for the bar that has to clear),
    // the drawn mark otherwise. Both are matched from the name the owner
    // typed, through the same catalogue that decides the service's URL, so
    // the visual and the page agree about what the service is. auto-fill
    // lets the grid hold any count without a stray half-empty row at the end.
    const items = list.map((s) => {
      const photo = servicePhotoFor(s.name);
      const visual = photo
        ? `<img class="rx-service-photo" src="${esc(photo.src)}" alt="${esc(photo.alt)}"`
          + ` width="${photo.width}" height="${photo.height}" loading="lazy" decoding="async">`
        : `<span class="rx-service-icon">${serviceIcon(s.name, s.icon)}</span>`;
      const desc = s.description ? `<p>${esc(s.description)}</p>` : '';
      return `<li class="rx-service-card">`
        + `<div class="rx-service-visual">${visual}</div>`
        + `<div class="rx-service-body"><h3>${esc(s.name)}</h3>${desc}</div>`
        + `</li>`;
    }).join('');
    return section(this.id, `${head}<ul class="rx-service-grid">${items}</ul>`);
  },
};

const reviews = {
  id: 'pharmacy.reviews',
  version: 1,
  name: 'Customer reviews',
  description: 'Things real customers have said. Entered by the pharmacy.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    reviews: {
      type: 'list',
      max: 12,
      of: {
        name: { type: 'text', max: 80, required: true },
        text: { type: 'text', max: 600, required: true },
        rating: { type: 'integer', min: 1, max: 5 },
      },
    },
  },

  // NO DEFAULT REVIEWS, and this is a product rule rather than an oversight.
  // Seeding a template with invented testimonials would publish fabricated
  // claims under a real pharmacy's name to real patients. An empty reviews
  // block renders nothing at all until the pharmacy enters something true.
  defaults: { heading: 'What our customers say', reviews: [] },

  responsive: { layout: 'grid', columns: { base: 1, 768: 2 } },

  editor: { label: 'Customer reviews', singleton: false, removable: true, draggable: true, icon: 'quote' },

  a11y: 'Each review is a <figure> with a <figcaption> attributing it; the rating is stated in text, not only as stars.',

  render(props) {
    const list = props.reviews || [];
    if (!list.length) return '';

    const items = list.map((r) => {
      // The star row is aria-hidden and paired with a text equivalent, so the
      // rating is not conveyed by a glyph alone.
      const rating = r.rating
        ? `<p class="rx-rating"><span aria-hidden="true">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>`
          + `<span class="rx-sr-only">Rated ${esc(r.rating)} out of 5</span></p>`
        : '';
      return `<figure class="rx-review">${rating}<blockquote><p>${esc(r.text)}</p></blockquote>`
        + `<figcaption>${esc(r.name)}</figcaption></figure>`;
    }).join('');

    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';
    return section(this.id, `${heading}<div class="rx-grid rx-grid-2">${items}</div>`);
  },
};

const faq = {
  id: 'pharmacy.faq',
  version: 1,
  name: 'FAQ',
  description: 'Common questions the pharmacy answers itself, in its own words.',
  category: 'pharmacy',

  props: {
    eyebrow: { type: 'text', max: 60 },
    heading: { type: 'text', max: 120 },
    subheading: { type: 'text', max: 240 },
    faqs: {
      type: 'list',
      max: 10,
      of: {
        question: { type: 'text', max: 150, required: true },
        answer: { type: 'text', max: 600, required: true },
      },
    },
  },

  // NO DEFAULT QUESTIONS, the same reason `reviews` above has no default
  // testimonials. "Do you offer delivery?" answered "Yes" for a pharmacy
  // that does not deliver is a fabricated policy, not a placeholder — this
  // is a website speaking on the pharmacy's behalf about something it has
  // no way to know. Nothing renders until the owner writes their own.
  defaults: { heading: 'Frequently Asked Questions', faqs: [] },
  responsive: { layout: 'list' },

  editor: { label: 'FAQ', singleton: false, removable: true, draggable: true, icon: 'help-circle' },

  a11y: 'Each question is a native <details>/<summary> disclosure — expand and collapse work with no '
    + 'JavaScript, and are announced correctly by assistive tech without any ARIA of our own to get wrong.',

  render(props) {
    const items = (Array.isArray(props.faqs) ? props.faqs : []).filter((f) => f?.question && f?.answer);
    if (!items.length) return '';

    const eyebrow = props.eyebrow ? `<span class="rx-eyebrow rx-eyebrow--outline">${esc(props.eyebrow)}</span>` : '';
    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';
    const subheading = props.subheading ? `<p>${esc(props.subheading)}</p>` : '';
    const head = (eyebrow || heading || subheading)
      ? `<div class="rx-head rx-head--center">${eyebrow}${heading}${subheading}</div>`
      : '';

    const rows = items.map((f) => `<details class="rx-faq-item">`
      + `<summary>${esc(f.question)}<span class="rx-faq-chevron" aria-hidden="true">${CHEVRON_SVG}</span></summary>`
      + `<p>${esc(f.answer)}</p></details>`).join('');

    return section(this.id, `${head}<div class="rx-faq-list">${rows}</div>`);
  },
};

module.exports = [about, services, reviews, faq];
