/**
 * What the dictation microphone says, and what it does to a box somebody may
 * already have typed in.
 *
 * The failure each test defends against is a specific sentence or a specific
 * lost keystroke in front of a pharmacist at a counter.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DICTATE_START, DICTATE_STOP, DICTATE_SENDING, dictationError, mergeDictation,
} from './dictation.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const BUTTON = fs.readFileSync(path.join(SRC, 'DictateButton.jsx'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

/**
 * The file with its comments removed.
 *
 * The last assertion in this file failed on the component’s own header,
 * which explains at length that dictation is NOT the consultation scribe —
 * so a substring search for "consultation" found the prose arguing it is
 * absent. Third time in one session, after GOLDEN-006 and the Workflows
 * route: a text-matching invariant has to read code, or it ends up pinning
 * the documentation instead of the thing documented.
 */
const codeOnly = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

test('every failure names the next move, not just the fault', () => {
  // "Dictation failed" is a fact about the software. The scribe learned this
  // the expensive way: an unreachable provider came back as a masked 500
  // that told a pharmacist nothing, least of all that the note had to be
  // typed — which is the designed degradation.
  for (const code of ['NO_MICROPHONE', 'NOTHING_HEARD', 'DICTATION_TOO_LONG',
    'DICTATION_TOO_LARGE', 'BAD_AUDIO', 'LLM_UNAVAILABLE', null, 'SOMETHING_NEW']) {
    const msg = dictationError({ code });
    expect(msg.length, `${code} has no message`).toBeGreaterThan(0);
    expect(msg, `${code} does not say what to do instead`).toMatch(/typ/i);
  }
});

test('a refused microphone is not described as a fault', () => {
  // Declining the microphone is a normal answer. A sentence that reads like
  // an accusation about a permission somebody deliberately withheld is the
  // wrong tone at a counter.
  const msg = dictationError({ code: 'NO_MICROPHONE' });
  expect(msg).toMatch(/no microphone/i);
  expect(msg).not.toMatch(/error|failed|denied|refused/i);
});

test('the length limit is explained as what dictation is FOR', () => {
  // The cap is a safety property — it is what stops this becoming a second,
  // ungated way to record a patient. The sentence should not apologise for
  // it as though it were a defect.
  const msg = dictationError({ code: 'DICTATION_TOO_LONG' });
  expect(msg).toMatch(/short phrases/i);
  expect(msg).not.toMatch(/sorry|unfortunately|limit exceeded/i);
});

test('an unknown failure never quotes the provider back', () => {
  // The provider's own message can contain the audio it heard. Putting that
  // on screen would show somebody their own spoken words in an error.
  const msg = dictationError({ code: 'WHATEVER', error: 'heard: my patient has chest pain' });
  expect(msg).not.toMatch(/chest pain/);
  expect(msg).toMatch(/type it instead/i);
});

test('dictated words are APPENDED to what was typed, never replacing it', () => {
  // Somebody who typed "ngozi" and then spoke "refills due" meant both.
  // Replacing silently deletes what they typed, in the one place that is
  // least expected — a box they are looking at.
  expect(mergeDictation('ngozi', 'refills due')).toBe('ngozi refills due');
  expect(mergeDictation('', 'refills due')).toBe('refills due');
  expect(mergeDictation('ngozi', '')).toBe('ngozi');
  expect(mergeDictation('  ngozi  ', '  refills  ')).toBe('ngozi refills');
  expect(mergeDictation(null, null)).toBe('');
});

test('the three labels say what the control is doing, in that moment', () => {
  // A microphone that silently does nothing is the thing people press twice,
  // and a second press while the first recording is still being read is how
  // a sentence gets lost.
  expect(DICTATE_START).toBeTruthy();
  expect(DICTATE_STOP).toBeTruthy();
  expect(DICTATE_SENDING).toBeTruthy();
  expect(new Set([DICTATE_START, DICTATE_STOP, DICTATE_SENDING]).size).toBe(3);
});

test('the control stops itself at the server’s cap', () => {
  // Without this the server refuses at the limit and whoever was speaking
  // loses the sentence. A safety limit discovered by losing work is a limit
  // people start working around.
  expect(BUTTON).toMatch(/cap\?\.maxSeconds/);
  expect(BUTTON).toMatch(/if \(n <= 1\) \{ stop\(\); return 0; \}/);
});

test('the microphone is released, including on unmount', () => {
  // The browser keeps the tab's recording indicator lit until every track is
  // stopped. A pharmacy laptop showing a live microphone all afternoon is
  // its own problem, and navigating away mid-recording is the common way in.
  expect(BUTTON).toMatch(/getTracks\?\.\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  expect(BUTTON).toMatch(/useEffect\(\(\) => release, \[release\]\)/);
});

test('the button is absent when it could not work', () => {
  // A microphone that cannot work is worse than none: somebody speaks a
  // whole sentence into it before finding out.
  expect(BUTTON).toMatch(/if \(cap && !cap\.available\) return null;/);
  expect(BUTTON).toMatch(/if \(!canRecordAudio\(\)\) return null;/);
});

test('recording is carried by motion, never by red', () => {
  // design.md reserves red for a person waiting on a human. Somebody
  // dictating a search is not that, and a red control here teaches staff to
  // discount red on the screen where it means a patient is waiting.
  expect(BUTTON).not.toMatch(/bg-red-|text-red-/);
  expect(CSS).toMatch(/\.ui-home-tool\.is-recording \{/);
  expect(CSS).toMatch(/@keyframes ui-dictate-pulse/);
  // And the one thing saying the microphone is open must survive reduced
  // motion rather than vanishing with the animation.
  const reduced = CSS.slice(CSS.indexOf('@keyframes ui-dictate-pulse'));
  expect(reduced).toMatch(/prefers-reduced-motion[\s\S]*is-recording[\s\S]*opacity: 1/);
});

test('dictation never reaches a consultation or a patient', () => {
  // This is the line between dictation and the scribe. The scribe records a
  // patient, with consent, onto a note. This fills a search box.
  expect(BUTTON).toMatch(/\/api\/dictate/);
  const code = codeOnly(BUTTON);
  expect(code, 'the dictation button reached for a consultation')
    .not.toMatch(/consultation/i);
  expect(code, 'the dictation button reached for a patient')
    .not.toMatch(/customers\//i);
});
