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

**Measured 2026-08-29**, at commit `75e2689` *"Let a trade account place a
trade-sized order"* on `main`, with an uncommitted working tree (40 paths —
the test-database separation work).

```
Command:  npm test
          ( eslint . && node --test "server/tests/*.test.js" )

eslint    0 errors, 44 warnings          (all no-unused-vars, in tests/helpers)

tests     1200
pass       807
skipped    386
failed       7
```

Updated 2026-08-29 twice: the golden suite added 6 (1161/768 → 1167/774), then
the reply-cap fix added 5 more (→ 1172/779), then the consultation-briefing
fix added 6 (→ 1178/785), then billing phases 1–3 added 22 (→ 1200/807).
`test-baseline.json` holds the machine-readable copy that `npm run test:ci`
reads. **The two are updated in the same commit or not at all.**

### Why 386 tests skip

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

**A skipped suite is not a passing suite.** 386 tests currently prove
nothing. Do not read a green-looking run as coverage of the clinical engine,
orders, customers or tenant isolation — none of that is being exercised.
Setting `TEST_DATABASE_URL` to a separate database and running
`npm run migrate:test` turns these back on, and will surface real failures
that are currently invisible.

### The 7 known failures

Two distinct categories. Keep them distinct.

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

### How to use this baseline

After `npm test`, compare:

| Observation | Meaning |
|---|---|
| 768 pass / 386 skip / 7 fail, same 7 names | No regression. Proceed. |
| Any failure NOT in the 7 above | **You broke something.** Fix the code, not the test. |
| Fewer than 768 passing | Something stopped running. Find out what. |
| More than 386 skipped | A suite started skipping. That is a silent loss of coverage, not a pass. |
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
