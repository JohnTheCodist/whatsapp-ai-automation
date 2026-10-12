/**
 * What the chrome above a screen says it is showing — the breadcrumb, the
 * page heading and the line under it.
 *
 * SHELL_PLAN.md phase 4. Pinned as structural invariants on App.jsx and
 * Customers.jsx, the same approach as sidebarRail.test.js and
 * consultationLayout.test.js: the wiring is React state across two files and
 * cannot be exercised without a browser, but the rules that make it correct
 * are plain text.
 *
 * WRITTEN AFTER THE FACT, and that is worth recording rather than hiding.
 * The commit that made the heading name the patient (a932d33) shipped with
 * no test at all, which AGENTS.md forbids. These cover that behaviour as
 * well as the subtitle it missed.
 *
 * The defect they all defend against is one thing: chrome that confidently
 * describes the screen you LEFT. Standing in Ngozi Okafor's medication
 * record, the breadcrumb said "Patients / All patients", the heading said
 * "Patients", and the line beneath it said "View all your customers'
 * details" — on a clinical record, where the name at the top is the thing a
 * pharmacist checks before acting.
 */

import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const CUSTOMERS = fs.readFileSync(path.join(SRC, 'Customers.jsx'), 'utf8');
const MODULES = fs.readFileSync(path.join(SRC, 'modules.js'), 'utf8');

/** The keys of App.jsx's SUBTITLE map, read from the source. */
function subtitleKeys() {
  const start = APP.indexOf('const SUBTITLE = {');
  const end = APP.indexOf('};', start);
  expect(start, 'the SUBTITLE map has been renamed or removed').toBeGreaterThan(-1);
  return new Set([...APP.slice(start, end).matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]));
}

test('the heading and the breadcrumb both name the patient whose record is open', () => {
  // Both, not one. The heading was what the owner was looking at, but the
  // breadcrumb is what says where you can go back TO, and "All patients"
  // while one patient is on screen is the same wrong subject.
  expect(APP).toMatch(/const pageTitle = openPatientName \|\| titleFor\(tab\)/);
  expect(APP).toMatch(/const crumbTitle = openPatientName \|\| crumbFor\(tab\)/);

  // The patient wins over the screen's own wording, not the other way round.
  expect(APP, 'the screen title would win over the patient')
    .not.toMatch(/const pageTitle = titleFor\(tab\) \|\| openPatientName/);
});

test('the line under the heading is ABSENT on a patient record, not just wrong', () => {
  // The defect this closes: the heading was fixed and the sentence beneath
  // it was not, so all nine sections of a record carried a subtitle about
  // the list the pharmacist had left.
  expect(APP).toMatch(/const pageSubtitle = openPatientName \? null : SUBTITLE\[tab\]/);

  // Rendered CONDITIONALLY. An empty <p> still occupies its line and reads
  // as something that failed to load, which is a different wrong answer
  // rather than no answer.
  expect(APP).toMatch(/\{pageSubtitle && \(/);
  expect(APP, 'the subtitle is still read straight out of the map at render')
    .not.toMatch(/<p[^>]*>\{SUBTITLE\[tab\]\}<\/p>/);
});

test('hiding the subtitle can only ever hide the patient case', () => {
  // THE GUARD THAT MAKES THE RULE ABOVE SAFE. `pageSubtitle` is nullable
  // now, so a screen that lost its SUBTITLE entry would silently render no
  // subtitle and look deliberate. Every screen the sidebar can open must
  // have one, which means the only thing the condition can suppress is the
  // record case it was written for.
  const subs = subtitleKeys();
  const tabs = [...MODULES.matchAll(/tab:\s*'([a-z-]+)'/g)].map((m) => m[1]);

  expect(tabs.length, 'no screen tabs were found in modules.js').toBeGreaterThan(0);
  const missing = tabs.filter((t) => !subs.has(t));
  expect(missing, `these screens would render no subtitle at all: ${missing.join(', ')}`).toEqual([]);
});

test('the name comes from the row that was clicked, not a second request', () => {
  // PatientSearch already hands the patient over beside the id. Asking the
  // server again for something just shown on screen is how two answers to
  // one question appear, and the slower one wins the heading.
  expect(CUSTOMERS).toMatch(/onOpen=\{\(id, p\) => \{ onPatientName\?\.\(p\?\.name \|\| null\); setSelectedId\(id\); \}\}/);

  // A patient opened by deep link (Refills, Conditions) arrives with no
  // name, and `|| null` is what makes the heading fall back to "Patients" —
  // vague, which is honest, rather than wrong.
  expect(CUSTOMERS, 'a missing name would be reported as a blank heading')
    .not.toMatch(/onPatientName\?\.\(p\?\.name\)/);
});

test('the name is cleared on the way back, by the state and not only by the button', () => {
  // THE HALF THAT MATTERS. A heading still carrying a patient's name after
  // you have left their record is worse than one that never had it: it is
  // confidently wrong rather than merely vague, and the next thing a
  // pharmacist does on that screen is about somebody else.
  //
  // Covered twice on purpose. The button is the path a person takes; the
  // effect is the one that holds when the record closes some other way —
  // a search, a deep link, a tab change that resets the selection.
  expect(CUSTOMERS).toMatch(/onBack=\{\(\) => \{ onPatientName\?\.\(null\); setSelectedId\(null\); \}\}/);
  expect(CUSTOMERS).toMatch(/if \(!selectedId\) \{ onPatientName\?\.\(null\); \}/);
  expect(CUSTOMERS).toMatch(/\}, \[selectedId, onPatientName\]\);/);
});

test('the shell is told the name and nothing else about the patient', () => {
  // The record stays where it is owned. `selectedId` is Customers' — it owns
  // the list/record switch — and lifting it would make every other caller of
  // Customers responsible for state they do not use. The shell needs one
  // string to write a heading with.
  expect(APP).toMatch(/onPatientName=\{setOpenPatientName\}/);
  expect(APP, 'the shell has taken ownership of which patient is selected')
    .not.toMatch(/setSelectedPatientId|selectedPatientId/);
});

/**
 * Home keeps the nav (owner, 2026-10-11, pointing at the Rhazes reference:
 * "for the home screen can u just add nav like this").
 *
 * Home used to be the one screen in the app you could not navigate FROM.
 * `isBare` hid the sidebar, so every route out went through the command
 * input or the header search — "where else can I go?" had no answer in view.
 * The reference puts the destinations BESIDE the command surface rather than
 * instead of it, which is what these pin.
 */

test('Home renders the sidebar, because it is the screen you start from', () => {
  // The whole fix is that Home is no longer bare.
  expect(APP, 'Home is hiding the sidebar again').not.toMatch(/const isBare = isHome \|\|/);
  expect(APP).toMatch(/const isBare = tab === 'customers';/);
  // And the sidebar is still gated on `isBare`, so the rule above is the one
  // that decides it rather than a second condition somewhere else.
  expect(APP).toMatch(/\{!isBare && \(<>/);
});

test('Patients keeps its exemption, which is the owner’s and not incidental', () => {
  // GUARD. The patient record grows its OWN twelve-section navigation, and
  // beside the module rail that is two vertical menus for one screen. That
  // exemption was asked for (2026-09-20) and must not be swept up by a later
  // tidy of `isBare`.
  expect(APP).toMatch(/const isBare = tab === 'customers';/);
  // Asserted as TWO separate claims, not `/twelve sections|PatientRecord/`.
  // An alternation here passes as soon as either half survives, which is how
  // the same mistake slipped past in screenHeadings.test.js — a mutation
  // deleting one half stayed green on the other.
  expect(APP, 'the count of record sections has gone from the reasoning')
    .toMatch(/twelve sections/);
  expect(APP, 'the screen that owns that navigation is no longer named')
    .toMatch(/PatientRecord\.jsx/);
});

test('Home does not show the logo twice now that the sidebar carries it', () => {
  // The header's R tile existed because Home had no sidebar. With one, a
  // second tile two inches from the first is the logo twice — the same
  // defect as Orders and the Inbox saying their own name twice.
  const home = APP.slice(APP.indexOf('{isHome ? ('), APP.indexOf('aria-label="Breadcrumb"'));
  expect(home.length, 'the Home header branch has moved').toBeGreaterThan(0);
  expect(home, 'the duplicate R tile is back').not.toMatch(/aria-label="RxNaija"/);

  // Nor a breadcrumb, which on Home would read "home-icon / Home" — a screen
  // naming itself, with the icon linking to the page you are already on.
  expect(home, 'Home grew a breadcrumb that names Home').not.toMatch(/crumbTitle/);
});

test('the sidebar is still a way back to Home, not just a way out of it', () => {
  // If Home is reachable only by the command input, giving it a sidebar has
  // made the app harder to leave AND harder to return to. The workspace tile
  // at the top of the sidebar is the way back, and it says so to a reader.
  expect(APP).toMatch(/aria-label="RxNaija home"/);
});

/**
 * One search field per screen (owner, 2026-10-11: "merge the two search
 * boxes").
 *
 * Giving Home the sidebar left it with TWO: the header's "Search patients"
 * pill and the body's command box, a few inches apart, doing overlapping
 * jobs. The pill is strictly weaker — it carries a term over to Patients —
 * while the box searches patients AND jumps to screens AND shows what it
 * found. A choice between two fields where one is worse is not a choice
 * worth offering, so Home keeps the box and the pill keeps every other
 * screen.
 */

const HOMECMD = fs.readFileSync(path.join(SRC, 'HomeCommand.jsx'), 'utf8');

test('Home has no header search, because its body already is one', () => {
  expect(APP).toMatch(/\{!isHome && \(/);
  // The width ternary went with it: the pill now renders at one size,
  // because it no longer has a Home case to be wide for.
  expect(APP, 'the header field still has a Home-sized variant')
    .not.toMatch(/isHome \? 'w-full max-w-md'/);
});

test('every other screen keeps the header field', () => {
  // The merge is Home-only. Removing the pill everywhere would take the
  // desk's Ctrl+K search off eleven screens to fix a duplicate on one.
  expect(APP).toMatch(/className="w-40 shrink-0 md:w-56 lg:w-72"/);
  expect(APP).toMatch(/onSubmit=\{submitSearch\}/);
});

test('Ctrl+K reaches whichever field is on screen', () => {
  // THE ONE THAT MATTERS. The shortcut's hint is printed inside the field,
  // and App.jsx's own comment says a hint for a key that does nothing is
  // worse than no hint. One ref, handed to whichever field exists — so
  // removing the header pill from Home could not leave Ctrl+K pointing at
  // something that is not rendered.
  expect(APP).toMatch(/searchRef\.current\?\.focus\(\)/);
  expect(APP).toMatch(/inputRef=\{searchRef\}/);
  expect(HOMECMD).toMatch(/const boxRef = inputRef \|\| localRef;/);
  expect(HOMECMD).toMatch(/ref=\{boxRef\}/);
});

test('the command box still focuses itself when nothing hands it a ref', () => {
  // homeCommand.test.jsx renders this component with no inputRef, and the
  // box autofocusing on load is the reason Home is typeable the moment it
  // opens. The fallback is load-bearing, not defensive decoration.
  expect(HOMECMD).toMatch(/const localRef = useRef\(null\);/);
  expect(HOMECMD).toMatch(/boxRef\.current\?\.focus\(\)/);
});

/**
 * The WhatsApp chip reports WhatsApp.
 *
 * THE DEFECT, found while finally opening Billing (2026-10-12). The rail's
 * chip read `health.status === 'ok'` — and /api/health sets `status` from
 * ONE thing, whether a database ping came back. So it showed **Live**,
 * titled "Connected to WhatsApp", on a pharmacy whose socket had never once
 * connected. Measured: /api/whatsapp/status answered
 * `{status: 'pending', live: false, registered: false}` while the rail said
 * Live, and Billing two inches away said "Connect WhatsApp to start your
 * 7-day free trial". Billing was right.
 *
 * That is the worst shape a status chip can take in this product. A
 * pharmacist who reads "Live" believes patients' messages are arriving, and
 * the expensive failure here has always been the silent one — sixteen
 * messages from a live patient dropped over three days.
 */

test('the connection chip is read from the WhatsApp endpoint, not the database ping', () => {
  expect(APP, 'the chip is reading service health again')
    .not.toMatch(/const connected = health\?\.status === 'ok'/);
  expect(APP).toMatch(/const connected = waStatus\?\.live === true;/);
  expect(APP).toMatch(/fetch\('\/api\/whatsapp\/status'\)/);
});

test('the chip keeps three states, so it never claims one it has not checked', () => {
  // "Down" before the answer arrives is the same error as "Live", merely
  // louder: a claim about a socket nobody has looked at. The third state is
  // neutral — no red, no green.
  expect(APP).toMatch(/const waKnown = waStatus !== null;/);
  expect(APP).toMatch(/\{!waKnown \? 'Checking' : connected \? 'Live' : 'Down'\}/);
  expect(APP).toMatch(/Checking the WhatsApp connection/);
});

test('only a KNOWN failure raises an alert', () => {
  // `waDown` is "we asked and it is down", never "we have not asked". The
  // bell and the favicon both take it, so an unanswered read cannot invent
  // an alarm — which would be the original bug inverted.
  expect(APP).toMatch(/const waDown = waKnown && !connected;/);
  expect(APP).toMatch(/connected=\{!waDown\}/);
  expect(APP).toMatch(/count=\{\(waDown \? 1 : 0\) \+ badges\.consultations \+ badges\.orders\}/);
});

test('the chip says why, in the server’s own words and only once', () => {
  // `statusDetail` is already a full sentence ("Not connected yet."), and
  // the first version prefixed it — producing "Not connected — Not
  // connected yet." on a real screen.
  expect(APP).toMatch(/waStatus\?\.statusDetail \|\| 'Not connected'/);
  expect(APP, 'the tooltip is prefixing a sentence that already stands alone')
    .not.toMatch(/`Not connected\$\{waStatus/);
});

test('service health is still read, and still means what it means', () => {
  // /api/health is not wrong — it was being asked the wrong question. It
  // still feeds Settings, where database and channel CONFIG belong.
  expect(APP).toMatch(/fetch\('\/api\/health'\)/);
  expect(APP).toMatch(/<Settings health=\{health\}/);
});

/**
 * Chats and Workflows at the top (owner, 2026-10-12: "i want chat and
 * workflow to be at the top... the workflow is not a subset of clinic
 * module... automatically chat is the default state").
 */

const MODULES_SRC = fs.readFileSync(path.join(SRC, 'modules.js'), 'utf8');
const HOMECMD_SRC = fs.readFileSync(path.join(SRC, 'HomeCommand.jsx'), 'utf8');
const HOMEMODEL = fs.readFileSync(path.join(SRC, 'homeCommand.js'), 'utf8');

test('Workflows is a top-level destination, not a screen inside Clinics', () => {
  // It was briefly a Clinics screen and the owner said that was wrong: a
  // clinical protocol is not a thing you do in the clinic, it is software
  // running in the pharmacy's name across every conversation it has.
  expect(MODULES_SRC, 'Workflows is back inside a module')
    .not.toMatch(/tab: 'workflows'/);
  expect(APP).toMatch(/const WORKFLOWS = \{ id: 'workflows'/);
  // A global screen, like Setup and Billing — which is what keeps it out of
  // MODULE_TABS while staying a valid tab the URL can carry.
  expect(APP).toMatch(/\[WORKFLOWS\.id\]: WORKFLOWS/);
});

test('the two live above the modules, as one control rather than two rows', () => {
  // A segmented control and not two sidebar rows: they are a choice between
  // two ways of working, where the modules below are places. A place list
  // opening with these two would read as though Workflows were a screen like
  // Orders, which is the arrangement this replaced.
  expect(APP).toMatch(/aria-label="Workspace"/);
  expect(APP).toMatch(/function TopTab\(/);
  // Pressed state, not a link role: a reader should hear which one is on.
  expect(APP).toMatch(/aria-pressed=\{active\}/);
});

test('Chats is the default state, and it is Home rather than a second surface', () => {
  // Home was already the landing state and already the greeting plus one
  // input — which is what the owner's reference shows. Naming it Chats
  // describes what is there instead of building a rival screen beside it.
  expect(APP).toMatch(/useState\(\(\) => readTabFromUrl\(\) \|\| HOME\.id\)/);
  expect(APP).toMatch(/active=\{isHome\}/);
  expect(APP).toMatch(/label="Chats"/);
});

test('the recording control sits in the composer, where the owner asked', () => {
  expect(HOMECMD_SRC).toMatch(/ui-home-tools/);
  expect(HOMECMD_SRC).toMatch(/RECORD_LABEL/);
});

test('the recording control opens the consultation and never a microphone', () => {
  // THE ONE THAT MATTERS. Transcription is bound to
  // /customers/:id/consultations/:consultationId/scribe, behind `scribeGate`,
  // re-read from the database per request and failing closed. 0071 added the
  // consent columns so "we do not record anyone who was not asked" stays
  // true without anybody maintaining it.
  //
  // There is no patient-free transcribe endpoint. A microphone on this box
  // would be a door marked "dictate your question" that a patient can be
  // recorded through, so the button leads to where a patient is chosen and
  // asked.
  expect(HOMECMD_SRC).toMatch(/onOpen\?\.\('consultation-notes'\)/);
  expect(HOMECMD_SRC, 'the command box opened a microphone of its own')
    .not.toMatch(/getUserMedia|MediaRecorder/);
});

test('the control says what it does, rather than implying it is listening', () => {
  // A button labelled "Record" that then asks a question is a small lie told
  // at the exact moment somebody is about to speak to a patient.
  expect(HOMEMODEL).toMatch(/RECORD_LABEL = 'Record a consultation'/);
  expect(HOMEMODEL).toMatch(/RECORD_NOTE = '[^']*asked before anything is recorded/);
});

test('every ui- class the composer tools use has a rule behind it', () => {
  // The consultation workspace once shipped six `ui-consult-*` names with no
  // styles at all — it rendered, as unstyled controls.
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');
  for (const cls of ['ui-home-tools', 'ui-home-tool', 'ui-home-toolnote']) {
    // Checked as a whole declaration rather than a substring: without the
    // trailing delimiter, `.ui-home-tool` passes on `.ui-home-tools` and
    // the narrower class could ship with no rule at all.
    const declared = [`.${cls} {`, `.${cls}:`, `.${cls},`]
      .some((needle) => css.includes(needle));
    expect(declared, `.${cls} has no rule`).toBe(true);
  }
});
