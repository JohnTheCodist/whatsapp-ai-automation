#!/usr/bin/env node
/**
 * Phase 0 of a voice agent: can it SAY a drug name, and can it HEAR one?
 *
 * WHY THIS RUNS BEFORE ANY TELEPHONY
 * Everything else in a voice agent — Twilio webhooks, audio streaming, turn
 * handling — is ordinary engineering that will work if you write it carefully.
 * Whether a model pronounces "amoxicillin" correctly to a customer, and hears
 * it back from a Nigerian accent, is not. It either does or it does not, and
 * no amount of downstream code repairs a transcript that says "a moxie
 * sillin" or a voice that says "amoxi-KILL-in".
 *
 * Finding that out costs an hour now, or three weeks of plumbing followed by
 * the same discovery.
 *
 * WHY THE TEST IS DRUG NAMES AND NOT GENERAL ACCURACY
 * "Do you have paracetamol" heard as "do you have paracetamol" minus an "um"
 * is fine. The same sentence with the medicine wrong is dangerous, and on a
 * phone call nobody sees it: there is no transcript for the customer to
 * re-read and no message to scroll back to. In chat a wrong drug name is
 * visible; in voice it is invisible to both sides.
 *
 * WHAT IT DOES
 *   speak  — Azure TTS renders sample pharmacy replies to .wav so you can
 *            LISTEN. No score: whether a voice sounds like a Nigerian
 *            pharmacy is a judgement, and a machine grading it would be
 *            measuring the wrong thing confidently.
 *   hear   — Azure STT transcribes your recordings and reports whether the
 *            terms that matter survived.
 *
 * USAGE
 *   node scripts/voice-check.js speak
 *   node scripts/voice-check.js hear ./samples
 *
 * ENDPOINTS AND REQUEST SHAPES ARE UNVERIFIED — the same caution
 * channelProvider.js carries. Check them against current Azure documentation
 * before trusting a result; they are isolated in the two functions below so a
 * correction is contained.
 */

const fs = require('node:fs');
const path = require('node:path');

const REGION = process.env.AZURE_SPEECH_REGION;
const KEY = process.env.AZURE_SPEECH_KEY;

// The two genuine Nigerian English neural voices. Not an American voice with
// an accent applied — these carry the syllable-timed rhythm and unreduced
// vowels of Nigerian English, which is the whole reason for choosing Azure.
const VOICES = (process.env.AZURE_TTS_VOICES || 'en-NG-EzinneNeural,en-NG-AbeoNeural').split(',');

/**
 * What a pharmacy assistant actually says, not "hello world".
 *
 * Every line carries something that breaks bad text-to-speech: a drug name, a
 * strength, a naira amount, or an abbreviation. A voice that handles "hello,
 * how may I help you" beautifully and then mangles "500mg" is no use, and a
 * generic demo sentence would never reveal that.
 */
const SAMPLES = [
  'Yes, we have amoxicillin 500mg. It is ₦2,500 for a card of ten.',
  'We have paracetamol, ibuprofen and diclofenac. Which one did the doctor say?',
  'Your order MWJ-4K7 is ready for collection. Please come with your order number.',
  'That is metformin 1000mg, twice daily. Take it with food.',
  'I am not able to advise on that — let me pass you to the pharmacist.',
];

function requireCredentials() {
  if (!KEY || !REGION) {
    console.error(`
  Set your Azure Speech credentials first:

    AZURE_SPEECH_KEY=<your key>
    AZURE_SPEECH_REGION=<e.g. westeurope>

  Put them in server/.env — it is gitignored. A key committed to a public
  repo is scraped within minutes, sandbox or not.
`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ speak ---

/**
 * Render each sample in each voice, so they can be listened to side by side.
 *
 * SSML rather than plain text because the plain endpoint gives no control
 * over the voice, and choosing the voice is the entire point.
 */
async function speak() {
  requireCredentials();
  const outDir = path.join(process.cwd(), 'voice-samples');
  fs.mkdirSync(outDir, { recursive: true });

  const url = `https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

  for (const voice of VOICES) {
    for (const [i, text] of SAMPLES.entries()) {
      // Escaped because a naira sign is fine but an ampersand or angle
      // bracket in a real reply would otherwise break the SSML document and
      // fail in a way that looks like an API problem.
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const ssml =
        `<speak version="1.0" xml:lang="en-NG">`
        + `<voice name="${voice}">${escaped}</voice></speak>`;

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': KEY,
          'Content-Type': 'application/ssml+xml',
          // 16kHz mono PCM: what telephony wants, so what you hear here is
          // what a caller hears. A 48kHz studio render would sound better and
          // tell you nothing about the phone call.
          'X-Microsoft-OutputFormat': 'riff-16khz-16bit-mono-pcm',
          'User-Agent': 'rxnaija-voice-check',
        },
        body: ssml,
      });

      if (!res.ok) {
        console.error(`  ${voice} sample ${i + 1}: ${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }

      const file = path.join(outDir, `${voice}-${String(i + 1).padStart(2, '0')}.wav`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log(`  ${path.basename(file)}`);
    }
  }

  console.log(`
  Written to ./voice-samples

  LISTEN to them. There is deliberately no score here — whether a voice sounds
  like a Nigerian pharmacy is a judgement you can make and a machine cannot.

  Two questions, in order:
    1. Are the DRUG NAMES right? amoxicillin, metformin, diclofenac.
       A voice that reads English beautifully and mangles medicines is no use.
    2. Does it sound like a person at a counter, or like a machine reading?

  If the drug names are wrong, stop here. That is not fixable downstream, and
  it is the one error a caller cannot see.
`);
}

// ------------------------------------------------------------------- hear ---

/**
 * Transcribe recordings and report whether the terms that matter survived.
 *
 * Same folder convention as stt-compare.js so one set of recordings serves
 * both: audio, a .txt of what was said, and a .terms list of what must come
 * through.
 */
async function hear(dir) {
  requireCredentials();
  if (!dir || !fs.existsSync(dir)) {
    console.error(`
  Usage: node scripts/voice-check.js hear ./samples

  A folder of .wav recordings — YOUR voice, or better, a pharmacy customer's.
  Beside each:
    01.wav
    01.txt     what was actually said
    01.terms   the words that must survive, one per line (the drug name)

  Record them on a phone, not a good microphone. A model that copes with a
  studio recording and fails on a call is worse than useless: it passes the
  test and fails in production.
`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  if (!files.length) {
    console.error(`  No .wav files in ${dir}. Azure's short-audio endpoint wants WAV.`);
    process.exit(1);
  }

  const url = new URL(`https://${REGION}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`);
  url.searchParams.set('language', process.env.AZURE_STT_LANGUAGE || 'en-NG');
  url.searchParams.set('format', 'detailed');

  let found = 0;
  let total = 0;

  for (const file of files) {
    const base = path.basename(file, '.wav');
    const expectedPath = path.join(dir, `${base}.txt`);
    const termsPath = path.join(dir, `${base}.terms`);
    const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath, 'utf8').trim() : null;
    const terms = fs.existsSync(termsPath)
      ? fs.readFileSync(termsPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

    let text;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': KEY,
          'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
          Accept: 'application/json',
        },
        body: fs.readFileSync(path.join(dir, file)),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      text = j.DisplayText ?? j.NBest?.[0]?.Display ?? '';
    } catch (err) {
      console.log(`\n${file}\n  ERROR  ${err.message}`);
      continue;
    }

    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
    const missing = terms.filter((t) => !norm(text).includes(norm(t)));
    total += terms.length;
    found += terms.length - missing.length;

    console.log(`\n${file}`);
    if (expected) console.log(`  said:  "${expected}"`);
    console.log(`  heard: "${text}"`);
    if (terms.length) {
      console.log(`  ${missing.length ? `MISSED: ${missing.join(', ')}` : 'all key terms survived'}`);
    }
  }

  const pct = total ? Math.round((found / total) * 100) : 0;
  console.log(`\n${'═'.repeat(64)}\n  KEY TERMS: ${found}/${total} (${pct}%)\n`);
  console.log(`  A drug name is not a word to get MOSTLY right. Below about 95%
  here, a voice agent will confidently mis-hear medicines — and on a phone
  call there is no transcript for anyone to check it against.

  If Azure struggles, try Intron Health: Nigerian, trained on AfriSpeech-200
  clinical data, with real Pidgin support. scripts/stt-compare.js runs the
  same recordings through several providers at once.
`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'speak') speak().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'hear') hear(arg).catch((e) => { console.error(e); process.exit(1); });
else {
  console.log(`
  Phase 0 — can a voice agent say a drug name, and hear one?

    node scripts/voice-check.js speak          render sample replies to .wav
    node scripts/voice-check.js hear ./samples transcribe your recordings

  Needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in server/.env.
`);
}
