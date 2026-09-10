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
// The contact marks and the "Mon – Fri" collapsing already exist, drawn and
// tested, for the location block's visit cards. requiring them here is a
// one-way edge (practical.js knows nothing of chrome.js) and the alternative
// is a second telephone icon that slowly stops matching the first.
const { groupedHours, PIN_ICON, PHONE_ICON, CLOCK_ICON } = require('./practical');
const { whatsappGlyph } = require('../icons');

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

/**
 * The four-column footer: who we are, the site's own links, the services
 * that have pages, and how to reach the pharmacy.
 *
 * EVERY COLUMN IS OMITTED WHOLE when there is nothing true to put in it.
 * The Services column needs service pages to exist, Contact needs an address
 * or a phone number, and the blurb needs the owner to have written a
 * description. A heading over an empty column is worse than one column fewer,
 * and inventing a filler line to avoid the gap is not on the table.
 *
 * There are no "Terms of Service" or "Privacy Policy" links, which the
 * reference has and this deliberately does not: those pages do not exist on
 * a site this builder generates, and a footer link to a 404 is worse than no
 * link. If they are ever real pages they belong here.
 */
function columnsFooter(props, ctx, tel, wa) {
  const address = [props.address, props.city, props.state].filter(Boolean).join(', ');

  const logoUrl = props.logo ? assetUrl(props.logo, ctx) : '';
  const brand = [
    logoUrl
      ? `<img class="rx-footer-logo" src="${esc(logoUrl)}" alt="${esc(props.pharmacyName || '')}" width="56" height="56" loading="lazy" decoding="async">`
      : '',
    props.pharmacyName ? `<p class="rx-footer-name">${esc(props.pharmacyName)}</p>` : '',
    props.blurb ? `<p class="rx-footer-blurb">${esc(props.blurb)}</p>` : '',
  ].filter(Boolean).join('');

  const pages = ctx.sitePages || [];
  const quick = pages.length
    ? `<nav class="rx-footer-col" aria-label="Footer"><h2 class="rx-footer-h">Quick Links</h2>`
      + `<ul class="rx-footer-links">${pages.map((x) => `<li><a href="${esc(x.path)}">${esc(x.nav)}</a></li>`).join('')}</ul></nav>`
    : '';

  const serviceLinks = ctx.serviceLinks || [];
  const svc = serviceLinks.length
    ? `<div class="rx-footer-col"><h2 class="rx-footer-h">Services</h2>`
      + `<ul class="rx-footer-dots">${serviceLinks.map((x) => `<li><a href="${esc(x.path)}">${esc(x.label)}</a></li>`).join('')}</ul></div>`
    : '';

  // The same "Mon – Fri" collapsing the visit cards use, so the two never
  // disagree about the week on the same site.
  const hours = groupedHours(ctx.profile?.opening_hours || []);
  const info = [
    address ? `<li><span class="rx-footer-mark">${PIN_ICON}</span><span>${esc(address)}</span></li>` : '',
    tel ? `<li><span class="rx-footer-mark">${PHONE_ICON}</span><a href="${esc(tel)}">${esc(props.phone)}</a></li>` : '',
    wa ? `<li><span class="rx-footer-mark">${whatsappGlyph({ size: 20 })}</span><a href="${esc(wa)}" rel="noopener noreferrer" target="_blank">WhatsApp</a></li>` : '',
    hours.length
      ? `<li><span class="rx-footer-mark">${CLOCK_ICON}</span><span>${
        hours.map((r) => `${esc(r.label)}: ${esc(r.value)}`).join('<br>')
      }</span></li>`
      : '',
  ].filter(Boolean).join('');
  const contact = info
    ? `<div class="rx-footer-col"><h2 class="rx-footer-h">Contact Info</h2><ul class="rx-footer-info">${info}</ul></div>`
    : '';

  const legal = props.copyright
    ? `<p class="rx-footer-legal">${esc(props.copyright)}</p>`
    : (ctx.year ? `<p class="rx-footer-legal">© ${esc(ctx.year)} ${esc(props.pharmacyName)}</p>` : '');

  const cols = `<div class="rx-footer-cols"><div class="rx-footer-brand">${brand}</div>${quick}${svc}${contact}</div>`;
  return section(this.id, `<div class="rx-footer-inner">${cols}${legal}</div>`, {
    tag: 'footer',
    className: 'rx-footer--columns',
  });
}

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
    // The pharmacy's own description, shown beside the name in the columns
    // layout. Bound, never written here: this is the sentence they already
    // wrote about themselves in their profile, and the assistant quotes the
    // same one.
    blurb: { type: 'text', max: 300, from: 'profile.description' },
    logo: { type: 'asset', from: 'profile.logo_asset_id' },
    // 'statement' is the footer every template had: the name at size, the
    // address under it, and the two ways to reach the pharmacy. 'columns' is
    // the directory footer — the same facts, plus the links the site already
    // has, in the four-column arrangement Metro's reference uses. A choice
    // about arrangement only; neither one can say anything the other cannot.
    layout: { type: 'enum', values: ['statement', 'columns'] },
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
    if (props.layout === 'columns') return columnsFooter.call(this, props, ctx, tel, wa);

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
