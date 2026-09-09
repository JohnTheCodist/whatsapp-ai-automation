/**
 * The blocks that ask the customer to do something.
 *
 * All three end in WhatsApp, and none of them stores a WhatsApp URL. They
 * store a phone number and a message, and render.js builds the link. That is
 * the design: a stored URL is a string an owner could point anywhere, while a
 * number and a message can only ever produce a link to WhatsApp, because
 * whatsappUrl() hardcodes the host and is the only thing that builds one.
 */

const { esc, safeHref, waHref, telHref, mapsHref, assetUrl, assetsOfKind, section } = require('../render');

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
    // Which of four fixed shapes this hero renders as — see render() below.
    // A template picks this once, the same way it picks a theme; the owner
    // can still change it afterwards through the advanced editor, same as
    // any other prop.
    layout: { type: 'enum', values: ['split', 'centered', 'framed', 'showcase'] },
  },

  defaults: {
    heading: 'Your neighbourhood pharmacy',
    subheading: 'Prescriptions, advice and everyday health — from people who know you.',
    primaryCtaLabel: 'Chat with us on WhatsApp',
    primaryCtaMessage: 'Hello, I have a question about my medication.',
    layout: 'split',
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
    // WhatsApp is the primary action and the point of the product — but a
    // pharmacy that has not set its published number would otherwise get a
    // hero with nothing to do in it, which is the weakest thing a page can
    // be. The phone is the honest fallback: it is real, it is already on the
    // profile, and it is counted the same way. Still nothing at all when the
    // pharmacy has neither, because a button that dials nobody is worse.
    const phone = wa ? '' : telHref(ctx?.profile?.phone, ctx);
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
      phone
        ? `<a class="rx-btn rx-btn-wa" href="${esc(phone)}">Call ${esc(ctx.profile.phone)}</a>`
        : '',
      secondary && secondaryLabel
        ? `<a class="rx-btn rx-btn-ghost" href="${esc(secondary)}" rel="noopener noreferrer" target="_blank">${esc(secondaryLabel)}</a>`
        : '',
    ].filter(Boolean).join('');

    const layout = ['centered', 'framed', 'showcase'].includes(props.layout) ? props.layout : 'split';

    // SHOWCASE'S heading is the owner's lead-in phrase with the pharmacy's
    // REAL, BOUND name always appended and highlighted after it — not a
    // string match against free text, which would only fire for the rare
    // owner whose own custom heading happens to already end with their own
    // name. Reading ctx.pharmacy.name directly means this is correct for
    // every pharmacy on this template from the moment it is created,
    // exactly like every other bound value in this file — never a guess,
    // never something the heading prop's own text has to happen to contain.
    const heading = layout === 'showcase' && props.heading && ctx?.pharmacy?.name
      ? `${esc(props.heading)} <span class="rx-hero-highlight">${esc(ctx.pharmacy.name)}</span>`
      : (props.heading ? esc(props.heading) : '');

    const copy = [
      eyebrow,
      heading ? `<h1>${heading}</h1>` : '',
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

    // CENTRED: a full-bleed, inverted colour band — WHETHER OR NOT a photo
    // exists. A photo becomes a dimmed cover background behind the text
    // rather than a side-by-side picture, so the treatment reads the same
    // bold way either way, instead of quietly becoming "split" the moment a
    // pharmacy uploads a photo. The scrim is a plain CSS pseudo-element, not
    // an inline style, so no per-pharmacy value ever needs to reach `style=`.
    if (layout === 'centered') {
      const bg = photo
        ? `<img class="rx-hero-bg" src="${esc(photo.url)}" alt="" loading="eager" fetchpriority="high" decoding="async">`
        : '';
      // The modifier class goes on the OUTER section, not the inner column —
      // .rx-pharmacy-hero already paints a full-bleed background (the light
      // tint every other layout uses), and putting the override a level
      // deeper, on .rx-hero-inner, only colours the centred, padded-in
      // content column, leaving the tint showing all around it as an
      // unintended frame. The section itself is the thing that has to be
      // full-bleed here.
      return section(
        this.id,
        `<div class="rx-hero-inner">${bg}<div class="rx-hero-copy">${copy}</div></div>`,
        { className: 'rx-hero--centered' },
      );
    }

    // eager + high fetchpriority: this is the largest element above the fold,
    // so it is the one the Largest Contentful Paint is measured on.
    const media = photo
      ? `<div class="rx-hero-media"><img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="eager" fetchpriority="high" decoding="async" /></div>`
      : '';

    // FRAMED: an asymmetric split with the photo inset in its own frame
    // rather than bleeding to the card's edge. Falls back to the same
    // typographic centre as `split` when there is no photo — there is
    // nothing to frame, and a frame around empty space is not a design.
    if (layout === 'framed' && media) {
      return section(this.id, `<div class="rx-hero-inner rx-hero--framed"><div class="rx-hero-copy">${copy}</div>${media}</div>`);
    }

    // SHOWCASE: a livelier split — a decorative shape behind the photo and a
    // small badge inset over its corner. The badge states how many days a
    // week the pharmacy is open, computed from its OWN stored hours rather
    // than a live "open now" check: this HTML is rendered once and published
    // as static markup (script-src 'none', no client clock to re-check
    // against), so a claim that depends on the moment somebody happens to
    // load the page would drift true-to-false the first time they load it
    // outside those hours. A day count is true at every hour of every day.
    // Omitted entirely with no hours set — nothing invented in its place.
    if (layout === 'showcase' && media) {
      const hours = Array.isArray(ctx?.profile?.opening_hours) ? ctx.profile.opening_hours : [];
      const openDays = hours.filter((h) => h && !h.closed).length;
      // Two lines — a small label over a bold value — rather than "Open
      // weekdays": this pharmacy's open days might not BE weekdays, and a day
      // COUNT is the one honest thing a static page can say about hours that
      // stays true no matter which days they actually are or when the page
      // happens to be viewed.
      const badge = openDays > 0
        ? `<div class="rx-hero-badge">`
          + `<span class="rx-hero-badge-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg></span>`
          + `<span class="rx-hero-badge-text"><span class="rx-hero-badge-label">Hours</span>`
          + `<span class="rx-hero-badge-value">${openDays} Day${openDays === 1 ? '' : 's'} a Week</span></span>`
          + `</div>`
        : '';
      const showcaseMedia = `<div class="rx-hero-media">`
        + `<img src="${esc(photo.url)}" alt="${esc(alt)}"${dims} loading="eager" fetchpriority="high" decoding="async" />`
        + `${badge}</div>`;
      return section(this.id, `<div class="rx-hero-inner rx-hero--showcase"><div class="rx-hero-copy">${copy}</div>${showcaseMedia}</div>`);
    }

    // SPLIT (the default): WITH a photograph the hero is a diptych. WITHOUT
    // one it becomes a centred typographic statement rather than a column of
    // text with an empty half beside it — which is what a pharmacy that has
    // not uploaded anything was getting, and it read as a page still
    // loading. A hero with no image is a legitimate design; a hero with a
    // hole where an image goes is not.
    const shape = media ? 'rx-hero-inner' : 'rx-hero-inner rx-hero--type';
    return section(this.id, `<div class="${shape}"><div class="rx-hero-copy">${copy}</div>${media}</div>`);
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
    // 'statement' is a quieter, more considered close — a tinted band with a
    // narrower, centred measure — for a template whose voice is "expert and
    // established" rather than "act now". See render() below.
    variant: { type: 'enum', values: ['plain', 'statement'] },
    // 'banner' is a full-width horizontal strip, text on one side and the
    // button on the other — a different SHAPE from 'stacked', independent of
    // variant/ctaType. See render() and the matching CSS.
    layout: { type: 'enum', values: ['stacked', 'banner'] },
    // 'phone' swaps the WhatsApp button for a real tel: link — see render().
    // buttonLabel is ignored in that mode: the button always reads "Call
    // {the pharmacy's own number}", the same wording the hero's own phone
    // fallback already uses, so the number shown is never stale or
    // configurable into saying something the link itself does not do.
    ctaType: { type: 'enum', values: ['whatsapp', 'phone'] },
  },

  defaults: {
    heading: 'Speak to a pharmacist',
    description: 'Not sure what you need? Ask us — we will help you work it out.',
    buttonLabel: 'Ask a pharmacist',
    message: 'Hello, please may I speak to a pharmacist?',
    variant: 'plain',
    layout: 'stacked',
    ctaType: 'whatsapp',
  },

  responsive: { layout: 'centered' },

  editor: { label: 'Speak to a pharmacist', singleton: false, removable: true, draggable: true, icon: 'stethoscope' },

  a11y: 'Uses <h2> so it sits under the hero\'s <h1> in the document outline rather than competing with it.',

  render(props, ctx) {
    let cta = '';
    if (props.ctaType === 'phone') {
      const tel = telHref(ctx?.profile?.phone, ctx);
      cta = (tel && ctx?.profile?.phone)
        ? `<a class="rx-btn rx-btn-solid" href="${esc(tel)}">Call ${esc(ctx.profile.phone)}</a>`
        : '';
    } else {
      const wa = waHref(props.whatsappNumber, props.message, ctx);
      cta = (wa && props.buttonLabel)
        ? `<a class="rx-btn rx-btn-wa" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.buttonLabel)}</a>`
        : '';
    }

    const copy = [
      props.heading ? `<h2>${esc(props.heading)}</h2>` : '',
      props.description ? `<p>${esc(props.description)}</p>` : '',
    ].filter(Boolean).join('');
    if (!copy && !cta) return '';

    const statement = props.variant === 'statement' ? ' rx-pharmacistCta--statement' : '';

    // BANNER: a full-width horizontal strip — text on one side, the button
    // on the other — rather than the stacked, centred column every other
    // variant uses. Never narrowed to .rx-narrow's 44rem: the strip is
    // meant to use the whole shell width.
    if (props.layout === 'banner') {
      const className = `rx-pharmacistCta--banner${statement}`;
      return section(this.id, `<div class="rx-pharmacistCta-banner-inner"><div>${copy}</div>${cta}</div>`, { className });
    }

    return section(this.id, `<div class="rx-narrow">${copy}${cta}</div>`, { className: statement.trim() || undefined });
  },
};

module.exports = [hero, whatsappCta, pharmacistCta];
