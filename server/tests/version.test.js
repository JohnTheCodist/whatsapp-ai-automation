/**
 * server/config/version.js — resolving the deployed commit from .git.
 *
 * WHY THIS IS TESTED AND THE REST OF THE MODULE IS NOT
 * Everything else in version.js is a try/catch around a file read that is
 * allowed to fail. resolveHead is the part with branches, and the part whose
 * failure mode is silence: get it wrong and /api/health reports no commit at
 * all, which reads exactly like "this deploy predates the feature". A wrong
 * answer here is worse than no answer, because somebody will trust it while
 * deciding whether a fix is live.
 *
 * The packed-refs case is the one that matters in production. A fresh
 * `git clone` on a deploy box very often has no loose refs at all, so a
 * resolver that only reads .git/refs/heads/<branch> works perfectly on a
 * developer machine and returns null on every server it was written for.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveHead } = require('../config/version');

const SHA = '9d3d7cba04796d4a2e4485fa364f1fdd7702c9c6';
const OTHER = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee';

/** A .git reader backed by a plain object, so no test touches a real repo. */
const reader = (files) => (rel) => (Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null);

test('a detached HEAD is the commit itself', () => {
  assert.equal(resolveHead(SHA + '\n', reader({})), SHA);
});

test('a branch ref is followed to its loose file', () => {
  const got = resolveHead('ref: refs/heads/main\n', reader({ 'refs/heads/main': SHA + '\n' }));
  assert.equal(got, SHA);
});

test('a branch ref still resolves when the repo is packed', () => {
  // No loose ref at all — the shape of a fresh clone on a deploy box.
  const packed = [
    '# pack-refs with: peeled fully-peeled sorted',
    `${OTHER} refs/heads/other`,
    `${SHA} refs/heads/main`,
    `${OTHER} refs/remotes/origin/main`,
  ].join('\n');
  assert.equal(resolveHead('ref: refs/heads/main\n', reader({ 'packed-refs': packed })), SHA);
});

test('a peel line is not mistaken for a ref', () => {
  // "^<sha>" lines give the commit an annotated TAG points at. They follow the
  // tag's own line and belong to it; treating one as a ref would return the
  // wrong commit rather than none, which is the failure worth preventing.
  const packed = [
    `${OTHER} refs/tags/v1`,
    `^${SHA}`,
    `${SHA} refs/heads/main`,
  ].join('\n');
  assert.equal(resolveHead('ref: refs/heads/v1', reader({ 'packed-refs': packed })), null);
});

test('an unresolvable ref is null, never a guess', () => {
  assert.equal(resolveHead('ref: refs/heads/missing\n', reader({ 'packed-refs': `${SHA} refs/heads/main` })), null);
  assert.equal(resolveHead('ref: refs/heads/missing\n', reader({})), null);
});

test('junk in HEAD does not throw and does not invent a commit', () => {
  for (const junk of ['', '   ', 'not a ref', 'ref:', 'deadbeef']) {
    assert.equal(resolveHead(junk, reader({})), null, `HEAD ${JSON.stringify(junk)}`);
  }
});

test('a short or malformed loose ref is rejected rather than reported', () => {
  // A truncated ref file is corruption. Reporting "9d3d7cb" from it would look
  // like a real answer.
  assert.equal(resolveHead('ref: refs/heads/main\n', reader({ 'refs/heads/main': '9d3d7cb\n' })), null);
});
