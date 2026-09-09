/**
 * The practical blocks — when you are open, where you are, how to reach you.
 *
 * ALL THREE INHERIT FROM pharmacy_profile AND STORE NOTHING.
 *
 * This is the part of the contract that answers the requirement that a
 * website must not be able to say "9:00 – 20:00" while the profile the
 * assistant answers from says "9:00 – 19:00". These blocks carry only
 * presentational props — a heading, a toggle — and read the facts through
 * `from` bindings at render time. A template seeds no hours, no address and
 * no phone number, so a template-built site is incapable of drifting.
 *
 * An owner CAN still override a field, and that override is stored, which is
 * the evidence they meant it. Inheritance is the default; divergence is a
 * deliberate act with a record.
 *
 * NOTE ON THE ORIGINAL SPEC: the block brief listed Opening Hours as carrying
 * days / openingTime / closingTime / closedDays of its own. That would be a
 * second copy of pharmacy_profile.opening_hours and precisely the divergence
 * the same brief forbids, so the fields are not duplicated here. The
 * override, if it is ever wanted, belongs in the profile or behind an
 * explicit "my website hours differ" product decision — not as a silent
 * default.
 */

const { esc, mapsHref, waHref, telHref, mailHref, assetsOfKind, section } = require('../render');

/** Canonical order and long names. Matches services/pharmacies.js's DAYS. */
const DAY_ORDER = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DAY_NAMES = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
});
const SHORT_DAY_NAMES = Object.freeze({
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
});

/** 24h "20:00" as a human "8:00 pm". Pure, so the render stays deterministic. */
function humanTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  if (!m) return '';
  const h = Number(m[1]);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/**
 * Opening hours as "Mon – Fri" ranges rather than seven separate rows — used
 * by location's own compact "visit us" card (see below), not by the full
 * Opening hours block above, which is deliberately the un-collapsed version
 * for whoever wants every day spelled out.
 *
 * A run is two or more CONSECUTIVE days (Tue then Wed, never Tue then Thu)
 * that share the exact same value, closed or not — never days that merely
 * happen to match out of order, which would misstate the week.
 */
function groupedHours(hours) {
  const byDay = new Map((hours || []).filter((h) => h?.day).map((h) => [h.day, h]));
  const ordered = DAY_ORDER.filter((d) => byDay.has(d));
  const valueFor = (day) => {
    const h = byDay.get(day);
    const open = humanTime(h.open);
    const close = humanTime(h.close);
    return h.closed || !open || !close ? 'Closed' : `${open} – ${close}`;
  };

  const rows = [];
  let i = 0;
  while (i < ordered.length) {
    const value = valueFor(ordered[i]);
    let j = i;
    while (
      j + 1 < ordered.length
      && DAY_ORDER.indexOf(ordered[j + 1]) === DAY_ORDER.indexOf(ordered[j]) + 1
      && valueFor(ordered[j + 1]) === value
    ) j += 1;
    const label = i === j
      ? DAY_NAMES[ordered[i]]
      : `${SHORT_DAY_NAMES[ordered[i]]} – ${SHORT_DAY_NAMES[ordered[j]]}`;
    rows.push({ label, value });
    i = j + 1;
  }
  return rows;
}

/**
 * A no-API-key Google Maps embed, built from the pharmacy's OWN structured
 * address fields — never from `maps_url`. That field can be any shape a
 * person pasted (a share link, a shortened URL, a plain search link) and
 * there is no reliable way to turn an arbitrary one into an embeddable
 * "output=embed" URL; a plain text search on the address the owner already
 * typed works the same way regardless of what, if anything, they set there.
 */
function mapEmbedSrc(profile) {
  const query = [profile?.address_line, profile?.city, profile?.state].filter(Boolean).join(', ');
  return query ? `https://maps.google.com/maps?q=${encodeURIComponent(query)}&output=embed` : '';
}

const PIN_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const PHONE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 '
  + '19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>';
const CLOCK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';

const openingHours = {
  id: 'pharmacy.openingHours',
  version: 1,
  name: 'Opening hours',
  description: 'When the pharmacy is open, taken from your pharmacy profile.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    hours: { type: 'list', max: 7, from: 'profile.opening_hours', of: {
      day: { type: 'enum', values: [...DAY_ORDER], required: true },
      open: { type: 'text', max: 5 },
      close: { type: 'text', max: 5 },
      closed: { type: 'boolean' },
    } },
    note: { type: 'text', max: 200 },
  },

  defaults: { heading: 'Opening hours' },
  responsive: { layout: 'list' },

  editor: {
    label: 'Opening hours',
    singleton: true,
    removable: true,
    draggable: true,
    icon: 'clock',
    // Tells the guided builder to send the owner to Settings rather than
    // offering an inline edit that would create a divergent copy.
    editsProfileField: 'opening_hours',
  },

  a11y: 'A description list: each day is a <dt> and its hours the matching <dd>, so the pairing survives linearisation.',

  render(props) {
    const hours = props.hours || [];
    if (!hours.length) return '';

    const byDay = new Map(hours.filter((h) => h && h.day).map((h) => [h.day, h]));

    // Rendered in canonical order, not stored order. Two profiles holding the
    // same days in a different sequence must produce identical HTML, or the
    // published_html cache churns for no reason.
    const rows = DAY_ORDER.filter((d) => byDay.has(d)).map((d) => {
      const h = byDay.get(d);
      const open = humanTime(h.open);
      const close = humanTime(h.close);
      const value = h.closed || !open || !close ? 'Closed' : `${open} – ${close}`;
      return `<div class="rx-hours-row"><dt>${esc(DAY_NAMES[d])}</dt><dd>${esc(value)}</dd></div>`;
    }).join('');

    if (!rows) return '';
    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';
    const note = props.note ? `<p class="rx-hours-note">${esc(props.note)}</p>` : '';

    // A diptych rather than one narrow column pinned to the left margin.
    // Seven rows of times is about 32rem wide at most, and on a desktop that
    // left the right half of the section empty — which reads as a page that
    // ran out of things to say rather than as deliberate space. The heading
    // now holds that side.
    return section(this.id, `<div class="rx-split rx-split--top">`
      + `<div class="rx-split-copy">${heading}${note}</div>`
      + `<dl class="rx-hours">${rows}</dl>`
      + `</div>`);
  },
};

const location = {
  id: 'pharmacy.location',
  version: 1,
  name: 'Location',
  description: 'Where to find the pharmacy, with a link to directions.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    address: { type: 'text', max: 200, from: 'profile.address_line' },
    city: { type: 'text', max: 80, from: 'profile.city' },
    state: { type: 'text', max: 80, from: 'profile.state' },
    landmark: { type: 'text', max: 120, from: 'profile.landmark' },
    mapsUrl: { type: 'url', from: 'profile.maps_url' },
    directionsLabel: { type: 'text', max: 40 },
    // Everything below is only read by the 'cards' layout — see render().
    subheading: { type: 'text', max: 240 },
    phone: { type: 'phone', from: 'profile.phone' },
    // Only ever appears once there is a real number to call — see render() —
    // so this generic label is safe even though the number itself is not.
    phoneCtaLabel: { type: 'text', max: 40 },
    hours: { type: 'list', max: 7, from: 'profile.opening_hours', of: {
      day: { type: 'enum', values: [...DAY_ORDER], required: true },
      open: { type: 'text', max: 5 },
      close: { type: 'text', max: 5 },
      closed: { type: 'boolean' },
    } },
    // 'cards' is address, phone and hours as three cards beside a real map;
    // 'split' (the default) is the original address-and-photo diptych.
    layout: { type: 'enum', values: ['split', 'cards'] },
  },

  defaults: { heading: 'Find us', directionsLabel: 'Get directions', layout: 'split' },
  responsive: { layout: 'split', stackBelow: 768 },

  editor: { label: 'Location', singleton: true, removable: true, draggable: true, icon: 'map-pin' },

  a11y: 'Uses <address>, the element that exists for exactly this. Latitude and longitude are never rendered.',

  render(props, ctx) {
    // DELIBERATELY NOT RENDERED: profile.latitude / profile.longitude. They
    // are on the profile and could trivially be bound here, but a precise
    // coordinate is operational data, and the block brief is explicit that
    // private operational information stays off the public page. The maps
    // link is the customer-facing form of the same fact.
    const parts = [props.address, props.city, props.state].filter(Boolean);
    if (!parts.length && !props.landmark) return '';

    const lines = [
      parts.length ? `<p>${esc(parts.join(', '))}</p>` : '',
      props.landmark ? `<p class="rx-landmark">Near ${esc(props.landmark)}</p>` : '',
    ].filter(Boolean).join('');

    const maps = mapsHref(props.mapsUrl, ctx);
    const link = maps
      ? `<a class="rx-btn rx-btn-ghost" href="${esc(maps)}" rel="noopener noreferrer" target="_blank">${esc(props.directionsLabel)}</a>`
      : '';

    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';

    // CARDS (Metro): address, phone and hours as three cards beside a real,
    // live map. There WAS no embedded map here at all until this layout —
    // the published CSP had no frame-src, on the reasoning that loosening it
    // for a third-party frame on a page that also serves health content was
    // a bad trade for a picture of a street. Revisited deliberately, at the
    // owner's explicit request after that tradeoff was raised: the allowance
    // added to publicCsp() is exactly the two hosts Google's key-less
    // embed actually needs (verified directly, including its own redirect)
    // and nothing wider, and the map's query is built from the pharmacy's
    // own address fields — never from `mapsUrl`, which can be any shape a
    // person pasted and is not reliably convertible to an embed URL.
    if (props.layout === 'cards') {
      const area = [ctx?.profile?.city, ctx?.profile?.state].filter(Boolean).join(', ');
      const subheading = props.subheading || (area ? `Conveniently located in ${area}.` : '');
      const head = (heading || subheading)
        ? `<div class="rx-head rx-head--center">${heading}${subheading ? `<p>${esc(subheading)}</p>` : ''}</div>`
        : '';

      const addressCard = (parts.length || props.landmark)
        ? `<div class="rx-visit-card rx-visit-card--address"><span class="rx-visit-card-icon">${PIN_ICON}</span>`
          + `<div><h3>Address</h3><address class="rx-address">${lines}</address></div></div>`
        : '';

      const tel = telHref(props.phone, ctx);
      const phoneCard = (tel && props.phone)
        ? `<div class="rx-visit-card rx-visit-card--phone"><span class="rx-visit-card-icon">${PHONE_ICON}</span>`
          + `<div><h3>Phone</h3><p>${esc(props.phone)}</p>`
          + (props.phoneCtaLabel ? `<a class="rx-btn rx-btn-solid" href="${esc(tel)}">${esc(props.phoneCtaLabel)}</a>` : '')
          + '</div></div>'
        : '';

      const hourRows = groupedHours(props.hours);
      const hoursCard = hourRows.length
        ? `<div class="rx-visit-card rx-visit-card--hours"><span class="rx-visit-card-icon">${CLOCK_ICON}</span>`
          + '<div><h3>Opening Hours</h3>'
          + `<div class="rx-visit-hours">${hourRows.map((r) => `<div class="rx-visit-hours-row"><span>${esc(r.label)}</span>`
            + `<span class="rx-visit-hours-value${r.value === 'Closed' ? ' rx-visit-hours-closed' : ''}">${esc(r.value)}</span></div>`).join('')}</div>`
          + '</div></div>'
        : '';

      const cards = [addressCard, phoneCard, hoursCard].filter(Boolean).join('');
      if (!cards) return head ? section(this.id, head) : '';

      const mapSrc = mapEmbedSrc(ctx?.profile);
      const map = mapSrc
        ? `<div class="rx-visit-map"><iframe src="${esc(mapSrc)}" loading="lazy" `
          + 'referrerpolicy="no-referrer-when-downgrade" title="Map"></iframe></div>'
        : '';

      return section(this.id, `${head}<div class="rx-visit-grid"><div class="rx-visit-cards">${cards}</div>${map}</div>`);
    }

    // SPLIT (the default): the address beside a photograph, unchanged.
    const [photo] = assetsOfKind(ctx, 'gallery');
    const place = [ctx?.profile?.city, ctx?.profile?.state].filter(Boolean).join(', ');
    const alt = place
      ? `${ctx?.pharmacy?.name || 'The pharmacy'}, ${place}`
      : (ctx?.pharmacy?.name || '');
    const media = photo
      ? `<div class="rx-split-media"><img src="${esc(photo.url)}" alt="${esc(alt)}"`
        + `${photo.width && photo.height ? ` width="${photo.width}" height="${photo.height}"` : ''}`
        + ` loading="lazy" decoding="async" /></div>`
      : '';

    const copy = `<div class="rx-split-copy">${heading}<address class="rx-address">${lines}</address>${link}</div>`;
    return section(this.id, media ? `<div class="rx-split">${copy}${media}</div>` : copy);
  },
};

const contact = {
  id: 'pharmacy.contact',
  version: 1,
  name: 'Contact',
  description: 'Phone, WhatsApp and email — whichever the pharmacy has.',
  category: 'pharmacy',

  props: {
    heading: { type: 'text', max: 120 },
    phone: { type: 'phone', from: 'profile.phone' },
    whatsappNumber: { type: 'phone', from: 'pharmacy.public_whatsapp_number' },
    // No binding: there is no email column on pharmacy_profile today. When
    // one is added, this gains `from: 'profile.email'` and every existing
    // site inherits it without a data migration — which is the point of
    // bindings being declarative.
    email: { type: 'email' },
    address: { type: 'text', max: 200, from: 'profile.address_line' },
  },

  defaults: { heading: 'Contact us' },
  responsive: { layout: 'list' },

  editor: { label: 'Contact', singleton: true, removable: true, draggable: true, icon: 'phone' },

  a11y: 'Every contact method is a link with a visible label, so none of them is conveyed by an icon alone.',

  render(props, ctx) {
    const tel = telHref(props.phone, ctx);
    const wa = waHref(props.whatsappNumber, null, ctx);
    const mail = mailHref(props.email, ctx);

    // "Only render values that actually exist" — an empty row with a dangling
    // label reads as a broken page, and a tel: link to nothing is worse than
    // no link at all.
    const rows = [
      tel ? `<li><span class="rx-label">Phone</span> <a href="${esc(tel)}">${esc(props.phone)}</a></li>` : '',
      wa ? `<li><span class="rx-label">WhatsApp</span> <a href="${esc(wa)}" rel="noopener noreferrer" target="_blank">Message us</a></li>` : '',
      mail ? `<li><span class="rx-label">Email</span> <a href="${esc(mail)}">${esc(props.email)}</a></li>` : '',
      props.address ? `<li><span class="rx-label">Address</span> ${esc(props.address)}</li>` : '',
    ].filter(Boolean).join('');

    if (!rows) return '';
    const heading = props.heading ? `<h2>${esc(props.heading)}</h2>` : '';
    return section(this.id, `${heading}<ul class="rx-contact">${rows}</ul>`);
  },
};

module.exports = [openingHours, location, contact];
module.exports.humanTime = humanTime;
module.exports.DAY_ORDER = DAY_ORDER;
