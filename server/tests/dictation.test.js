/**
 * Dictation — a pharmacist speaking their own words into a search box.
 *
 * DATABASE-FREE, all of it. The provider is stubbed through `global.fetch`,
 * so these run on an unconfigured machine, which AGENTS.md calls the
 * committed default.
 *
 * WHAT THESE DEFEND. Dictation and the scribe both open a microphone in a
 * pharmacy, and only one of them is allowed to hear a patient. The scribe is
 * bound to a consultation and gated on consent recorded under 0071.
 * Dictation has no patient at all — so the thing that must never happen is
 * dictation quietly becoming a second, ungated way to transcribe somebody.
 *
 * Three properties stop that, and none is a rule anybody has to remember:
 * a short cap measured against the AUDIO rather than the file, no
 * diarization ever requested, and nothing stored.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_FILE = path.join(__dirname, '..', 'services', 'ai', 'dictation.js');
const ROUTE_FILE = path.join(__dirname, '..', 'routes', 'dictation.js');
/**
 * A file with its comments removed.
 *
 * Written after two of the tests below failed on their own explanation:
 * the header says "NO DIARIZATION IS REQUESTED" and the route says "there
 * is no :id", so a plain substring search found both words in the prose
 * arguing they are absent. The same shape as GOLDEN-006, where a forbidden
 * word appeared in a comment inside the route being matched.
 *
 * Rewording the comments would have worked and been worse: they explain
 * why the absence matters, and an invariant about code should read code.
 */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

const SERVICE = fs.readFileSync(SERVICE_FILE, 'utf8');
const ROUTE = fs.readFileSync(ROUTE_FILE, 'utf8');

const { dictate, MAX_DICTATION_SECONDS } = require('../services/ai/dictation');

/** Stand in for the provider, and report what it was asked for. */
function withProvider(body, run) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => body };
  };
  const done = () => { global.fetch = real; };
  return Promise.resolve(run(calls)).then(
    (v) => { done(); return v; },
    (e) => { done(); throw e; },
  );
}

const SPEECH = (transcript, duration) => ({
  metadata: { duration },
  results: { channels: [{ alternatives: [{ transcript }] }] },
});

test('a short phrase comes back as text', async () => {
  await withProvider(SPEECH('show me ngozi okafor', 3.2), async () => {
    const out = await dictate(Buffer.from('x'), { mimetype: 'audio/webm' });
    assert.equal(out.text, 'show me ngozi okafor');
    assert.equal(out.seconds, 3.2);
  });
});

test('the cap is short enough that a consultation cannot fit through it', async () => {
  // The number IS the safety property. A cap of five minutes would make this
  // a second scribe with no consent step, which is the one thing dictation
  // must never become.
  assert.ok(MAX_DICTATION_SECONDS <= 60, 'the dictation cap has grown past a phrase');
  assert.ok(MAX_DICTATION_SECONDS >= 5, 'the cap is too short to say anything');
});

test('audio longer than the cap is refused AND its text thrown away', async () => {
  // THE ONE THAT MATTERS. The transcript exists by this point — the question
  // is whether it ever reaches the caller. A long recording is not a
  // dictated query whatever it contains.
  await withProvider(SPEECH('a whole consultation about a patient', 600), async () => {
    await assert.rejects(
      () => dictate(Buffer.from('x'), { mimetype: 'audio/webm' }),
      (err) => {
        assert.equal(err.code, 'DICTATION_TOO_LONG');
        assert.equal(err.status, 413);
        // And the refusal does not quote back what was heard.
        assert.ok(!/consultation about a patient/.test(err.message), 'the refusal quotes the audio');
        return true;
      },
    );
  });
});

test('audio whose length cannot be measured is refused, not assumed short', async () => {
  // GOLDEN-002c's rule in a new place: "we could not tell" is never "it is
  // safe". A provider response with no duration could be a ten-minute
  // recording.
  const noDuration = { results: { channels: [{ alternatives: [{ transcript: 'hello' }] }] } };
  await withProvider(noDuration, async () => {
    await assert.rejects(
      () => dictate(Buffer.from('x'), { mimetype: 'audio/webm' }),
      (err) => err.code === 'DICTATION_TOO_LONG',
    );
  });
});

test('the provider is never asked to separate speakers', async () => {
  // Not a preference. Without diarization there is no shape in which "what
  // the patient said" could come back, so dictation cannot produce the thing
  // the scribe needs consent for.
  await withProvider(SPEECH('one voice', 2), async (calls) => {
    await dictate(Buffer.from('x'), { mimetype: 'audio/webm' });
    assert.equal(calls.length, 1);
    assert.ok(!/diarize/.test(calls[0]), 'dictation asked for speaker separation');
    assert.ok(!/utterances/.test(calls[0]), 'dictation asked for per-speaker utterances');
  });
  // And in the source, so a future edit has to delete this test to add it.
  const code = codeOnly(SERVICE);
  assert.ok(!/diarize/.test(code), 'the dictation service requests diarization');
  assert.ok(!/utterances/.test(code), 'the dictation service requests utterances');
});

test('dictation stores nothing anywhere', async () => {
  // No audio, no transcript, no row, no event. The text goes back to the box
  // the pharmacist is typing in and nowhere else.
  for (const forbidden of ['getSql', 'recordEvent', 'clinicalAudit', 'insert into']) {
    assert.ok(
      !SERVICE.includes(forbidden),
      `the dictation service reaches for ${forbidden}`,
    );
    assert.ok(
      !ROUTE.includes(forbidden),
      `the dictation route reaches for ${forbidden}`,
    );
  }
});

test('the route names no patient and no consultation', async () => {
  // The scribe's path is /customers/:id/consultations/:consultationId/scribe.
  // This one has nowhere to put a patient, so it cannot attribute a word to
  // one even by mistake.
  const code = codeOnly(ROUTE);
  assert.ok(!/:id/.test(code), 'the dictation route grew a patient parameter');
  assert.ok(!/consultation/i.test(code), 'the dictation route names a consultation');
  // And it mounts at a path with no patient in it.
  assert.ok(!/customers/.test(code), 'the dictation route reaches for a customer');
});

test('the byte guard is far smaller than the scribe accepts', async () => {
  // Belt and braces, and the braces are the duration check. The scribe takes
  // 25MB because a consultation is long; dictation taking the same would
  // make the door the same size.
  const scribe = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'ai', 'scribe.js'), 'utf8',
  );
  assert.match(scribe, /MAX_AUDIO_BYTES = 25 \* 1024 \* 1024/, 'the scribe cap moved');
  assert.match(SERVICE, /MAX_DICTATION_BYTES = 2 \* 1024 \* 1024/);
});
