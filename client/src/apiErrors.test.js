/**
 * What a pharmacist is told when the API does not answer properly.
 *
 * THE FAILURE THIS FILE COMES FROM, 2026-10-04: the local API was down while
 * the dashboard was up. Every screen that called `res.json()` on the empty
 * body got a browser internal —
 *
 *     Failed to execute 'json' on 'Response': Unexpected end of JSON input
 *
 * — which is what the owner saw. It is not a fact about their pharmacy, it
 * does not say whether their work was saved, and it is not actionable.
 *
 * §34 of the Messages and Consultation briefs both say the same thing: the
 * interface must clearly show when something did not happen, and must never
 * make a failure look like a success.
 *
 * These tests run the REAL `readJson` out of each screen, extracted from the
 * source, so they cannot drift from the thing that actually runs.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Pull `readJson` out of a screen and make it callable. */
function readJsonFrom(file) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  const at = src.indexOf('async function readJson(res) {');
  expect(at, `${file} has no readJson`).toBeGreaterThan(-1);
  // The function ends at the first line that is exactly "}" at column 0.
  const end = src.indexOf('\n}\n', at);
  expect(end, `${file}: could not find the end of readJson`).toBeGreaterThan(at);
  const body = src.slice(at, end + 3);
  return new Function(`${body}; return readJson;`)();
}

/** A Response whose body is not JSON — what a dead API behind a proxy sends. */
const unreadable = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
});

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

const SCREENS = ['Consultation.jsx', 'PatientMessages.jsx'];

// THE MOST IMPORTANT TEST IN THIS FILE.
test.each(SCREENS)('%s never shows a browser internal when the API is down', async (file) => {
  const readJson = readJsonFrom(file);

  // A dead API behind the dev proxy: 500 with an empty body.
  await expect(readJson(unreadable(500))).rejects.toThrow(/pharmacy server is not responding/i);

  try {
    await readJson(unreadable(502));
    throw new Error('an unreadable reply was accepted');
  } catch (e) {
    // The exact string the owner saw must never reach a pharmacist.
    expect(e.message).not.toMatch(/Failed to execute/i);
    expect(e.message).not.toMatch(/Unexpected end of JSON input/i);
    expect(e.message).not.toMatch(/SyntaxError/i);
    // And it says what to do, rather than only that something broke.
    expect(e.message).toMatch(/try again/i);
  }
});

test.each(SCREENS)('%s does not report success for a reply it could not read', async (file) => {
  const readJson = readJsonFrom(file);
  // A 200 whose body is not JSON is still a failure: we asked for JSON and got
  // something else, so returning {} would make the screen render an empty note
  // as though it had loaded.
  await expect(readJson(unreadable(200))).rejects.toThrow(/could not read/i);
});

test.each(SCREENS)('%s still passes the server\'s own message through', async (file) => {
  const readJson = readJsonFrom(file);
  // The whole point of the server naming its errors (errorHandler carries
  // `field` and `code`) is that the screen shows THAT, not a generic sentence.
  await expect(readJson(json(400, { error: 'Say why you are referring.', code: 'INVALID' })))
    .rejects.toThrow('Say why you are referring.');

  try {
    await readJson(json(409, { error: 'Already finalised.', code: 'ALREADY_FINALISED' }));
  } catch (e) {
    expect(e.code).toBe('ALREADY_FINALISED');
    expect(e.status).toBe(409);
  }
});

test.each(SCREENS)('%s returns the body on success', async (file) => {
  const readJson = readJsonFrom(file);
  expect(await readJson(json(200, { id: 'c1', status: 'draft' }))).toEqual({ id: 'c1', status: 'draft' });
  // An empty object is a legitimate JSON body and must NOT be treated as
  // unreadable — only a body that fails to parse is.
  expect(await readJson(json(200, {}))).toEqual({});
});
