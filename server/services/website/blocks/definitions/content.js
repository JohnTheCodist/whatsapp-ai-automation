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

const { esc, section, assetsOfKind } = require('../render');
const { serviceIcon } = require('../icons');
const { servicePhotoFor } = require('../servicePhotos');

const about = {
  id: 'pharmacy.about',
  version: 1,
  name: 'About the pharmacy',
  description: 'A short introduction to the business.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    description: { type: 'text', max: 1200, from: 'profile.description' },
  },

  defaults: { heading: 'About us' },
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

    // THE SECOND PHOTOGRAPH, not the first. The hero has already taken the
    // pharmacy's leading image; About takes the next one so the two are not
    // the same picture twice. With only one photo uploaded, this section
    // stays prose — which is a composition, not a gap.
    const photos = [...assetsOfKind(ctx, 'hero'), ...assetsOfKind(ctx, 'gallery')];
    const photo = photos[1] || null;

    if (!photo) {
      return section(this.id, `<div class="rx-prose">${heading}${paragraphs}</div>`);
    }

    const place = [ctx?.profile?.city, ctx?.profile?.state].filter(Boolean).join(', ');
    const alt = place
      ? `${ctx?.pharmacy?.name || 'The pharmacy'}, ${place}`
      : (ctx?.pharmacy?.name || '');
    const dims = photo.width && photo.height ? ` width="${photo.width}" height="${photo.height}"` : '';

    // rx-split--flip puts the photograph on the LEFT at desktop width while
    // leaving the copy first in the DOM — so the alternation reads as a
    // designed rhythm on a wide screen and the reading order on a phone is
    // still heading, then words, then picture.
    return section(this.id, `<div class="rx-split rx-split--flip">`
      + `<div class="rx-split-copy">${heading}${paragraphs}</div>`
      + `<div class="rx-split-media"><img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="lazy" decoding="async" /></div>`
      + `</div>`);
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
    // /services/ index page — see render() below.
    layout: { type: 'enum', values: ['cards', 'rows'] },
  },

  defaults: { heading: 'What we offer', layout: 'cards' },
  responsive: { layout: 'grid', columns: { base: 1, 640: 2, 1024: 3 } },

  editor: { label: 'Services', singleton: false, removable: true, draggable: true, icon: 'grid' },

  a11y: 'A real <ul>, so a screen reader announces how many services there are before reading them.',

  render(props) {
    const list = props.services || [];
    if (!list.length) return '';

    const head = props.heading
      ? `<div class="rx-head"><h2>${esc(props.heading)}</h2></div>`
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

module.exports = [about, services, reviews];
