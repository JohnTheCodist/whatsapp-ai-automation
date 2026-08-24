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
 * All are 24x24, currentColor, 2 stroke. Consistent weight matters more than
 * any individual glyph: mismatched stroke widths are the fastest way to make
 * a nav look assembled rather than designed. Was 1.6 — thin enough that
 * against the rest of the surface it read as tentative rather than drawn on
 * purpose; 2 is the same weight the reference chrome uses.
 *
 * EMOJI ARE NOT ICONS
 * A handful of screens used to reach for 🤖 / 👥 / 🛒 / 👤 / 🔕 / 💬 / ❤️ /
 * 📈 as a shortcut for "put something next to this label" — a robot for "AI
 * sales", a shopping cart for "order". Emoji are the single fastest way a
 * screen reads as generated rather than designed: they carry a platform's
 * own illustration style, not this one's, and render differently release to
 * release. Every one of those spots now draws from this file instead. See
 * design.md's Icon-chip section — the ban is on colourful pictographic
 * emoji specifically; a plain ✓ / ✗ / ★ rendered in the theme's ink colour
 * is a conventional status glyph, not this problem, and stays allowed.
 */

const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

export const IconOverview = (p) => (
  <svg {...base} {...p}>
    <path d="M3 13h4l2.5 6 4-14 2.5 8h5" />
  </svg>
);

/**
 * A handshake-over-counter, reduced: two halves meeting.
 * Not a shopping cart — this group is the whole exchange (asked, ordered,
 * couldn't supply), and a cart would claim it is only the buying part.
 */
export const IconDeals = (p) => (
  <svg {...base} {...p}>
    <path d="M3 8h4l3 3-2 2 4 4 2-2 3 3v3" />
    <path d="M21 8h-4l-3 3" />
    <path d="M3 8V6a1 1 0 0 1 1-1h3M21 8V6a1 1 0 0 0-1-1h-3" />
  </svg>
);

/**
 * A rising bar with a spark — the assistant's output, not a robot face.
 * A robot would say "this screen is about the AI"; the point of the screen is
 * what the AI produced, which is a trend.
 */
export const IconAi = (p) => (
  <svg {...base} {...p}>
    <path d="M4 20V10M9.5 20V5M15 20v-7" />
    <path d="M18.5 4.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
  </svg>
);

/** Shelved boxes — stock on a shelf, which is what a catalogue really is. */
export const IconInventory = (p) => (
  <svg {...base} {...p}>
    <path d="M3 7h18M3 12h18M3 17h18" />
    <path d="M7 7v5M14 12v5" />
  </svg>
);

/** Tray with an arrow going in. */
export const IconUpload = (p) => (
  <svg {...base} {...p}>
    <path d="M12 15V3M8 7l4-4 4 4" />
    <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
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

/**
 * The "there is more to say about this field" mark.
 *
 * Drawn at a lighter weight than the nav set: it sits beside a label rather
 * than in a rail, and at 1.6 next to 13px text it reads as a warning sign
 * instead of a quiet offer of help.
 */
export const IconInfo = (p) => (
  <svg {...base} strokeWidth={1.5} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.75v.5" />
  </svg>
);

/** Replaces the ❤️ emoji on the chronic register — see this file's header. */
export const IconHeart = (p) => (
  <svg {...base} {...p}>
    <path d="M12 20s-7-4.35-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 5c-2.5 4.65-9.5 9-9.5 9z" />
  </svg>
);

/** Replaces the 📈 emoji on the revenue & growth heading. */
export const IconTrendUp = (p) => (
  <svg {...base} {...p}>
    <path d="M3 16l6-6 4 4 8-8" />
    <path d="M15 6h6v6" />
  </svg>
);

/** A single person — the pharmacist-handoff timeline events, distinct from
 *  IconCustomers' two-person mark so "one pharmacist" reads differently from
 *  "the whole patient base". */
export const IconPerson = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);

/** Filled — a timeline marker, not a rating control, so it reads as a dot
 *  with a point rather than an invitation to click five of them. */
export const IconStar = (p) => (
  <svg {...base} fill="currentColor" stroke="none" {...p}>
    <path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z" />
  </svg>
);

/** "Customer notified" on the timeline — a reply going back out. */
export const IconReply = (p) => (
  <svg {...base} {...p}>
    <path d="M9 8 4 12l5 4" />
    <path d="M4 12h9a6 6 0 0 1 6 6v1" />
  </svg>
);

/** Points down when the account menu is shut, and is rotated when it is open. */
export const IconChevronDown = (p) => (
  <svg {...base} {...p}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/** A door with an arrow leaving it — not a power symbol, which reads as "shut
 *  the computer down" to someone glancing at a shop-floor screen. */
export const IconSignOut = (p) => (
  <svg {...base} {...p}>
    <path d="M15 17v1.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2V7" />
    <path d="M10 12h11m0 0-3-3m3 3-3 3" />
  </svg>
);

/** The connected-socket indicator. A plug, because that is what it means. */
export const IconLink = (p) => (
  <svg {...base} {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3A5 5 0 0 0 13.5 3.5L12 5" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3A5 5 0 0 0 10.5 20.5L12 19" />
  </svg>
);
