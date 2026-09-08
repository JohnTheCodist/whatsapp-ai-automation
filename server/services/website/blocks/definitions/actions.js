/**
 * The blocks that ask the customer to do something.
 *
 * All three end in WhatsApp, and none of them stores a WhatsApp URL. They
 * store a phone number and a message, and render.js builds the link. That is
 * the design: a stored URL is a string an owner could point anywhere, while a
 * number and a message can only ever produce a link to WhatsApp, because
 * whatsappUrl() hardcodes the host and is the only thing that builds one.
 */

const { esc, safeHref, waHref, mapsHref, assetUrl, assetsOfKind, section } = require('../render');

/**
 * The photograph the hero leads with.
 *
 * DETERMINISTIC, and resolved by KIND rather than stored on the block. An
 * explicit `image` prop still wins — an owner who picked one meant it — but
 * with none set the hero takes the pharmacy's first `hero` photo, or its
 * first `gallery` photo when there is no hero one. That ordering is what
 * makes "upload a photo of your shop" enough to get a photograph into the
 * hero, with nothing else to configure.
 *
 * Templates deliberately store no asset id (see templates.js), so this is the
 * path every template-built site takes. Returns null rather than a
 * placeholder when the pharmacy has uploaded nothing at all: the hero then
 * renders as a single column of type, which is a composition rather than an
 * empty grey rectangle where a picture was supposed to be.
 */
function heroImage(props, ctx) {
  const explicit = assetUrl(props.image, ctx);
  if (explicit) return { url: explicit, width: null, height: null };
  const [photo] = [...assetsOfKind(ctx, 'hero'), ...assetsOfKind(ctx, 'gallery')];
  return photo || null;
}

const hero = {
  id: 'pharmacy.hero',
  version: 1,
  name: 'Hero',
  description: 'The first thing a visitor sees: who you are and what to do next.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    subheading: { type: 'text', max: 240 },
    primaryCtaLabel: { type: 'text', max: 40 },
    // The primary CTA is a WhatsApp NUMBER, not a URL, so the most prominent
    // button on the page cannot be pointed somewhere else. A secondary CTA
    // may be a real URL — that is where "find us on Google Maps" belongs.
    primaryCtaWhatsapp: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    primaryCtaMessage: { type: 'text', max: 160 },
    secondaryCtaLabel: { type: 'text', max: 40 },
    secondaryCtaUrl: { type: 'url' },
    image: { type: 'asset' },
  },

  defaults: {
    heading: 'Your neighbourhood pharmacy',
    subheading: 'Prescriptions, advice and everyday health — from people who know you.',
    primaryCtaLabel: 'Chat with us on WhatsApp',
    primaryCtaMessage: 'Hello, I have a question about my medication.',
  },

  responsive: { layout: 'split', stackBelow: 768 },

  editor: {
    label: 'Hero',
    singleton: true,
    removable: true,
    draggable: true,
    icon: 'layout-hero',
  },

  a11y: 'The heading renders as <h1> — the page\'s single top-level heading. Decorative imagery carries an empty alt.',

  render(props, ctx) {
    const wa = waHref(props.primaryCtaWhatsapp, props.primaryCtaMessage, ctx);
    // The secondary action is directions when the pharmacy has a map link and
    // has not set its own — "where are you" is the second question every
    // visitor has, and it is the only other thing worth a button up here.
    // Routed through mapsHref so the tap is counted like any other.
    const ownSecondary = safeHref(props.secondaryCtaUrl);
    const secondary = ownSecondary || mapsHref(ctx?.profile?.maps_url, ctx);
    const secondaryLabel = props.secondaryCtaLabel || (ownSecondary ? '' : 'Get directions');
    const photo = heroImage(props, ctx);

    // The place, in the pharmacy's own words, above its name. Omitted when
    // the profile has no city or state — an eyebrow reading "Pharmacy" is
    // furniture, not information.
    const place = [ctx?.profile?.city, ctx?.profile?.state].filter(Boolean).join(', ');
    const eyebrow = place ? `<span class="rx-eyebrow">Pharmacy in ${esc(place)}</span>` : '';

    const buttons = [
      wa && props.primaryCtaLabel
        ? `<a class="rx-btn rx-btn-wa" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.primaryCtaLabel)}</a>`
        : '',
      secondary && secondaryLabel
        ? `<a class="rx-btn rx-btn-ghost" href="${esc(secondary)}" rel="noopener noreferrer" target="_blank">${esc(secondaryLabel)}</a>`
        : '',
    ].filter(Boolean).join('');

    const copy = [
      eyebrow,
      props.heading ? `<h1>${esc(props.heading)}</h1>` : '',
      props.subheading ? `<p class="rx-lede">${esc(props.subheading)}</p>` : '',
      buttons ? `<div class="rx-cta-row">${buttons}</div>` : '',
    ].filter(Boolean).join('');

    // The alt names the business and the place rather than describing the
    // photograph. We know it is this pharmacy; we have not seen what is in
    // the frame, and inventing "our bright modern dispensary" would be
    // software describing an image nobody here has looked at.
    const alt = place
      ? `${ctx?.pharmacy?.name || 'The pharmacy'}, ${place}`
      : (ctx?.pharmacy?.name || '');
    const dims = photo && photo.width && photo.height
      ? ` width="${photo.width}" height="${photo.height}"`
      : '';
    // eager + high fetchpriority: this is the largest element above the fold,
    // so it is the one the Largest Contentful Paint is measured on.
    const media = photo
      ? `<div class="rx-hero-media"><img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="eager" fetchpriority="high" decoding="async" /></div>`
      : '';

    return section(this.id, `<div class="rx-hero-inner">${`<div class="rx-hero-copy">${copy}</div>`}${media}</div>`);
  },
};

const whatsappCta = {
  id: 'pharmacy.whatsappCta',
  version: 1,
  name: 'WhatsApp button',
  description: 'A band that invites customers to start a WhatsApp conversation.',
  category: 'pharmacy',

  props: {
    label: { type: 'text', max: 60 },
    // The band's own heading and line. Optional: with neither set this stays
    // the bare button it has always been, which is what the `solid` and
    // `outline` styles are for mid-page.
    heading: { type: 'text', max: 120 },
    description: { type: 'text', max: 240 },
    phoneNumber: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    message: { type: 'text', max: 160 },
    style: { type: 'enum', values: ['solid', 'outline', 'band'] },
  },

  defaults: {
    label: 'Chat with us on WhatsApp',
    message: 'Hello, I would like to ask about a medicine.',
    style: 'band',
  },

  responsive: { layout: 'centered' },

  editor: { label: 'WhatsApp button', singleton: false, removable: true, draggable: true, icon: 'whatsapp' },

  a11y: 'A link, not a button element — it navigates. Opens in a new tab, which is announced by the rel/target pair.',

  render(props, ctx) {
    const wa = waHref(props.phoneNumber, props.message, ctx);
    // No number, no block. Rendering a dead button on a public page is worse
    // than rendering nothing: a customer taps it and nothing happens.
    if (!wa) return '';

    const button = `<a class="rx-btn rx-btn-wa rx-btn-${esc(props.style)}" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.label)}</a>`;

    // With a heading it becomes the page's closing statement; without one it
    // stays the plain button it was, for use mid-page.
    if (!props.heading && !props.description) return section(this.id, button);

    const inner = [
      props.heading ? `<h2>${esc(props.heading)}</h2>` : '',
      props.description ? `<p>${esc(props.description)}</p>` : '',
      button,
    ].filter(Boolean).join('');
    return section(this.id, `<div class="rx-narrow">${inner}</div>`);
  },
};

const pharmacistCta = {
  id: 'pharmacy.pharmacistCta',
  version: 1,
  name: 'Speak to a pharmacist',
  description: 'Invites customers with a question to talk to a person.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    description: { type: 'text', max: 300 },
    buttonLabel: { type: 'text', max: 40 },
    whatsappNumber: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    message: { type: 'text', max: 160 },
  },

  defaults: {
    heading: 'Speak to a pharmacist',
    description: 'Not sure what you need? Ask us — we will help you work it out.',
    buttonLabel: 'Ask a pharmacist',
    message: 'Hello, please may I speak to a pharmacist?',
  },

  responsive: { layout: 'centered' },

  editor: { label: 'Speak to a pharmacist', singleton: false, removable: true, draggable: true, icon: 'stethoscope' },

  a11y: 'Uses <h2> so it sits under the hero\'s <h1> in the document outline rather than competing with it.',

  render(props, ctx) {
    const wa = waHref(props.whatsappNumber, props.message, ctx);
    const inner = [
      props.heading ? `<h2>${esc(props.heading)}</h2>` : '',
      props.description ? `<p>${esc(props.description)}</p>` : '',
      wa && props.buttonLabel
        ? `<a class="rx-btn rx-btn-wa" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.buttonLabel)}</a>`
        : '',
    ].filter(Boolean).join('');
    return inner ? section(this.id, `<div class="rx-narrow">${inner}</div>`) : '';
  },
};

module.exports = [hero, whatsappCta, pharmacistCta];
