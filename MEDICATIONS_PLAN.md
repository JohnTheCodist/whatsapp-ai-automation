# Medications — architecture plan

**Status: awaiting review. No production code written.**

Written 2026-09-21 against the Medications brief. House convention: a plan
at the repo root beside `ARCHITECTURE_AUDIT.md` and `design.md`, with file
and line references so every claim can be checked rather than believed.

---

## 1. The audit — what this codebase already has

The brief says: *"do not blindly create these exact tables if the
application already has equivalent entities. Reuse the existing
architecture."* It does have equivalents, and the most important one is not
obvious from the outside.

| The brief asks for | This codebase already has | Where |
|---|---|---|
| `PatientMedication` | **`medication_journeys`** — product link + name snapshot, `units_per_day`, `status`, `started_on`, `created_by`, plus **`refills`** for supply cycles | `db/migrations/0052_medication_journeys.sql` |
| `patientId` | `customers.id` — the pharmacy has **one** identity for a person | `0037_patient_condition.sql:36-39` |
| `medicationId / medicationReference` | `products.id`, nullable, with the name snapshotted alongside — the `order_items` pattern | `0052:…product_id + medicine_name` |
| `indication` | `patient_condition` (code + name, confirmed by purchase) | `0037_patient_condition.sql:33` |
| `prescriberId` | `pharmacy_members` (`owner`/`pharmacist`/`staff`) over `auth.users` | `0001_init.sql:46` |
| vitals context | `patient_vitals` | `0054_patient_vitals.sql` |
| consultation context | `clinical_encounters` | `0029_clinical_foundation.sql:214` |
| the Meds tab itself | already in the record's navigation, `built: false` | `client/src/patientRecordTabs.js:30` |
| **allergies context** | **nothing. This does not exist.** | — |

**Who reads `medication_journeys` today** — this is the blast radius of any
change to it:

- `server/services/refills/medicationJourneys.js` — start / dispense / stop
- `server/services/customers/patientSearch.js:127` — the Medication filter
- `server/services/customers/patientSearch.js:226` — the medications column
- `server/services/customers/patientEventTypes.js` — timeline event types
- `server/services/customers/customerProfile.js` — the profile payload
- the client: `MedicationJourneys.jsx`, `PatientSummary.jsx` (Meds card),
  `PatientSearch.jsx` (the table's Medication column)

---

## 2. The central decision

**Extend `medication_journeys` into the clinical medication record. Do not
create a parallel `patient_medications` table.**

**Why.** A journey already *is* "this patient takes this medicine, and here
is its status". If a second table is added, a patient's amlodipine exists
twice, and "what is this patient taking?" has two answers that drift the
first time one is edited and the other is not. The refill call list, the
patient search's Medication filter, the summary's Meds card and the refill
engine all read journeys; they would keep reading the old half. This is the
same failure `0037_patient_condition.sql:36-39` refuses when it declines to
create a parallel patient table.

**Rejected: a new `patient_medications` table, with journeys kept for
refills.** Cleaner on paper — the brief's field list maps onto a blank table
with no compromises — and it would leave the refill engine untouched. Rejected
because it splits one clinical fact across two tables and leaves six existing
readers pointing at the lesser half. The cost lands later, on whoever has to
answer "why does the call list disagree with the medication list".

**Rejected: rename the table to `patient_medications` in the same change.**
A rename touches six modules and their tests while the columns are also
changing, which is exactly the diff `AGENTS.md` forbids — one that both moves
code and changes it, so a reviewer cannot see which lines are which. If the
name matters, it is a mechanical change of its own afterwards.

### What gets added to it (migration 0055)

```
strength          text        -- "10 mg", "20 mg/5 mL"
form              text        -- tablet · capsule · syrup · suspension · cream · injection · inhaler
dose              text        -- "1 tablet", "500 mg"
route             text        -- oral · topical · IM · IV · SC · inhaled · ophthalmic · otic
frequency         text        -- once daily · twice daily · … · every 8 hours · as needed
duration_days     integer     -- null = ongoing
ended_on          date
indication        text        -- free text
condition_code    text        -- optional link to patient_condition, when it is one we track
generic_name      text
brand_name        text
prescriber_id     uuid        -- references auth.users, for an in-house prescriber
prescriber_name   text        -- for the external prescriber, who will never be a user
instructions      text        -- shown to the patient: "Take after food"
notes             text        -- pharmacist's own note
source            text        -- prescribed · patient_reported · pharmacist_added · imported · historical
encounter_id      uuid        -- optional link to the consultation it came out of
```

`status` widens from `active|stopped` to
`draft|active|completed|stopped|cancelled`.

**Why both `prescriber_id` and `prescriber_name`.** A community pharmacy in
Lagos mostly sees prescriptions written by people who will never have a login
here. Forcing "Dr John at LUTH" through a foreign key to `auth.users` means
either inventing user rows for strangers or losing the prescriber's name. Both
columns, with a check that a record uses one or the other, keeps the in-house
case relational and the external case honest.

**Why `duration_days` does not replace `refills.days_supply`.** They are
different facts and both are needed: duration is the course that was
*prescribed* ("30 days"), `days_supply` is what was physically *handed over*
on a given visit. A 30-day course dispensed fortnightly is two refills against
one duration. Collapsing them would make the refill engine compute run-out
dates from a number nobody dispensed.

---

## 3. Medication review (migration 0056)

Three new tables, structured rather than one free-text field, as the brief
asks:

- **`medication_reviews`** — `patient/customer_id`, `reviewed_on`,
  `reviewer_id`, `adherence` (`good|partial|poor|unknown`), `notes`,
  `outcome` (`resolved|monitoring|prescriber_follow_up|referred|pending`),
  `follow_up_on`, `follow_up_reason`, `follow_up_notes`, `status`
  (`draft|signed`).
- **`medication_review_problems`** — one row per problem, `review_id`,
  optional `journey_id` (the medicine it is about), `problem` (the thirteen
  codes in the brief), `notes`.
- **`medication_review_actions`** — one row per intervention, `review_id`,
  optional `problem_id`, `action` (the nine codes), `notes`.

**Why problems and actions are separate tables rather than arrays on the
review.** A problem is *about a medicine*; an intervention is *about a
problem*. Kept as arrays, "which interaction did you contact the prescriber
about" is unanswerable, and that question is the whole point of recording an
intervention.

**Reconciliation** (prescription / OTC / herbal / patient-reported /
unknown) is **not** a fourth table: it is the `source` column on the
medication itself, set during the review. One fact, one place.

---

## 4. API

New router `server/routes/medications.js`, mounted like
`routes/patientSearch.js` (before `routes/customers.js`, which owns `/:id`).

```
GET    /api/customers/:id/medications?status=…   list, grouped by status
POST   /api/customers/:id/medications            add
PATCH  /api/customers/:id/medications/:medId     edit, including status change
GET    /api/customers/:id/medications/:medId     detail
GET    /api/customers/:id/medication-reviews     list
POST   /api/customers/:id/medication-reviews     start (draft)
PATCH  /api/customers/:id/medication-reviews/:reviewId   save / sign
GET    /api/customers/:id/medication-context     conditions · recent vitals · last consultation
```

Pure input contracts in `server/services/clinical/medicationInput.js` and
`medicationReviewInput.js`, following `vitalsInput.js`: a form's strings
become values once, `""` becomes absent rather than a stored empty, and an
unknown enum is a 400 naming its field.

---

## 5. UI

One workspace at the record's **Meds** tab (`patientRecordTabs.js:30`,
flipped to `built: true`) — not three pages. Existing idioms, no new ones:

- **Section tabs** `Current · History · Review`, the underline strip already
  used by Vitals (`.ui-vitals-tab`).
- **The table** reuses the patients-table idiom recorded in `design.md`
  (`.ui-ptable`): one primary column, fixed row height, declared widths,
  quiet absence, tabular figures.
- **A row expands** to the detail view rather than navigating away, so
  context is never lost (acceptance criterion 17).
- **Add / edit** reuses the vitals record panel (`.ui-vital-sheet`) — the
  side sheet with Cancel / Sign & Save.
- **History** groups by month with status chips, using the `--ui-tone-*`
  tokens so a stopped medicine reads the same as everywhere else.
- **Review** is a guided sheet: active medicines listed, adherence,
  problems (multi-select), interventions, outcome, follow-up.
- **Context panel** is compact and links out — conditions, last vitals, last
  consultation. Not a copy of the chart.

Status colour: `active` emerald, `completed` neutral, `stopped`/`cancelled`
quiet grey, `draft` outlined. **Red stays reserved** for a person waiting
(`design.md`).

---

## 6. Risks, named

1. **Widening `status` can break the refill engine.** `refills` and the call
   list assume `status = 'active'` (`patientSearch.js:51`, `:208`), and there
   is a partial unique index allowing one active journey per medicine
   (`0052:73`). A medicine that becomes `completed` must stop appearing in
   the call list without its refill history being deleted.
   *Mitigation:* the new statuses are additive; every existing query keeps
   `= 'active'` semantics; `completed` and `cancelled` close any open refill
   in the same transaction, and a test asserts the call list ignores them.

2. **This is the change that makes RxNaija an EHR.**
   `server/services/customers/customerProfile.js:22` says in capitals *"NOT
   AN EHR: no diagnosis, clinical notes, or medical history anywhere"*, and
   `customerProfile.test.js` enforces it. Prescriber, indication, route and a
   pharmacist's clinical review cross that line deliberately.
   *Needs your decision:* I will rewrite that boundary comment to say what
   the product now is, and amend the test to forbid what should still be
   forbidden (a diagnosis field) rather than what is now legitimate. I am not
   silently deleting a safety test.

3. **Allergies do not exist.** The brief's review context wants them. The
   panel will show **"Not recorded"**, never "None" — the rule already in
   `patientSummaryModel.js`. An interaction or contraindication check against
   allergies is **not** in this plan; it needs the allergy record first.

4. **No interaction checking.** The brief lists "potential interaction" as a
   problem a pharmacist may *record*. Nothing in this plan detects one. Per
   §12 the software documents; the pharmacist decides.

5. **Stock stays separate.** `product_id` remains a nullable reference with
   the name snapshotted. No price, batch, expiry, quantity or supplier is
   read or written by anything here, and a test will assert the medication
   payload contains no inventory field.

---

## 7. Phasing

The whole brief in one change would be a diff nobody can review, against
`AGENTS.md`'s "one behaviour per change". Three changes, each shippable:

| Phase | Contents | Acceptance criteria |
|---|---|---|
| **1 — the record** ✅ built | 0055, the medications API, Current + History + detail + add/edit/status | 1–9, 16–20 |
| **2 — the review** ✅ built (+0057, finding order) | 0056, the review API, the review workflow, follow-up | 10–15 |
| **3 — context** ⏸ ON HOLD (owner, 2026-09-22) — to be done with the Clinics module / Consultation work | the context panel, entry points from Consultation and Triage | 17, §8, §15 |

Estimated new tests: ~20 database-free (input contracts, status rules, the
history grouping, the review model) and ~18 against the database (tenant
isolation on every new table, status transitions, the call list ignoring
completed medicines, review problems and actions). Baselines move in step, as
always.

---

## 8. What I will not build

Per §16, and stated so the omissions are deliberate rather than forgotten:
insurance, e-prescribing, external fulfilment, controlled-substance
workflows, dispensing, payment, sales, formulary management, automatic
diagnosis, AI treatment decisions. Plus, from §7 above: allergy records and
interaction detection.

---

## 9. What I need from you

1. **Approve or redirect the central decision** (extend `medication_journeys`
   rather than add `patient_medications`).
2. **Decide the EHR boundary** (risk 2) — I will not quietly rewrite a safety
   test.
3. **Confirm the phasing**, or say you want phase 1 only for now.

On approval I will start with phase 1 and report exactly which files,
migrations, routes and tests changed.
