/**
 * The navigation icon set.
 *
 * Inline SVG rather than an icon package: the rest of this app loads nothing
 * from a CDN, and a nav that renders as empty boxes because a font failed is
 * worse than one that ships a few hundred bytes of path data.
 *
 * Each icon is chosen for what the section DOES, not for a generic metaphor —
 * a stethoscope for consultations rather than a speech bubble, a pill for the
 * catalogue rather than a box. Staff should be able to learn the rail once
 * and then hit it without reading.
 *
 * All are 24x24, currentColor, 1.6 stroke. Consistent weight matters more
 * than any individual glyph: mismatched stroke widths are the fastest way to
 * make a nav look assembled rather than designed.
 */

const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

export const IconOverview = (p) => (
  <svg {...base} {...p}>
    <path d="M3 13h4l2.5 6 4-14 2.5 8h5" />
  </svg>
);

/** Stethoscope — a pharmacist, not a chat. */
export const IconConsultations = (p) => (
  <svg {...base} {...p}>
    <path d="M5 3v6a4 4 0 0 0 8 0V3" />
    <path d="M5 3H3.5M13 3h1.5" />
    <path d="M9 13v2a5 5 0 0 0 10 0v-1" />
    <circle cx="19" cy="12" r="2" />
  </svg>
);

export const IconInbox = (p) => (
  <svg {...base} {...p}>
    <path d="M4 13h4l1.5 3h5L16 13h4" />
    <path d="M5.5 5h13l1.5 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z" />
  </svg>
);

export const IconOrders = (p) => (
  <svg {...base} {...p}>
    <path d="M3 4h2l2 11h10l2-7H7" />
    <circle cx="9" cy="19" r="1.4" />
    <circle cx="17" cy="19" r="1.4" />
  </svg>
);

/** A pill — things asked for that the shelf could not supply. */
export const IconRequests = (p) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-30 12 12)" />
    <path d="M8.4 6.6 15.6 17.4" />
  </svg>
);

export const IconCustomers = (p) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19a6 6 0 0 1 12 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 19a5.5 5.5 0 0 0-2-4.3" />
  </svg>
);

export const IconSetup = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const IconSearch = (p) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconBellOn = (p) => (
  <svg {...base} {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
    <path d="M13.7 20a2 2 0 0 1-3.4 0" />
  </svg>
);

export const IconBellOff = (p) => (
  <svg {...base} {...p}>
    <path d="M18 8a6 6 0 0 0-9.3-5" />
    <path d="M6.3 6.3A6 6 0 0 0 6 8c0 6-2 7-2 7h13" />
    <path d="M13.7 20a2 2 0 0 1-3.4 0" />
    <path d="m3 3 18 18" />
  </svg>
);

/** The connected-socket indicator. A plug, because that is what it means. */
export const IconLink = (p) => (
  <svg {...base} {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3A5 5 0 0 0 13.5 3.5L12 5" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3A5 5 0 0 0 10.5 20.5L12 19" />
  </svg>
);
