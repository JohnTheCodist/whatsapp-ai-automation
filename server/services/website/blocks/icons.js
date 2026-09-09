/**
 * The service icon set.
 *
 * DRAWN HERE, NOT FETCHED. Published pages carry `default-src 'none'`, so
 * there is no icon font, no sprite sheet and no CDN request — these are inline
 * SVG paths in the document, which is also why they cost no round trip on the
 * connection a Nigerian customer actually has. Adding an icon library would
 * mean loosening the CSP of a page about somebody's health to download a
 * picture of a pill.
 *
 * THE DEFAULT, STILL, IS A DRAWN MARK, NOT A PHOTOGRAPH. A photograph of
 * "blood pressure checks" is a stock image of somebody else's arm, on a real
 * pharmacy's website, implying it was taken there. The pharmacy's OWN
 * photographs go in the hero, About and Location; a service the renderer
 * cannot show a genuine photo of gets a drawn mark instead, which claims
 * nothing about a room that does not exist.
 *
 * A SMALL, DELIBERATE EXCEPTION: servicePhotos.js supplies a real photograph
 * for the handful of services where one could be sourced without that
 * problem — properly licensed, generic (no third-party product branding, no
 * identifiable person, no claim about a specific medical product this
 * pharmacy may not actually stock). The services block (definitions/
 * content.js) tries that first and falls back to the icon below when there
 * is none. See servicePhotos.js's own header for exactly which services
 * qualify and why most do not.
 *
 * MATCHED ON THE SERVICE THE OWNER TYPED, through pages.js's own catalogue —
 * the same matcher that decides a service's URL. So "BP check", "Blood
 * Pressure Monitoring" and "blood pressure test" get one icon for the same
 * reason they get one page. An unrecognised service gets the neutral mark
 * rather than a wrong one: a delivery van beside "Compounding" is worse than
 * no picture at all.
 *
 * Every path is a single 24×24 grid, stroked not filled, 1.6 units, round
 * caps and joins. One grid and one weight is what makes nine drawings read as
 * a set rather than as nine downloads.
 */

const { catalogueFor } = require('../pages');

/** The drawings. Keyed by an internal name, never by a service slug. */
const PATHS = Object.freeze({
  // A capsule, on the diagonal so it does not read as a battery.
  pill: '<g transform="rotate(-45 12 12)"><rect x="2.5" y="8.5" width="19" height="7" rx="3.5"/>'
    + '<path d="M12 8.5v7"/></g>',

  // A heart with a pulse across it — blood pressure, without a cuff nobody
  // would recognise at 24px.
  heart: '<path d="M12 20.4 4.9 13.3a4.6 4.6 0 0 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 0 1 6.5 6.5Z"/>'
    + '<path d="M5.5 12.4h3l1.4-2.6 2.2 5 1.6-3.3 1.1 1h3.7"/>',

  // A droplet — the finger-prick test.
  droplet: '<path d="M12 3.6c0 0 6 6.3 6 10.1a6 6 0 0 1-12 0c0-3.8 6-10.1 6-10.1Z"/>',

  // A speech bubble with a cross: talking to a pharmacist.
  advice: '<path d="M20 14.4A2.6 2.6 0 0 1 17.4 17H9.2L4.5 20.2V6.6A2.6 2.6 0 0 1 7.1 4h10.3A2.6 2.6 0 0 1 20 6.6Z"/>'
    + '<path d="M12.2 8.2v5M9.7 10.7h5"/>',

  // A clipboard with a tick — a screening, a review, a check carried out.
  clipboard: '<rect x="5" y="5" width="14" height="16" rx="2.2"/>'
    + '<path d="M9 5V3.9a.9.9 0 0 1 .9-.9h4.2a.9.9 0 0 1 .9.9V5"/>'
    + '<path d="M9.2 12.6l2.1 2.1 4.2-4.2"/>',

  // A van — home delivery.
  van: '<path d="M3 7.2h10.4v9.3H3z"/><path d="M13.4 10.4h3.5l3.1 3.4v2.7h-6.6z"/>'
    + '<circle cx="7" cy="17.6" r="1.9"/><circle cx="16.8" cy="17.6" r="1.9"/>',

  // A syringe — vaccination.
  syringe: '<g transform="rotate(-45 12 12)"><rect x="7.5" y="9.4" width="9" height="5.2" rx="1.1"/>'
    + '<path d="M16.5 12h4M3.5 12h4M10 9.4v5.2M12.5 9.4v5.2"/></g>',

  // A shield with a cross — the neutral mark, and the one an unrecognised
  // service gets.
  shield: '<path d="M12 3.2 19 6v5.4c0 4.2-2.8 7.6-7 9.4-4.2-1.8-7-5.2-7-9.4V6Z"/>'
    + '<path d="M12 9.4v5.2M9.4 12h5.2"/>',
});

/**
 * Which drawing a service gets.
 *
 * The canonical catalogue first, because that is the same decision that gives
 * the service its URL. Then a small keyword pass for the common services the
 * catalogue does not canonicalise (delivery, vaccination). Then the shield.
 */
const BY_SLUG = Object.freeze({
  'prescription-refills': 'pill',
  'blood-pressure-check': 'heart',
  'blood-glucose-testing': 'droplet',
  'medication-counselling': 'advice',
  'health-screening': 'clipboard',
});

const BY_KEYWORD = Object.freeze([
  [/\b(deliver|dispatch|courier)/i, 'van'],
  [/\b(vaccin|immunis|immuniz|jab)/i, 'syringe'],
  [/\b(review|screen|check|monitor|test)/i, 'clipboard'],
  [/\b(advice|counsel|consult|ask|talk)/i, 'advice'],
  [/\b(refill|prescription|dispens|medicine|medication|drug)/i, 'pill'],
]);

function iconNameFor(serviceName) {
  const entry = catalogueFor(serviceName);
  if (entry && BY_SLUG[entry.slug]) return BY_SLUG[entry.slug];
  const text = String(serviceName || '');
  for (const [pattern, name] of BY_KEYWORD) {
    if (pattern.test(text)) return name;
  }
  return 'shield';
}

/**
 * One icon, as inline SVG.
 *
 * aria-hidden and focusable="false": the service name sits beside it and is
 * the accessible label. An icon announced as "graphic" before every heading
 * is noise in a screen reader, and a focusable SVG is a tab stop that goes
 * nowhere — which is worse than useless on a page a person is trying to get
 * a phone number out of.
 *
 * `name` may be an explicit icon name from the block's enum, in which case it
 * wins; otherwise it is matched from the service's own name.
 */
/**
 * The block contract's icon enum, in its own words, mapped onto the drawings.
 *
 * The enum is `pill · syringe · delivery · test · advice · baby · heart` and
 * predates this file. Renaming it would invalidate every stored block that
 * already carries one of those values, so the enum stays and this translates.
 * `baby` has no drawing and resolves to the neutral mark rather than to
 * something that would be wrong.
 */
const FROM_ENUM = Object.freeze({
  pill: 'pill',
  syringe: 'syringe',
  delivery: 'van',
  test: 'droplet',
  advice: 'advice',
  heart: 'heart',
  baby: 'shield',
});

function serviceIcon(serviceName, explicit) {
  const named = explicit && (FROM_ENUM[explicit] || (PATHS[explicit] ? explicit : null));
  const key = named || iconNameFor(serviceName);
  return `<svg class="rx-svg" viewBox="0 0 24 24" width="24" height="24" fill="none"`
    + ` stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false">${PATHS[key]}</svg>`;
}

module.exports = { serviceIcon, iconNameFor, PATHS };
