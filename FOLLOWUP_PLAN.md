# Follow-up — architecture plan

**Status: awaiting approval. No production code has been written.**
Brief: the owner's 34-section Follow-up brief, 2026-09-24.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the pattern of
Allergies (0058), Conditions (0059), Tests (0060) and Care programmes (0061).

---

## 1. What already exists

| Thing | Where | Matters because |
|---|---|---|
| **A task system — built today** | `care_program_activities` (0061) | Due date, assignee, five statuses, recurrence (exactly one next occurrence, anchored to the due day), completion with who and when, a validated link to what it produced, and an audit trail. **But `program_id` is NOT NULL**: every task belongs to a care programme. This is the central decision in §2 |
| **No appointments table** | — | The Appointments tab is still `built: false`. §19's "Schedule Appointment" has nothing to schedule into; §34 forbids building one |
| **Consultation** | `clinical_encounters` (0029) + `Consultations.jsx`, the Clinics module's desk | The Clinical module documents what happened. `problems.js#encounterChoices` already lists a patient's consultations read-only, so the source link costs nothing |
| **A follow-up date that goes nowhere** | `medication_reviews.follow_up_on`, `_reason`, `_notes` (0056) | Captured when a review is signed and shown on no screen afterwards. This is the strongest single argument for the feature |
| **"Pharmacist follow-up" tag** | `patientFilters.js` — a staff tag + a search filter | A flag on a patient, not an action with a date. Untouched |
| Care programmes | 0061 — enrolment, goals, activities | A programme's activities ARE follow-up needs. §20: the programme keeps the longitudinal plan |
| Vitals / Tests / Conditions / Medications | 0054 / 0060 / 0059 / 0055, each with a `xSummary()` and a brief component | What a follow-up links to, and what completing one may produce |
| Recurrence | `careProgramInput.nextOccurrence` / `nextDue` / `addMonths` | §23 is already solved, and must be SHARED rather than copied (the `partialDate.js` precedent) |
| Audit | `clinicalAudit.js` + `patientEventTypes.js` | §29. `patientEventTypes.js` is a tripwire: 20 modules import it, and additions are additive |
| **The Encounters tab is a placeholder** | `patientRecordTabs.js:32` — `built: false` | §3 says replace it. But `patientSummaryModel.js:235` has an Encounters CARD pointing at it — see question 2 |

---

## 2. The central decision: one task table, or two

§22 and §34 say: **do not duplicate Tasks if a task system already exists.**
One does — it was built hours ago, and it is `care_program_activities`.

The repository has already decided this exact question once. 0055 EXTENDED
`medication_journeys` rather than adding `patient_medications` beside it,
because "six things already read that table meaning *what this patient takes*,
and a parallel one would give that question two answers."

`care_program_activities` already means **"a thing to be done for this patient,
on a date, by someone, possibly repeating."** A `patient_followups` table
beside it gives "what does this patient need next?" two answers, two overdue
calculations and two due-today lists.

**Recommended — one table.** `0062` renames it to **`patient_tasks`**, makes
`program_id` NULLABLE, and adds the follow-up columns. Then:

```
patient_tasks
  program_id IS NULL      a follow-up raised on its own (a consultation, a
                          test, a review, or by hand)
  program_id IS NOT NULL  a care-programme activity — which is also a
                          follow-up, and appears in the same queue
```

- **Follow-up** = this patient's tasks, whatever raised them.
- **The Care program's Tasks tab** = the same table filtered to that programme.
  Unchanged behaviour; every existing query already filters on `program_id`.
- One due-date engine, one overdue rule, one recurrence, one audit vocabulary.

The alternative is in question 1, with its trade-off stated honestly.

**What the rename costs:** every query lives in `carePrograms.js` and its two
test files. The table is one day old and, on the production database, empty.
Forward-only: `alter table ... rename to` is one statement, and 0061 is never
edited.

---

## 3. Data model — migration `0062_patient_tasks.sql`

```sql
alter table care_program_activities rename to patient_tasks;
alter table patient_tasks alter column program_id drop not null;
alter table patient_tasks add column customer_id uuid;   -- then backfilled,
                                                         -- then set not null
```

**`customer_id` is the important addition.** Today a task reaches its patient
through its programme. A follow-up with no programme has no such path, so the
patient id moves onto the row — backfilled from `patient_care_programs` in the
same migration, then made NOT NULL with a foreign key and an index. That is
also what makes "this patient's action queue" one indexed query.

New columns, each answering one of the brief's eleven questions (§2):

| Column | Brief | Notes |
|---|---|---|
| `reason` text | §2.2, §7 | Why it needs to happen. Free text |
| `priority` `routine \| urgent` | §24 | Default routine |
| `source_type` / `source_id` | §8 | `consultation · medication_review · care_program · test · vitals · condition · triage · manual`. **Distinct from `linked_type`/`linked_id`, which already means what the task PRODUCED** (§12). Cause and result are different facts |
| `outcome` | §13 | `completed · improved · stable · no_improvement · worsened · unable_to_assess · did_not_attend · referred · needs_further_followup · other` |
| `completion_notes` text | §12 | Beside the existing `outcome_note` — one becomes the other; see §9 |
| `cancelled_at` / `cancelled_by` | §15 | The existing `status_reason` carries the reason |
| `rescheduled_count` | §14 | Cheap, and makes "moved three times" visible without reading the audit trail |
| `due_time` time | §7 | Optional. **Overdue stays a DATE comparison** — a task is not late at 09:00 for a 17:00 slot, and the Lagos-day rule already in `carePlanFormat` and the tests holds |

**`kind` grows to the union of both vocabularies** (§6): the nine it has plus
`clinical_review`, `medication_review`, `condition_monitoring`,
`adherence`, `lifestyle`, `care_program_review`, `appointment`. A CHECK
change, forward-only. §6 asks for configurable-later; the honest step now is
one list in one file (`careProgramInput` → `taskInput`), not a table nobody
edits.

**Statuses are NOT extended.** The brief's six (§5) map onto the existing
five: Pending = `not_started`, In Progress, Completed, Cancelled, and
**Due / Overdue are DERIVED from the due date**, exactly as §5 asks and as
`isOverdue()` already does. `skipped` stays for a task deliberately not done.

**No `appointment_id`, no `task_id`.** There is no appointment table to point
at, and the task IS this row — a `task_id` on it would point at itself.

---

## 4. What is derived, never stored

- **Overdue** (§5, §16): `status in (not_started, in_progress) and due_on < today`
  in Lagos. Already written and tested.
- **Due today** (§17), **upcoming**, and the counts on every surface.
- **The next follow-up** (§26).
- Nothing clinical, ever: a follow-up holds ids, not readings.

---

## 5. API — `server/routes/followups.js`, mounted before `routes/customers.js`

| Route | Does |
|---|---|
| `GET /:id/followups?filter=` | the queue: overdue, due today, upcoming, completed, cancelled, with counts |
| `GET /:id/followups/options` | the vocabulary (§6, §13, §15, §24) |
| `GET /:id/followups/sources` | what this patient has to point at: consultations, reviews, programmes, tests, readings, conditions |
| `POST /:id/followups` | create (§7) |
| `GET /:id/followups/:followupId` | the detail view (§11) |
| `PATCH /:id/followups/:followupId` | edit, **reschedule**, **cancel** (§14, §15) |
| `POST /:id/followups/:followupId/completion` | the completion workflow (§12) — its own route because it is its own act, with an outcome and a result link |
| `GET /:id/followups/:followupId/timeline` | this follow-up's history (§18, §29) |

**Roles.** Anyone may create, edit, reschedule and complete a follow-up —
that is the work. **Cancelling** is the one act that says a piece of planned
care will not happen, so it takes the pharmacist/owner rule that allergies,
conditions, tests and programmes already use.

**Audit** (§29): `FOLLOWUP_CREATED`, `FOLLOWUP_UPDATED`,
`FOLLOWUP_RESCHEDULED`, `FOLLOWUP_COMPLETED`, `FOLLOWUP_CANCELLED`,
`FOLLOWUP_REOPENED`, plus the entity type `patient_task`. The existing
`CARE_PROGRAM_ACTIVITY_CHANGED` keeps covering changes made inside a
programme, so nothing about the Care program tab's trail changes.

---

## 6. Screens

**The tab** (§3): `{ id: 'encounters', label: 'Encounters', built: false }`
becomes `{ id: 'followup', label: 'Follow-up', built: true }`. The Encounters
tab has never had a screen, so nothing is replaced — the same situation as
Clinic → Care program. Question 2 covers the summary card that pointed at it.

**The queue** — a clinical action list, not a dashboard (§30):

```
Follow-up                                      [ + Create follow-up ]
All · Due today · Upcoming · Overdue · Completed · Cancelled

OVERDUE
 Repeat blood pressure      Vitals monitoring   Due 20 Sep · 4 days overdue
 Hypertension monitoring · Pharm. John · from Consultation 6 Sep
                                             [ Complete ] [ Reschedule ]
DUE TODAY
 Review HbA1c result        Test review        Due today
UPCOMING
 Medication review          Medication review  Due 30 Sep
```

Urgent wears a mark; **overdue is amber, never red** (design.md reserves red
for a person waiting). A task from a care programme shows "from Diabetes care"
and opens the programme.

**The detail view** (§11) — status, type, due, assignee, reason, source,
related records, notes, and the four actions.

**Completion** (§12) — its own panel: completed when, by whom, an outcome from
§13, notes, and **the result**: link the vitals reading, test or consultation
it produced. Phase 2 records a reading inline through the existing vitals
service (question 3). Nothing clinical is ever stored on the follow-up itself.

**Reschedule** (§14) shows the original date beside the new one and keeps both
in the audit trail. **Cancel** (§15) takes a reason from a short list and keeps
the row.

**Elsewhere** (§26): a Follow-up card on the patient summary — overdue, due
today, upcoming, and the next one — and a line in the clinical-context brief,
reusing the `careProgramSummary` pattern exactly.

---

## 7. Not in this change

An appointment system (§19 — there is nothing to schedule into, and §34
forbids it), a second task system, automatic follow-up creation from a
reading or a result (§27 — a pharmacist creates it; the system tracks it),
clinical recommendations of any kind, a calendar, and any change to
Consultation, Triage, Care programmes, Tests, Vitals, Conditions, Allergies or
Medications beyond reading them.

---

## 8. Risks

1. **The rename touches a table built today.** Contained: one service file,
   one route file, two test files, one migration. The suite is the proof, and
   it runs against a real database.
2. **Two meanings in one table.** Mitigated by `program_id`: every existing
   query already filters on it, and the Care program tab's behaviour is
   unchanged. A test pins that a follow-up never appears in a programme's
   progress counts.
3. **"Follow-up" already means three things in this product** (a review's
   date, a staff tag, an activity kind). §10 of this plan names each and says
   which one this is.

---

## 9. Tests

| What | Where |
|---|---|
| The contract: statuses, types, priority, outcome, the cancel reason, a due date that is not in the past by accident, recurrence | `taskInput.test.js` (pure) |
| Overdue and due-today at the boundary day, in Lagos | pure (extends the existing ones) |
| Create, edit, reschedule (history kept), complete (outcome + result link), cancel (row kept), reopen | `followups.test.js` (database) |
| Cross-tenant refusal on every read and write | database |
| A source link checked against its own table AND this patient | database |
| A programme activity appears in the patient's queue; a standalone follow-up never appears in a programme's progress | database |
| Recurrence creates exactly one next occurrence — the existing rule, through the shared function | database |
| The summary card and the context line | client + database |
| 0062's carry-across: every existing activity keeps its programme, its dates and its status | database |
| The Care program tab still passes every one of its 31 tests | regression |

Then: lint, the client suite, the full server suite with and without a
database, the baseline and `check-baseline`, and a browser walk-through.

---

## 10. Three things already called "follow-up", and which one this is

1. `medication_reviews.follow_up_on` — a date written at signing, shown
   nowhere. **This plan gives it somewhere to go** (question 4).
2. The "Pharmacist follow-up" tag — a flag on a patient for the patient list.
   Untouched.
3. `kind = 'follow_up'` on a care-programme activity — one type of task.
   Becomes one type among the brief's eleven.

**This feature is the patient's action queue**: what needs to happen next, why,
who, when, and what happened when it did.

---

## 11. Phasing

| Phase | Contents |
|---|---|
| **1 — the queue** | 0062, the contract, the service, the routes, the tab: list with filters, create, detail, edit, reschedule, cancel, complete with outcome and an existing-record link, audit, roles |
| **2 — the connections** | Recording a reading inline at completion, the source pickers for every kind, the follow-up timeline, creating a follow-up from a signed medication review |
| **3 — elsewhere** | The summary card, the clinical-context line, and the Care program tab showing its tasks as part of one queue |

---

## 12. Questions

1. One table or two (§2).
2. The patient summary's Encounters card, once the tab it opens is gone (§3).
3. Whether completion may record a new vitals reading in phase 1 or phase 2 (§12).
4. Whether signing a medication review with a follow-up date offers to create
   the follow-up (§34's "Medication Review → creates Follow-up" against §27's
   "the pharmacist creates it, the system tracks it").

**Answered 2026-09-24 (owner).** 1: **one table** — 0062 renames
`care_program_activities` to `patient_tasks`, adds `customer_id`, makes
`program_id` nullable and adds the follow-up columns. 2: the patient summary's
Encounters card **stays and opens the Clinics module's Consultations desk**, so
nothing on the summary is a dead end. 3: completion **links an existing record
in phase 1**; recording a reading inline is phase 2. 4: signing a medication
review with a follow-up date **offers** to create the follow-up, and a
pharmacist presses it — nothing is created automatically (phase 2).

**Approved 2026-09-24. Phase 1 building.**

---

## 13. Phase 1 — built 2026-09-24

Built as sections 2–6 describe, with these decisions made while building:

- **The rename's proof is the care-programme suite.** All 31 of its tests pass
  unchanged against `patient_tasks`, and two of them were CORRECTED rather than
  left alone: they queried `information_schema` for the old table name, which
  would now match nothing and pass vacuously. One gained
  `assert.ok(cols.length > 0)` so it can never pass on an empty answer again.
- **`outcome_note` was reused rather than a `completion_notes` column added.**
  The activity table already had "what happened", which is exactly what a
  completion note is.
- **The cancel reason is a code in the audit trail and a sentence on the row.**
  `status_reason` reads "Transferred care — Moved to Abuja"; the event carries
  `reason: 'transferred_care'`, so "how many were cancelled as duplicates"
  stays answerable without a column no screen filters on.
- **Two shared modules came out of it, not a second copy:** `taskRow.js` (the
  one row shape and INSERT for `patient_tasks`) and `clinicalRefs.js` (one
  answer to "is this record this patient's, in this pharmacy?").
- **A bug the migration's own CHECK caught:** `updateActivity` set a status of
  `cancelled` without recording when, because the column had not existed.
  Fixed in the service.
- **A bug the browser caught:** the detail panel rendered from the LIST row,
  which does not resolve references — so it printed "no longer on the record"
  about a reading that was perfectly fine. The detail now fetches the full
  follow-up when a row is opened.

**Phase 2 next:** the per-follow-up timeline, recording a reading inline at
completion, and the offer to create a follow-up when a medication review is
signed with a follow-up date. **Phase 3:** the summary card and the
clinical-context line.

---

## 14. Phase 2 — built 2026-09-25

Recording a reading at completion, each follow-up's own history, and the offer
from a signed medication review.

- **The reading goes to Vitals, through the Vitals contract.** The boxes come
  from `vitalRanges`, the route validates with `readVitalsInput` and
  `recordVitals` writes the row — so this section defines no measurement and no
  plausibility rule of its own.
- **It is written BEFORE the completion transaction, deliberately outside it.**
  A reading taken at the counter happened; if the completion then fails it
  still belongs in Vitals. The reverse — a completed follow-up pointing at a
  reading that was never saved — is the failure worth preventing. The follow-up
  is checked first so a bad id cannot leave a stray reading behind.
- **Recording one AND pointing at another is refused**: two answers to "what
  did this produce".
- **The history is this follow-up's**, filtered by the entity its events
  already point at. The patient-level history §18 sketches is the queue's
  Completed and Cancelled groups, which already exist — a third list of the
  same rows was not built.
- **The medication review offers, and a pharmacist presses.** Prefilled from
  the date and reason already written at signing; the screen reads which
  reviews already have one, so it cannot be created twice.

**Two bugs found while verifying.** A date-dependent inconsistency the calendar
surfaced — `addActivity`, `addGoal`, `removeGoal`, `removeActivity`,
`enrolProgram` and `createFollowup` computed progress and buckets against the
REAL day while their caller had named another — now fixed in the services, with
the care-programme test left exactly as written. And a **completed** follow-up
whose due date had passed read "1 day overdue", which says there is work
outstanding when there is none; it now reads "Was due 20 Sep 2026".

**Phase 3 is built** — see below.

---

## 15. Phase 3 — built

**The follow-up elsewhere.** A **Follow-up** card on the patient summary and a
**Follow-ups** brief in the clinical context beside Medications, so a
pharmacist writing up a medicine can see that a repeat blood pressure is late
without leaving the screen. Both are POINTERS: nothing outside the Follow-up
section creates, completes, reschedules or cancels one.

**One read feeds both.** `followupSummary(pharmacyId, customerId, { today,
limit })` is the same `listFollowups` the section itself uses, trimmed to the
three still waiting plus the counts — so the section, the card and the brief
cannot disagree about what is outstanding or what is late. `medicationContext`
awaits it and returns one new `followups` key; no other key changed shape.

On the client the counts sentence is one function too (`summaryParts`), for the
same reason three screens should not find three ways to write "2 overdue · 1
today". Overdue carries `ui-tone-3` (amber) — red stays reserved for a person
waiting, per design.md.

**What the card counts** is OUTSTANDING work — overdue + due today + upcoming —
never the total, which includes everything already finished. A patient with
sixteen follow-ups, all dealt with, is not a patient with sixteen things to do.

**Three states, said apart** (`emptyText`):

| what is true | what the screen says |
|---|---|
| the read failed or never happened | **Not recorded** |
| none was ever raised | **No follow-ups** |
| everything raised has been dealt with | **Nothing outstanding** |

The same distinction the allergy card has made since 0058, and it matters the
same way: a pharmacist reading "nothing outstanding" about a patient whose
follow-ups simply failed to load is being told the work is done.

### What this phase cost, and what it caught

**A false sentence on a real screen.** The card asked whether any follow-up had
ever been raised; the brief did not, and told a pharmacist "Nothing
outstanding" about a demo patient who had never had one — while the card for
that same patient said "No follow-ups". Found by opening the screen, not by a
test. The fix is not that the brief was corrected: it is that WHICH empty
sentence is true is now one function both ask, so they cannot answer
differently again.

**A worthless assertion.** The summary test asserted that a completed follow-up
is absent from `next` while asking with the default cap of 3 — where the
completed row fell off the end anyway. Letting `completed` through the filter
left the test GREEN. It now asks with a limit that could hold the row. Both of
this phase's server tests were checked that way: the behaviour was removed, the
test failed, the behaviour was restored.

### Tests

2 server, **both needing a database**:

- `followups.test.js` — the summary agrees with the queue's own counts, is
  ordered overdue-first, excludes what is finished even when asked for more
  than fits, carries no percentage or score, is capped, and returns nothing for
  another pharmacy.
- `medications.test.js` — the context panel carries the follow-ups, and shows
  an empty list rather than a missing key when there are none.

5 client: two in `patientSummaryModel.test.js` (the card counts what is
outstanding and flags what is late; "never asked" told apart from "nothing to
do"), three in `followupFormat.test.js` (the counts sentence; the two empty
phrases being different facts and neither about the patient; and which one is
true being decided once, for every screen that says one).

**Measured 2026-09-25:** 1999/1354/638/7 with no test database, 1999/1994/0/5
with one. Pass unchanged at 1354, the same 7 known failures, skipped ceiling
636 → 638 for the two database tests. Client 246/246. AGENTS.md and
`test-baseline.json` updated in the same pass.

### Verified in the browser

Against the demo database, on three patients: the card showing 3 outstanding
with their due labels and agreeing with the section behind "See all"; the
context brief beside Medications showing the same three; and "No follow-ups" on
a patient who has none, on both the card and the brief. The "Nothing
outstanding" state has no demo patient in it — every follow-up in the demo data
is either open or on a patient with open ones — so that third wording is
covered by test rather than by eye, which is stated here rather than implied.
