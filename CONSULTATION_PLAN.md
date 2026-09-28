# Consultation — architecture plan

**Status: phase 1 built 2026-09-27 (§12). Phases 2–3 not started.**
Brief: the owner's 43-section Consultation brief, 2026-09-26.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the pattern of
Allergies (0058), Conditions (0059), Tests (0060), Care programmes (0061),
Follow-ups (0062) and Messages (0063–0066).

---

## 1. The finding that reshapes the brief

The brief's §1 says to inspect before writing. Doing so turned up something
that changes what this module is:

> **There is no pharmacist-facing Triage screen, and `Consultations.jsx` is
> not a consultation form. It is the triage desk.**

Its own header says so: *"The previous version was a stack of triage cards…
So: queue on the left, the whole case on the right."* It shows who is waiting,
what they typed, symptom duration, severity, which red flag fired, and the
chronic conditions inferred from purchases. It lets a pharmacist take over the
conversation and resolve it.

What **does** exist as "triage" is a server-side engine — `redFlagEvaluator`,
`safetyGate`, `clinicalFilter`, `protocolExecutionService`, `answerNormaliser`
— that collects structured answers during a WhatsApp conversation and writes
them to `clinical_encounters`.

What **does not exist anywhere** is the thing the brief actually asks for: a
place where the pharmacist records *their own* assessment. There is no
Objective, no Assessment/Impression, no Intervention, no Plan, no Referral
record, no consultation type, no finalisation and no amendment.

**So this is not a redesign of an existing consultation form. It is building
the missing half.** And the split it falls along is the one the brief itself
names from Medplum:

```
Encounter            clinical_encounters (0029)   EXISTS — written by the
                     what happened, what the       WhatsApp engine
                     patient reported, red flags

ClinicalImpression   pharmacist_consultations      MISSING — this plan
                     what the PHARMACIST assessed
                     and did about it
```

---

## 2. What already exists, and what it means for this

| Thing | Where | Matters because |
|---|---|---|
| **`clinical_encounters`** | 0029 | The episode: `presenting_complaint`, `reported_symptoms`, `symptom_duration`, `severity`, `relevant_history`, `current_medications_reported`, `allergies_reported`, `patient_concerns`, `red_flags_detected`, protocol id/slug/version, and a 7-value status. **This is §6's triage summary, already captured.** |
| **It is written by the live path** | `clinicalEncounterService`, `recommendationService`, `routes/conversations.js` | Restructuring it would touch code that runs against real patients mid-conversation. Additive only. |
| **The triage desk** | `Consultations.jsx` (479 lines) | Queue + case panel. §6's "View Triage" should open *this*, not a screen that does not exist |
| **Finalisation precedent** | `medication_reviews` (0056) — `draft` → `signed`, and *"a signed review is the record of a professional act. It is not deleted"* | §23 and §39's Draft → Completed, and §32's audit |
| **Amendment precedent** | `patient_tests` (0060) — `preliminary`/`final`/`amended`/`corrected` plus `patient_test_corrections` snapshots, and *"saying a report was cancelled, amended or corrected always says why"* | §32's "correction/amendment mechanism rather than silently overwriting" |
| **Record linking** | `clinicalRefs.js` — resolves vitals, test, medication, condition, medication_review, care_program, consultation, followup, conversation | §12's "each problem may link to Condition / Medication / Test / Vital", without a new resolver |
| **Follow-up from a consultation** | `patient_tasks.source_type` already accepts `consultation` (0062/0065) | §19 and §30 are **already supported** — nothing new needed |
| **Care-programme activities** | `patient_tasks` with `program_id` | §21's "the consultation becomes an activity within the programme" is buildable |
| **Vitals** | `patient_vitals` (0054) + `recordVitals` + `vitalsInput` | §9's objective data, through the existing module. Follow-ups phase 2 already writes vitals from another workflow — the same seam |
| **Tests** | `patient_tests` (0060) with an `ordered` status | §10's "order a test" already has a status to write |
| **Role rule** | owner/pharmacist may confirm/finalise; anyone may record | §33, and it is the rule every clinical module already uses |
| **No appointments table** | — | §20's "Schedule Appointment" and §43's Appointment box have nothing to point at. Third feature to hit this |

---

## 3. The central decision: a new table, not a wider one

`clinical_encounters` could be given twenty more columns. It should not be.

**Why a separate `pharmacist_consultations`:**

1. **Different author, different lifecycle.** The encounter is written by the
   assistant during a conversation and is already `completed` by the time a
   pharmacist finalises anything. A consultation is written by a person,
   possibly days later, and has its own draft → completed → amended life.
2. **A consultation may have no encounter at all.** Most community-pharmacy
   consultations happen at the counter, not over WhatsApp. `conversation_id`
   on the encounter is nullable precisely because "a pharmacist could open an
   encounter with no live conversation behind it" — but every field on that
   table is shaped around what a patient *reported in a chat*.
3. **One-to-many.** A long episode can have more than one pharmacist
   assessment. One row cannot hold two.
4. **The live path.** Adding columns to a table the WhatsApp ingest writes is
   the kind of change this repo's baseline exists to catch.

So: `pharmacist_consultations` references `clinical_encounters` **optionally**,
and references the patient always.

---

## 4. Data model — proposed

Three tables, mirroring how the review (0056) split a finding from its
intervention, because the same question applies: *which problem did you
counsel about?*

```
pharmacist_consultations       the note: type, reason, S/O, plan,
                               referral, status, who and when
consultation_problems          §12's numbered problem list — one row per
                               assessment, each optionally pointing at a
                               Condition / Medication / Test / Vitals row
consultation_interventions     §14's interventions — one row each, each
                               optionally about one of the problems above
```

**Nothing clinical is duplicated.** A problem row holds a *label*, a
*certainty* (possible / provisional / suspected / established / needs
evaluation) and a *pointer*. A blood pressure lives in Vitals; a diagnosis
lives in Conditions; a result lives in Tests. §36 is explicit and the house
already works this way: **nothing here creates a Condition or an Allergy.**

`consultation_links` is **not** proposed — `clinicalRefs` plus the pointer
columns on the problem rows cover §12 and §29 without another link table.

---

## 5. What is derived, never stored

- **The clinical summary (§22)** is generated on read from the fields the
  pharmacist entered. It is not a column. A stored summary goes stale the
  moment the note is amended, and §22 says it must come from what was
  actually entered.
- **Completeness for finalisation (§23)** is computed from the consultation
  type, not stored as a flag.
- **The patient-context header (§5)** is the existing summary reads —
  allergies, conditions, medications — through the functions the record
  already uses, so the header cannot disagree with the sections.

---

## 6. Consultation types (§24)

Data, not code — the pattern `test_definitions` and `care_program_definitions`
already use (`pharmacy_id is null` for shipped rows, a pharmacy may add its
own). Each type names which sections are **emphasised** and which are
**required to finalise**. Conditional rendering, one workspace — §24 says
explicitly not to build separate systems.

Shipped types: Minor ailment, Medication review, Chronic disease review, Blood
pressure review, Blood glucose review, Weight management, Prescription review,
Adverse drug reaction, OTC consultation, Health screening, Follow-up
consultation, Other.

---

## 7. What this will NOT build, and why

- **Appointments (§20, §43).** No table, third feature to need one. The button
  is not drawn rather than drawn-and-dead.
- **A second Triage screen (§6).** "View Triage" opens the existing desk case
  panel. See §9, question 2.
- **Any auto-creation (§36).** No Condition from assessment text, no Allergy
  from an adverse-effect note, no intervention generated, no referral decided
  from symptoms, no treatment recommended. The house rule since 0059.
- **AI summarisation (§22).** Explicitly out; the summary is assembled from
  entered fields only.
- **An ecommerce flow (§15).** An OTC recommendation may name a product; no
  price, no stock, no basket.
- **Prescribing (§16).** RxMax has no prescribing workflow, so nothing will
  imply it changed an external prescription.

---

## 8. Risks

1. **`clinical_encounters` is live.** Mitigation: read it, never restructure it.
2. **`clinicalFilter.js` / `assistant.js` are tripwires.** This module does not
   touch either — it is pharmacist-facing and runs after the fact.
3. **`patientEventTypes.js` has 20 dependents.** Additions only, and
   `clinicalAudit.js` keeps a second allowlist that must be updated with it —
   forgetting has broken every clinical module's first test run so far.
4. **Scope.** 43 sections is larger than any module built so far. Phasing in §10.

---

## 9. Questions for the owner

1. **Where does a walk-in consultation start?** Most community-pharmacy
   consultations are at the counter with no WhatsApp thread. Should a
   pharmacist be able to start a consultation from the patient record with no
   encounter behind it? (Recommendation: **yes** — otherwise the module only
   serves the minority of cases that began in a chat.)
2. **"View Triage" (§6).** There is no separate triage screen. Should it open
   the existing consultation-desk case panel, or should the desk be renamed
   *Triage* and Consultation become a second screen beside it?
3. **Confirm Appointments (§20) is out**, pending a real appointments module.
4. **Who may finalise?** Recommendation: owner/pharmacist finalise and amend;
   any staff member may open and write a draft — the rule every other clinical
   module uses.

---

## 10. Phasing

1. **Phase 1 — the note.** Migration, the consultation record, types, the
   S/O/A/P workspace, draft → completed, the generated summary, history.
2. **Phase 2 — the connections.** Problems with pointers, interventions,
   referral, vitals captured through the Vitals module, test ordering,
   follow-up and care-programme links.
3. **Phase 3 — the record's integrity.** Amendment with reason and snapshot,
   entered-in-error, the audit trail, permissions.

---

## 11. Decisions — answered by the owner, 2026-09-27

**1. A consultation may stand alone.** `encounter_id` is nullable. Most
community-pharmacy consultations happen at the counter with no WhatsApp thread,
and a module that only served the minority that began in a chat would be the
wrong module. The triage summary section renders only when there is an
encounter to summarise — it is not faked when there is not.

**2. The triage desk keeps its name and its screen.** Nothing is renamed.
"View Triage" (§6) opens the existing desk's case panel — the red flags,
severity and duration the engine already collected — and Consultation becomes a
second screen in the Clinical module beside it. This is the same position
Care program and Follow-up were in: the entry existed, the screen did not, so
nothing is replaced.

**3. Three phases, approved one at a time**, in the rhythm Messages and Care
programmes used.

**4. Owner or pharmacist may finalise and amend; anyone may open and write a
draft.** The rule every clinical module here already uses — doing the work is
not closing the file.

**5. Appointments (§20) stay out**, pending a real appointments module. Not
contradicted at review.

---

## 12. Phase 1 — built 2026-09-27

**The note.** The pharmacist's assessment layer, which this product did not
have.

| | |
|---|---|
| `0067_pharmacist_consultations.sql` | the note + `consultation_definitions` (12 shipped types, as DATA) |
| `0068_consultation_assessment.sql` | the assessment column 0067 forgot |
| `clinical/consultationInput.js` | the contract, the finalisation gate, the derived summary |
| `clinical/consultations.js` | the service |
| `routes/consultations.js` | mounted on `/api/customers`, before `routes/customers.js` |
| `client/src/Consultation.jsx` | the workspace + the patient's history |
| `client/src/ConsultationNotes.jsx` | the Clinical module's second screen |
| `client/src/consultationFormat.js` | the wording |

### What the inspection changed

The brief said a separate Pharmacist Triage workflow exists. It does not:
`Consultations.jsx` **is** the triage desk, and triage is otherwise a
server-side engine writing `clinical_encounters`. So this was not a redesign —
it was building the missing half, along the split the brief itself names from
Medplum. The desk is untouched and keeps its name; Consultation notes sits
beside it.

### The decisions that shaped it

**A new table, not a wider one.** `clinical_encounters` is written by the
assistant *during* a live conversation. The note is written by a person,
possibly days later, has its own draft → completed → retired life, and one
episode may carry several assessments. The live path needed no edit.

**The encounter is optional.** Most consultations happen at the counter. Where
there is an episode the triage summary is read from it; where there is not the
panel says so — an empty triage panel reading "no red flags" would be a safety
claim nobody made. The same reason `redFlagLine` says **"None recorded"** and
never "None".

**Types are data, and they decide what finalisation requires.** §23's
conditional requirements are a column. The same half-written note finalises as
a minor ailment and is refused as a blood-pressure review — proven in the
contract, at the database, and on screen.

**The summary is derived on every read**, with a test asserting no `%summary%`
column exists, and it **omits what was never entered**. Not "Referral: none",
not "Nil" — nothing. That sentence on a note where nobody considered referral
is a claim the software invented, and the next pharmacist reads it as a
decision somebody took.

### What this phase surfaced

**0067 forgot the assessment column**, and every type requires an assessment to
finalise — so as shipped it created a note that could never be completed. Fixed
forward in 0068 rather than by editing an applied migration.

**A name collision, caught before it bit.** `clinicalRefs.js` already resolves
the word `consultation` to `clinical_encounters`. The new entity type is
`pharmacist_consultation`; one name meaning two tables is how a pointer finds
the wrong row.

**`recordEvent` needs `actorType`**, which the first draft omitted — every
database test failed until the shared `auditEvent` helper was added, matching
`problems.js`. Its idempotency key is per-event, because the default
(`eventType:entityType:entityId`) is what lost a patient's second relabel in
Messages phase 2.

### Tests

**31 server — 15 database-free** (`consultationInput`) **and 16 needing a
database** (`consultations`), plus **9 client** (`consultationFormat`).
Measured **2087/1391/689/7** with no test database; skipped ceiling 673 → 689.
Client 280/280. With a database: **2087/2081/0/5**, plus a sixth between 23:00
and 00:00 UTC only — the `websiteAnalytics` timezone-window test, diagnosed,
unrelated, and deliberately not in the baseline.

The type-driven gate was mutation-checked: disabling it turned 2 contract tests
and 1 database test red.

**One existing test amended and strengthened:** `modules.test.js`'s clinics
sidebar list grew by one, and gained an assertion that states the rule itself —
so a clinical service with no screen fails even if somebody updates the list.

### Verified in the browser

Choosing a patient, starting a blood-pressure review, being **refused**
finalisation with *"Record what was measured or observed."* while the note
stayed a draft, then finalising once the objective was filled. The summary read
back Reason / Findings / Assessment / Plan with **no Subjective line at all**,
because none was entered. And on the demo database afterwards: **0 vitals rows,
0 conditions, 0 tasks** created — the "BP 138/86" typed into the note became a
record nowhere, which is §36.

---

## Phase 2 — built (2026-09-28)

The problem list with pointers (§12), interventions (§14), the referral
decision (§17), the prescription review (§16) and the care-programme pointer
(§21).

### 0069 — two tables, not two array columns

`consultation_problems` and `consultation_interventions`, plus additive
columns on `pharmacist_consultations` for the referral, the prescription
review and the programme pointer.

Arrays on the note were considered and rejected for the reason 0056 settled
for the medication review: **an intervention is about a PROBLEM.** Held as
`text[]`, *"which problem did you ring the prescriber about"* has no answer —
and that relation is precisely what the next pharmacist reads the note to
find out.

### A problem carries a pointer, never a copy

Label, certainty, status, and at most one `(ref_kind, ref_id)` resolved
through `clinicalRefs.describeRecord` on every load. So a dose changed in
Medications shows here next time, and the note can never display a value that
has stopped being true.

A record deleted from its own section leaves the problem saying **"No longer
on the record"** rather than the row vanishing: that the consultation was
about it is a fact, and losing it would rewrite the note.

### The referral distinction, held in three places

```
NULL     nobody considered referral        the summary says NOTHING
'none'   a pharmacist decided against it   "No referral required"
```

In the database (nullable column beside a `none` value), in the derived
summary (the section is absent, not empty), and on the screen (the select
opens on *"Not recorded — leave this undecided"*). A CHECK requires a reason
whenever a destination is named, because "Refer to hospital" with no reason is
something neither the next pharmacist nor the hospital can act on.

**Nothing is inferred.** §17 wants a validated clinical rule before software
suggests a referral, and this product has none — so no code reads the
assessment and proposes one.

### What was NOT built in this phase

- **Vitals captured through the Vitals module (§9)** and **test ordering
  (§10)**. Both are cross-module write paths, and both already have a working
  version in their own section. Deferred deliberately rather than half-built.
- **The follow-up link (§19).** `patient_tasks` accepts a `source_type`, and
  adding `pharmacist_consultation` to it is a migration of its own that ought
  to arrive with the button that uses it.
- **Amendment of a finalised note (§32).** Phase 3.

### Tests

**27 server — 12 database-free** (`consultationInput`) **and 15 needing a
database** (`consultations`), plus **14 client** (5 `consultationFormat`, 5
the new `recordPicker`, 4 the new `consultationLayout`).
Measured **2114/1403/704/7** with no test database; skipped ceiling 689 → 704.
Client 280 → 294. With a database: **2114/2109/0/5**.

Four things were mutation-checked and each turned red before being restored:
the referral-needs-a-reason rule, the summary order, the intervention
surviving its problem (constraint switched to `cascade`), and the
tone-on-a-pill rule.

### Three things this phase got wrong first

**The summary read back in a different order than it is written.** Phase 2
appended problems and interventions to the END of `consultationSummary`, so a
pharmacist filled the screen assessment → problems → interventions → plan and
read it back … → plan → problems → interventions. Nothing failed. It was
simply wrong for the person reading it in a hurry. Corrected to the SOAP
order and pinned.

**An emergency referral painted an amber BAR across the panel.** The tone was
on the `<dd>`, which is `display: block`; and `.ui-consult-summary dd`
outranked `.ui-tone-1` on colour, so the text was not even amber. Found by
reading `getComputedStyle` off the running screen. The tone now goes on a
pill.

**Phase 1 had shipped six `ui-consult-*` class names with no styles at all.**
The screen rendered, as a column of unstyled controls, and no test noticed.
`index.css` now has the block, and `consultationLayout.test.js` asserts that
every `ui-` class the workspace uses has a rule behind it.

### Shared, not copied

`CarePrograms.jsx` already held a map from `condition | medication | test |
vitals | encounter` to the owning section's own endpoint and row shape —
exactly what a problem pointer needs. It moved to `client/src/recordPicker.js`
and both screens use it. Its test reads the vocabularies from the **server**
(`PROBLEM_REF_KINDS`, `LINK_KINDS`) and asserts every kind either screen may
OFFER can actually be listed, so the screen cannot draw a button that returns
an empty list.

### Verified in the browser

On the demo database, against the running API: a problem added with a pointer
to **Metformin 500mg tablets**, picked from a list read live out of the
patient's Medications section and rendered back as *"2. Provisional Possible
interaction with metformin / Active / Metformin 500mg tablets"*.

The Referral section, before anybody decided, read *"Not recorded — nobody has
recorded a referral decision for this consultation."* and contributed **no
line to the summary**. Recording an emergency referral rendered it as an amber
pill. Naming a destination with no reason was refused with *"Say why you are
referring."* against the reason field; recording a prescriber outcome with
nobody contacted was refused against its own field.

And the summary read back **Problems → Intervention**, in the order the note
is written.

---

## Phase 3 — built (2026-09-28)

The record's integrity. §32's amendment, §39's entered-in-error refined, the
per-note audit view and the permission model.

### 0070 — one table, and no fifth status

`consultation_amendments` holds the note as it read before each correction,
with a reason the database itself requires. Nothing else was added.

**A status called `amended` was the obvious design, and was rejected twice**

1. **A note reopened to be corrected is not finished.** Labelling it
   `amended` would show a half-rewritten clinical record as though it were
   signed. It goes back to `in_progress` — it really is — and re-finalising
   puts it to `completed` **through the same gate**, so an amendment cannot
   be used to get round §23.
2. **"Amended, and how often?" is answered by counting the rows**, on every
   read. A stored counter is one more thing that can disagree with what it
   counts.

**0067 had already enforced what follows.** Its CHECK says a note in `draft`
or `in_progress` carries no `completed_at` and no `finalised_by`, so
reopening clears both — right rather than merely required: a reopened note
has no signature, and naming whoever signed the version being replaced would
attribute a record they have not seen. That name is in the snapshot, where it
stays true.

### The snapshot is a full copy, not a diff

A diff is only readable beside the thing it applies to, and after two
amendments nobody can reconstruct the middle version without replaying them
in the right order. §32 exists so that what the note SAID is recoverable, and
a full copy is the only form of that which cannot be got wrong.

It is written FIRST, in the same transaction — 0060's order, for 0060's
reason: if the update lands and the snapshot does not, what the record said
is gone. **This is the one place in the feature that copies clinical values**
rather than pointing at them. Everywhere else a copy goes stale; here going
stale is the entire purpose.

### Two holes in entered-in-error, closed

- A retired note could be **amended back into the record** — precisely the
  laundering §39 exists to prevent.
- It could be **re-marked**, which overwrote `error_reason` (losing the only
  explanation the record has) and put a second `ENTERED_IN_ERROR` on the
  audit trail for something that happened once.

### Permissions (§§33, 37–39)

Unchanged from the decision taken before phase 1: **owner or pharmacist may
finalise and amend; anyone may open and write a draft.** `assertMayAmend`
reads the same frozen `FINALISING_ROLES` list as `assertMayFinalise` rather
than a copy, and a test asserts that — a note is reopened in order to be
re-signed, so splitting the two would let a staff member reopen a record
nobody could then close.

### Tests

**14 server — 3 database-free** (`consultationInput`) **and 11 needing a
database** (`consultations`), plus **6 client** (`consultationFormat`).
Measured **2128/1406/715/7** with no test database; skipped ceiling 704 → 715.
Client 294 → 300. With a database: **2128/2123/0/5**.

**Six mutations, each turning exactly the right test red:** the snapshot
never written (4 red), the snapshot taken after the reopen (1 red, on the
assertion that it kept `completed`), each of the three guards removed in turn
(1 red each), and `amendmentCount` hard-coded to 0 (1 red).

### What the client will not say

A note nobody has corrected shows **no badge at all** — never "Original",
never "Version 1", never "No amendments". All three are claims about a
history nobody has looked at, and the first two invent a version number this
product does not have.

A history shows an event it has **no wording for by its raw name**, marked,
rather than dropping it. A history that silently omits what it cannot label
reads as complete when it is not, which is the one thing an audit trail must
never do. Its test reads the event list from the server, so a new type
shipping without wording is caught.

### A wrong heading, caught by opening the screen

The amend panel was first offered on a retired note as well, under a section
headed **"Amend this note"** whose body then said the note is not amended. A
heading naming an action the panel refuses is worse than no panel. The
section is now offered only on a finalised note, and the sentence moved into
the banner that already explains the status. Its test moved with it.

### Verified in the browser

A finalised minor ailment, amended with the reason *"Assessment was wrong —
allergic rhinitis"*, edited and re-signed. The header read **"Completed ·
Amended once"**; the Assessment field read **"Allergic rhinitis"** while the
History panel beside it showed the snapshot — *Reason: Cough, Assessment:
Uncomplicated acute cough, Plan: Hydration and rest* — which is the whole of
§32 visible on one screen.

The event log rendered in words (Finalised / Amended / Finalised /
Consultation opened, newest first). The amend button stayed disabled on an
empty reason and on two characters, matching the server contract. A retired
note offered **no** amend section and its banner read *"Entered in error —
Opened against the wrong patient. This note is kept as a record of what was
written; it is not deleted. It is not amended either: a note that should
never have existed is left as it is."*

### Still not built, deliberately

- **Vitals captured through the Vitals module (§9)** and **test ordering
  (§10)** — cross-module write paths, deferred from phase 2 and still
  deferred. Both work today in their own section.
- **The follow-up link (§19)** — needs its own migration to widen
  `patient_tasks_source_type`, which ought to arrive with the button.
- **Appointments (§20, §43)** — there is still no appointments table
  anywhere in this product.

The three phases the owner approved are complete.
