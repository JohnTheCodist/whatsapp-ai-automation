/**
 * Which pages a pharmacy's website has, and what each one is about.
 *
 * ONE MODEL, CONSUMED BY EVERYTHING. The router serves from it, the sitemap
 * is generated from it, breadcrumbs and internal links are built from it, and
 * every page's title and description come out of it. That is the point: the
 * commonest SEO failure in a generated site is a sitemap listing pages that
 * do not exist, or a page nothing links to, and both are impossible when one
 * function is the only thing that decides what exists.
 *
 * PAGES ARE DERIVED, NEVER STORED AS A LIST. A pharmacy that adds "Blood
 * glucose testing" to its profile gains /services/blood-glucose-testing/ and
 * a sitemap entry, with nothing to publish separately and nothing to tidy up
 * when it removes it again. The owner manages a business profile; the site
 * map is a consequence.
 *
 * NOTHING IS INVENTED. A page exists only when the pharmacy has the
 * information the page would be about — no address, no /location/; no
 * services, no /services/. A generated page with nothing real on it is worse
 * than no page: it is a thin page, and Google is explicit that a site full of
 * them ranks worse than a small site that is entirely substantial.
 *
 * PURE. No database, no I/O, no clock. Everything here is a function of the
 * pharmacy row and its profile, which is what makes the whole site map
 * testable without a database and identical between the renderer, the
 * sitemap and the router.
 */

/** Canonical service slugs, so a common service gets a stable, searched URL. */
const SERVICE_CATALOGUE = [
  {
    slug: 'prescription-refills',
    // Matched loosely against whatever the owner actually typed. Owners write
    // "Refills", "Prescription refill", "Repeat prescriptions" — all the same
    // page to a searcher, and giving them one canonical URL is the difference
    // between one page with authority and four thin ones competing.
    match: /\b(refill|repeat)\b.*\b(prescription|medic)|\bprescription\b.*\brefill/i,
    label: 'Prescription Refills',
    summary: 'Repeat prescriptions dispensed and ready for collection.',
  },
  {
    slug: 'blood-pressure-check',
    match: /\b(blood\s*pressure|bp)\b.*\b(check|test|monitor)|\b(check|test)\b.*\bblood\s*pressure/i,
    label: 'Blood Pressure Checks',
    summary: 'Have your blood pressure measured and recorded by pharmacy staff.',
  },
  {
    slug: 'blood-glucose-testing',
    match: /\b(blood\s*)?(glucose|sugar)\b.*\b(test|check|monitor)|\b(test|check)\b.*\b(glucose|blood\s*sugar)/i,
    label: 'Blood Glucose Testing',
    summary: 'Blood sugar testing for people managing or monitoring diabetes.',
  },
  {
    slug: 'medication-counselling',
    match: /\b(medicat|medicine|drug)\w*\b.*\b(counsel|advice|review|adherence)|\bcounsel\w*\b.*\bmedic/i,
    label: 'Medication Counselling',
    summary: 'Talk to a pharmacist about how to take your medicines safely.',
  },
  {
    slug: 'health-screening',
    match: /\bhealth\s*(screen|check)\w*|\bscreening\b/i,
    label: 'Health Screening',
    summary: 'Routine checks that help catch a problem before it becomes urgent.',
  },
];

/**
 * A URL path segment from arbitrary text.
 *
 * Deliberately strict and lossy. This value ends up in a URL, in a sitemap,
 * in a canonical tag and in an internal link, and every one of those is a
 * place where an unexpected character is a bug rather than a cosmetic issue.
 * Anything that does not survive becomes null and the caller drops the page,
 * because a page at an unpredictable URL is worse than one page fewer.
 */
function slugify(text) {
  const slug = String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFKD')
    // Strip accents rather than percent-encoding them. "Chemêst" and "Chemest"
    // should not be two different URLs.
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (!slug) return null;
  // A purely numeric segment reads as an id, not a subject.
  if (/^[0-9]+$/.test(slug)) return null;
  return slug;
}

/** The catalogue entry a typed service name corresponds to, or null. */
function catalogueFor(name) {
  const text = String(name || '');
  return SERVICE_CATALOGUE.find((entry) => entry.match.test(text)) || null;
}

/** Does the profile carry enough of an address to justify a location page? */
function hasLocation(profile) {
  return Boolean(profile?.address_line || profile?.city || profile?.state);
}

/** The town or city used in titles. The single highest-value local SEO token. */
function placeOf(profile) {
  return profile?.city || profile?.state || null;
}

/**
 * "Ikeja, Lagos" — area and city together where both are known.
 *
 * Searchers type a neighbourhood far more often than a state, so the finer
 * grain leads. Falls back cleanly when only one is set.
 */
function areaOf(profile) {
  const parts = [profile?.city, profile?.state].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * The services this pharmacy actually offers, as pages.
 *
 * Duplicates collapse on slug: two entries that both mean "BP check" would
 * otherwise become two URLs with the same content, which is the classic
 * self-inflicted duplicate-content problem.
 */
function servicePages(pharmacy, profile) {
  const raw = Array.isArray(profile?.services) ? profile.services : [];
  const seen = new Set();
  const out = [];

  for (const item of raw) {
    const name = String(item?.name || '').trim();
    if (!name) continue;

    const entry = catalogueFor(name);
    const slug = entry ? entry.slug : slugify(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    // The owner's own words win over ours. Our summary exists so a page is
    // never empty, not so it can overwrite something a pharmacist wrote.
    const description = String(item?.description || '').trim() || (entry ? entry.summary : '');

    out.push({
      path: `/services/${slug}/`,
      kind: 'service',
      name,
      label: entry ? entry.label : name,
      description,
      slug,
    });
  }
  return out;
}

/**
 * Every page on this pharmacy's site, in the order they should be linked.
 *
 * @param {object} args
 * @param {object} args.pharmacy  the pharmacies row (name)
 * @param {object} args.profile   the pharmacy_profile row (NAP, services)
 * @param {string[]} args.health  slugs of health topics the OWNER has enabled
 * @param {object[]} args.healthLibrary  available health articles
 * @returns {object[]} pages
 */
function buildPages({ pharmacy, profile, health = [], healthLibrary = [] } = {}) {
  const name = String(pharmacy?.name || 'Our pharmacy').trim() || 'Our pharmacy';
  const place = placeOf(profile);
  const area = areaOf(profile);
  const services = servicePages(pharmacy, profile);

  const pages = [];

  pages.push({
    path: '/',
    kind: 'home',
    // Not "Home". A title tag is a search result heading, and "Home" says
    // nothing a searcher was looking for.
    title: place ? `${name} — Pharmacy in ${place}` : `${name} — Pharmacy`,
    h1: area ? `Trusted community pharmacy in ${area}` : `${name}`,
    nav: 'Home',
  });

  // /about/ needs the pharmacy to have said something about itself. Without a
  // description this page would be the name and nothing else.
  if (profile?.description) {
    pages.push({
      path: '/about/',
      kind: 'about',
      title: place ? `About ${name} — Pharmacy in ${place}` : `About ${name}`,
      h1: `About ${name}`,
      nav: 'About',
    });
  }

  if (services.length) {
    pages.push({
      path: '/services/',
      kind: 'services',
      title: place ? `Pharmacy Services in ${place} — ${name}` : `Services — ${name}`,
      h1: area ? `Pharmacy services in ${area}` : 'Our services',
      nav: 'Services',
      children: services.map((s) => s.path),
    });
    for (const service of services) {
      pages.push({
        ...service,
        title: place ? `${service.label} in ${place} — ${name}` : `${service.label} — ${name}`,
        h1: area ? `${service.label} in ${area}` : service.label,
        nav: service.label,
        parent: '/services/',
      });
    }
  }

  if (hasLocation(profile)) {
    pages.push({
      path: '/location/',
      kind: 'location',
      title: area ? `Find ${name} in ${area} — Address & Opening Hours` : `Find ${name}`,
      h1: area ? `Find us in ${area}` : 'Find us',
      nav: 'Location',
    });
  }

  // Contact is unconditional: a pharmacy that has published a website has, at
  // minimum, a WhatsApp number, because that is what the platform is.
  pages.push({
    path: '/contact/',
    kind: 'contact',
    title: place ? `Contact ${name} — Pharmacy in ${place}` : `Contact ${name}`,
    h1: `Contact ${name}`,
    nav: 'Contact',
  });

  // Health articles are OPT-IN and come from a reviewed library. See
  // health.js for why none of this is generated per pharmacy.
  const enabled = healthLibrary.filter((a) => health.includes(a.slug));
  if (enabled.length) {
    pages.push({
      path: '/health/',
      kind: 'healthIndex',
      title: `Health Information — ${name}`,
      h1: 'Health information',
      nav: 'Health',
      children: enabled.map((a) => `/health/${a.slug}/`),
    });
    for (const article of enabled) {
      pages.push({
        path: `/health/${article.slug}/`,
        kind: 'health',
        slug: article.slug,
        title: `${article.title} — ${name}`,
        h1: article.title,
        nav: article.title,
        parent: '/health/',
        description: article.summary,
      });
    }
  }

  return pages;
}

/** The subset that belongs in the top navigation: one level, in order. */
function navPages(pages) {
  return pages.filter((p) => !p.parent && p.kind !== 'home');
}

/** Breadcrumb trail for a page, home first, the page itself last. */
function breadcrumbsFor(pages, path) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const page = byPath.get(path);
  if (!page || page.path === '/') return [];

  const trail = [{ path: '/', label: 'Home' }];
  if (page.parent && byPath.has(page.parent)) {
    const parent = byPath.get(page.parent);
    trail.push({ path: parent.path, label: parent.nav });
  }
  trail.push({ path: page.path, label: page.nav });
  return trail;
}

module.exports = {
  buildPages,
  navPages,
  breadcrumbsFor,
  servicePages,
  slugify,
  catalogueFor,
  SERVICE_CATALOGUE,
};
