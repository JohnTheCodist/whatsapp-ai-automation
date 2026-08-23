/**
 * fuzzyResolveGeneric — the NAFDAC anchor productBuilder uses to tell a
 * typo from a second, genuinely different drug.
 *
 * The ambiguity-guard test matters most here: a small edit distance alone is
 * not evidence of a typo, because real, different drugs can sit one or two
 * edits apart (Hydralazine/Hydroxyzine, Prednisone/Prednisolone — a known
 * medication-safety hazard, not a hypothetical one). The function must
 * refuse to pick between two equally-close real generics rather than guess.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fuzzyResolveGeneric, loadNafdac } = require('../services/ingestion/nafdacLookup');

test('an exact generic name resolves as a canonicalisation, not a correction', () => {
  const result = fuzzyResolveGeneric('Ciprofloxacin');
  assert.ok(result);
  assert.equal(result.matchType, 'exact');
});

test('a misspelling close to exactly one real generic resolves to it', () => {
  const result = fuzzyResolveGeneric('Cirpofloxacin');
  assert.ok(result, 'expected a fuzzy NAFDAC match');
  assert.equal(result.matchType, 'fuzzy');
  assert.equal(result.generic, 'Ciprofloxacin');
});

test('a short misspelling does not fuzzy-match even when one edit from a real generic', () => {
  // "Zonc" is one edit from the real generic "Zinc" — but below the length
  // floor, a couple of edits reaches too much of the index to mean anything,
  // so this must stay unresolved even though a longer word this close would
  // resolve. (The exact spelling "Zinc" still resolves — see above — this
  // guards fuzzy matching specifically, not short generics in general.)
  assert.equal(fuzzyResolveGeneric('Zonc'), null);
});

test('unrelated text finds nothing', () => {
  assert.equal(fuzzyResolveGeneric('Xylophone Bicycle Rocket'), null);
});

test('two real, distinct drugs equidistant from a typo are never picked between', () => {
  const csvPath = path.join(os.tmpdir(), `nafdac-ambiguity-test-${process.pid}.csv`);
  const header = 'brand_name,category,nafdac_no,form,route,strength,registration_date,status,generic,'
    + 'therapeutic_group,therapeutic_subgroup,company';
  // "Alphazane" is one edit from BOTH of these — the look-alike-sound-alike
  // scenario the ambiguity guard exists for.
  const rows = [
    'Alpha Brand,Drugs,X1-0001,Tablet,Oral,10mg,2023,Active,Alphazine,Anti-Infectives,Antibiotic,Test Co',
    'Beta Brand,Drugs,X1-0002,Tablet,Oral,10mg,2023,Active,Alphazone,Anti-Infectives,Antibiotic,Test Co',
  ];
  fs.writeFileSync(csvPath, [header, ...rows].join('\n'), 'utf-8');

  try {
    const loaded = loadNafdac(csvPath);
    assert.ok(loaded.success, loaded.error);

    assert.equal(
      fuzzyResolveGeneric('Alphazane'), null,
      'a tie between two real, different drugs must never be resolved by guessing',
    );
  } finally {
    loadNafdac(); // restore the real dataset for any other test sharing this process
    fs.rmSync(csvPath, { force: true });
  }
});
