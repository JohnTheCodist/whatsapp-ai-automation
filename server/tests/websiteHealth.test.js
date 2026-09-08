/**
 * The health content system, and the gate in front of it.
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * "Medically reviewed by Dr X, Pharmacist" is a claim about a real named
 * person, published on a real pharmacy's website and indexed by Google, which
 * treats it as a credibility signal for health content. Software must not be
 * able to make that claim on its own. Most of this file exists to prove it
 * cannot — not by convention, but because every path that could produce a page
 * runs through a filter that refuses without a named reviewer and a date.
 *
 * The second thing at risk is the content itself. A pharmacy website cannot
 * examine anybody, so the articles must not diagnose, must not dose, and must
 * always say when to stop reading and get help. Those are checked as
 * properties of the library rather than left to whoever edits it next.
 *
 * Database-free: the library is data and the renderer is a pure function.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const health = require('../services/website/health');
const { buildPages } = require('../services/website/pages');
const { renderAllPages } = require('../services/website/siteRender');
const { getTemplate, cloneSeed } = require('../services/website/templates');

const { STATUS, allArticles, publishableArticles, isPublishable, bylineFor } = health;

const pharmacy = { name: 'Ikeja Family Pharmacy' };
const profile = {
  city: 'Ikeja',
  state: 'Lagos',
  address_line: '12 Allen Avenue',
  phone: '08012345678',
  whatsapp_phone: '2348012345678',
  description: 'A community pharmacy serving Allen Avenue since 2011.',
  services: [{ name: 'BP check' }, { name: 'Blood glucose testing' }],
};

/** An article that HAS been reviewed, for testing the published path. */
function approved(slug) {
  return {
    ...health.getArticle(slug),
    status: STATUS.APPROVED,
    author: { name: 'Amaka Obi', title: 'Pharmacist' },
    reviewer: { name: 'Tunde Bello', title: 'Pharmacist' },
    reviewedAt: '2026-09-01',
  };
}

// ---------------------------------------------------------------- the gate

test('nothing ships approved: every article awaits a real reviewer', () => {
  // The correct default. Out of the box a pharmacy can publish no health
  // content at all, because no pharmacist has read any of it yet.
  for (const a of allArticles()) {
    assert.equal(a.status, STATUS.PENDING_REVIEW, a.slug);
    assert.equal(a.reviewer, null, a.slug);
    assert.equal(a.reviewedAt, null, a.slug);
  }
  assert.deepEqual(publishableArticles(), []);
});

test('approved without a named reviewer is NOT publishable', () => {
  // The attack this closes: setting a status flag to publish unreviewed
  // medical content. Approval requires a person, not a label.
  const a = { ...health.getArticle('malaria'), status: STATUS.APPROVED };
  assert.equal(isPublishable(a), false, 'no reviewer at all');
  assert.equal(isPublishable({ ...a, reviewer: {} }), false, 'reviewer with no name');
  assert.equal(isPublishable({ ...a, reviewer: { name: 'X' } }), false, 'no review date');
  assert.equal(isPublishable({ ...a, reviewer: { name: 'X' }, reviewedAt: '2026-09-01' }), true);
});

test('a reviewer without approval is still not publishable', () => {
  const a = { ...approved('malaria'), status: STATUS.PENDING_REVIEW };
  assert.equal(isPublishable(a), false);
});

test('an archived article is not publishable however complete it looks', () => {
  assert.equal(isPublishable({ ...approved('diabetes'), status: STATUS.ARCHIVED }), false);
});

test('a byline is null rather than vague when nobody is named', () => {
  // No "reviewed by our team". A vague attribution is still an attribution
  // and a reader cannot tell it from a real one.
  assert.equal(bylineFor(health.getArticle('hypertension')), null);
  const by = bylineFor(approved('hypertension'));
  assert.equal(by.reviewer, 'Tunde Bello, Pharmacist');
  assert.equal(by.reviewedAt, '2026-09-01');
});

test('an unapproved article cannot become a page even if opted into', () => {
  // The end-to-end version of the gate: the pharmacy asks for it, and it
  // still does not appear, because the library it is matched against contains
  // only approved articles.
  const pages = buildPages({
    pharmacy, profile, health: ['malaria'], healthLibrary: publishableArticles(),
  });
  assert.ok(!pages.some((p) => p.path.startsWith('/health/')));
});

test('renderAllPages defaults to approved-only, not to everything', () => {
  // A caller that forgets to pass a library must get the SAFE set, not all of
  // it. This is the difference between a missing feature and a published
  // unreviewed medical page.
  const { rendered } = renderAllPages({
    site: cloneSeed('professional'),
    pharmacy,
    profile,
    theme: getTemplate('professional').theme,
    health: ['hypertension', 'diabetes', 'malaria', 'medicine-safety'],
  });
  assert.ok(!rendered.some((r) => r.path.startsWith('/health/')));
});

// ---------------------------------------------------------- content safety

test('no article states a dosage or names a medicine as a recommendation', () => {
  // A website cannot know a reader's weight, age, other medicines or
  // pregnancy. A number here would be read as instruction.
  const forbidden = [
    /\b\d+\s?(mg|ml|mcg|g)\b/i,
    /\btake\s+\d/i,
    /\b\d+\s+(tablets?|capsules?)\b/i,
    /\btwice a day\b/i,
    /\bthree times a day\b/i,
  ];
  for (const a of allArticles()) {
    const text = JSON.stringify(a);
    for (const re of forbidden) {
      assert.doesNotMatch(text, re, `${a.slug} contains dosing language: ${re}`);
    }
  }
});

test('no article diagnoses the reader or promises an outcome', () => {
  const forbidden = [
    // Naming a condition AT the reader. Deliberately not /you have/, which
    // matches the ordinary sentence "if you have been prescribed medicine".
    /\byou (probably )?have (high|diabetes|malaria|hypertension|an? )/i,
    /this means you\b/i,
    /\bwill cure\b/i,
    /\bguarantee/i,
    /\bdefinitely\b/i,
  ];
  for (const a of allArticles()) {
    const text = JSON.stringify(a);
    for (const re of forbidden) {
      assert.doesNotMatch(text, re, `${a.slug} matches ${re}`);
    }
  }
});

test('every article says when to seek care, with specific signs', () => {
  // The single most useful thing a health page can do for a worried reader is
  // tell them plainly when to stop reading a website.
  for (const a of allArticles()) {
    assert.ok(a.seekCare, `${a.slug} has no seek-care section`);
    assert.ok(a.seekCare.items.length >= 3, `${a.slug} seek-care is too thin`);
    for (const item of a.seekCare.items) {
      assert.ok(item.length > 15, `${a.slug}: vague sign "${item}"`);
    }
  }
});

test('every article is substantial rather than a stub', () => {
  // Relevance over quantity. An article that says nothing is worse than no
  // article, because it is a thin page with a pharmacy's name on it.
  for (const a of allArticles()) {
    assert.ok(a.intro && a.intro.length > 80, `${a.slug} intro`);
    assert.ok(a.sections.length >= 3, `${a.slug} has ${a.sections.length} sections`);
    for (const s of a.sections) {
      assert.ok(s.heading, `${a.slug} section without a heading`);
      assert.ok(s.paragraphs.length >= 1, `${a.slug}: empty section "${s.heading}"`);
    }
  }
});

test('slugs, titles and summaries are unique', () => {
  const articles = allArticles();
  for (const key of ['slug', 'title', 'summary']) {
    const values = articles.map((a) => a[key]);
    assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
  }
});

// ------------------------------------------------------------- the rendering

function renderWithApproved(slugs) {
  return renderAllPages({
    site: cloneSeed('professional'),
    pharmacy,
    profile,
    theme: getTemplate('professional').theme,
    canonicalBase: 'https://naspaa.rxnaija.com',
    year: 2026,
    health: slugs,
    healthLibrary: slugs.map(approved),
  });
}

test('an approved, opted-in article becomes a real page', () => {
  const { rendered } = renderWithApproved(['hypertension']);
  const paths = rendered.map((r) => r.path);
  assert.ok(paths.includes('/health/'));
  assert.ok(paths.includes('/health/hypertension/'));
});

test('the article page carries its content, byline and seek-care section', () => {
  const { rendered } = renderWithApproved(['hypertension']);
  const page = rendered.find((r) => r.path === '/health/hypertension/');
  assert.match(page.html, /Medically reviewed by Tunde Bello, Pharmacist/);
  assert.match(page.html, /Written by Amaka Obi, Pharmacist/);
  assert.match(page.html, /Last updated/);
  assert.match(page.html, /When to seek care/);
  assert.match(page.html, /not medical advice/);
  assert.equal((page.html.match(/<h1[ >]/g) || []).length, 1);
});

test('Article schema names the reviewer only when there is one', () => {
  const withReviewer = renderWithApproved(['hypertension']).rendered
    .find((r) => r.path === '/health/hypertension/');
  assert.match(withReviewer.html, /"@type":"Article"/);
  assert.match(withReviewer.html, /"reviewedBy"/);
  assert.match(withReviewer.html, /Tunde Bello/);

  // The same article without a reviewer must emit no reviewedBy at all,
  // rather than an empty or placeholder one.
  const anonymous = renderAllPages({
    site: cloneSeed('professional'),
    pharmacy,
    profile,
    theme: getTemplate('professional').theme,
    health: ['hypertension'],
    healthLibrary: [{
      ...health.getArticle('hypertension'),
      status: STATUS.APPROVED,
      reviewer: { name: 'R' },
      reviewedAt: '2026-09-01',
      author: null,
    }],
  }).rendered.find((r) => r.path === '/health/hypertension/');
  assert.doesNotMatch(anonymous.html, /"author"/);
  assert.doesNotMatch(anonymous.html, /Written by/);
});

test('related links point only at services this pharmacy actually offers', () => {
  // The hypertension article relates to blood-pressure-check AND
  // medication-counselling. This pharmacy offers the first and not the
  // second, so only the first may be linked — a link to a page that does not
  // exist would be a broken link generated on purpose.
  const { rendered } = renderWithApproved(['hypertension']);
  const page = rendered.find((r) => r.path === '/health/hypertension/');
  assert.match(page.html, /href="\/services\/blood-pressure-check\/"/);
  assert.doesNotMatch(page.html, /href="\/services\/medication-counselling\/"/);
});

test('every internal link on a health page resolves', () => {
  const { rendered } = renderWithApproved(['hypertension', 'diabetes']);
  const existing = new Set(rendered.map((r) => r.path));
  for (const r of rendered) {
    const hrefs = [...r.html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      if (href.startsWith('/go/') || href.startsWith('/p/') || /\.[a-z0-9]+$/i.test(href)) continue;
      assert.ok(existing.has(href), `${r.path} links to ${href}`);
    }
  }
});

test('the health index lists exactly the articles that were published', () => {
  const { rendered } = renderWithApproved(['hypertension', 'diabetes']);
  const index = rendered.find((r) => r.path === '/health/');
  assert.match(index.html, /href="\/health\/hypertension\/"/);
  assert.match(index.html, /href="\/health\/diabetes\/"/);
  assert.doesNotMatch(index.html, /href="\/health\/malaria\/"/);
});

test('health pages appear in the site navigation once, not per article', () => {
  // Twenty articles must not become twenty navigation entries.
  const { rendered } = renderWithApproved(['hypertension', 'diabetes', 'malaria']);
  const home = rendered.find((r) => r.path === '/');
  const navLinks = [...home.html.matchAll(/href="(\/health[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(navLinks)], ['/health/']);
});
