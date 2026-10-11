/**
 * The consultation workspace's layout, pinned as structural invariants on
 * index.css and Consultation.jsx — the same approach as
 * `patientRecordNav.test.js` and `sidebarRail.test.js`, and for the same
 * reason: what a screen LOOKS like cannot be exercised without a real
 * browser, but the rules that keep it honest are plain text.
 *
 * Each test below defends a specific way this screen goes wrong.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const JSX = fs.readFileSync(path.join(SRC, 'Consultation.jsx'), 'utf8');
const NOTES = fs.readFileSync(path.join(SRC, 'ConsultationNotes.jsx'), 'utf8');
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
// EXTENDED 2026-10-10 with the AI scribe, which is a second file rendering
// inside this screen. Leaving it out would not have failed anything — it
// would have silently exempted the newest `ui-` classes on the workspace
// from the one test that checks a class name was kept, which is exactly the
// gap this file was written after.
const SCRIBE = fs.readFileSync(path.join(SRC, 'ConsultationScribe.jsx'), 'utf8');
// EXTENDED 2026-10-11 with the create-patient form, for the same reason the
// scribe was added: it renders on this screen, and a class name is a promise
// to the stylesheet that nothing else checks was kept.
const NEWPATIENT = fs.readFileSync(path.join(SRC, 'NewPatient.jsx'), 'utf8');

/** Every class name the workspace asks index.css for. */
const usedClasses = [...`${JSX}\n${SCRIBE}\n${NEWPATIENT}`.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
  .flatMap((m) => (m[1] || m[2]).split(/\s+/))
  .map((c) => c.replace(/\$\{.*/, '').trim())
  .filter((c) => c.startsWith('ui-'));

// THE MOST IMPORTANT TEST IN THIS FILE.
test('every ui- class the workspace uses is actually defined', () => {
  // Phase 1 shipped six `ui-consult-*` class names with NO styles behind them.
  // Nothing failed and no test noticed: the screen rendered, as a column of
  // unstyled boxes. A class name is a promise to the stylesheet, and this is
  // the only thing that checks it was kept.
  // Matched as a WHOLE token, not a substring. The first version used
  // CSS.includes(`.${c}`), and renaming .ui-consult-add to .ui-consult-addX
  // left it green — every prefix of a longer class name counted as defined.
  const defined = (c) => new RegExp(String.raw`\.` + c + String.raw`(?![\w-])`).test(CSS);
  const missing = [...new Set(usedClasses)].filter((c) => !defined(c));
  expect(missing, `no CSS rule for: ${missing.join(', ')}`).toEqual([]);
  // Guard the guard: if the extraction stops finding classes, the test above
  // passes vacuously.
  expect(usedClasses.length).toBeGreaterThan(15);
});

test('a tone is carried by an inline mark, never by a block that fills the panel', () => {
  // Found by reading the computed styles on the real screen: an emergency
  // referral put `ui-tone-1` on a <dd>, which is display:block — so instead
  // of an amber label the panel got a 662px tinted BAR, and the summary rule
  // outranked it on colour so the text was not even amber.
  //
  // AMENDED 2026-10-04, and TIGHTENED. The first version matched the class
  // NAME against /-pill/, which was a proxy for the shape. The redesign added
  // `.ui-consult-fact` — inline-flex, fully rounded, a pill by every property
  // that matters — and the name check failed it while a class called
  // `x-pill` that was secretly a block would have passed. So it now checks
  // the CSS itself.
  expect(CSS).toMatch(/\.ui-tone-1\s*\{[^}]*background/);

  for (const m of JSX.matchAll(/className=\{`([^`]*\$\{[a-zA-Z.]*tone[^`]*)`\}/g)) {
    const carrier = m[1].split('$')[0].trim().split(/\s+/).filter(Boolean).pop();
    expect(carrier, `a tone with no class to sit on: ${m[1]}`).toBeTruthy();

    // Find that class in the stylesheet and prove it is an inline mark.
    const rule = CSS.match(new RegExp(String.raw`\.${carrier}\s*\{([^}]*)\}`));
    expect(rule, `${carrier} carries a tone but has no CSS rule`).toBeTruthy();
    const body = rule[1];
    // ROUNDED, so the tone reads as a mark rather than a rectangle...
    expect(body, `${carrier} carries a tone but is not rounded`).toMatch(/border-radius/);
    // ...and NOT a block, which is what painted the 662px bar. An explicit
    // `display: inline` is deliberately NOT required: `.ui-cprog-pill` is a
    // <span>, already inline, and demanding the declaration would only add a
    // line of CSS that changes nothing.
    expect(body, `${carrier} carries a tone and is a block — it will paint a bar`)
      .not.toMatch(/display:\s*block/);
  }

  // And no element is given a bare tone as its whole class list, which is
  // the shape the original defect had.
  expect(JSX).not.toMatch(/className=\{\w*\.?tone\s*\|\|\s*''\}/);
});

test('the workspace names no tone of its own', () => {
  // The first draft of this test asserted the JSX contains an amber tone and
  // no red one. It found ZERO tones and failed — correctly, because the
  // premise was wrong: every tone on this screen comes from
  // consultationFormat.js, where `consultationFormat.test.js` already pins
  // that none of them is red.
  //
  // So the invariant worth having is the one that keeps it that way. A
  // literal `ui-tone-3` typed into this file would be red on a note, and it
  // would be invisible to the format tests.
  expect(JSX).not.toMatch(/ui-tone-\d/);
  // The tones are still reaching the screen, through the format module.
  expect(JSX).toMatch(/statusTone|\btone\b/);
});

test('the note reads as one column on a phone, with no two-line links', () => {
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px)', CSS.indexOf('.ui-consult ')));
  expect(mobile).toMatch(/\.ui-consult-body/);
  // A "Remove" pushed to the right of a wrapped row becomes a second line of
  // clickable text at phone width, which is the one thing that must not happen.
  expect(mobile).toMatch(/\.ui-consult-problems \.ui-psection-link/);
});

// THE MOST IMPORTANT TEST IN THIS FILE.
test('one place marker at a time, and the note is the subject', () => {
  // Reported 2026-10-04 as "amateur", and it measured out as FIVE stacked
  // place markers on one screen: the app shell’s title, the screen’s own
  // heading, "Choose another patient", "Consultations", and the note type —
  // two of them back links that looked identical and went to different
  // places, with the note (the actual subject) set SMALLER than the module
  // label above it.

  // The screen titles itself, the way Setup does. Without this the shell
  // adds a sixth marker back.
  expect(APP, 'App.jsx no longer exempts consultation-notes from the page title')
    .toMatch(/tab !== 'consultation-notes'/);

  // Exactly ONE h1 per state, and the open note’s is the note itself.
  const noteHeads = [...JSX.matchAll(/<h1>\{([^}]+)\}<\/h1>/g)].map((m) => m[1]);
  expect(noteHeads.length, 'the open note must have exactly one h1').toBeGreaterThan(0);
  expect(noteHeads.join(' ')).toMatch(/typeLabel|patientName/);

  // And ONE way back out of each state. Two back links that read the same
  // and go to different places is the specific thing that was wrong.
  const backs = [...JSX.matchAll(/className="ui-consult-back"/g)];
  expect(backs.length, 'more than two back controls is the old stack again')
    .toBeLessThanOrEqual(2);

  // The old duplicated links are gone by name.
  expect(JSX).not.toMatch(/\u2190 Consultations</);
  expect(NOTES, 'ConsultationNotes must not add its own back link above the note')
    .not.toMatch(/Choose another patient/);
});

test('the note header outranks the chrome around it', () => {
  // The note was 15px while the module label above it was 20px — the
  // hierarchy upside down. Whatever you are looking at is the h1.
  const rule = CSS.match(/\.ui-consult-page h1\s*\{([^}]*)\}/);
  expect(rule, '.ui-consult-page h1 has no rule').toBeTruthy();
  const size = Number((rule[1].match(/font-size:\s*(\d+)px/) || [])[1]);
  expect(size, `the note title is ${size}px — too small to be the subject`)
    .toBeGreaterThanOrEqual(18);

  // design.md: 14px / 600 section headings. They were 13px and read as
  // field labels rather than as the sections they open.
  const head = CSS.match(/\.ui-consult-main \.ui-psection-head\s*\{([^}]*)\}/);
  expect(head).toBeTruthy();
  expect(head[1]).toMatch(/font-size:\s*14px/);
  expect(head[1]).toMatch(/font-weight:\s*600/);
});

test('a field is a field, not a page-wide grey bar', () => {
  // At 1440px the documentation column is 840px, and an unconstrained
  // single-line input filled all of it. The app caps prose in `ch`
  // (.ui-mrev-blurb, .ui-mrev-blocking) and this follows that idiom.
  // A selector appears in more than one rule — the phase-2 one that gives the
  // field its padding, and the later one that caps it. So this asks whether
  // ANY rule for that selector carries the cap, rather than whether the first
  // one does: the first version matched the padding rule and failed on code
  // that was correct.
  const cappedIn = (selector) => [...CSS.matchAll(
    new RegExp(String.raw`${selector}[^{}]*\{([^}]*)\}`, 'g'),
  )].some((m) => /max-width:\s*\d+ch/.test(m[1]));

  expect(cappedIn(String.raw`\.ui-consult-field select`),
    'single-line consultation fields are uncapped — they fill the column').toBe(true);
  expect(cappedIn(String.raw`\.ui-consult-field textarea`),
    'consultation prose fields have no measure').toBe(true);
});

test('a one-sentence notice does not use the empty-state box', () => {
  // `.ui-allergy-failed` is 28px of padding and a dashed border — the
  // EMPTY-STATE style. A retired note used it for one sentence and got a
  // wall of whitespace where its content should be.
  expect(JSX).toMatch(/ui-consult-notice/);
  const rule = CSS.match(/\.ui-consult-notice\s*\{([^}]*)\}/);
  expect(rule).toBeTruthy();
  expect(rule[1], 'the notice is dashed like an empty state').not.toMatch(/dashed/);
});

/* ==========================================================================
 * The AI scribe, as structural invariants (SCRIBE_PLAN.md)
 *
 * This component makes four promises in its own header. Three of them are
 * properties of the FILE rather than of anything a render test could reach,
 * and they are the three that matter: it does not save, it does not keep the
 * audio, and it does not open the microphone before consent.
 * ======================================================================== */

// THE MOST IMPORTANT SCRIBE TEST IN THIS FILE.
test('the scribe never writes to the note', () => {
  // A draft the pharmacist has not accepted must leave NO trace. If this
  // component could PATCH the consultation, the note would have two writers
  // and a machine draft could reach the record without anybody agreeing to
  // it — which is the one thing the whole review step exists to prevent.
  //
  // Accepting calls the parent’s `set`, exactly as a keystroke does, and the
  // ordinary Save is still what commits it.
  const calls = [...SCRIBE.matchAll(/fetch\(([^)]*)/g)].map((m) => m[1]);
  expect(calls.length, 'the fetch extraction found nothing').toBeGreaterThan(2);

  // Every endpoint it touches is a scribe endpoint.
  for (const call of calls) {
    expect(call, `the scribe calls something that is not a scribe endpoint: ${call}`)
      .toMatch(/scribe/);
  }

  // And it issues no PATCH, PUT or DELETE at all — the methods that change a
  // record in this API.
  expect(SCRIBE).not.toMatch(/method:\s*.(?:PATCH|PUT|DELETE)./);

  // The accept path hands the text UPWARDS and nowhere else.
  // AMENDED 2026-10-10 with the SOAP rewrite. The rule is unchanged and the
  // shape is not: the scribe used to hand up one string and now hands up
  // four sections. What matters is still that it hands them UP rather than
  // writing them itself.
  expect(SCRIBE).toMatch(/onAccept\?\.\(\{ sections \}\)/);
  // And the parent lands them through the same `set` a keystroke uses, so
  // the note keeps exactly one writer.
  expect(JSX).toMatch(/if \(value\) set\(field, value\);/);
});

test('the scribe keeps no audio anywhere', () => {
  // "The recording is not kept" is said to the patient’s face in the consent
  // script. On the server it is true because nothing in the schema can hold
  // one; here it is true because the Blob is handed to fetch and dropped.
  //
  // Every mechanism a browser offers for keeping it is named, because this
  // failure would be invisible: the feature would work perfectly and quietly
  // accumulate recordings of real patients.
  for (const keeps of [
    /localStorage/, /sessionStorage/, /indexedDB/i, /IDBDatabase/,
    /createObjectURL/, /download/i, /showSaveFilePicker/, /FileSystemFileHandle/,
    /sendBeacon/, /caches\./,
  ]) {
    expect(SCRIBE, `the scribe can keep audio via ${keeps}`).not.toMatch(keeps);
  }

  // The chunks are released, and on UNMOUNT as well as on stop — a
  // pharmacist who navigates away mid-recording must not leave the
  // microphone live or the audio sitting in memory.
  expect(SCRIBE).toMatch(/chunksRef\.current = \[\]/);
  expect(SCRIBE).toMatch(/useEffect\(release, \[release\]\)|useEffect\(\s*\(\)\s*=>\s*release\s*,/);
  expect(SCRIBE).toMatch(/getTracks/);
});

test('the microphone cannot be reached before consent is on the server', () => {
  // ABSENT, not disabled. A greyed-out record button is an invitation to
  // find the way round it, and the way round it is to tick the consent box
  // without saying anything to the patient.
  //
  // AMENDED 2026-10-10 with the SOAP rewrite, which replaced the early
  // return with a MODE machine. Ordering no longer proves anything, so this
  // pins the reachability directly, which is a sharper claim than before.

  // The microphone is OPENED in exactly one place. Matched as a CALL, not
  // as a mention: the file also feature-detects it and names it in a
  // comment, and counting those made this assertion fail on its own
  // premise the first time it ran.
  const opens = SCRIBE.match(/await navigator\.mediaDevices\.getUserMedia\(/g) || [];
  expect(opens.length, `the microphone is opened ${opens.length} times`).toBe(1);

  // That place is start(), and start() is only rendered under mode 'ready'.
  expect(SCRIBE).toMatch(/async function start\(\)[\s\S]*?getUserMedia/);
  expect(SCRIBE).toMatch(/mode === 'ready' &&[\s\S]*?onClick=\{start\}/);

  // And 'ready' is reachable in exactly two ways: the choose screen, which
  // sends an unconsented pharmacist to the consent step instead, and
  // confirmConsent's success path, which runs only after the SERVER accepted
  // the consent. Neither lets somebody who has asked nobody reach a
  // microphone.
  expect(SCRIBE).toMatch(/setMode\(consentAt \? 'ready' : 'consent'\)/);
  expect(SCRIBE).toMatch(/await fetch\(`\$\{base\}\/scribe\/consent`[\s\S]*?setMode\('ready'\)/);

  // The consent read comes from the NOTE — the server’s answer — rather
  // than a flag this component sets for itself and could decline to unset.
  expect(SCRIBE).toMatch(/const consentAt = note\?\.scribeConsentAt \|\| null;/);
});

test('the scribe is only offered where the server says it exists', () => {
  // An unconfigured deployment shows no microphone at all, rather than a
  // control that fails when pressed. The answer comes from the options
  // endpoint, so one deployment setting turns the whole feature off.
  expect(SCRIBE).toMatch(/if \(!available\) return null;/);
  expect(JSX).toMatch(/available=\{Boolean\(options\?\.scribe\?\.available\)\}/);

  // And only while the note can still be written into. A draft for a
  // finalised note has nowhere to go, which the server refuses too.
  expect(JSX).toMatch(/\{open && \(/);
  const at = JSX.indexOf('<ConsultationScribe');
  expect(at).toBeGreaterThan(-1);
  expect(JSX.slice(Math.max(0, at - 200), at), 'the scribe renders on a finalised note')
    .toMatch(/\{open && \(/);
});

/* ==========================================================================
 * The recording path (2026-10-10)
 * ======================================================================== */

test('the microphone is asked for a pharmacy counter, not a quiet room', () => {
  // `{ audio: true }` takes the browser's defaults, which assume a quiet
  // room. A pharmacy counter has a fan, a till, a queue and a radio, and
  // these three are the difference between a usable recording and one the
  // provider returns nothing from.
  expect(SCRIBE).toMatch(/echoCancellation: true/);
  expect(SCRIBE).toMatch(/noiseSuppression: true/);
  // autoGainControl matters most: a patient leaning away from the phone is
  // the common case, and without it they simply drop out.
  expect(SCRIBE).toMatch(/autoGainControl: true/);
  expect(SCRIBE).toMatch(/getUserMedia\(AUDIO_CONSTRAINTS\)/);
  expect(SCRIBE, 'the microphone is still asked for with bare defaults')
    .not.toMatch(/getUserMedia\(\{ audio: true \}\)/);
});

test('the container is chosen, not left to the browser', () => {
  // `new MediaRecorder(stream)` with no type is fine on Chrome and is NOT on
  // Safari, where mp4 is the only supported container and an unsupported
  // type throws rather than falling back.
  expect(SCRIBE).toMatch(/isTypeSupported/);
  expect(SCRIBE).toMatch(/audio\/mp4/);
  // Opus first: a fraction of the size for speech, which matters on a
  // Nigerian pharmacy's connection.
  const list = SCRIBE.match(/const PREFERRED_TYPES = \[([\s\S]*?)\]/);
  expect(list, 'the preferred-type list is gone').toBeTruthy();
  expect(list[1].indexOf('opus')).toBeLessThan(list[1].indexOf('audio/mp4'));
});

test('audio accrues while recording rather than arriving all at once', () => {
  // A timeslice, so a consultation interrupted by a closed laptop or a
  // crashed tab still has most of itself. Verified in a real browser: 3
  // chunks over 2.6 seconds instead of 1.
  expect(SCRIBE).toMatch(/rec\.start\(1000\)/);
  expect(SCRIBE, 'the recorder starts with no timeslice').not.toMatch(/rec\.start\(\)/);
});

// THE ONE THE OWNER ASKED FOR.
test('a recording that heard nothing is a state, not a server error', () => {
  // The bug: with zero turns the draft step was called with an empty
  // transcript, the server refused it as a bad request, and the pharmacist
  // got the raw 400 — "There is no transcript to draft from" — after talking
  // for five minutes. That blames the request when the truth is about the
  // room.
  expect(SCRIBE).toMatch(/if \(\(heard\.turns \|\| \[\]\)\.length === 0\) \{/);
  expect(SCRIBE).toMatch(/setError\(NO_SPEECH\)/);

  // It returns BEFORE the draft call, so the empty transcript never reaches
  // the server to be refused.
  const guard = SCRIBE.indexOf('setError(NO_SPEECH)');
  const draft = SCRIBE.indexOf('await writeUp(heard.turns');
  expect(guard).toBeGreaterThan(-1);
  expect(draft).toBeGreaterThan(guard);
});

test('the meter reads the same stream the recorder does', () => {
  // A meter fed from a second getUserMedia call could show sound while the
  // recording captured silence — which is the exact failure it exists to
  // reveal, with a reassuring bar on top.
  expect(SCRIBE).toMatch(/function watchLevel\(stream\)/);
  expect(SCRIBE).toMatch(/createMediaStreamSource\(stream\)/);
  expect(SCRIBE).toMatch(/watchLevel\(stream\)/);

  // And it is NEVER routed to the speakers — that howls across a counter.
  expect(SCRIBE, 'the microphone is connected to the output').not.toMatch(/connect\(ctx\.destination\)/);

  // The AudioContext is closed on release, or the browser's recording
  // indicator stays lit after the pharmacist has stopped.
  expect(SCRIBE).toMatch(/audioCtxRef\.current\?\.close\(\)/);
  expect(SCRIBE).toMatch(/cancelAnimationFrame\(meterRef\.current\)/);
});

/* ==========================================================================
 * Choosing to type (2026-10-11)
 *
 * The owner: "when user click type option, nothing happens". It did not —
 * the branch read `mode === 'choose' || mode === 'typing'`, so pressing the
 * button set a state that rendered THE SAME TWO CARDS. Shipped because I
 * never pressed it.
 * ======================================================================== */

// THE TEST THAT WOULD HAVE CAUGHT IT.
// AMENDED 2026-10-11 (SHELL_PLAN.md phase 3). This used to pin that
// choosing to type rendered something different from the chooser — written
// that morning, after the owner reported that pressing "Type it" did
// nothing, which it did.
//
// THERE IS NO CHOOSER NOW. The two cards became one box with a microphone
// on it, because the reason the reference reads as intuitive is that it
// asks nothing. A test that a choice behaves correctly, when nothing is
// chosen, has no subject — so it pins the stronger thing: that the choice
// never comes back.
test('the note is written in one box, not chosen from two', () => {
  // The failure this replaces could not happen again without the chooser
  // returning, so the chooser is what is pinned absent.
  expect(SCRIBE, 'the two-card chooser is back').not.toMatch(/ui-scribe-choices/);
  expect(SCRIBE, 'a typing mode is back').not.toMatch(/mode === 'typing'/);

  // One box, and it is a real textarea rather than a button dressed as
  // one — something that looks like an input and is not is its own lie.
  expect(SCRIBE).toMatch(/<textarea[\s\S]{0,200}ui-scribe-box/);
  expect(SCRIBE).toMatch(/NOTE_PLACEHOLDER/);
});

test('the box IS the Subjective field, and there is only one of it', () => {
  // Two boxes for one value is how a pharmacist loses a sentence: both
  // would read `note.subjective` and agree, and they would still have to
  // work out which to type in.
  expect(SCRIBE).toMatch(/onChange=\{\(e\) => onSubjective\?\.\(e\.target\.value\)\}/);
  expect(JSX).toMatch(/subjective=\{note\.subjective\}/);
  expect(JSX).toMatch(/onSubjective=\{\(v\) => set\('subjective', v\)\}/);

  // No editable Subjective section below it. The one that remains is a
  // READ-BACK on a finalised note, where the box is gone with the editing.
  expect(JSX, 'an editable Subjective section is back')
    .not.toMatch(/<Field label="What the patient reported"/);
  expect(JSX).toMatch(/\{!open && note\.subjective && \(/);
});
test('choosing to type opens every section, not the budget', () => {
  // The owner's second half: "it should automatically show all what the
  // pharmacist is to type". The budget (§31) exists so a routine minor
  // ailment does not present fourteen boxes to somebody who wants to be done
  // in a minute — but a pharmacist who has just SAID they are typing is
  // asking to see what there is to type, and hiding half of it behind "More
  // sections" answers a different question.
  //
  // Measured on the running screen: 7 sections before, 13 after.
  expect(SCRIBE).toMatch(/onTyping\?\.\(\)/);
  expect(JSX).toMatch(/onTyping=\{\(\) => setShowAll\(true\)\}/);
});

test('recording still goes through consent, from the only place it starts', () => {
  // AMENDED with phase 3: this pinned a "use voice instead" link out of the
  // typing state, which no longer exists. The rule it protected does — the
  // microphone is never reachable without consent — and it is pinned at the
  // one control that now starts a recording.
  expect(SCRIBE).toMatch(/RECORD_LABEL/);

  const box = SCRIBE.slice(
    SCRIBE.indexOf("if (mode === 'choose') {"),
    SCRIBE.indexOf('/* ---- 2. consent'),
  );
  expect(box.length, 'the note box is gone').toBeGreaterThan(0);
  expect(box, 'Record skips consent').toMatch(/setMode\(consentAt \? 'ready' : 'consent'\)/);

  // And it is offered only where a microphone exists.
  expect(box).toMatch(/\{canRecord && \(/);
});
