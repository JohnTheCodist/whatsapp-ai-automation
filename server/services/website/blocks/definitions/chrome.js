/**
 * Page chrome — the header and footer that bracket every pharmacy site.
 *
 * Both are marked `singleton` and `removable: false` in their editor
 * metadata. A pharmacy website with two headers, or with none, is not a
 * customisation an owner meant to make, and the guided builder should not
 * offer it. The adapter turns these flags into GrapesJS component options
 * later; nothing here knows GrapesJS exists.
 */

const { esc, attr, waHref, telHref, assetUrl, section } = require('../render');

const header = {
  id: 'pharmacy.header',
  version: 1,
  name: 'Header',
  description: 'Pharmacy name or logo, page links, and a WhatsApp button.',
  category: 'chrome',

  props: {
    // BOUND to the pharmacy's logo as of Phase 6.
    //
    // This prop had no `from` when it was written, on the reasoning that
    // inheriting an image a pharmacy had not chosen would surprise them. That
    // reasoning is obsolete: pharmacy_profile.logo_asset_id did not exist
    // then, and now it does and is set by the owner deliberately, in the
    // guided form, by uploading a logo. Inheriting it is what makes "upload
    // your logo once" true — and it keeps templates free of asset ids, the
    // same rule every other bound field follows.
    //
    // An explicit value still overrides, for a pharmacy that wants a
    // different mark on its website than on its receipts.
    logo: { type: 'asset', from: 'profile.logo_asset_id' },
    pharmacyName: { type: 'text', max: 120, from: 'pharmacy.name' },
    navigation: {
      type: 'list',
      max: 6,
      of: {
        label: { type: 'text', max: 40, required: true },
        // Same-page anchors and real links both go through the URL validator,
        // so `javascript:` cannot arrive here dressed as navigation.
        href: { type: 'url', required: true },
      },
    },
    whatsappNumber: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    whatsappLabel: { type: 'text', max: 40 },
  },

  defaults: {
    whatsappLabel: 'Chat on WhatsApp',
    navigation: [],
  },

  // Consumed by the stylesheet generator in the publishing phase; the
  // renderer emits the class that carries it, so this is not decoration.
  responsive: { layout: 'row', stackBelow: 640 },

  editor: {
    label: 'Header',
    singleton: true,
    removable: false,
    draggable: false,
    icon: 'layout-top',
  },

  a11y: 'Renders a <header> landmark with a <nav>; the WhatsApp button is a link, not a div.',

  render(props, ctx) {
    const logo = assetUrl(props.logo, ctx);
    const brand = logo
      ? `<img class="rx-logo" src="${esc(logo)}"${attr('alt', props.pharmacyName)} />`
      : `<span class="rx-brand-name">${esc(props.pharmacyName)}</span>`;

    // NAVIGATION: the owner's own links if they set any, otherwise the
    // site's real pages.
    //
    // The fallback is what connects the home page to the rest of the site.
    // This prop defaults to an empty list, so before this the home page
    // linked nowhere — every generated page was an orphan reachable only by
    // typing its URL, which is precisely the shape of internal linking
    // failure that makes pages rank for nothing. Caught by a test asserting
    // the home page links to /health/ exactly once.
    //
    // An explicit list still wins. A pharmacy that chose its own navigation
    // meant it, and silently appending to it would be overriding a decision
    // rather than filling a gap.
    const links = (props.navigation || []).length
      ? props.navigation
      : (ctx.sitePages || []).map((page) => ({ href: page.path, label: page.nav }));

    const nav = links.length
      ? `<nav class="rx-nav" aria-label="Main">${
        links.map((i) => `<a href="${esc(i.href)}">${esc(i.label)}</a>`).join('')
      }</nav>`
      : '';

    const wa = waHref(props.whatsappNumber, null, ctx);
    // rel on every outbound link: noopener closes the window.opener handle,
    // and these all leave the site.
    const cta = wa
      ? `<a class="rx-btn rx-btn-wa" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.whatsappLabel)}</a>`
      : '';

    return section(this.id, `<div class="rx-header-inner rx-stack-640">${brand}${nav}${cta}</div>`, {
      tag: 'header',
    });
  },
};

const footer = {
  id: 'pharmacy.footer',
  version: 1,
  name: 'Footer',
  description: 'Pharmacy name, address, contact details and copyright.',
  category: 'chrome',

  props: {
    pharmacyName: { type: 'text', max: 120, from: 'pharmacy.name' },
    address: { type: 'text', max: 200, from: 'profile.address_line' },
    phone: { type: 'phone', from: 'profile.phone' },
    whatsappNumber: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    // Not bound and not defaulted to a year: a default computed at render
    // time makes the output non-deterministic, and the renderer tests assert
    // determinism. The publishing step supplies the year through ctx.
    copyright: { type: 'text', max: 200 },
  },

  defaults: {},
  responsive: { layout: 'column' },

  editor: {
    label: 'Footer',
    singleton: true,
    removable: false,
    draggable: false,
    icon: 'layout-bottom',
  },

  a11y: 'Renders a <footer> landmark. Contact details are links, so a screen reader announces them as actionable.',

  render(props, ctx) {
    const tel = telHref(props.phone, ctx);
    const wa = waHref(props.whatsappNumber, null, ctx);

    const lines = [
      props.pharmacyName ? `<p class="rx-footer-name">${esc(props.pharmacyName)}</p>` : '',
      props.address ? `<p class="rx-footer-address">${esc(props.address)}</p>` : '',
      tel ? `<p><a href="${esc(tel)}">${esc(props.phone)}</a></p>` : '',
      wa ? `<p><a href="${esc(wa)}" rel="noopener noreferrer" target="_blank">WhatsApp</a></p>` : '',
      // No fabricated year — see the copyright prop.
      props.copyright ? `<p class="rx-footer-legal">${esc(props.copyright)}</p>`
        : (ctx.year ? `<p class="rx-footer-legal">© ${esc(ctx.year)} ${esc(props.pharmacyName)}</p>` : ''),
    ].filter(Boolean).join('');

    return section(this.id, `<div class="rx-footer-inner">${lines}</div>`, { tag: 'footer' });
  },
};

module.exports = [header, footer];
