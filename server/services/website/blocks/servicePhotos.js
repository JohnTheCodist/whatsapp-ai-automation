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
 * KEYED BY CATEGORY, NOT BY URL SLUG — the same category icons.js's
 * iconNameFor already sorts a service into (pill, heart, droplet, advice,
 * clipboard, van, syringe, shield). Sharing that function rather than
 * re-matching against pages.js's catalogue independently means a service
 * photo and its icon can never disagree about what a service is, and it is
 * also what lets these two photos cover more than the two exact service
 * names they were sourced for: any custom-typed service that resolves to
 * "pill" (mentions refill, prescription, dispensing, medicine, medication or
 * drug, and isn't caught by a more specific category first) gets the real
 * tablets photograph, not just the literal "Prescription Refills" toggle.
 * "heart" has no such keyword net in icons.js — it is reached only through
 * pages.js's own blood-pressure-check matcher — so it widens only as far as
 * that already does.
 *
 * SECOND ROUND, 2026-09-09: searched droplet (blood glucose), advice
 * (counselling), clipboard (screening), van (delivery) and syringe
 * (vaccination) again, seven more query variations each. Nothing cleared the
 * bar — Commons' free corpus for these specific modern medical objects is
 * either 19th/early-20th-century scanned journals (wrong content entirely)
 * or modern product photography licensed CC-BY/CC-BY-SA (a visible credit
 * requirement — see the "no attribution obligation" rule below — not a
 * one-off gap that a few more search terms would close). Recorded here so
 * the next attempt does not repeat the same seven queries expecting a
 * different result; NOTICE.md carries the specifics.
 */

const { iconNameFor } = require('./icons');

const BASE = '/website-templates/services';

/**
 * category -> { src, width, height, alt }. Both files are 640×480 (4:3), q72 JPEG.
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
  pill: {
    src: `${BASE}/prescription-refills.jpg`, width: 640, height: 480,
    alt: 'Prescription tablets',
  },
  heart: {
    src: `${BASE}/blood-pressure-check.jpg`, width: 640, height: 480,
    alt: 'A blood pressure monitor and cuff',
  },
});

/** A photo for this service name, or null — the caller decides the fallback. */
function servicePhotoFor(serviceName) {
  return PHOTOS[iconNameFor(serviceName)] || null;
}

module.exports = { servicePhotoFor, PHOTOS };
