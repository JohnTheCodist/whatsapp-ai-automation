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

const { esc, mapsHref, waHref, telHref, mailHref, section } = require('../render');

/** Canonical order and long names. Matches services/pharmacies.js's DAYS. */
const DAY_ORDER = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DAY_NAMES = Object.freeze({
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
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
    return section(this.id, `${heading}<dl class="rx-hours">${rows}</dl>${note}`);
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
  },

  defaults: { heading: 'Find us', directionsLabel: 'Get directions' },
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
    return section(this.id, `${heading}<address class="rx-address">${lines}</address>${link}`);
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
