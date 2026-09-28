# Working rules for AI agents in this repository

This file is binding on any AI agent making changes here. It exists because
the expensive failures in this codebase have not been bad new code — they
have been *working old code that quietly stopped working*, with nobody
noticing until a pharmacy did.

Read `ARCHITECTURE_AUDIT.md` for what the system is. This file is about how
to change it.

---

## The loop

Every feature, fix or refactor follows this order. It is not a suggestion
about tidiness; each step exists because skipping it has cost something.

```
UNDERSTAND
    ↓
IMPACT ANALYSIS
    ↓
SMALL CHANGE
    ↓
NEW TEST
    ↓
REGRESSION TESTS
    ↓
GIT DIFF
```

### UNDERSTAND

Read the code you are about to change, and read the comments above it. The
comments in this repository carry measured numbers, dates and incident
history — `services/db.js` records the exact connection timings behind every
constant in it, and `orders/orderLimits.js` names the real customer
conversation that produced each rule. A change that contradicts one of those
comments is a change that is re-opening a closed incident.

Three files are exceptions and must not be trusted: `README.md`,
`ARCHITECTURE.md` and the header of `server/index.js` all still describe a
scaffold that no longer exists.

### IMPACT ANALYSIS

Before editing, establish who depends on what you are touching. `grep` for
the module's name. The high fan-in modules are listed in
`ARCHITECTURE_AUDIT.md` §12; `services/db.js` alone has 82 dependents.

State the blast radius in your own output before you edit. "This touches
`patientEventTypes.js`, which 20 modules import" is the sentence that
prevents a rename from becoming a repo-wide breakage.

### SMALL CHANGE

One behaviour per change. A diff that both moves code and changes it cannot
be reviewed, because the reviewer cannot see which lines are the move and
which are the change.

### NEW TEST

**Every new feature must include tests for the new behaviour.** A feature
with no test is not complete, regardless of whether it works when you try it
by hand.

Write the test so that it fails without your change. A test that passes
against the old code is testing something other than what you built.

Follow the house pattern: the test names in this repo are sentences stating
the rule, and the comments above them say what real failure the test is
defending against. `tests/orderLimits.test.js` and
`tests/clinicalFilter.test.js` are the models.

### REGRESSION TESTS

**The relevant regression suite must be run before a change is considered
complete.** Not "the tests I wrote" — the suite.

```bash
npm test
```

That is `eslint . && node --test "server/tests/*.test.js"`. Lint runs first
deliberately: a `ReferenceError` in a branch no test happens to walk is
invisible to the suite but fatal in production, which is exactly how a
deleted variable (`shelfHasMore`) reached `orderService.js`.

Compare the result against **the baseline below**. Reporting "the tests pass"
without that comparison is not evidence of anything, because the suite is not
green and has not been for some time.

### GIT DIFF

Read your own diff before saying you are done.

```bash
git diff
git status --short
```

Check for: files you did not mean to touch, debugging left in, a change that
is larger than the one you described. State what changed and what you
verified. If something is broken or unfinished, say so plainly — a partial
change reported as complete is worse than no change.

---

## Two hard rules

### 1. A feature is not complete without tests and a regression run

New behaviour ships with tests for that behaviour, and with the regression
suite run and compared to the baseline. Both, every time.

### 2. Never fix a failing regression test by weakening the test

If a test starts failing, the default assumption is that **your change broke
the behaviour the test was defending**. Fix the code.

A test may only be changed when the *intended product behaviour* changed —
and then the change is to the test's stated rule, with the reason recorded in
a comment, in the same commit as the behaviour change.

Specifically forbidden as a way to get to green:

- deleting a failing assertion
- loosening an assertion (`assert.equal` → `assert.ok`, exact → "contains")
- adding `{ skip: true }`, `.skip`, or a conditional that makes the test not run
- widening an accepted range until the wrong answer fits inside it
- catching and swallowing the error the test exists to detect

This matters more here than in most codebases. `tests/clinicalFilter.test.js`
is not a test file, it is the **specification** of what the assistant may
answer without a pharmacist. Its MUST ESCALATE half is a patient-safety
boundary and its MUST ANSWER half is the product being useful at all.
Weakening either direction to get a green run is changing what the product
does to real people, silently, in a commit that claims to be a test fix.

If you cannot make a test pass without weakening it, stop and say so.

---

## After a bug: the golden suite

Fixing a bug is half the work. The other half is making sure that exact bug
cannot come back, because it will — the same reasoning that produced it the
first time is still in the codebase, and an AI agent re-deriving a solution
from scratch will re-derive the mistake too.

```
BUG
 ↓
FIX
 ↓
REGRESSION TEST
 ↓
ADD TO GOLDEN SUITE
```

`server/tests/golden.test.js` is organised by **incident**, not by module.
Every other test file tests a unit; this one encodes lessons. It grows and is
never pruned, so protection accumulates instead of resetting each time
somebody new touches the code.

**Its four rules:**

1. Every entry names the incident it came from, and the date.
2. **Nothing in it may need a database, a network, or a model.** It must run
   everywhere, always. A golden test that skips is not protection — it is a
   comment with extra steps, and 386 tests in this repo already skip and
   prove nothing.
3. Entries are only ever added. Removing one asserts the lesson no longer
   applies, which is argued in a commit message, never done quietly to get
   a green run.
4. When one fails, **the code is wrong, not the test.**

**Template:**

```
GOLDEN-0NN — <one line: what the user experienced>
Date:       <when it was found>
Symptom:    <what was observed, in the user's words where possible>
Cause:      <the mechanism, not the blame>
Protection: <what this test would have caught>
```

**Prefer a structural invariant over a specific reproduction.** GOLDEN-001
came from "Pharmacy A received Pharmacy B's inventory". It does not test that
today's queries are correctly scoped — `isolation.test.js` does that, against
a real database. It tests that the *shape* which makes the leak possible
cannot be introduced: that no tool schema lets the model name a tenant, and
that every tool guards before it queries. A reproduction protects against one
bug; an invariant protects against the whole class.

That distinction earns its keep immediately. GOLDEN-002c — asserting the
test-database guard fails closed on an unparseable URL — failed on first run
and exposed a real hole in the guard: `postgres://` parsed to the identity
`pg::5432::`, a confident answer about a string naming no database. Found by
writing the invariant, not by hitting the bug in production.

---

## The baseline

You cannot prove you did not break the old code without knowing what was
already broken. These are the numbers to compare against.

**Measured 2026-09-06**, on the merge of `website-builder` into `main`
(parent `8729e7d` *"Stop dropping the messages of the patient who most needs
an answer"*), with no test database configured.

```
Command:  npm test
          ( eslint . && node --test "server/tests/*.test.js" )

eslint    0 errors, 44 warnings          (all no-unused-vars, in tests/helpers)

tests     1487
pass      1033
skipped    447
failed       7
```

**These are the NO-DATABASE numbers, and that is deliberate.** `server/.env`
is gitignored, so an unconfigured machine is the committed default and the
gate has to be valid there. With `TEST_DATABASE_URL` configured the same
commit measures **1385 / 1381 / 0 / 4** — so the recorded figures are a floor
on passing and a ceiling on skipping, and both environments pass. See
"What a test database changes" below, which is now a measured result rather
than a prediction.

Updated 2026-08-29 twice: the golden suite added 6 (1161/768 → 1167/774), then
the reply-cap fix added 5 more (→ 1172/779), then the consultation-briefing
fix added 6 (→ 1178/785), then billing phases 1–3 added 22 (→ 1200/807).

Updated 2026-09-05: website builder phase 1 added 35 (→ 1235/825). **17 of
those 35 skip**, which is why the skipped floor moved from 386 to 403 — they
are the new `websiteService` database half and all of `websiteIsolation`,
skipping for the same pre-existing reason as every other database suite. The
gate correctly BLOCKED on the rise before this was recorded: it cannot tell a
new test that skips from an old suite that stopped running, and it is right
to stop rather than guess. The 18 that run are the validators, the template
registry and the server/grapesjs import boundary — all of which need no
database, deliberately.

Updated 2026-09-06: website builder phase 2 added 48 (→ 1284/873). **47 of
them do not touch a database and always run** — the block contract's registry,
validation, rendering, escaping, template composition and editor-adapter
tests. That is deliberate: the block contract is what turns a pharmacy's
stored data into HTML on the public internet, and it is the last thing in this
repository that should be guarded by a suite which skips. Only the 48th, a
cross-tenant render assertion in `websiteIsolation`, needs a database, which
is why the skipped ceiling moved 403 → 404.

Updated 2026-09-06: website builder phase 3 added 22 (→ 1306/895), **all of
them database-free** — the theme contract, the generated stylesheet and the
published document, including the JSON-LD escaping and the noindex rule. The
skipped ceiling did not move at all, which is the shape every phase of this
feature has aimed for.

Updated 2026-09-06: website builder phase 4 added 31 (→ 1337/910). 15 run
anywhere — the web-address rules, the public resolver against malformed
input, and GOLDEN-005, which asserts the SPA fallback cannot swallow a
published pharmacy website. The other 16 need a database because publishing
is a database act; they moved the skipped ceiling 404 → 420.

Website builder phase 5 (2026-09-06) added the advanced editor and **no
server tests at all** — these counts are unchanged by it. Its 18 tests are
client-side and run under `npm run test:ci`, which is worth knowing before
concluding that a phase shipped untested: the client suite is now 31 tests and
is where the editor's correctness lives, because the editor is client code.
The one that matters most asserts that `site_data` survives a round trip
through the editor unchanged, against the server's real block manifest rather
than a fixture — if that ever fails, merely opening the editor damages a page.

Website builder phase 6 (2026-09-06) added 23 (→ 1360/920), 10 of them
database-free. Its database half uses an in-memory store double rather than a
real bucket: there is no test Supabase project, so the seam in
`services/website/assetStore.js` is what makes tenant path prefixing and
cross-tenant asset resolution testable at all. The Supabase calls themselves
remain untested and are deliberately the thinnest code in the feature.

Website builder phase 7 (2026-09-06) added 25 (→ 1385/936), 16 of them
database-free. Analytics are counted server-side and buffered in memory,
because published pages carry `script-src 'none'` and cannot host a tracking
script without giving up the guarantee that makes the stored-XSS class
unreachable. Subdomain resolution is implemented and tested but INERT: it
needs `PUBLIC_SITE_DOMAIN`, which stays unset until wildcard DNS and TLS are
confirmed. See docs/test-database-setup.md.

Updated 2026-09-06, on main while the branch above was open: GOLDEN-006
added 1, needing no database. render.yaml and deploy/Caddyfile were both
pointing their health check at /api/health, which pings Postgres — so a
database blip would have restarted the process and dropped every pharmacy's
WhatsApp socket, or with Caddy, answered 502 for the whole dashboard.
server/index.js had argued against exactly that for months and both
deployment files disagreed with it.

Updated 2026-09-06: `conversationPolicy` added 2, also database-free. Every
inbound WhatsApp message from one live patient had been dropped for three
days — 16 of them — by a deadlock between the one-open-conversation index,
the sweep's correct refusal to close a thread awaiting a pharmacist, and a
policy branch that asked for a second open thread anyway. Three existing
tests in that file were *corrected*, not relaxed: they had been pinning a
decision the database could not carry out, and passed throughout.

**Merged website-builder into main, 2026-09-06 → measured 1388/939/442/7.**
Three files conflicted, all additively: this one, `test-baseline.json`, and
`golden.test.js` (004/005/005b from the branch, 006 from main, kept in
numeric order). The 7 failures are the same pre-existing names as before the
merge, and the skipped ceiling did not move — everything added on main since
the branch was cut is database-free.

**Changing design on an existing website, 2026-09-08 → measured 1485/1033/445/7.**
`websiteService.switchTemplate` is the one operation the Website redesign
needed that did not exist: `createWebsite` refuses once a site exists, by
design, so switching had to be its own function rather than a weakened guard.
Its 3 tests raise the SKIPPED ceiling from 442 to 445, which is the one
direction this baseline treats as a blocker — declared here rather than
worked around, per "unless you added tests that skip" below. They are gated
because the behaviour worth pinning is what the UPDATE does and does not
touch: template_id and site_data change; `theme`, `content` and everything
published stay exactly as they were. That cannot be asserted without a
database. Pass, fail and the 7 known failures are all unchanged.

**Photographs on the generated pages, 2026-09-08 → measured 1482/1033/442/7.**
`pharmacy_assets` already carried `kind in (logo, hero, gallery, service)` and
`width`/`height`, so nothing about the data model needed changing. What was
missing is that `assetMapFor` dropped both on the way to the renderer, so a
generated page could neither ask for "the hero photo" nor emit the dimensions
that stop a page shifting as images load. Alt text is generated from the
pharmacy name and city — true, and useful to a screen reader — and never
describes what is in the frame, which no part of this system has seen. The 7
added tests are database-free; the skipped ceiling did not move.

**Added the deployed commit to the health endpoints, 2026-09-06 → measured
1395/946/442/7.** The whole difference is `server/tests/version.test.js`: 7
database-free tests over `.git` HEAD parsing, so they run whether or not a
test database is configured. Nothing else moved. Worth recording is how the
first attempt failed — GOLDEN-006 matches the `/api/live` route as TEXT, and
the forbidden word appeared in a comment I had just written inside it. The
comment was reworded; the test was left alone. That is rule 2 working on the
person who wrote the rule.

**Pharmacy websites on their own hostname, 2026-09-06 → measured
1405/956/442/7.** `resolveSiteKey` had preferred the host since it was
written, but the router was mounted only at `/p`, so `<address>.rxnaija.com/`
arrived with path `/`, matched nothing, and fell through to the SPA fallback —
serving the dashboard shell, at 200, to a pharmacy's customers and to Google.
Exactly the failure GOLDEN-005 exists to prevent, reached by the shape it did
not cover. GOLDEN-005c closes it and was checked the only way worth checking:
the bug was reintroduced, the test failed, the fix restored.

The other 9 are `tlsAsk.test.js`. Certificates for pharmacy subdomains are
issued on demand, and a wildcard DNS record means any hostname reaches the
box — so without a gate a stranger can spend a weekly issuance limit that is
counted against the entire registered domain. The gate is security-critical
and its non-database half is exported specifically so it can be tested
without Postgres. All 10 are database-free; the skipped ceiling did not move.

**The WhatsApp number field saved nothing, silently, 2026-09-09 → measured
1487/1033/447/7.** `client/src/website/api.js`'s `savePublicWhatsappNumber`
sent `public_whatsapp_number` (snake_case); `updateAssistantSettings` only
ever checks `'publicWhatsappNumber' in fields` — so the field was never
"present" as far as that function could tell, the update quietly kept
whatever was already stored, and a pharmacy owner who filled the box in and
saved got no error and no WhatsApp button anywhere on their site. Every other
field this same endpoint accepts (`botName`, `welcomeNote`, `notifyPhone`,
`replyMode`) is camelCase; this was the one call site out of step with its
own endpoint. Fixed at the call site, not by teaching the endpoint a second
key shape. The 2 added tests are `assistantSettings.test.js`'s and need a
database — they pin that `updateAssistantSettings` both recognises the field
under its real name AND converts a local `0…` number to the `234…` form a
wa.me link needs, which is also the second half of the report this fixes
("the number should be 080 or 070, not require the international form" —
`normalisePublicNumber` already did that; it was just never being reached).
The skipped ceiling moves 445 → 447. A third test, database-free, was added
to `client/src/website/api.test.js` and pins the request body's shape
directly — the same file's own header says thin wrappers around fetch are not
worth testing individually, and this one is the counterexample: the body
shape WAS the bug, and nothing else would have caught either side renaming
its half of the contract.

**Medication journeys and the refill call list, 2026-09-19 → measured
1686/1207/472/7.** Measured first on HEAD `bf0e185` with no change applied:
1620/1166/447/7. So the 133 tests `main` gained after the 2026-09-09 figures
were all database-free — the skipped ceiling had not moved, and the gate was
right to pass them. This change adds 66. **41 always run**: `refillSchedule`
(30 — the Lagos calendar day, the run-out date, the due/overdue/lapsed
boundaries, the profile counts) and `refillInput` (11 — the request-body
contract; dashboard forms send `"30"`, and without that layer every UI
enrolment would have failed while every service test passed). **25 need a
database** — `medicationJourneys` (24: tenant isolation on every write and
read, the one-active-journey index, the same-day duplicate refused under a
real concurrent race, the call list agreeing with the schedule rules at the
boundary day) and one in `patientEventArchitecture` — which moves the
SKIPPED ceiling 447 → 472, declared here per the rule below. That one is
also the only existing test edited: its "reserved entity type is accepted"
example moved from `medication_journey` (which 0052 gave a table) to
`delivery` (still reserved), with the reason in a comment, and a new test
pins that `medication_journey` is now verified. With a local test database
the same tree measures **1686/1681/0/5** against **1620/1615/0/5** before
— the same five names, the four in A+C plus the flaky pre-keys test.

**The patients module — search, filters, the chronic switch and the
patient record, 2026-09-20 → measured 1733/1225/501/7**, no test database, against HEAD `20269da`. This change adds
43 server tests. **18 always run**: `patientFilters` (12 — the filter
contract: the eight filter names and their allowed values, the 400 that
names the offending field so a bad query string can never quietly widen a
result set, and the chronic switch, which has exactly one spelling on the
wire because a switch shown ON while the server filtered nothing would put
every patient in front of a pharmacist who asked for the ones they follow)
and `careInput` (6 — the PATCH body contract for assignment and for age and
sex). **25 need a database** — `patientSearch`, which is the
whole point of the feature and cannot be honestly tested without one: every
filter at its boundary day, several filters combined (AND, never OR), the
options list built from this pharmacy's own conditions, medicines and
pharmacists, the assignment rules, and cross-tenant refusal proven at the
database (a foreign key rejecting with 23503) rather than by a service
remembering to check. That moves the **SKIPPED ceiling 472 → 497**, declared
here per the rule below. No existing test was edited, and the 7 failures are
the same 7 names. The patient record — the twelve-section navigation and the summary that
links into it — added 4 more database tests to `customerProfile.test.js`,
for the two fields the summary needed on the profile: a patient's
CONFIRMED-BY-PURCHASE conditions, and their consultation counts. Both read
through a join, which is where a tenant scope gets lost with no visible
symptom, so one of the four plants pharmacy B's condition on pharmacy A's
customer id and proves it is not returned. That moves the skipped ceiling to
**501**. Its client half is 20 tests across `patientRecordTabs.test.js` (the
sections and their order), `patientRecordNav.test.js` (CSS invariants,
including that this second sidebar never opens on hover — the first one
does, and a record is worked in with the cursor crossing the column) and
`patientSummaryModel.test.js`, which pins the wording: an unrecorded section
says "not recorded" and never "none", because an empty Allergies card
reading "None" is how a pharmacist gets told someone is safe by a system
that has simply never been asked.

**Consultation, phase 3 — the record's integrity, 2026-09-28 →
2128/1406/715/7 (no database).** CONSULTATION_PLAN.md §32 (amendment with a
reason and a snapshot), §39 (entered-in-error, refined), the per-note audit
view and the permission model.

**0070 adds ONE table and NO fifth status**, and the status is the
interesting decision. `amended` is the obvious design and it was rejected
twice over:

1. **A note reopened to be corrected is not finished.** Labelling it
   `amended` would show a half-rewritten clinical record as though it were
   signed — the opposite of what §32 is for. It goes back to `in_progress`,
   because it really is in progress, and re-finalising puts it back to
   `completed` **through the same gate**. An amendment cannot be used to get
   round §23: a blood-pressure review that needed an objective to be signed
   still needs one after being reopened, which a test proves end to end.
2. **"Has this been amended, and how often?" is answered by COUNTING** the
   snapshot rows, on every read. A stored counter is one more thing that can
   disagree with the rows it counts, and nothing else in this feature stores
   a derived answer.

**0067 had already enforced the design that follows.** Its CHECK says a note
in `draft` or `in_progress` carries no `completed_at` and no `finalised_by`,
so reopening must clear both — which is right rather than merely required: a
reopened note has no signature, and naming whoever signed the version being
replaced would attribute a record they have not seen. Who signed it is in the
snapshot, where it stays true.

**The snapshot is a FULL COPY, not a diff.** A diff of a clinical record is
only readable beside the thing it applies to, and once there are two
amendments nobody can reconstruct the middle version without replaying them
in order and getting it right. §32 exists so that what the note SAID is
recoverable, and a full copy is the only form of that which cannot be got
wrong. This is the one place in the whole feature that deliberately COPIES
clinical values rather than pointing at them — everywhere else a copy would
go stale, and here going stale is the entire purpose.

**Two holes in entered-in-error, closed.** A retired note could be AMENDED
back into the record, which is precisely the laundering §39 exists to
prevent. And it could be RE-MARKED: the second call overwrote `error_reason`,
losing the only explanation the record has, and put a second
`CONSULTATION_ENTERED_IN_ERROR` on the audit trail for something that
happened once.

14 server tests — **3 database-free** (`consultationInput`: an amendment
always says why, with a blank box refused and a SHORT real reason accepted —
the floor is there to refuse an empty box, not to make a pharmacist justify
themselves to a form; the amend roles asserted to be the same frozen
`FINALISING_ROLES` list rather than a copy, because a note is reopened in
order to be re-signed and splitting them would let a staff member reopen a
record nobody could then close; and the status vocabulary asserted to have
gained nothing) and **11 needing a database** (`consultations`: the snapshot
keeping what the note SAID after the note says something else; the whole note
and not a diff; a second amendment as its own entry; an amended note still
held to its gate; an OPEN note refused as "amended"; a retired note refused
amendment; re-marking refused with the first reason surviving; the role rule
with nothing written on refusal; the history scoped to THIS note with
cross-tenant AND same-pharmacy refusal; the audit view in order with who did
it; and amending creating no clinical record anywhere). Skipped ceiling
**704 → 715**, declared here per the rule below. The 7 failures are the same
7 names. The client adds 6 in `consultationFormat.test.js` (client 294 → 300).
**With a local test database: 2128/2123/0/5.**

**Five mutations were run against the service, and each turned exactly the
right test red**: the snapshot never written (4 red), the snapshot taken
AFTER the reopen (1 red, on the assertion that it kept `completed`), and each
of the three guards removed in turn (1 red each, the matching one). A sixth,
hard-coding `amendmentCount` to 0, turned red the test that had just gained
it.

**The client says nothing about versions.** A note nobody has corrected shows
no badge at all — never "Original", never "Version 1", never "No
amendments", all three being claims about a history nobody has looked at, and
the first two inventing a version number this product does not have. A note
that HAS been corrected says so wherever it is read, because the text on
screen is not what was signed.

**A history shows an event it cannot label rather than dropping it.** A
history that silently omits what it has no wording for reads as complete when
it is not, which is the one thing an audit trail must never do. The
unlabelled event is shown by its raw name and marked, and a test reads the
event list from the SERVER so a new type shipping without wording is caught.

**A wrong heading, caught by opening the screen.** The amend panel was first
offered on a retired note too, under a section headed **"Amend this note"**
that then said the note is not amended. A heading naming an action the panel
refuses is worse than no panel: the section is now offered only on a
finalised note, and the sentence moved into the banner that already explains
the status. Its test moved with it, with the reason in a comment.
**Consultation, phase 2 — the problem list, what was done, and where the
patient was sent, 2026-09-28 → 2114/1403/704/7 (no database).**
CONSULTATION_PLAN.md §12 (problems with pointers), §14 (interventions), §17
(referral), §16 (the prescription review) and §21 (the care-programme
pointer).

**0069 adds two TABLES rather than two array columns**, for the reason 0056
settled for the medication review: an intervention is about a PROBLEM, and
held as `text[]` on the note, *"which problem did you ring the prescriber
about"* cannot be answered. That relation is the thing a second pharmacist
reads the note to find out.

**A problem carries a pointer, never a copy.** Label, certainty, status and at
most one `(ref_kind, ref_id)` — resolved through `clinicalRefs.describeRecord`
on every load, so a dose changed in Medications shows here next time and the
note can never display a value that has stopped being true. A record deleted
from its own section leaves the problem saying **"No longer on the record"**
rather than the row vanishing: that the consultation was about it is a fact,
and losing it would rewrite the note.

**The referral distinction, held in three places.** `referral_destination` is
nullable AND has a `none` value, and they are different clinical facts:

```
NULL     nobody considered referral        → the summary says NOTHING
'none'   a pharmacist decided against it   → "No referral required"
```

A CHECK requires a reason whenever a destination is named, because "Refer to
hospital" with no reason is something neither the next pharmacist nor the
hospital can act on. Nothing is inferred: §17 requires a validated clinical
rule before software suggests a referral and this product has none, so no code
reads the assessment and proposes one.

**The summary order was CORRECTED, and the correction is the interesting part.**
Phase 2 first appended problems and interventions to the END of
`consultationSummary`, so a pharmacist filled the screen in one order
(assessment → problems → interventions → plan) and read it back in another
(… → plan → problems → interventions). Nothing failed; it was simply wrong for
the person reading it in a hurry. The order is now the SOAP one — the problem
list and the interventions belong to the assessment, and the plan follows from
them — and pinned by a test that was mutation-checked by putting the plan back
where it had been.

**The record pickers were EXTRACTED, not copied.** `CarePrograms.jsx` already
held a map from `condition | medication | test | vitals | encounter` to the
owning section's own endpoint and row shape, which is exactly what a problem
pointer needs. It is now `client/src/recordPicker.js`, used by both, and its
test asserts the invariant that matters: **every kind either screen may OFFER
can actually be listed** — read from the server's own `PROBLEM_REF_KINDS` and
`LINK_KINDS` rather than a fixture. The failure it prevents is a pharmacist
choosing "Medication", waiting, and being told this patient has none while the
Medications section beside it shows four. Removing one picker turns it red;
that was checked.

27 server tests — **12 database-free** (`consultationInput`: a problem carrying
a pointer and never a copy, a half-written pointer refused in both directions,
a referral that names somewhere having to say why, a prescriber outcome refused
unless somebody was recorded as contacted, an intervention refused when it
names a problem the note does not hold, and the summary reading back in the
order the note is written) and **15 needing a database** (`consultations`:
cross-tenant refusal on every new write; another patient's record refused as a
pointer; a deleted record leaving the problem saying so; the list ordered as
the pharmacist ordered it; an intervention naming another consultation's
problem refused; the referral CHECK at the database; the prescription review;
the care-programme pointer checked against this patient's own programmes;
and the audit trail). Skipped ceiling **689 → 704**, declared here per the
rule below. The 7 failures are the same 7 names. The client adds 14 — 5 in
`consultationFormat.test.js`, 5 in the new `recordPicker.test.js` and 4 in
the new `consultationLayout.test.js` (client 280 → 294). **With a local test
database: 2114/2109/0/5.**

**The 15th database test was found by driving the endpoints, not by writing
it.** Deleting a problem left the intervention behind with its pointer
cleared — 0069's `on delete set null` doing exactly the right thing, and
nothing asserting it. An intervention is a professional act that HAPPENED,
so a pharmacist tidying a problem off the list must not thereby erase the
record of the call they made about it. Mutation-checked by switching the
constraint to `cascade`, which turned it red.

**Phase 2 also closed a phase-1 gap nobody had noticed:** the workspace used
six `ui-consult-*` class names that had no styles at all — it rendered, but as
unstyled controls. `index.css` now has the block, and it keeps the same rule
the rest of the module does: no red anywhere, including on an emergency
referral, because design.md reserves red for a person waiting on a human and
that is the consultation DESK.

**And a visual defect the browser found that no test could have.** An
emergency referral put its tone on the `<dd>`, which is `display: block` —
so instead of an amber label the panel got a 662px tinted BAR, and
`.ui-consult-summary dd` outranked `.ui-tone-1` on colour, so the text was
not even amber. Read off `getComputedStyle` on the running screen. The tone
now goes on a pill, as everywhere else in this app, and
`client/src/consultationLayout.test.js` pins three rules that would have
caught it and the unstyled-class gap above: every `ui-` class the workspace
uses has a CSS rule behind it, a tone is carried by a pill and never by a
block, and the screen names no tone of its own (they all come from
`consultationFormat.js`, where the no-red rule is already pinned).

**Its own first draft was wrong twice, and both are recorded in the file.**
One test asserted the JSX contains an amber tone — it contains none, because
the tones live in the format module, so it failed on its premise and was
rewritten into the invariant that keeps them there. And the
class-is-defined check first used `CSS.includes(".ui-consult-add")`, which a
rename to `.ui-consult-addX` satisfies by substring; it now matches a whole
token.

**Consultation, phase 1 — the pharmacist's note, 2026-09-27 → 2087/1391/689/7
(no database).** CONSULTATION_PLAN.md phase 1, approved before code.

**The inspection changed what this module is.** The brief asked to redesign the
Consultation workflow and said a separate Pharmacist Triage workflow already
exists. Reading the code first: `Consultations.jsx` **is** the triage desk —
its own header says *"The previous version was a stack of triage cards… queue
on the left, the whole case on the right"* — and triage otherwise is a
server-side engine (`redFlagEvaluator`, `safetyGate`, `clinicalFilter`,
`protocolExecutionService`) that writes `clinical_encounters`. What does not
exist anywhere is the place a pharmacist records **their own** assessment: no
objective, no impression, no intervention, no plan, no referral record, no
consultation type, no finalisation.

So this is not a redesign. **It is the missing half**, and it falls along the
split the brief itself names from Medplum: `clinical_encounters` is the
Encounter, and `pharmacist_consultations` is the ClinicalImpression beside it.

**0067 adds a table rather than widening the live one.** `clinical_encounters`
is written by the assistant *during* a conversation; a consultation is written
by a person, possibly days later, has its own draft → completed → retired life,
and one episode may carry more than one assessment. Adding twenty columns to a
table the WhatsApp ingest writes is the change this repo's baseline exists to
catch. The live path needed no edit at all.

**The encounter is OPTIONAL** (owner's decision). Most community-pharmacy
consultations happen at the counter with no WhatsApp thread, and a module that
only documented the minority which began in a chat would be the wrong module.
Where there is an episode, §6's triage summary is READ from it rather than
re-typed; where there is not, the panel is **absent rather than empty** — a
triage panel saying "no red flags" on a counter consultation is a safety claim
nobody made.

**Consultation types are DATA** (`consultation_definitions`, the
`test_definitions` / `care_program_definitions` pattern), and a type does not
create a second form. It says which sections are emphasised and — the part
that matters — **which must be filled to finalise**. §23's conditional
requirements are therefore a column, not a hard-coded list: the same
half-written note finalises as a minor ailment and is refused as a
blood-pressure review, which a test proves end to end.

**§22's summary is derived on every read and is not a column**, with a test
asserting no column matching `%summary%` exists. A stored summary goes stale
the moment the note is edited, and §22 says it must come from what the
pharmacist actually entered.

**The summary OMITS what was never entered.** Not "Referral: none", not "Nil",
not "No abnormality" — nothing at all. That sentence on a note where nobody
considered referral is a clinical claim the software invented, and the next
pharmacist reads it as a decision somebody took. A test asserts the rendered
summary contains none of `none / nil / not required / no abnormality /
unremarkable / normal`.

**0068 exists because 0067 forgot the assessment column.** Every shipped type
requires an assessment to finalise, so as shipped 0067 created a note that
could never be completed. Migrations here are forward-only, so it is a second
migration rather than an edit — AGENTS.md: *"A bad migration is fixed by
writing the next one."* The untidiness is the honest record.

31 server tests — **15 database-free** (`consultationInput`: the four states,
the role rule, a focused examination asserted to contain no hospital field, a
blank finding stored as absent rather than empty, the type-driven finalisation
gate, and the summary that omits what was not entered) and **16 needing a
database** (`consultations`: cross-tenant refusal and another patient in the
same pharmacy refused; a counter consultation with no episode; an episode's
triage read and **not copied** into the note's own columns; another patient's
episode refused; a draft saved field by field; the gate at the database; a
staff member writing but not finalising; a finalised note refusing edits with
409 and never deleted; entered-in-error keeping the row with its reason; **a
consultation creating no Condition, Allergy, Vitals, medication or task as a
side effect**; the table asserted to have nowhere to store a measurement; the
history, the summary, and the audit trail). Skipped ceiling 673 → 689.

**A name collision caught before it bit.** `clinicalRefs.js` already resolves
the word `consultation` to `clinical_encounters` — the Clinical module calls an
encounter a consultation. The new entity type is therefore
`pharmacist_consultation`, not `consultation`: one name meaning two tables is
how a pointer finds the wrong row.

**With a local test database: 2087/2081/0/6.** The sixth is NOT a regression
and is deliberately not in `test-baseline.json`:
`websiteAnalytics.test.js` → "a flush writes the buffer and a second flush adds
to it" fails **only between 23:00 and 00:00 UTC**, and this was measured at
23:2x. `analytics.today()` returns the UTC day on purpose (its comment explains
why); the test asserts against `day = current_date`, which Postgres evaluates
in the session timezone — `Africa/Lagos`. Measured directly: service day
2026-09-26, `current_date` 2026-09-27. A test yardstick, not a product defect,
and it has its own task. Outside that hour the figure is 2087/2081/0/5.

**The record stopped advertising sections it does not have, 2026-09-26 → server
numbers unchanged at 2056/1376/673/7.** The owner asked for **Clinical view**,
**Form entry** and **Appointments** to be removed from the patient record. All
three were `built: false` placeholders that had never had a screen, so nothing
was replaced — and every section that remains is built, which a new test now
pins so a placeholder cannot quietly come back.

**Removing a tab orphans whatever points at it.** The summary carried an
**Appointments card** whose `tab` named the section being removed. Left alone
it would have rendered a card that opens nothing — and
`patientSummaryModel.test.js`'s own rule, *"nothing on the summary is a dead
end"*, **would not have caught it**: it only checked the destination was a
STRING. It now checks the destination EXISTS, for record sections
(`PATIENT_TABS`) and for other modules' screens (`MODULE_TABS`) alike. Both
halves were mutation-checked — pointing a card at a removed section, and at a
module screen that does not exist, each turn it red.

The Consultations card is untouched and still correct: it names a screen in the
Clinics MODULE, not a section of the record, and that screen exists.

No server test touches any of this, so the baseline above is unchanged. Client
270 → 271.

**Messages, phase 3 — internal threads, 2026-09-26 → 2056/1376/673/7 (no
database).** Staff-to-staff threads about a patient (§14), which **cannot
reach that patient** — and GOLDEN-007, which is the first entry in the golden
suite written WITH a feature rather than after an incident.

**The danger, stated plainly.** Every outbound message in this product ends at
one function, and a conversation row is a conversation row. An internal thread
distinguished only by a flag is one missing WHERE clause away from delivering a
pharmacist's private clinical discussion to the person being discussed. So the
guarantee is built from three things that must all fail before a leak is
possible:

1. **`conversations.channel`** — an internal thread is a different KIND of row,
   not a flagged one.
2. **0066's CHECKs** — an internal message cannot carry a provider id, a
   delivery status or a category, and an internal conversation cannot carry a
   reply window or be left in `mode = 'bot'` for the assistant to answer. There
   is nowhere to record one as sent.
3. **The guard in `sendAndRecordOutbound`**, which reads the channel from the
   conversation and refuses BEFORE the consent check and long before the
   transport.

**Checked before building it:** the assistant's history is loaded as
`select direction, body from messages where conversation_id = ...` in
`worker.js`. It is scoped BY CONVERSATION, so an internal note — being its own
conversation — is never in the set rather than filtered out of it. That is what
made one message store safe, and a test runs the worker's own query shape
against real rows to prove it.

**The one-open index was NARROWED, never weakened.** `idx_conversations_one_open`
now applies `where status = 'open' and channel = 'whatsapp'`. Every existing row
has `channel = 'whatsapp'`, so the predicate matches exactly the same set as
before; a patient may have one open WhatsApp thread and several internal ones.
A test asserts BOTH halves — that internal threads do not collide, and that a
second open WhatsApp thread is still refused by the index with 23505. That
second half is the invariant whose violation dropped 16 live messages for three
days.

**GOLDEN-007 found something while being written.** Its first draft asserted
that `outboundMessage.js` is the ONLY module that calls the transport. That is
false — `worker.js`, `routes/orders.js`, `routes/whatsapp.js` and
`staffAlert.js` all call `sessionManager.sendText` directly. Each is
legitimate, and for the same reason: they fire only where there is **no
conversation** (the `else` of `if (target.conversation_id)`), or they message
the pharmacy's own number. So the real invariant is not "one caller" but
**every send that NAMES a conversation goes through the one path**, and the
test pins that list closed plus asserts both branchers still route a send with
a conversation through the guard. A fifth caller now has to justify itself.

**Two more things GOLDEN-007's own drafts got wrong**, both caught by running
it: a regex for the function body stopped at the destructured parameter list's
closing `\n})` and captured the ARGUMENTS, and `fs` was used without the
per-test `require` this file uses. Both fixed; the guard was then mutated two
ways — removed entirely (2 golden tests red) and moved to AFTER the transport
(007a red on its ordering assertion) — and restored.

17 server tests — **7 database-free** (`messageInput` 3: the two kinds with the
patient's as the default, the subject and first note an internal thread needs,
and a note contract carrying no route to a patient; **`golden` 4**) and **10
needing a database** (`patientMessages`: internal threads not colliding with the
open WhatsApp thread while a second WhatsApp thread is still refused; an
internal thread never appearing in the patient's own history or transcript
read; **the send path refusing an internal thread and an unknown one at
runtime**; the database refusing to record an internal note as sent; a note
refused into a patient conversation; cross-tenant refusal; notes in order with
their authors; internal unread counting colleagues' notes and never your own;
the event log carrying the SUBJECT and never the note; and the assistant's
history query proven unable to see one). Skipped ceiling 663 → 673. The client
adds 3 in `messageFormat.test.js`. With a local test database: 2056/2051/0/5.

**Outreach (§15) was NOT built**, and `canStartConversation` is still false.
An internal thread is not outreach, because it never leaves the pharmacy.

**Three existing tests changed with the product, none relaxed.** The default
list query gained `channel` (still `deepEqual`); the capabilities test gained
`internalThreads: true` with the reason, while keeping the assertion that
matters most — this product still does not message a patient first; and "reading
a patient's messages creates nothing and sends nothing" was **tightened**, from
"no export matches send|reply|create|start" to "nothing matches send|reply, and
the only creator is `createInternalThread`".

**A pre-existing defect surfaced, diagnosed and NOT fixed here.**
`medications.test.js`'s "an edit changes what it names and leaves the rest of
the record alone" fails intermittently (~1 run in 6 in isolation, more often
under the parallel full run). `addMedication` lets `updated_at` default to the
database's `now()`; `updateMedication` sets it from Node's `new Date()`. Two
clocks for one column, so a clinical record's "last updated" can move backwards
and "which edit was later" becomes unanswerable. Nothing in Messages touches
medications — it was exposed by running the suite, not caused by it. It is
**deliberately not in `test-baseline.json`**, per the rule that listing an
intermittent failure as known is how a flaky test becomes permanent, and it has
its own task.

**Messages, phase 2 — the connections, 2026-09-26 → 2039/1369/663/7 (no
database).** What a conversation was ABOUT (§13), unread per person (§17), a
follow-up raised from what a patient said (§23), and the summary card (§28).

**Two new tables, and nothing added to `conversations` or `messages`.** 0064
adds `conversation_links` and `conversation_read_marks`; 0065 widens
`patient_tasks_source_type` to accept `conversation`. The tables carrying live
WhatsApp traffic gained one nullable column in 0063 and none at all here.

**A link is a POINTER, and the test says so structurally.** `conversation_links`
holds a kind, an id and an optional note — the label comes from the section that
owns the record, through `clinicalRefs.describeRecord`, on every read. So a dose
changed in Medications shows in the conversation next time it is opened, and a
thread can never display a value that has stopped being true. The test asserts
the table's COLUMN LIST, not the absence of a value in a row: the first version
searched the serialised row for `148` and failed spuriously, because a uuid
contains three-digit runs by chance. That version would also have proved
nothing. The replacement is care programmes' shape — **the table has nowhere to
put a clinical value.**

**Unread is per READER, and that is the whole point.** A flag on the message
would mean the first pharmacist to open a thread clears the badge for the
colleague who was about to answer it — and the colleague never learns the
patient was waiting. `conversation_read_marks` holds one row per (conversation,
user) with the moment that person last read it; unread is COUNTED on read as
inbound messages newer than the mark. No counter to drift, no backfill, and a
user with no row has read nothing, which is correct. **Nothing is marked read
by reading**: listing, opening the transcript and loading the summary all leave
the mark alone, and a test asserts all three write no row — §17 says do not mark
read before it is viewed, so the mark is a POST from a screen that has actually
rendered the transcript.

**A reader we cannot identify gets 0, never the pharmacy's count.** With no user
id the counts come back zero rather than somebody else's unread, which would be
the per-pharmacy behaviour this deliberately is not.

**§23 creates nothing automatically.** A pharmacist types what needs to happen
and presses the button; `source_type = 'conversation'` records where it came
from. A conversation belonging to another patient is refused as the source, by
the same `assertRecord` check every other source kind gets.

17 server tests — **5 database-free** (`messageInput`: every offered link kind
asserted to be resolvable by `clinicalRefs`, so the screen cannot draw a link
nothing can open; **no appointment link**, because there is no appointments
table, while the topic label stays; a link carrying a kind and an id and never a
copy of what the record says; the attach contract's rejections; and a follow-up
able to name a conversation as its source) and **12 needing a database**
(`patientMessages`: the column-list invariant, cross-tenant refusal on attach
and on reading links, only this patient's own records attachable, a deleted
record leaving the link saying so, detach removing the link and never the
record, the duplicate attach being one attachment, the audit trail staying
internal and carrying no value, the follow-up raised from a conversation, unread
per reader, nothing marked read by reading, the unidentified reader, the summary
agreeing with the section, and a transcript carrying its OWN links). Skipped
ceiling 651 → 663. The client adds 8 — five in `messageFormat.test.js` and three
in `patientSummaryModel.test.js`. With a local test database: 2039/2034/0/5.

**One existing test extended, not relaxed.** `patientMessages.test.js`'s "a
patient has at most ONE active thread" asserts the counts object exactly; phase
2 gave it two more keys, so the expectation gained them. Still `deepEqual`, still
exact — the rule it pins (the counts describe the patient, not the filtered
list) is unchanged, with the reason in a comment.

**The summary card counts unread, not conversations.** A badge counting threads
tells a pharmacist how long somebody has been a customer, which never changes
and which nobody needs on a summary. Three states apart as everywhere else: the
read failed ("Not recorded"), nobody has ever messaged ("No messages"), and
everything has been read ("Nothing unread"). A thread waiting on a pharmacist
outranks anything merely unread — one is about the patient, the other about the
reader.

**Messages — the patient's communication history, 2026-09-25 → 2022/1364/651/7
(no database).** MESSAGES_PLAN.md phase 1, approved before code. The patient
record's **Messages** tab had never had a screen (`built: false`), so giving it
one replaced no behaviour — the same clean position as Clinic → Care program
and Encounters → Follow-up.

**This module is unlike the six before it: the thing the brief asked for
already existed.** `conversations` and `messages` have been here since 0001 and
receive every live patient's WhatsApp traffic, with five migrations of incident
history defending them. So the work was not "build messaging" — it was **build
a patient-scoped VIEW without breaking the thing the view is about**, which is
§36 of the brief: do not keep a second copy of the messages.

**What was NOT built, deliberately, and why:**

- **No second send path.** Replying goes to `POST /api/conversations/:id/reply`,
  which already checks the WhatsApp connection, declares a category to
  `communicationPolicy` and resets the handoff clock. Archiving likewise. The
  patient service exports nothing matching `/send|reply|create|start/` and a
  test asserts that.
- **No second open thread.** The brief's §5 shows three ACTIVE conversations
  for one patient; `idx_conversations_one_open` forbids it, and the last time
  code asked for a second open thread it deadlocked and dropped **16 messages
  from a live patient over three days**. The owner chose one open thread with
  history as sessions. The index is untouched and the ingest is untouched.
- **No "+ New Message".** This product is strictly reactive — `staffAlert.js`
  says every message it has ever sent is a reply to somebody who wrote first,
  and that is what its channel-risk argument rests on. Outreach waits for its
  own pass (owner's decision).
- **No attachments.** The only file store is the PUBLIC `pharmacy-assets`
  bucket; a patient's attachment cannot live at a guessable public URL. The
  same wall Tests hit in 0060. Inbound `media_url` WhatsApp already stored is
  displayed — existing data, not new storage.
- **No appointments link.** There is still no appointments table.

0063 adds one nullable `topic` column plus who set it and when, and an index.
**No default:** every conversation predating 0063 arrived before topics did, and
`general` would be this product inventing an answer about thousands of real
threads — the "None" on an allergy card nobody was asked about (0058).

23 server tests — **10 database-free** (`messageInput`: the topic vocabulary,
the two states the database actually has, the four authors that keep the
assistant and the pharmacist apart, the delivery states asserted to be the
provider's own with no invented value, a bad filter refused rather than
silently widening the list, and the capabilities that tell the screen what this
phase cannot do) and **13 needing a database** (`patientMessages`: cross-tenant
refusal on read, transcript and relabel; **another patient in the same pharmacy
refused too**, because a conversation id is not a capability; one active thread
with the rest as history; archiving losing nothing; the transcript keeping
patient / assistant / pharmacy / system apart and in order; an unknown delivery
status reported as null rather than "sent"; search that cannot reach another
patient's messages; the summary agreeing with the section; and a read that
creates and sends nothing). Skipped ceiling 638 → 651. The client adds 12 in
`messageFormat.test.js`. With a local test database: 2022/2017/0/5.

**Two bugs the database caught on the first run.** The shared column list was
written `c.id, c.status, …` and reused inside an `UPDATE … RETURNING`, where no
alias exists — "missing FROM-clause entry for table c". And the test helper
wrote a closed conversation with `workflow_state = 'open'`, which 0024's
`conversations_workflow_matches_status` CHECK refused: the constraint doing
exactly its job.

**A third the test caught, and it would have lost a patient's history.**
`recordEvent`'s default idempotency key is `eventType:entityType:entityId`,
which is right when the entity itself is the uniqueness — a conversation is
started once. A topic is a judgement that can be revised, so the second relabel
of a thread was silently discarded as "already recorded" and the history showed
one change where two had happened. It now passes an explicit key.

**One existing test changed with the product:**
`patientRecordTabs.test.js`'s built list gains `messages`, with the reason in a
comment. The rule it pins — exactly the sections marked built are the ones with
a screen — is unchanged.

**Follow-ups, phase 3 — the follow-up elsewhere, 2026-09-25 → 1999/1354/638/7
(no database).** A **Follow-up** card on the patient summary and a **Follow-ups**
brief in the clinical context, so a pharmacist writing up a medicine can see
that a repeat blood pressure is three weeks late without leaving the screen.

**One read feeds both**, as in care-programme phase 3. `followupSummary` is the
same query the queue itself uses, trimmed to the three that are waiting and
their counts — so the section, the summary card and the context brief cannot
disagree about what is outstanding or what is late. The counts sentence comes
from one function too (`summaryParts` in `followupFormat.js`), for the same
reason three screens should not find three ways to write "2 overdue · 1 today".

**"Nothing outstanding" and "no follow-ups" are different claims**, and the card
says whichever is true: nothing was ever raised, or everything raised has been
dealt with. "Not recorded" is kept for the read that failed or never happened.
Same distinction as the allergy card (0058) and the care-programme card, and it
matters the same way — a pharmacist reading "nothing outstanding" about a
patient whose follow-ups simply failed to load is being told the work is done.

2 server tests, **both needing a database** (`followups`: the summary agreeing
with the queue's own counts, ordered overdue-first, carrying no percentage,
capped, and refusing a cross-tenant read; `medications`: the context panel
carrying the follow-ups and showing an empty list rather than a missing key when
there are none). Skipped ceiling 636 → 638; pass is unchanged at 1354 and the 7
failures are the same 7 names. The client adds 5 — two in
`patientSummaryModel.test.js` and three in `followupFormat.test.js`. With a
local test database: 1999/1994/0/5.

**A false sentence on a real screen, found by opening it.** The card asked
whether any follow-up had ever been raised; the brief did not, and told a
pharmacist "Nothing outstanding" about a demo patient who had never had one.
Two screens, two answers, one of them untrue. The fix is not to correct the
brief — it is that WHICH empty sentence is true is now one function
(`emptyText` in `followupFormat.js`) that both ask, so they cannot answer
differently again. Its test reintroduces the bug and fails on it.

**A worthless assertion, caught by mutating the code it guarded.** The summary
test first asserted that a completed follow-up is absent from `next` while
asking with the default cap of 3 — where the completed row fell off the end
anyway. Setting the filter to let `completed` through left the test GREEN. It
now asks with a limit that could hold the row, and fails when the filter is
wrong. Both of this phase's tests were checked that way: the behaviour was
removed, the test failed, the behaviour restored.

**Nothing new is written anywhere.** The card and the brief are pointers: no
screen outside the Follow-up section creates, completes, reschedules or cancels
one, and `medicationContext` gained one key without changing the shape of any
other.

**Follow-ups, phase 2 — the connections, 2026-09-25 → 1997/1354/636/7 (no
database).** Three things that only make sense once the queue exists:
completing a follow-up may RECORD the reading it produced, each follow-up has
its own history, and a signed medication review offers to turn its follow-up
date into a follow-up.

**The reading goes to Vitals, through the Vitals contract.** The completion
panel's boxes come from `vitalRanges` (one list, tested against it), the route
validates them with `readVitalsInput` — the same contract the Vitals screen
uses, so a follow-up cannot invent a second idea of a plausible blood
pressure — and `recordVitals` writes the row. The follow-up keeps its id. A
test asserts the numbers come back through `vitalsSeries`, which is what makes
it one record rather than two.

**The reading is written BEFORE the completion transaction, deliberately
outside it.** `recordVitals` owns `patient_vitals` and opens its own
connection, and that is the right way round: a reading taken at the counter
HAPPENED, so if the completion then fails it still belongs in Vitals and is
there. The reverse — a completed follow-up pointing at a reading that was never
saved — is the failure worth preventing. The follow-up is checked first, so a
bad id cannot leave a stray reading behind, and recording one AND pointing at
another is refused as two answers to one question.

**The history is THIS follow-up's**, filtered to its row by the entity its
events already point at. The patient's record is a different screen, and the
other follow-ups are already in the queue's Completed and Cancelled groups —
this answers what those cannot: when it was raised, every time it moved, and
who did it.

**The medication review's follow-up date now goes somewhere.** A signed review
with one shows "Create follow-up", prefilled from what the pharmacist already
wrote, and — once created — "Follow-up created — open it". Nothing is created
automatically (§27), and a second press cannot duplicate it because the screen
reads which reviews already have one.

5 server tests — **2 database-free** (`followupInput`: record a reading OR
point at one, never both; and the measurements offered are the Vitals screen's
own list) and **3 needing a database** (`followups`: the reading landing in
`patient_vitals` and read back through `vitalsSeries`, with the audit saying it
was recorded rather than linked; a reading refused by the Vitals contract
leaving the follow-up untouched; and the history holding this follow-up and not
another). Skipped ceiling 633 → 636. The client adds 3 in
`followupFormat.test.js`. With a local test database: 1997/1992/0/5.

**A date-dependent defect the calendar surfaced.** The real day rolled over
from the 24th to the 25th mid-session and `carePrograms.test.js`'s "progress
counts what the rows say, at the boundary day" started failing — 2 overdue
where it expected 1. Not the test's fault and not phase 2's: `addActivity`,
`addGoal`, `removeGoal`, `removeActivity`, `enrolProgram` and `createFollowup`
all returned progress and buckets computed against the REAL day while their
caller had named another, so the same call answered differently depending on
when it ran. They now honour the day they are given, and the test passes on any
date. Fixed in the services; the test was left exactly as written.

**Follow-ups — the patient's action queue, 2026-09-24 → 1992/1352/633/7 (no
database).** FOLLOWUP_PLAN.md phase 1, approved before code. The patient
record's **Encounters** tab — which had never had a screen — became
**Follow-up**. The distinction is the owner's: the Clinical module's
Consultation documents what HAPPENED; the patient record carries what needs to
happen NEXT.

**0062 is a rename, not a new table.** `care_program_activities` became
`patient_tasks`, with `program_id` made nullable and `customer_id` added
(backfilled from the programme, then NOT NULL). A follow-up raised from a
consultation and an activity inside a care programme are the same kind of row —
a thing to be done for this patient, on a date, by somebody, possibly repeating
— and two tables would give "what does this patient need next?" two answers,
two overdue calculations and two due-today lists. That is the call 0055 made
when it extended `medication_journeys` instead of adding `patient_medications`
beside it, and the brief (§22) asked for it explicitly: do not build a second
task system.

```
program_id IS NULL      a follow-up raised on its own
program_id IS NOT NULL  a care-programme activity, which is also a follow-up
                        and appears in the same queue
```

**The proof the rename was safe is the 31 care-programme tests passing
unchanged against it** — and two of those tests were CORRECTED rather than
left: they queried `information_schema` for `care_program_activities`, which
would now match nothing and pass vacuously. One of them gained
`assert.ok(cols.length > 0)` so it can never pass on an empty answer again.

**Due and Overdue are derived** from the due date against the Lagos day (§5),
never stored — and **a follow-up may have no due date at all**: "review the
HbA1c when the result comes back" is a real thing to remember, and forcing a
date would put a made-up one in front of a pharmacist. Completing records an
outcome and POINTS AT what it produced; the reading stays in Vitals (§12).
Rescheduling keeps the date it moved from and counts the moves; cancelling
keeps the row with its reason and is the one act that needs a pharmacist.

28 server tests — **14 database-free** (`followupInput`: the optional due date,
the repeat that needs a first one, an outcome belonging only to a follow-up
that was done, the cancel reasons, and an assertion that the task vocabulary is
the SAME frozen object the care plan uses rather than a copy) and **14 needing
a database** (`followups`: cross-tenant refusal on every read and write; the
queue bucketing at the boundary day; a care-programme activity appearing in the
patient's queue while a standalone follow-up never reaches the programme's plan
or counts; every kind in the vocabulary accepted by the CHECK; completion with
a result pointer; exactly one next occurrence for a repeat; rescheduling;
cancelling with the role rule; and the audit trail). Skipped ceiling 619 → 633.
The client adds 12 in `followupFormat.test.js`. With a local test database:
1992/1987/0/5.

**Two shared modules came out of this, rather than a second copy.**
`services/clinical/taskRow.js` holds the one row shape and INSERT for
`patient_tasks`, used by both the care-programme service and the follow-up
service. `services/clinical/clinicalRefs.js` answers "is this record this
patient's, in this pharmacy?" for every feature that points at a record it does
not own.

**A bug 0062's own CHECK caught immediately.** `updateActivity` set a status of
`cancelled` without recording WHEN — the column had not existed before — and
the new `patient_tasks_cancelled_has_time` constraint refused it on the first
run. Fixed in the service, not by loosening the constraint.

**Three client tests were changed with the product**, each with the reason in a
comment: the record's twelve labels (Encounters → Follow-up), the built list,
and "every section names the one it opens" — a summary card may now name a
record section OR a module screen, because the Consultations card became the
second kind when consultations stopped being a section of the record.

**Care programmes, phase 3 — the programme elsewhere, 2026-09-24 →
1964/1338/619/7 (no database).** A **Care program** card on the patient summary
and a **Care programmes** brief in the clinical context (Medications and the
Review), so a pharmacist writing up a medicine can see that this patient is
being followed for something and that a task is three weeks late, without
leaving the screen.

**One read feeds both.** `careProgramSummary` is the same query the section
itself uses, trimmed to three open programmes and their counts — so the tab,
the summary card and the context brief cannot disagree about what is open or
what is overdue. The counts LINE they print comes from one function too
(`countsLine` in `carePlanFormat.js`), for the same reason: three screens
should not find three ways to write "Goals 1/3 · Tasks 8/12".

**The wording distinction this phase had to get right.** The summary card says
**"Not recorded"** when the read failed or never happened, and **"No care
programmes"** when it succeeded and was empty. Those are different claims, and
the difference is real: whether somebody was enrolled is a fact this system
holds completely — nobody can be in a programme it was never told about —
whereas "no allergies" is a fact it can only know by asking. The same
distinction the allergy card has made since 0058, applied the other way round.

3 server tests, **all needing a database** (`carePrograms`: the summary
agreeing with the section, an ended programme leaving the active list with
nothing outstanding, the three-programme cap and cross-tenant refusal;
`medications`: the context carrying the programmes and showing an empty list
rather than nothing when there are none). Skipped ceiling 616 → 619; pass is
unchanged at 1338. The client adds 4 — two in `patientSummaryModel.test.js`
(the card's counts, and "no care programmes" said only when the record was
actually read) and two in `carePlanFormat.test.js`. With a local test database:
1964/1959/0/5.

**Nothing new is written anywhere.** The card and the brief are pointers: no
screen outside the Care program section starts, changes or completes a
programme, and `medicationContext` gained one key without changing the shape of
any other.

**Care programmes, phase 2 — the connections, 2026-09-24 → 1961/1338/616/7
(no database).** Monitoring, related records and links, and the programme's own
timeline. **None of the three holds anything**, which is the whole point of the
phase: the Care program section had to become useful without becoming a second
copy of Vitals, Tests, Conditions or Medications.

- **Monitoring** reads through `vitalsSeries` (0054) and `testTrend` (0060) —
  the same functions the Vitals and Tests screens use — so a panel here cannot
  drift from the section it points at. A correction made in Tests shows in the
  programme on the next load, because there is only one of the number.
- **What a programme watches needs no column.** It is the template's
  `monitoring` list PLUS every goal that reads a measurement, deduplicated. A
  programme typed by hand, with no template, gets a panel the moment somebody
  writes a goal that measures something.
- **Related records** are the links a pharmacist attached by hand, plus a live
  query for conditions, medicines and tests sharing the programme's house
  condition code. A record already attached is not listed twice, and detaching
  removes the LINK only — the condition stays on the patient's record and
  returns as a derived one.
- **The timeline** is the events the service already writes, filtered to this
  programme by the entity they point at. The patient's whole history is its own
  screen; mixing them would bury six events under three hundred messages.
- **A record deleted from its own section leaves the link saying so** ("No
  longer on the record") rather than the row vanishing, which would lose that
  it was ever attached.

11 server tests — **3 database-free** (`careProgramInput`: the attach contract
carries a kind and an id and never a copy of what the record says; the
monitoring list; and a metric this product cannot read being left out rather
than shown empty forever) and **8 needing a database** (`carePrograms`:
monitoring read from the real tables with an assertion that no table in this
feature has a column that could hold a clinical value; a hand-typed programme
watching its goals; cross-tenant refusal on all four new reads; the derived and
attached lists; only this patient's own records attachable; the deleted record;
the timeline holding THIS programme and not the patient's; and attaching and
detaching on the audit trail). Skipped ceiling 608 → 616. The client adds 5 in
`carePlanFormat.test.js`. With a local test database: 1961/1956/0/5 — the four
known names plus the known-flaky pre-keys test.

**Three bugs the tests caught before any screen existed.** An unknown
monitoring `source` fell through both guards and would have been queried as a
test code. A vitals metric came back with no unit, so the panel would have
shown a bare "148" — the unit now comes from `vitalRanges`, the one place that
knows. And `addLink` returned a read on a FRESH connection from inside its own
transaction, so attaching a record answered with the list as it was and the
screen would have looked like it did nothing; the transaction is now passed
through, as every other write path in this service already does.

**One test was changed with the product, deliberately:**
`carePlanFormat.test.js`'s "the four sections of a programme" is now six, with
the reason in a comment. The rule it pins — the sections and their order — is
unchanged.

**Care programmes, 2026-09-24 → 1950/1335/608/7 (no database).**
CARE_PROGRAM_PLAN.md phase 1, approved before code. The patient record's
"Clinic" tab had never had a screen (`built: false`), so renaming it to **Care
program** replaced no behaviour — worth saying plainly, because the brief warned
against renaming a page and leaving its old behaviour, and there was none to
leave. Two other things the brief assumed were checked and are NOT there: this
product has **no tasks table and no appointments table anywhere**. So
`care_program_activities` IS the task list — the first task concept in the
product, which a future Tasks module grows from rather than arriving beside —
and a follow-up is an activity with a due date. No appointment store was built.

0061 adds `care_program_definitions` (7 shipped templates, data not code, with
`pharmacy_id is null` like `test_definitions`), `patient_care_programs` (the
enrolment: six statuses, and CHECKs that a completed programme carries an
outcome, a discontinued one a reason, and an open one no end date),
`care_program_goals`, `care_program_activities` and `care_program_links` (which
phase 1 does not use yet). **Nothing clinical is stored in any of them.** A goal
records WHERE its value is read from — a vitalRanges key or a test code — and
the screen reads it from Vitals or Tests on display, so a goal and the reading
it is about cannot disagree. Progress is counted on read: there is no progress
column, no score, and **no percentage anywhere**, because a percentage over
tasks answers "how much of the admin is done" and beside a patient's name reads
as a claim about the patient (the owner chose counts only).

Enrolling in a template copies its goals and activities into the patient's own
rows, dated from the start day and editable from that moment; the template is
never consulted again, and the programme NAME is snapshotted so renaming a
template cannot rewrite what somebody was enrolled in. Completing a recurring
task writes **exactly one** next occurrence, in the same transaction, anchored
to the day it was DUE rather than the day it was done — a task ticked off nine
days late does not push the schedule nine days later — and rolls forward if that
date is still in the past. The completed row is kept. Only a pharmacist or owner
may complete, discontinue or cancel a PROGRAMME; anyone may enrol, write the
plan and tick off a task, because doing the work is not closing the file.

41 server tests — **20 database-free** (`careProgramInput`: the ended-programme
rules, the role rule, a template trusted over the client, a goal refused when it
names a metric this product does not record, the month clamp on a repeat, the
next occurrence, and progress asserted to contain no percentage) and **21
needing a database** (`carePrograms`: cross-tenant refusal on read, enrol, edit,
goals and tasks; the template expanded into the patient's own rows; the
duplicate refused by the service with the existing programme named AND by the
index, which is what actually holds under a race; ending a programme keeping
every goal and task; the CHECKs themselves refusing a meaningless ending; a task
that was done refusing deletion; a link checked against its own table and this
patient; and the audit trail, including the next date a repeat created).
Skipped ceiling 587 → 608. The client adds 13 in `carePlanFormat.test.js`, and
`patientRecordTabs.test.js` was changed deliberately with the rename. With a
local test database: 1950/1946/0/4.

**Three bugs this work surfaced, all caught by tests before any screen existed.**
`clinicalAudit.js` keeps its own allowlist of event types, so all 21 database
tests failed on the first run until the seven `CARE_PROGRAM_*` events were
registered — the guard doing its job. `carePlanFormat`'s current-value line used
`filter(Boolean)`, which dropped a reading of 0 and printed the unit on its own.
And `errorHandler`'s 409 block, extended to name a programme as well as a
condition, put `label: undefined` beside a condition's name; `errorHandler.test.js`
says "its id and name, nothing more", and an empty key is one more thing — the
code was fixed and the test gained the programme half rather than being relaxed.

**Tests — diagnostic results, 2026-09-23 → 1909/1315/587/7 (no database).**
TESTS_PLAN.md phases 1 and 2, approved before code. 0060 adds
`test_definitions` (a catalogue that grows as DATA — 31 shipped rows with
`pharmacy_id is null`, a pharmacy may add its own), `patient_tests` (ONE row
per test event: the order and the report are the same event in a community
pharmacy, so `ordered → pending → preliminary → final → amended/corrected/
cancelled` lives on one row), `patient_test_results` (one row per analyte,
with a CHECK that a row carries exactly one kind of value — a number, a code,
or words) and `patient_test_corrections` (what a finalised report said
before). A value entered NEVER finalises a report by itself: it becomes
preliminary until a pharmacist says otherwise, and only a pharmacist or owner
may finalise, amend, correct or cancel. Editing a finalised report snapshots
it first and comes out `corrected`, with a reason. 31 server tests —
**14 database-free** (`testInput`: the preliminary rule, a reported test
needing a performed date, one kind of value per row, ranges belonging to a
number, the reading OFFERED from the range typed beside it and never saying
"critical", the role rule) and **17 needing a database** (`tests`:
cross-tenant refusal, round trip for quantitative / coded / text / panel,
the lifecycle, corrections keeping every earlier value, the role rule, the
filters and their counts, a trend in ONE unit only, the consultation link and
another patient's refused, the shipped catalogue readable by every tenant, the
summary other screens show, the database's own CHECKs, and the audit trail).
Skipped ceiling 570 → 587. The client adds 11 in `testFormat.test.js` and 1 in
`patientSummaryModel.test.js`. With a local test database: 1909/1905/0/4.

**The Vitals/Tests line holds by construction.** `patient_vitals` (0054) has
no glucose column, so a glucose TEST has only one home. Nothing here creates a
condition: the catalogue's `condition_code` exists so a result can be shown
BESIDE a condition a pharmacist recorded, never to make one.

**The nav entry "Test results" is now "Tests"** (owner): the section covers
orders and pending tests, not only results.

**Attachments are NOT built** (owner's decision). The only file store is the
PUBLIC `pharmacy-assets` bucket, and a patient's lab report cannot live there;
a private bucket with signed URLs waits for its own pass. A test names its
laboratory and report reference in `source_name` meanwhile.

**Two bugs this work surfaced, both found by driving the browser.** A
finalised report that a form re-saved with the status it had loaded kept
"Completed" while its values changed — the service now forces `corrected`
whenever a finalised report changes. And re-saving a finalised report
unchanged demanded a reason for a change nobody had made; "nothing to do" is
now decided before the correction rules.

**Conditions — the problem list, 2026-09-22 → 1878/1301/570/7 (no database).**
CONDITIONS_PLAN.md phases 1 and 2, approved before code. 0059 adds
`patient_problems` (FHIR Condition concepts: six clinical statuses, six
verification statuses, category, severity, body site, onset and resolution at
the precision known, source, asserter, consultation link) and
`patient_problem_evidence` (a link to a vitals reading, never a copy). It sits
BESIDE `patient_condition` (0037, the purchase engine's inference, "not a
diagnosis") and never merges with it: an inference shows as a labelled
suggestion and becomes a record only when a pharmacist writes it down. Same
role rule as allergies: only a pharmacist or owner may confirm, list as a
differential, refute or mark in error. A second current condition with the same
code or name is refused with 409 unless "continue anyway", which the audit
records. 36 server tests: **16 database-free** (`problemInput` 15: honest
defaults, codes that are terminology-ready, the six-and-six statuses, untrue
never current, resolution only on an abated condition, the symptom and allergy
hints never refusing, the catalogue's codes shaped like ICD-10;
`errorHandler` 1: a 409 names the record it conflicted with) and **20 needing
a database** (`problems`: cross-tenant refusal, round trip with consultation
and reading linked, another patient's consultation or reading refused, the
duplicate rules, history kept with dates and reasons, role rule, audit, the
purchase suggestion hidden once recorded, triage's seed, 0059's carry-across,
a picker that creates nothing, and the Patients list counting a recorded
condition under the chronic switch, the Condition filter and the column).
Skipped ceiling 550 → 570. The client adds 10 in `conditionFormat.test.js`
and 2 in `patientSummaryModel.test.js`. With a local test database:
1878/1874/0/4.

**The chronic switch now reads both kinds** (owner's decision): a purchase
inference OR a recorded current, non-refuted condition with the house code.
`patientSearch.test.js` is unchanged and still passes, since a patient with no
recorded condition behaves exactly as before.

**Shared, not copied:** `services/clinical/partialDate.js` and
`client/src/PartialDateInput.jsx` came out of the allergy code, and Allergies
uses them unchanged.

**The allergy record, 2026-09-22 → 1842/1285/550/7 (no database).**
ALLERGIES_PLAN.md phases 1 and 2, approved before code. 0058 adds
`patient_allergies` + `patient_allergy_reactions` (FHIR AllergyIntolerance
concepts, one level flatter) and the "no known allergies" assertion on
`patient_profiles`. The overall state is DERIVED — known / none known / not
assessed — so an empty record is never read as "no allergies". Nothing is
deleted: refuted and entered-in-error are kept, with a reason the database
itself requires. First role rule on a clinical route: only a pharmacist or
owner may confirm, refute, mark in error, or assert NKA. 30 server tests —
**15 database-free** (`allergyInput`: honest defaults, allergy vs
intolerance, multiple reactions in order, severity kept apart from
criticality, untrue-never-active, half-known dates at their precision, the
role rule) and **15 needing a database** (`allergies`: cross-tenant refusal,
round trip after refresh, the three states, NKA withdrawn by a new allergy
and refused while one is current, refute / error / resolve kept in history,
the role rule enforced at the service, the audit trail, triage's seed, and
0058's carry-across run twice). Skipped ceiling 535 → 550. The client adds
12 in `allergyFormat.test.js` and 1 in `patientSummaryModel.test.js`. With a
local test database: 1842/1838/0/4.

**Tests rewritten on purpose, with the product.** `medications.test.js`'s
"context says allergies are NOT RECORDED" now asserts the real record — the
same rule ("never say none unasked"), stricter. `patientRecordTabs.test.js`'s
built list gains `allergies`.

**A latent bug this surfaced.** `seedFromProfile` gave each profile allergy
its own `profile_allergy` fact; `recordFact` keeps one live value per concept,
so a second allergy would have raised a false FACT_CONFLICT_DETECTED in
triage. Nothing wrote allergies before, so it never fired. Triage now gets one
`profile_allergies` fact listing every current allergy.

**The medication review, 2026-09-22 → 1812/1270/535/7 (no database).**
Phase 2 of MEDICATIONS_PLAN.md. 0056 adds three tables — `medication_reviews`,
`medication_review_problems`, `medication_review_actions` — because a problem
is about a MEDICINE and an intervention is about a PROBLEM, and held as arrays
on one row "which interaction did you ring the prescriber about" cannot be
answered. Nothing in them is computed: no severity, no score, no suggested
intervention. 21 server tests — **11 database-free**
(`medicationReviewInput`: the signing gate — an outcome, and an intervention
for every review that found a problem; a follow-up needing both a date and a
reason; an intervention refused when it points at a problem the review does
not hold; and the vocabulary carrying labels only, never a rank) and **10
needing a database** (`medicationReviews`: cross-tenant refusal on all three
tables; one open draft per patient; findings replaced wholesale on save so a
removed problem does not linger; a signed review refusing edits with 409; a
finding surviving the medicine it was about being deleted; and the order the
pharmacist wrote the findings in). Skipped ceiling 525 → 535. The client adds
10 in `reviewFormat.test.js`. With a local test database: 1812/1807/0/5.

**A bug this work surfaced.** 0056 ordered findings by `created_at, id`, but
every finding in one save is written in one transaction, where `now()` is
constant — so the tiebreak was a random uuid and a review read back in a
different order on different loads. The DB test caught it by failing only
some of the time. 0057 adds a `position` column, set from the form; forward
only, per the runner's rule.

**An incident this work caused, and the guard it added.** `server/.env`'s
`DATABASE_URL` is the live project. Running `node scripts/migrate.js` from a
checkout, meaning to migrate a local copy, applied 0052–0057 to PRODUCTION on
2026-09-21. The owner chose to keep them: all six only add (the new tables
are empty, the one new `customers` column is null on every row) and `main`
reads none of it — verified read-only. `scripts/migrate.js` now refuses any
non-local host unless given `--production`; the deploy scripts pass it, and
`migrate:test` hands over through an in-process handshake after its own
`useTestDatabase()` check. Nothing about a local run changes.

**The medication record, 2026-09-21 → 1791/1259/525/7 (no database).**
Phase 1 of MEDICATIONS_PLAN.md, approved before any code was written. 0055
EXTENDS `medication_journeys` rather than adding a `patient_medications`
table beside it: six things already read that table meaning "what this
patient takes", and a parallel one would give that question two answers.
31 server tests — **18 database-free** (`medicationInput` 14: the contract,
including that a medicine needs only a name because a pharmacist writing up
what a patient *says* they take often knows nothing else; `errorHandler` 4,
below) and **13 needing a database** (`medications`: cross-tenant refusal on
read, write and edit; every clinical field surviving a round trip; the
payload carrying no inventory field; and the four that hold the status
widening against the refill engine — a completed course leaves the call list
while its refill history survives, and a draft never reaches the list).
Skipped ceiling 512 → 525. The client adds 12 in `medicationFormat.test.js`.

**A bug this work surfaced, in shared code.** `middleware/errorHandler.js`
was dropping `err.field` from every client error. Four input contracts set
it — `careInput`, `vitalsInput`, `patientFilters`, `medicationInput` — and
every form reading `body.field` was highlighting nothing: the message said
"Pulse must be a number" while the pulse box looked like the other eight.
Fixed, with `errorHandler.test.js` holding both halves of the rule: a client
error names its field, and a 500 still says nothing about itself.

**Vitals and biometrics, 2026-09-20 → 1760/1241/512/7 (no database).** The
record's second built section, replicating the OpenMRS 3 flow the owner
asked for: a table of readings, a chart of one sign over time, and a panel
that records a set. 0054 adds `patient_vitals`. 26 server tests: **16
database-free** — `vitalRanges` (10: the adult reference ranges, BMI, and
the rule that NO range is applied to a child or to an unknown age, because a
toddler's pulse of 120 is ordinary and a red number against a healthy child
is how staff learn to ignore red) and `vitalsInput` (6: a form's strings,
and the empty box that must become absent rather than a stored zero — a
pulse of 0 on a living patient). **10 need a database** (`vitals`: the
cross-tenant refusal on both read and write, BMI derived rather than stored,
the adult ranges applied to an adult and not to a child, newest-first
paging, and the table's own refusal of a reading with no numbers in it).
Skipped ceiling 501 → 512. The client adds 11 in `vitalsFormat.test.js`,
the sharpest being that a visit which recorded no temperature is ABSENT from
the temperature line rather than plotted at zero, which would draw a
collapse that never happened.

On the client, 11 tests were added to
`patientSearchQuery.test.js` (filter order, query building and encoding, the
labels, and the chronic switch staying out of the filter count while still
reaching the server); those run under vitest, which this baseline does
not count. With a local test database the same tree measures
**1729/1725/0/4** against **1686/1681/0/5** before — all 43 added tests pass,
and the failures are the four category A+C names, re-confirmed individually.
The fifth failure of the 2026-09-19 run was the flaky pre-keys test, which
passed this time: it is not in the baseline, and a run of 4 or 5 failures
here is the same result.

`test-baseline.json` holds the machine-readable copy that `npm run test:ci`
reads. **The two are updated in the same commit or not at all.**

### Why 715 tests skip

`TEST_DATABASE_URL` is **not yet configured**. Every database-backed suite
skips itself, loudly, rather than running — and each one prints its own
reason (`"TEST_DATABASE_URL not set — <what> was NOT verified"`).

This is the safe state, not a broken one. Until 2026-08-29 that variable was
byte-identical to `DATABASE_URL`, which meant ~87 `DELETE` statements and a
direct `insert into auth.users` were pointed at the live database — five real
pharmacies, a connected WhatsApp socket, and messages from that morning.
`server/tests/helpers/testDb.js` now refuses to run when the two resolve to
the same database, including via a port swap or the direct-connection
hostname.

**A skipped suite is not a passing suite.** 715 tests prove nothing when the
variable is unset. Do not read a green-looking run as coverage of the clinical
engine, orders, customers, tenant isolation, the pharmacy website record, or
the clinical records added since — allergies, conditions, tests and care
programmes all have a database half that is not being exercised.

### What a test database changes — measured 2026-09-05

This section used to end "…will surface real failures that are currently
invisible." That has now been done, against a local PostgreSQL 17.10, and the
prediction was correct.

```
                    unset      configured
tests                1385            1385
pass                  936            1381
skipped               442               0
failed                  7               4
```

Three distinct things happened, and they should not be confused:

1. **Five of the seven known failures started passing.** The
   `customerIdentity.test.js` five were never product defects — the module is
   required inside a `before()` that returns early when `SKIP` is true, so the
   binding was only assigned when a database existed. Running the suite fixes
   them. They stay in `test-baseline.json` because they still fail on an
   unconfigured machine, which is the committed default.

2. **Two genuine, previously invisible bugs appeared** in
   `amendPendingOrder.test.js`, both failing with `UNDEFINED_VALUE: Undefined
   values are not allowed` — postgres.js refusing an `undefined` interpolated
   into a query. Real, in the order-amendment path, and unrelated to whatever
   work surfaced them. Recorded in `test-baseline.json` as
   `surfaced-by-configuring-a-test-database`.

3. **One test turned out to be flaky against a local database**:
   `authStore.test.js` → "writing pre-keys costs a constant number of round
   trips". Observed failing in **1 of 4 isolated runs and 3 of 5 full-suite
   runs** — more often under a full run, not less, which is itself a clue:
   `node --test` runs files in parallel, so the CPU term grows under load
   while the floored divisor below cannot. It is a *test* defect, not a
   product one, and the mechanism is worth knowing because the file's own
   comment warns against it: the test normalises elapsed time by a measured
   round trip so that latency cancels out, but floors that divisor at 1 ms.
   A local `select 1` is sub-millisecond, so the divisor clamps to 1 and the
   ratio degenerates back into the raw wall-clock threshold the comment
   explains was removed for being flaky. The ~15–25 ms of CPU spent encrypting
   60 keys then straddles the `LIMIT = 20` boundary. Correct against a remote
   pooler, structurally broken against a fast local one.

   **It is deliberately NOT in `test-baseline.json`.** Listing an
   intermittent failure as "known" is how a flaky test becomes permanent, and
   the gate blocking on it is the gate working. Fix the yardstick.

### Setting one up

Any separate Postgres works — a second Supabase project, or a local instance.
No admin install is required: `embedded-postgres` from npm ships real
PostgreSQL binaries that can be initialised into a scratch directory and
started on a spare port, which is how the numbers above were measured.

Then, for either:

```bash
npm run migrate:test
```

### The 9 known failures

Three distinct categories. Keep them distinct — on an unconfigured machine
you will see A and B (7 failures); with a test database you will see A and C
(4 failures), because B passes as soon as the suite actually runs.

**A. Pre-existing — `server/tests/conditionEngine.test.js` (2)**

```
not ok - 18. A single purchase is PENDING, not confirmed, under the default threshold
not ok - thresholds are configuration, and the engine reads them per condition
```

Deterministic: fails in isolation and in the full run. The file and
`services/clinical/conditionEngine.js` are both unmodified at HEAD. Not
diagnosed. Predates the current work.

**B. Surfaced 2026-08-29 by the test-database separation — `server/tests/customerIdentity.test.js` (5)**

```
not ok - a locally-written Nigerian number and its international form are the same number
not ok - a foreign number is not silently rewritten as Nigerian
not ok - unusable input is null rather than a plausible-looking guess
not ok - a sender with no phone falls back to the LID, clearly marked
not ok - nothing identifying at all yields null, not a fabricated key
```

All five fail with `normalizePhone is not a function`.

These are **pure unit tests that need no database**, but the module is
imported inside the file's `before()` hook, which returns early when `SKIP`
is true. So the binding is only assigned when a database is available. They
were passing only because the suite was running against production.

Not a product defect, and not caused by a code change — emptying
`TEST_DATABASE_URL` exposed a latent coupling in the test file. The fix is to
move the `require` to module scope, which is a change to a test and is
therefore **not** to be made as a drive-by; it needs its own change with its
own reasoning.

**These five pass whenever a test database is configured.** They are kept in
the baseline because the unconfigured machine is the committed default.

**C. Surfaced 2026-09-05 by configuring a test database — `server/tests/amendPendingOrder.test.js` (2)**

```
not ok - a quantity can be changed while the order is still pending
not ok - the price comes from the line, not from a re-read of the catalogue
```

Both fail with `UNDEFINED_VALUE: Undefined values are not allowed` —
postgres.js refusing an `undefined` interpolated into a query.

**These are real bugs**, in the order-amendment path, and they are the first
thing this project has learned from running its database suites. They had
been invisible for as long as the suite had been skipping. Not diagnosed, and
deliberately not fixed by whoever configured the database — a bug in order
amendment deserves its own change, not a footnote in someone else's.

### How to use this baseline

After `npm test`, compare:

| Observation | Meaning |
|---|---|
| **No test database:** 1406 pass / 715 skip / 7 fail, categories A+B | No regression. Proceed. |
| **Test database configured:** 2123 pass / 0 skip / 4-5 fail, categories A+C | No regression. Proceed — and this run is worth far more than the one above. Measured, not derived: 2128/2123/0/5 on 2026-09-28 against a local PostgreSQL 17.10, plus a SIXTH between 23:00 and 00:00 UTC only — the websiteAnalytics timezone-window test described above, which is a test yardstick and not in this baseline (2114/2109/0/5 before Consultation phase 3; 2087/2081/0/5 before Consultation phase 2; 2056/2051/0/5 before Consultation phase 1; 2039/2034/0/5 before Messages phase 3; 2022/2017/0/5 before Messages phase 2; 1999/1994/0/5 before Messages; 1997/1992/0/5 before follow-up phase 3; 1992/1987/0/5 before follow-up phase 2; 1964/1959/0/5 before follow-ups; 1961/1956/0/5 before care-programme phase 3; 1950/1946/0/4 before phase 2; 1909/1905/0/4 before care programmes; 1878/1874/0/4 before tests; 1842/1838/0/4 before conditions; 1812/1807/0/5 before allergies; 1791/1786/0/5 on 2026-09-21 before the review; 1686/1681/0/5 on 2026-09-19 before the patients module). The fifth failure is "writing pre-keys costs a constant number of round trips", the known-flaky one (see below) — it appears in some runs and not others, and is not a regression either way. |
| Any failure NOT among the 9 | **You broke something.** Fix the code, not the test. |
| Fewer than 1406 passing | Something stopped running. Find out what. |
| More than 715 skipped | A suite started skipping. That is a silent loss of coverage, not a pass — unless you added tests that skip, in which case say so and move the ceiling in the same commit. |
| "writing pre-keys costs a constant number of round trips" fails | Known flaky against a local database, ~1 run in 4. Not in the baseline on purpose. Do not re-run until green — read the entry above and fix the yardstick. |

(These numbers were stale before 2026-09-05: the table read 768/386 while the
block above it read 807/386. Both are now derived from measured runs.)
| eslint errors > 0 | Blocking. Lint has caught a real production crash before. |

Name the failures you saw. "7 failures, the known ones" is checkable;
"tests mostly pass" is not.

When the baseline legitimately changes — a database gets configured, one of
the 7 gets fixed — update this section in the same commit, with the date and
the reason.

---

## Repository-specific tripwires

Things that look like ordinary refactors and are not:

- **`services/db.js`** — every constant is an incident postmortem. Failures
  here present as hangs, not errors.
- **`services/safety/clinicalFilter.js`** — runs before the model, and must
  continue to. See rule 2.
- **`services/ai/assistant.js`** — the four-step order (filter → tools →
  validate → send) is a safety guarantee, not a code layout.
- **`orders/orderService.js`** — the stock commit uses a conditional UPDATE
  for race safety. A refactor that loses the condition oversells silently.
- **`productNormalizer.js` / `productIdentityResolver.js`** — they produce
  `natural_key`, the catalogue upsert identity. Change it and the next upload
  duplicates every product instead of updating it. Untested.
- **`patientEventTypes.js`** — 20 modules depend on this vocabulary.
- **Migrations are forward-only.** A bad migration is fixed by writing the
  next one. Never edit an applied migration.
- **`db/test-bootstrap.sql` must stay out of `db/migrations/`.** Applying its
  `auth.uid()` stub to the real database would disable every RLS policy.
