/**
 * Page chrome — the header and footer that bracket every pharmacy site.
 *
 * Both are marked `singleton` and `removable: false` in their editor
 * metadata. A pharmacy website with two headers, or with none, is not a
 * customisation an owner meant to make, and the guided builder should not
 * offer it. The adapter turns these flags into GrapesJS component options
 * later; nothing here knows GrapesJS exists.
 *
 * THE MOBILE MENU IS A <details>, NOT A SCRIPT. Published pages carry
 * `script-src 'none'` and contain no JavaScript at all — that is what makes
 * the whole stored-XSS class unreachable rather than merely defended against,
 * and it is not being traded away for a navigation drawer. A disclosure
 * widget is what the platform already provides, it is keyboard-operable and
 * screen-reader-announced for free, and it cannot fail to open because a
 * bundle did not load on a slow connection.
 */

const { esc, attr, waHref, telHref, assetUrl, section } = require('../render');

/** The links the site actually has, or the owner's own if they set any. */
function navLinks(props, ctx) {
  if ((props.navigation || []).length) return props.navigation;
  return (ctx.sitePages || []).map((page) => ({ href: page.path, label: page.nav }));
}

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

  a11y: 'Renders a <header> landmark with a <nav>; the WhatsApp button is a link, not a div. The mobile menu is a <details>, so it is operable by keyboard and announced as a disclosure without any script.',

  render(props, ctx) {
    const logo = assetUrl(props.logo, ctx);
    // The brand is a link home. On every page but the home page that is the
    // one navigation control a visitor looks for first.
    const brand = logo
      ? `<a class="rx-brand" href="/"><img class="rx-logo" src="${esc(logo)}"${attr('alt', props.pharmacyName)} /></a>`
      : `<a class="rx-brand rx-brand-name" href="/">${esc(props.pharmacyName)}</a>`;

    // NAVIGATION: the owner's own links if they set any, otherwise the
    // site's real pages.
    //
    // The fallback is what connects the home page to the rest of the site.
    // This prop defaults to an empty list, so before this the home page
    // linked nowhere — every generated page was an orphan reachable only by
    // typing its URL, which is precisely the shape of internal linking
    // failure that makes pages rank for nothing.
    const links = navLinks(props, ctx);
    // aria-current marks the page you are already on. Set from ctx rather
    // than a prop because it is a fact about the request, not about the
    // block — the home page composes this same header with no currentPath
    // and simply gets no mark.
    const linkHtml = links.map((i) => {
      const current = ctx.currentPath && i.href === ctx.currentPath ? ' aria-current="page"' : '';
      return `<a href="${esc(i.href)}"${current}>${esc(i.label)}</a>`;
    }).join('');
    const nav = links.length ? `<nav class="rx-nav" aria-label="Main">${linkHtml}</nav>` : '';

    const wa = waHref(props.whatsappNumber, null, ctx);
    // rel on every outbound link: noopener closes the window.opener handle,
    // and these all leave the site.
    const cta = wa
      ? `<a class="rx-btn rx-btn-wa rx-header-cta" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.whatsappLabel)}</a>`
      : '';

    // The same links again, in a disclosure, for a screen with no room for a
    // nav bar. Rendered only when there is something to put in it.
    const menu = (links.length || wa)
      ? `<details class="rx-menu"><summary aria-label="Menu"><span class="rx-menu-bars" aria-hidden="true"></span>Menu</summary>`
        + `<div class="rx-menu-panel">${linkHtml}`
        + (wa ? `<a class="rx-btn rx-btn-wa" href="${esc(wa)}" rel="noopener noreferrer" target="_blank">${esc(props.whatsappLabel)}</a>` : '')
        + `</div></details>`
      : '';

    return section(this.id, `<div class="rx-header-inner">${brand}${nav}${cta}${menu}</div>`, {
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
    // The WHOLE address, in three bound parts. A footer that says "12 Allen
    // Avenue" without the city is a worse footer for a reader and a broken
    // one for local search: the name-address-phone string has to be identical
    // on every page of the site, and the generated pages print the full
    // locality. Asserted by websiteSeo.test.js, which caught this the day the
    // footer stopped emitting city and state.
    address: { type: 'text', max: 200, from: 'profile.address_line' },
    city: { type: 'text', max: 80, from: 'profile.city' },
    state: { type: 'text', max: 80, from: 'profile.state' },
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

    // A statement, not four columns of links: the pharmacy's name at size,
    // the address under it, and the two ways to reach it. Everything here is
    // omitted when the pharmacy has not got it — an empty column with a
    // heading over nothing is worse than one column fewer.
    // One address string, built the same way every generated page builds it.
    const address = [props.address, props.city, props.state].filter(Boolean).join(', ');

    const identity = [
      props.pharmacyName ? `<p class="rx-footer-name">${esc(props.pharmacyName)}</p>` : '',
      address ? `<p class="rx-footer-address">${esc(address)}</p>` : '',
      (tel || wa)
        ? `<ul class="rx-footer-contact">${
          (tel ? `<li><a href="${esc(tel)}">${esc(props.phone)}</a></li>` : '')
          + (wa ? `<li><a href="${esc(wa)}" rel="noopener noreferrer" target="_blank">WhatsApp</a></li>` : '')
        }</ul>`
        : '',
    ].filter(Boolean).join('');

    const pages = ctx.sitePages || [];
    const nav = pages.length
      ? `<nav aria-label="Footer"><ul class="rx-footer-nav">${
        pages.map((p) => `<li><a href="${esc(p.path)}">${esc(p.nav)}</a></li>`).join('')
      }</ul></nav>`
      : '';

    // No fabricated year — see the copyright prop.
    const legal = props.copyright
      ? `<p class="rx-footer-legal">${esc(props.copyright)}</p>`
      : (ctx.year ? `<p class="rx-footer-legal">© ${esc(ctx.year)} ${esc(props.pharmacyName)}</p>` : '');

    return section(this.id, `<div class="rx-footer-inner">${identity}${nav}${legal}</div>`, { tag: 'footer' });
  },
};

module.exports = [header, footer];
