#!/usr/bin/env node
/**
 * Compare speech-to-text providers on YOUR audio, not on a demo.
 *
 * WHY THIS EXISTS BEFORE ANY VOICE CODE
 * Everything else in a voice agent is solvable engineering. Whether a model
 * hears "amoxicillin" from a Lagos customer switching into Pidgin is not — it
 * either does or it does not, and no amount of prompt work downstream repairs
 * a transcript that says "a moxie sillin".
 *
 * Finding that out costs a day now, or three weeks of plumbing followed by
 * the same discovery.
 *
 * WHAT IT MEASURES, AND WHY NOT WORD ERROR RATE
 * Overall WER is the wrong number here. "Do you have amoxicillin" transcribed
 * as "do you have amoxicillin" with a missing "um" is fine; the same sentence
 * with the drug name wrong is useless and possibly dangerous. So this reports
 * whether the TERMS THAT MATTER survived — drug names, strengths, quantities
 * — separately from general accuracy.
 *
 * USAGE
 *   1. Record 15-20 real utterances as .wav or .mp3 in a folder.
 *   2. Beside each, a .txt with what was actually said, and a .terms file
 *      (one per line) listing the words that must survive — usually the drug
 *      name and strength.
 *   3. Set the API keys of whichever providers you want to compare.
 *   4. node scripts/stt-compare.js ./samples
 *
 *   samples/
 *     01.wav
 *     01.txt      "Do you get amoxicillin five hundred?"
 *     01.terms    amoxicillin
 *                 500
 *
 * ENDPOINTS ARE UNVERIFIED — the same caution channelProvider.js carries.
 * Each provider's URL and request shape must be checked against its current
 * documentation; they are isolated in PROVIDERS below so correcting one is a
 * two-line change rather than a rewrite. Intron in particular is left as an
 * explicit slot rather than guessed at: writing a request shape from memory
 * produces something that looks right and 400s on contact.
 */

const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac']);

/**
 * Each provider: does it have credentials, and how does it transcribe a file?
 *
 * A provider with no key is SKIPPED rather than failed — the usual run is
 * comparing two of these, not all of them.
 */
const PROVIDERS = [
  {
    name: 'deepgram',
    key: () => process.env.DEEPGRAM_API_KEY,
    note: 'Generic model. The baseline African-accent performance is measured against.',
    async transcribe(buffer, filename) {
      // VERIFY against current Deepgram documentation before trusting a
      // result from this — particularly the model name, which changes.
      const url = new URL('https://api.deepgram.com/v1/listen');
      url.searchParams.set('model', process.env.DEEPGRAM_MODEL || 'nova-2');
      url.searchParams.set('smart_format', 'true');
      // Domain vocabulary. Without it, a general model has no reason to
      // prefer "amoxicillin" over the many common words that sound like it.
      for (const term of loadKeyterms()) url.searchParams.append('keyterm', term);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': contentTypeFor(filename),
        },
        body: buffer,
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    },
  },

  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    note: 'Whisper-family. Generally tolerant of accents; weaker on rare proper nouns.',
    async transcribe(buffer, filename) {
      const form = new FormData();
      form.append('file', new Blob([buffer]), filename);
      form.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
      // The prompt is a vocabulary hint, not an instruction — it biases the
      // decoder toward these spellings.
      const terms = loadKeyterms();
      if (terms.length) form.append('prompt', `Nigerian pharmacy. Terms: ${terms.join(', ')}.`);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).text ?? '';
    },
  },

  {
    name: 'intron',
    key: () => process.env.INTRON_API_KEY && process.env.INTRON_STT_URL,
    note: 'Nigerian, trained on AfriSpeech-200 (clinical) — supports Pidgin and code-switching.',
    async transcribe(buffer, filename) {
      // DELIBERATELY NOT GUESSED. Set INTRON_STT_URL from their documentation.
      // The request below is the common multipart shape and may still be
      // wrong; correcting it is a change to this function only.
      const form = new FormData();
      form.append('audio', new Blob([buffer]), filename);
      if (process.env.INTRON_LANGUAGE) form.append('language', process.env.INTRON_LANGUAGE);

      const res = await fetch(process.env.INTRON_STT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.INTRON_API_KEY}` },
        body: form,
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      // Shape unknown; try the usual keys rather than assume one.
      return j.transcript ?? j.text ?? j.result?.transcript ?? JSON.stringify(j).slice(0, 200);
    },
  },
];

/** Words that must survive, pooled across every sample. */
let KEYTERMS = null;
function loadKeyterms() {
  return KEYTERMS || [];
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  }[ext] || 'application/octet-stream';
}

/** Loose match: case and punctuation are not what is being tested. */
function said(haystack, term) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
  return norm(haystack).includes(norm(term).trim());
}

/**
 * Rough word overlap, reported only as context for the term result.
 *
 * NOT presented as accuracy: it counts a missing "um" the same as a wrong
 * drug name, which is exactly the confusion this tool exists to avoid.
 */
function overlap(expected, actual) {
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const e = words(expected);
  if (!e.length) return null;
  const a = new Set(words(actual));
  return Math.round((e.filter((w) => a.has(w)).length / e.length) * 100);
}

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) {
    console.error('Usage: node scripts/stt-compare.js ./samples\n');
    console.error('  A folder of .wav/.mp3 files, each with a matching .txt (what was said)');
    console.error('  and optionally a .terms file (words that must survive, one per line).\n');
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase())).sort();
  if (!files.length) {
    console.error(`No audio files in ${dir}.`);
    process.exit(1);
  }

  // Pooled so every provider is given the same vocabulary hint. Testing one
  // with a hint list and another without measures the hint, not the model.
  KEYTERMS = [...new Set(files.flatMap((f) => {
    const p = path.join(dir, path.basename(f, path.extname(f)) + '.terms');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  }))];

  const active = PROVIDERS.filter((p) => p.key());
  const skipped = PROVIDERS.filter((p) => !p.key()).map((p) => p.name);

  console.log(`\n  ${files.length} samples · ${KEYTERMS.length} key terms · comparing: ${active.map((p) => p.name).join(', ') || 'nothing'}`);
  if (skipped.length) console.log(`  skipped (no credentials): ${skipped.join(', ')}`);
  if (!active.length) {
    console.error('\n  Set at least one provider key. See the header of this file.\n');
    process.exit(1);
  }
  console.log('');

  const score = Object.fromEntries(active.map((p) => [p.name, { termsFound: 0, termsTotal: 0, failed: 0 }]));

  for (const file of files) {
    const base = path.basename(file, path.extname(file));
    const buffer = fs.readFileSync(path.join(dir, file));
    const expectedPath = path.join(dir, `${base}.txt`);
    const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath, 'utf8').trim() : null;
    const termsPath = path.join(dir, `${base}.terms`);
    const terms = fs.existsSync(termsPath)
      ? fs.readFileSync(termsPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

    console.log(`\n${'─'.repeat(72)}\n${file}`);
    if (expected) console.log(`  said:  "${expected}"`);
    if (terms.length) console.log(`  must survive: ${terms.join(', ')}`);
    console.log('');

    for (const p of active) {
      let text;
      try {
        text = await p.transcribe(buffer, file);
      } catch (err) {
        score[p.name].failed += 1;
        console.log(`  ${p.name.padEnd(10)} ERROR  ${err.message}`);
        continue;
      }

      const missing = terms.filter((t) => !said(text, t));
      score[p.name].termsTotal += terms.length;
      score[p.name].termsFound += terms.length - missing.length;

      const pct = expected ? overlap(expected, text) : null;
      console.log(`  ${p.name.padEnd(10)} "${text}"`);
      console.log(
        `  ${' '.repeat(10)} ${terms.length ? (missing.length ? `MISSED: ${missing.join(', ')}` : 'all key terms survived') : ''}`
        + `${pct !== null ? `   (word overlap ${pct}%)` : ''}`,
      );
    }
  }

  console.log(`\n${'═'.repeat(72)}\n  KEY TERMS — the number that decides this\n`);
  for (const p of active) {
    const s = score[p.name];
    const pct = s.termsTotal ? Math.round((s.termsFound / s.termsTotal) * 100) : 0;
    console.log(
      `  ${p.name.padEnd(10)} ${String(s.termsFound).padStart(3)}/${String(s.termsTotal).padEnd(3)} `
      + `(${pct}%)${s.failed ? `   ${s.failed} request(s) failed` : ''}`,
    );
  }
  console.log(`
  A drug name is not a word to get MOSTLY right. Below roughly 95% here, a
  voice agent will confidently mis-hear medicines — and unlike a typo in chat,
  nobody sees the mistake before it is acted on.

  If the numbers are close, prefer the one that handles Pidgin and
  code-switching: your customers will not stay in one language.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
