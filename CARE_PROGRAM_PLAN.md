# Care Program — architecture plan

**Status: awaiting approval. No production code has been written.**
Brief: the owner's 33-section Care Program brief, 2026-09-24.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the pattern of
Allergies (0058), Conditions (0059) and Tests (0060), which are working.

---

## 1. What already exists

| Thing | Where | Matters because |
|---|---|---|
| **The "Clinic" tab is a PLACEHOLDER** | `client/src/patientRecordTabs.js:35` — `{ id: 'clinic', label: 'Clinic', built: false }` | It renders the "not built yet" panel and nothing else. **There is no old behaviour to preserve** — the brief's warning about renaming and leaving the old page is moot here |
| **No appointments table. No tasks table.** | — | §16/§17 say to reuse them if they exist. They do not. See §5 below — this is the one place the brief's assumption does not hold |
| Consultations | `clinical_encounters` (0029), `problems.js#encounterChoices` | An activity or the program can link to one |
| Conditions | `patient_problems` (0059) + `local_code` | Related records, by the house code |
| Medications | `medication_journeys.condition_code` (0055) | Same |
| Tests | `patient_tests` + `test_definitions.condition_code` (0060), `testTrend` | Monitoring reads these |
| Vitals | `patient_vitals` (0054), `vitalsSeries` | Monitoring reads these |
| Allergies | `allergySummary` (0058) | §25's safety strip, already a component (`AllergySafety`) |
| Timeline | `GET /api/customers/:id/timeline` over `customer_events`, `CustomerTimeline.jsx` | §15 is the same events, **filtered to this program** |
| Audit + roles | `clinicalAudit.js`, `req.pharmacyRole` | Reused unchanged |
| Recurrence precedent | `refills` + `refillSchedule.js` (run-out dates, Lagos day) | §12's recurring activities follow the same date discipline |
| A different "care" | `services/customers/patientCare.js` = the patient's assigned pharmacist, age and sex | **Naming collision to avoid**: the new service is `carePrograms.js`, never `care.js` |
| Not this | `protocol_executions` (0032) = the WhatsApp triage questioning engine | A different thing entirely. Untouched |

---

## 2. The central decision: a definition, an enrolment, and the work

Four tables, mapping the brief's seven concepts onto what is actually
different:

| Brief §26 | Here | Why |
|---|---|---|
| `CareProgram` (the template) | `care_program_definitions` | Shipped rows + a pharmacy's own, exactly like `test_definitions` (0060). Its `goals`/`activities`/`monitoring` jsonb IS the template — Medplum's PlanDefinition, at the size this product needs |
| `PatientProgramEnrollment` | `patient_care_programs` | One row per enrolment: status, dates, responsible pharmacist, reason, and the outcome/discontinuation fields |
| `CareProgramGoal` | `care_program_goals` | Measurable, with baseline / target / current |
| `CareProgramActivity` + `CareProgramTask` | **`care_program_activities`** — one table | An activity IS the task here. There is no task system to integrate with, and two tables would be one row each, always, with a 1:1 join |
| `CareProgramReview` | the program's `next_review_on` + an activity of kind `review` | A review is a thing that happens on a date — which is what an activity is |
| `CareProgramOutcome` | columns on `patient_care_programs` | One outcome per program |
| — | `care_program_links` | §14: records a pharmacist explicitly attaches. Typed columns, never a polymorphic id |

**Nothing clinical is copied.** No BP, no medicine, no result, no diagnosis
lives in any of these tables — only ids pointing at the records that own
them, and the code (`condition_code`) the other modules already share.

---

## 3. Data model — migration `0061_care_programs.sql`

### `care_program_definitions` — the template (§21)
`id`, `pharmacy_id` **nullable** (null = shipped), `code`, `name`,
`description`, `condition_code` (the house code the program is about, e.g.
`DIABETES`), `goals` jsonb, `activities` jsonb (each with `kind`, `title`,
`offsetDays`, `recurrence`), `monitoring` jsonb (what to show: vitals metrics
and test codes), `default_review_days`, `active`.

Seeded with seven, from §22: Diabetes care, Hypertension management, Weight
management, Medication management, Family planning, Vaccination follow-up,
Chronic disease monitoring. A pharmacy can add rows later; **nothing is
hard-coded in the UI**, and a program may also be enrolled with a free-text
name and no definition.

### `patient_care_programs` — the enrolment (§7)
`id`, `pharmacy_id`, `customer_id`, `definition_id` nullable, `program_name`
(snapshotted), `condition_code`, `status` (`planned · active · on_hold ·
completed · discontinued · cancelled`), `enrolled_on`, `start_date`,
`next_review_on`, `end_date`, `responsible_user_id`, `responsible_name`,
`reason`, `notes`, `outcome` (`achieved · partially_achieved · not_achieved ·
transferred · other`), `outcome_notes`, `follow_up_recommendation`,
`discontinuation_reason` (`patient_withdrew · transferred_care ·
no_longer_applicable · lost_to_follow_up · other`), `recorded_by`,
`updated_by`, timestamps.

CHECKs: a completed program has an `end_date` and an `outcome`; a
discontinued one has an `end_date` and a `discontinuation_reason`; an ended
program is never `active`. **Nothing is deleted** (§5, §20).

### `care_program_goals` (§10)
`program_id` → cascade, `title`, `description`, `status` (`planned ·
in_progress · achieved · not_achieved · cancelled`), `measure` (what is being
measured, e.g. "Weight"), `baseline_value` + `unit`, `target_value`,
`target_text` (for goals that are not a number), `target_date`, `position`,
`notes`. **Current value is NOT stored** — it is read from Vitals or Tests at
display time, so a goal can never disagree with the record.

### `care_program_activities` (§11, §12, §16)
`program_id` → cascade, `goal_id` nullable, `title`, `description`,
`kind` (`assessment · review · monitoring · counselling · test · follow_up ·
vaccination · other`), `status` (`not_started · in_progress · completed ·
skipped · cancelled`), `due_on`, `assigned_to_user_id` / `assigned_to_name`,
`completed_at`, `completed_by`, `position`, `notes`,
**`recurrence`** jsonb (`{"every": 14, "unit": "day"}`), `recurrence_of` (the
activity this one followed), and the link to what it produced:
`linked_type` (`vitals · test · medication · condition · encounter`) +
`linked_id`, validated against the real table.

### `care_program_links` (§14)
`program_id`, `kind` (the five above), `ref_id`, `note`, `created_by` —
`unique (program_id, kind, ref_id)`. Each id is checked against its table and
this pharmacy before it is stored.

RLS, indexes and tenant scoping follow 0060.

---

## 4. What is derived, never stored

- **Progress** (§18): counts, computed on read — goals by status, activities
  completed / total, overdue count, and the next due activity. Question 3
  asks whether to show a percentage beside the counts.
- **Monitoring** (§13): read live from `patient_vitals` and `patient_tests`,
  driven by the definition's `monitoring` list. No second copy, ever.
- **Related records** (§14): the explicit links, PLUS anything sharing the
  program's `condition_code` (conditions, medicines, tests) — read-only.
- **A goal's current value** (§10): from the latest vitals reading or test
  result for its measure.
- **The timeline** (§15): this program's own audit events from
  `customer_events`, filtered to the program and its activities. Never the
  patient's whole history.
- **Patient safety** (§25): the existing `AllergySafety` and `ConditionsBrief`
  components, unchanged.

---

## 5. Appointments and tasks — where the brief meets the product

The brief says to reuse the existing appointment and task systems. **Neither
exists.** So:

- **Tasks**: `care_program_activities` IS the task list, and it is the first
  task concept in the product. When a general Tasks module arrives, this is
  the table it grows from — not a second one to reconcile.
- **Appointments**: an activity has a due date, an assignee and a `follow_up`
  kind, which is what "schedule a follow-up" means here. The **Appointments
  tab stays unbuilt**; building an appointment system is explicitly out of
  scope (§31). The acceptance line "schedule/review follow-up" is met by the
  program's `next_review_on` and a follow-up activity with a due date.

I would rather say this plainly than quietly satisfy the words with a second
appointment store.

---

## 6. API — `server/routes/carePrograms.js`, mounted before `routes/customers.js`

| Route | Does |
|---|---|
| `GET /:id/care-programs` | active + past, each with its progress counts |
| `GET /:id/care-programs/options` | the vocabulary |
| `GET /:id/care-programs/catalogue` | the definitions a pharmacy may enrol into |
| `POST /:id/care-programs` | enrol (optionally from a definition — question 1) |
| `GET /:id/care-programs/:programId` | the workspace: goals, activities, links, monitoring, related records, timeline, progress |
| `PATCH /:id/care-programs/:programId` | edit, change status, complete, discontinue |
| `POST/PATCH …/goals[/:goalId]` | goals |
| `POST/PATCH …/activities[/:activityId]` | activities, including completing one (question 2) |
| `POST/DELETE …/links` | attach or detach an existing record |

**Roles**, as everywhere else: any member may enrol, edit, add goals and
activities, and complete an activity. **Pharmacist or owner** may complete,
discontinue or cancel a PROGRAM — the statements that close a course of care.

**Audit** (§28): `CARE_PROGRAM_ENROLLED`, `CARE_PROGRAM_UPDATED`,
`CARE_PROGRAM_STATUS_CHANGED`, `CARE_PROGRAM_GOAL_CHANGED`,
`CARE_PROGRAM_ACTIVITY_CHANGED`, `CARE_PROGRAM_COMPLETED`,
`CARE_PROGRAM_DISCONTINUED` — each carrying before → after and the reason.
The timeline reads these.

---

## 7. Screens (`client/src/CarePrograms.jsx`)

**The list** — the tab's landing page:
```
Care programs                                  [ + Enrol in a care program ]
Active
 Diabetes care          Active    Started 10 Jun 2026   Goals 1/3 · Tasks 8/12 · 2 overdue   Review 25 Sep
 Hypertension           Active    Started 20 Jul 2026   Goals 0/2 · Tasks 3/7               Review 30 Sep
Past
 Weight management      Completed Jan – Jun 2026        Outcome: achieved
```

**The workspace** — one program, opened in place inside the patient record
(never a separate page), with the safety strip at the top and six sections:

- **Overview** — why enrolled, status, progress counts, next review, open
  tasks, goals by status, and the next thing to do.
- **Goals** — title, target (value or words), current value read from the
  record, status, review date.
- **Care plan** — the activities in order, with their status marks, due
  dates, assignee, and a recurrence note where one applies.
- **Tasks** — the same activities as a working list: overdue first, then due,
  each completable in one click.
- **Monitoring** — the vitals and test values the definition names, latest
  and previous, each linking into Vitals or Tests. No chart unless a trend
  already exists there.
- **Timeline** — this program's events, newest first.

Enrolment, goals and activities use the record panel every other tab uses.
Completing and discontinuing use the dialog pattern from Conditions, and each
asks for what the brief lists (§19, §20).

**Elsewhere (phase 2):** the patient summary's card, and a line in the
Medications/Review clinical context ("Diabetes care · 2 overdue tasks").

**The nav** (§3): `{ id: 'clinic', label: 'Clinic' }` becomes
`{ id: 'care', label: 'Care program', built: true }`. The tab-label test
changes with it, in the same commit.

---

## 8. Not in this change
An appointment system, a general task system, protocol authoring, automatic
enrolment, automatic goals or activities from a patient's data, clinical
decision support, insurance or case management, and any change to Conditions,
Allergies, Medications, Tests, Vitals or Consultations beyond reading them.

---

## 9. Risks
1. **This is the biggest surface yet**: four tables, ~10 routes, one workspace
   with six sections. It is phased (below) so the record works before the
   trimmings.
2. **Derived values must never drift into storage.** A goal's "current" and a
   program's "progress" are computed on read. Tests pin that.
3. **Recurrence can multiply rows.** Whatever question 2 decides, exactly one
   next occurrence is ever created, in the same transaction, and it is linked
   to the one it followed.
4. **"Care" is already a word here** (`patientCare.js`). New files are named
   `carePrograms.*` throughout.

---

## 10. Tests (brief §32 → where each lives)
| What | Where |
|---|---|
| The contract: statuses, the ended-program rules, goals, activities, recurrence shape, role rule | `carePlanInput.test.js` (pure, ~16) |
| Enrol, edit, status, complete, discontinue, history kept | `carePrograms.test.js` (DB, ~20) |
| Goals and activities, assignment, due dates, completion, recurrence creating exactly one next | DB |
| Links: each id checked against its own table and this pharmacy; another patient's refused | DB |
| Monitoring and related records READ the existing tables and store nothing | DB (assert no clinical column exists on the new tables, and that values come back from Vitals/Tests) |
| Progress computed from goals and activities | pure + DB |
| The timeline shows this program's events and not the patient's whole history | DB |
| Authorisation: cross-tenant refusal; staff cannot complete or discontinue a program | DB |
| The screens' wording, empty states, overdue ordering | `carePlanFormat.test.js` (client, ~10) |
| The nav says "Care program" and is built | `patientRecordTabs.test.js` (changed deliberately) |

Then: lint, the client suite, the full server suite with and without a
database, baseline + `AGENTS.md`, `check-baseline`, and a browser walk-through.

---

## 11. Phasing
| Phase | Contents |
|---|---|
| **1 — the record** | 0061, definitions seeded, API, the tab: list, enrol, workspace (Overview, Goals, Care plan, Tasks), statuses, complete, discontinue, audit, roles |
| **2 — the connections** | Monitoring, related records and links, the timeline, the safety strip |
| **3 — elsewhere** | summary card, the clinical-context line |

---

## 12. Questions
1. **Enrolling from a template**: create its goals and activities immediately
   (editable, deletable), or enrol empty and let the pharmacist add them?
2. **A recurring activity**: when one is completed, create the next occurrence
   automatically, or leave a "repeat" marker the pharmacist acts on?
3. **Progress**: counts only ("Goals 1/3 · Tasks 8/12 · 2 overdue"), or counts
   plus a single percentage?

**Answered 2026-09-24 (owner).** 1: enrolling in a template creates its goals
and activities immediately, all editable and deletable, shown on the enrolment
screen before saving. 2: completing a recurring activity writes exactly one
next occurrence, linked to the one it followed; the completed one is kept. 3:
progress is counts only — "Goals 1/3 · Tasks 8/12 · 2 overdue" — and no
percentage anywhere, because a percentage over tasks reads as a statement about
the patient.

**Approved 2026-09-24. Phase 1 building.**

---

## 13. Built — what changed from this plan, and why

Phase 1 shipped 2026-09-24. Everything in sections 1–11 was built as written,
except these:

- **`care_program_links` exists but is unused.** The table is in 0061 because a
  polymorphic link needs its shape decided once; the UI that fills it is phase
  2, with monitoring and the timeline. Nothing reads it yet, and nothing
  pretends to.
- **An activity already carries `linked_type` / `linked_id`**, and the service
  checks both against the right table AND this patient before storing them — so
  the guarantee section 3 promised is in place and tested, a phase early.
- **`removeGoal` and `removeActivity` were added.** The plan said goals and
  activities are editable; in the record panel they also need removing while a
  plan is being written, because a template row a pharmacy never does is noise
  on every visit. A goal or activity holds nothing clinical, so removing one is
  a plan edit, audited with what it said. A COMPLETED task refuses deletion
  (409) and offers "cancelled" instead: a thing that happened cannot be made
  never to have happened.
- **Reopening is defined, not just ending.** Moving a finished programme back to
  active clears the end date and the outcome, which no longer describe anything,
  and the event says `CARE_PROGRAM_STATUS_CHANGED` rather than the completion
  name. The audit keeps what the outcome said.
- **A duplicate has no "continue anyway".** Conditions offers one; a second live
  copy of the same programme has no clinical meaning, so the dialog offers
  "Open it" instead. The index enforces it under a race, and the service gives
  the sentence.
- **The enrolment screen shows the plan before saving** and lets a row be
  dropped, which is what makes "created with it" safe to default to.

### What this cost elsewhere

- `patientEventTypes.js` gained seven `CARE_PROGRAM_*` events and one entity
  type; `clinicalAudit.js` gained the same seven in its allowlist. Both are
  required — the allowlist is what made 21 tests fail loudly on the first run
  rather than writing events nothing would ever show.
- `errorHandler.js`'s 409 block now passes `label` beside `conditionName`, and
  only the key the caller set. Its test gained the programme half.
- The patient record's `clinic` tab became `care`, labelled "Care program" and
  `built: true`. `patientRecordTabs.test.js` changed with it, deliberately, in
  the same commit.

---

## 14. Phase 2 — built 2026-09-24

Monitoring, related records and links, and the programme's own timeline. Built
as section 4 described, with these decisions made while building:

- **What a programme watches needs no column.** It is the definition's
  `monitoring` list PLUS every goal that reads a measurement, deduplicated. A
  programme typed by hand gets a monitoring panel as soon as somebody writes a
  goal that measures something — which is better than the alternative the plan
  left open (a `monitoring` column on the enrolment), because it cannot drift
  from the goals it is about.
- **Monitoring reads through `vitalsSeries` and `testTrend`**, the functions the
  Vitals and Tests screens already use, rather than querying `patient_vitals`
  and `patient_test_results` directly. One reader per number, so a correction
  made in Tests shows in the programme.
- **A vitals metric takes its unit from `vitalRanges`.** The shipped templates
  do not carry units, and a panel showing a bare "148" is not a reading anybody
  can act on.
- **The related panel lists derived records read-only** and never lists one that
  has also been attached by hand. Detaching removes the LINK only.
- **A link whose record has since been deleted says "No longer on the record"**
  rather than disappearing — the row remembers that it was attached, which is
  the only thing it was there for.
- **The safety strip was already record-wide** (`AllergyStrip` in
  PatientRecord.jsx spans every section), so §25 needed only the conditions
  half: the Overview reuses `ConditionsBrief` from ClinicalContext.jsx, the
  same component the Medications screen uses, reading the same endpoint.
- **Attaching is audited as `CARE_PROGRAM_UPDATED` with an action**, rather than
  a new event type. `patientEventTypes.js` has 20 dependents and the vocabulary
  should not grow for a distinction the metadata already carries.

**Three bugs the tests caught before any screen existed** — an unknown
monitoring source that would have been queried as a test code, a vitals metric
with no unit, and `addLink` returning a read on a fresh connection from inside
its own transaction (so attaching a record would have answered with the list as
it was, and the screen would have looked like it did nothing).

**Still not built, and deliberately:** a chart on the monitoring panel (the
trend already exists in Tests and Vitals, and a third place to draw it is a
third thing to keep true), and the programme's appearance on the patient
summary and in the clinical context — that is phase 3.

---

## 15. Phase 3 — built 2026-09-24

The programme where a pharmacist already is: a **Care program** card on the
patient summary, and a **Care programmes** brief in the clinical context panel
(Medications, and the Review).

- **One read feeds both.** `careProgramSummary` is the same query the section
  uses, trimmed to three open programmes and their counts. The tab, the card
  and the brief cannot disagree about what is open or what is late.
- **One counts line.** `countsLine` in `carePlanFormat.js` is what all three
  print, so "Goals 1/3 · Tasks 8/12" has one spelling. Still no percentage.
- **"Not recorded" and "No care programmes" are different claims**, and the
  card makes the distinction: the first when the read failed, the second when
  it succeeded and was empty. Enrolment is a fact this system holds completely
  — nobody can be in a programme it was never told about — which is exactly why
  the allergy card cannot say the same thing about allergies.
- **`medicationContext` gained one key** and changed no other, so its existing
  readers are untouched.
- **The brief had to be added in two places**, because the Medications screen
  composes its own `ContextPanel` from the briefs rather than using
  `ClinicalContext`. Both now render it; the Review gets it through
  `ClinicalContext`.

Nothing outside the Care program section starts, changes or completes a
programme. Both new surfaces are pointers.

**Phase 3 completes CARE_PROGRAM_PLAN.md.** What section 8 said would not be
built still is not: no appointment system, no general task system, no protocol
authoring, no automatic enrolment, no generated goals or activities, and no
clinical decision support.
