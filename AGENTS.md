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

tests     1475
pass      1026
skipped    442
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

`test-baseline.json` holds the machine-readable copy that `npm run test:ci`
reads. **The two are updated in the same commit or not at all.**

### Why 442 tests skip

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

**A skipped suite is not a passing suite.** 442 tests prove nothing when the
variable is unset. Do not read a green-looking run as coverage of the clinical
engine, orders, customers, tenant isolation, or the pharmacy website record —
none of that is being exercised.

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
| **No test database:** 1026 pass / 442 skip / 7 fail, categories A+B | No regression. Proceed. |
| **Test database configured:** ~1384 pass / 0 skip / 4 fail, categories A+C | No regression. Proceed — and this run is worth far more than the one above. The figure is derived, not observed: the last measured configured run was 1381 on 2026-09-05, before three database-free tests were added. Re-measure and replace this with a real number rather than trusting the arithmetic. |
| Any failure NOT among the 9 | **You broke something.** Fix the code, not the test. |
| Fewer than 1026 passing | Something stopped running. Find out what. |
| More than 442 skipped | A suite started skipping. That is a silent loss of coverage, not a pass — unless you added tests that skip, in which case say so and move the ceiling in the same commit. |
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
