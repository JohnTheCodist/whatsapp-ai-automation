/**
 * Real photographs for the small number of services a safe one exists for.
 *
 * DELIBERATELY THIN. This is not "a stock photo per service" — see
 * icons.js's header for why a photograph is the exception, not the rule.
 * Every entry here was individually sourced, licensed and eyeballed before
 * being added; see client/public/website-templates/services/NOTICE.md for
 * where each file came from, its license, and — just as important — which
 * services were searched for and rejected, and why. That file is the
 * record to update before adding another entry, not an afterthought.
 *
 * A REAL BAR, not a formality:
 *   - licensed for unlimited commercial redistribution with no attribution
 *     obligation (public domain / CC0 only — a CC-BY photo would need a
 *     visible credit on every one of potentially thousands of pharmacy
 *     sites, which is not a cost this feature is worth to a pharmacy owner
 *     who never chose it)
 *   - no third-party product branding legible in the shot (a specific
 *     manufacturer's logo on every unrelated pharmacy's site implies an
 *     affiliation that does not exist)
 *   - no identifiable person in frame
 *   - generic enough that showing it does not assert this pharmacy stocks
 *     one particular product or offers one particular sub-service it may
 *     not (this is why a COVID-19-labelled vaccine vial was rejected for a
 *     general "Vaccination Services" listing — a website builder that lets
 *     software assert what a real healthcare business specifically offers
 *     is exactly the failure health.js's whole design exists to prevent)
 *
 * SELF-HOSTED, so the published page's `img-src 'self'` CSP allows it with
 * no change to that policy — these are static files under client/public,
 * the same pattern templates.js's own preview images use, not fetched from
 * any third party at render time or at request time.
 *
 * Matched the same way icons.js matches an icon: through pages.js's own
 * service catalogue, so a photo and a page agree about what a service is.
 * No match, no photo — the caller falls back to the drawn icon.
 */

const { catalogueFor } = require('../pages');

const BASE = '/website-templates/services';

/**
 * slug -> { src, width, height, alt }. Both files are 640×480 (4:3), q72 JPEG.
 *
 * `alt` DESCRIBES THE PHOTOGRAPH, IT DOES NOT NAME THE PHARMACY. Every other
 * image on this page — the hero, About, the gallery — gets
 * `alt="<pharmacy name>, <area>"` because that is true of them: the owner
 * took those photos. It is not true of these. They are a stock photo of a
 * pile of tablets and a stock photo of a blood pressure cuff, sourced from
 * Wikimedia Commons (see NOTICE.md), and asserting via alt text that either
 * one depicts this specific pharmacy would be a false claim about a real
 * healthcare business — accessibility metadata is still a claim, and the
 * fact that a sighted visitor never reads it is exactly why it would go
 * unnoticed if it were wrong.
 */
const PHOTOS = Object.freeze({
  'prescription-refills': {
    src: `${BASE}/prescription-refills.jpg`, width: 640, height: 480,
    alt: 'Prescription tablets',
  },
  'blood-pressure-check': {
    src: `${BASE}/blood-pressure-check.jpg`, width: 640, height: 480,
    alt: 'A blood pressure monitor and cuff',
  },
});

/** A photo for this service name, or null — the caller decides the fallback. */
function servicePhotoFor(serviceName) {
  const entry = catalogueFor(serviceName);
  if (!entry) return null;
  return PHOTOS[entry.slug] || null;
}

module.exports = { servicePhotoFor, PHOTOS };
