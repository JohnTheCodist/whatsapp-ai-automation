# Conditions — architecture plan

**Status: APPROVED 2026-09-22 — phases 1 and 2 BUILT (0059).** Decisions (owner): a separate problem list beside the purchase inference, promoted only by hand (§2); the chronic switch and Condition filter count recorded active conditions too (§9.1, phase 2); Consultation/Triage indicators parked for the Clinics pass (§6.3).
Brief: the owner's 32-section Conditions brief, 2026-09-22.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the same pattern as
the Allergies record (`ALLERGIES_PLAN.md`), which the owner has already seen
working, so the two tabs behave alike.

---

## 1. What already exists

| Thing | Where | What it is | Matters because |
|---|---|---|---|
| **`patient_condition`** | `db/migrations/0037_patient_condition.sql` | **Purchase-inferred.** "Purchase history is consistent with this condition, for pharmacy tracking. NOT a diagnosis." One row per patient per condition code, `unique (pharmacy_id, customer_id, condition_code)`, owned and upserted by the condition engine | The central decision (§2). Four codes today: `HYPERTENSION`, `DIABETES`, `DYSLIPIDEMIA`, `ASTHMA_OR_COPD` (`server/config/conditionMappings.js`) |
| Its readers | `patientSearch.js:103-120` (Condition filter and **chronic switch**), `customerProfile.js` (summary card, body markers), `medications.js` `medicationContext` (Medications panel), `routes/conditions.js`, `insights.js`, `conversations.js` | All read `CONFIRMED_BY_PURCHASE` | Each has to decide whether it wants the inference, the record, or both (§6) |
| `patient_clinical_facts` `fact_type='condition'` | `0029_clinical_foundation.sql:117` | One text value, no status. **Nothing writes it** | Carried across, like allergies were (§3) |
| Triage seed | `clinicalFactService.js` `seedFromProfile` | Seeds profile facts into a triage encounter | Must read the new record, the way it now reads allergies |
| Consultations | `clinical_encounters` (0029), `client/src/Consultations.jsx` | One clinical episode each | §15 encounter association points here |
| Encounter list | `clinicalEncounterService.js:140` `listEncountersForPatient` | **Creates a profile as a side effect of reading** | The picker uses its own read-only query |
| Vitals | `patient_vitals` (0054) | One reading per row | §16 supporting evidence can link to a reading |
| Medications | `medication_journeys.condition_code` (0055) | A medicine's indication, as a code | §23: related through that code, never merged |
| Audit, roles | `clinicalAudit.js`, `requireRole` / `req.pharmacyRole` | As used by Allergies | Reused unchanged |
| Follow-up | `medication_reviews.follow_up_*` (0056) | The only follow-up in the product | Not touched |

---

## 2. The central decision: a problem list beside the purchase inference, never merged into it

**Chosen: a new table, `patient_problems`, for conditions a person asserts.**
`patient_condition` stays exactly as it is: the engine's inference.

- **Why not extend `patient_condition`.** 0037's own header says it: mixing
  inference into an asserted record "would let a purchase-derived guess sit in
  the same column as a pharmacist-confirmed fact". Its unique key also allows
  only one row per condition, so "malaria, resolved Aug 2026" and "malaria,
  active again" could not both exist. And the engine upserts those rows, so it
  would overwrite a pharmacist's entry.
- **Why the name `patient_problems`, not `patient_conditions`.** A table one
  letter away from `patient_condition`, with the opposite meaning, is an
  accident waiting to happen. The screen still says **Conditions**, and "problem
  list" is the clinical term the brief itself uses.
- **How the two meet on screen.** The Conditions tab shows the recorded list.
  Below it, a separate, clearly labelled block reads **"Suggested by purchase
  history — not a diagnosis"** and lists any engine conditions not already
  recorded. Each has a **Record as condition** action that opens the form
  pre-filled, with verification set to *Unconfirmed*. The pharmacist decides.
  Nothing is ever promoted automatically (brief §20, §22).

---

## 3. Data model — migration `0059_patient_problems.sql`

### `patient_problems` (FHIR Condition concepts)
| Column | Values | Brief § |
|---|---|---|
| `id`, `pharmacy_id`, `customer_id` | uuid, FKs | 27 |
| `condition_name` | text 1–200, required. What is displayed | 6 |
| `code_system`, `code` | nullable, e.g. `icd10` + `I10`. **Terminology-ready**: a later service fills these without a schema change | 6, 27 |
| `local_code` | nullable, the house code (`HYPERTENSION`…) that `patient_condition` and `medication_journeys.condition_code` already use, so the record, the inference and a medicine's indication can be matched | 2, 23 |
| `category` | problem_list · chronic · acute · encounter_diagnosis · other (labels: "Problem list", "Chronic", "Acute", "Diagnosis at a consultation", "Other") | 7 |
| `clinical_status` | active · recurrence · relapse · inactive · remission · resolved. **UI groups these as Active / Inactive / Resolved or in remission** | 8 |
| `verification_status` | confirmed · provisional · unconfirmed · differential · refuted · entered_in_error. Default **unconfirmed** | 9 |
| `severity` | mild · moderate · severe · unknown, nullable (never forced) | 10 |
| `body_site` | text ≤ 100, nullable | 13 |
| `onset_date` + `onset_precision` (day · month · year) + `onset_note` (≤ 100, e.g. "since childhood") | all nullable. Same partial-date shape as allergies | 11 |
| `abatement_date` + `abatement_precision` | nullable. Resolved or remission date | 12 |
| `source` | patient · previous_record · prescriber · pharmacist · laboratory · other | 14 |
| `asserted_by_name` | text, nullable. The *person* the diagnosis came from, when outside ("Dr Okafor, LUTH"). `recorded_by` is who typed it | 14 |
| `encounter_id` | → `clinical_encounters`, nullable, `on delete set null` | 15 |
| `notes` | ≤ 2000 | 17 |
| `status_reason` | ≤ 500. Required for refuted / entered-in-error | 18 |
| `recorded_by`, `updated_by`, `created_at`, `updated_at` | existing user model | 14, 28 |

CHECKs, the same ones Allergies has: a refuted or entered-in-error record is
never active and always has a reason; each date travels with its precision;
the abatement date is not before onset; `resolved`/`remission` may carry an
abatement date and `active` may not.

### `patient_problem_evidence` (brief §16, only what exists)
`problem_id` → cascade, and **`vitals_id` → `patient_vitals`**. One typed
column per kind, not a polymorphic "any id": the database checks the link is
real and belongs to this pharmacy. Consultations are already linked through
`encounter_id`. There are no laboratory results in the product yet, so no
column for them. When results exist, they get a column.

### Carrying across
0059 copies any `patient_clinical_facts` condition rows (nothing writes them
today), exactly as 0058 did for allergies. The old rows stay.

RLS, indexes and tenant scoping follow 0058.

### No "No known conditions" state, yet
Brief §26 says an assessed patient *may later* have one. This change shows
**"No conditions recorded"** for an empty list and infers nothing. The NKA
pattern from Allergies can be reused when you want it: one column, one dialog.

---

## 4. Vocabulary and search (brief §6)

- **A curated list of ~35 common community-pharmacy conditions**, each with its
  ICD-10 category code and, where one exists, the house `local_code`:
  hypertension (I10), type 2 diabetes (E11), type 1 diabetes (E10), asthma
  (J45), COPD (J44), hyperlipidaemia (E78.5), osteoarthritis (M19.9), migraine
  (G43.9), peptic ulcer disease (K27.9), GORD (K21.9), malaria (B54),
  gastroenteritis (A09), sickle cell disease (D57.1), hypothyroidism (E03.9),
  gout (M10.9), epilepsy (G40.9), heart failure (I50.9), and others.
  - Held in one server file, like the allergy vocabulary. It is a starting
    list, not a limit: **free text is always accepted**, and code fields stay
    empty until a terminology service is added.
  - I'll double-check each code before it ships. A wrong code is worse than
    none.
- **Two gentle guards, never blocks** (brief §20, §21):
  - Typing a symptom word (headache, fever, cough, nausea…) shows a hint: "This
    reads like a symptom. Symptoms usually belong in the consultation."
  - Typing "allergy" or "allergic to" shows: "Allergies belong in the Allergies
    tab", with a link.
  - Both are hints only. No diagnosis logic, nothing auto-created.

---

## 5. Duplicate prevention (brief §19)

On create, the server looks for a **current** record (active / recurrence /
relapse, and not refuted or in error) with the same code, or the same local
code, or else the same normalised name. If one exists, it answers **409
`DUPLICATE_ACTIVE`** with that record's id. The form then shows:

> This patient already has an active Hypertension condition.
> [ View existing ]  [ Continue anyway ]

"Continue anyway" resends with `allowDuplicate: true`, and the audit event
records that the duplicate was deliberate. **No check** for the category
*Diagnosis at a consultation*, or for a record created already resolved, since
those are legitimate history (brief §19's last line).

---

## 6. Screens

### 6.1 The Conditions tab (`client/src/Conditions.jsx`)
Same idiom as Allergies and Medications: header and "+ Add condition", then
compact tables.

```
Conditions                                          [ + Add condition ]
Active
 Condition               Category   Status   Verification    Severity  Onset   Updated
 Hypertension            Chronic    Active   Confirmed       Moderate  ~2022   22 Sep
 Possible asthma         Chronic    Active   Provisional ⓘ   –         ~2019   22 Sep
History                          [ All | Active | Inactive | Resolved | Refuted ]  [ List | Timeline ]
 Malaria                 Acute      Resolved Confirmed       –         Aug 2026 …
Suggested by purchase history — not a diagnosis
 Dyslipidaemia        from 4 purchases since Mar 2026          [ Record as condition ]
```
- **Uncertainty is visible, not just a word.** Provisional, differential and
  unconfirmed conditions show an outlined chip, a softer name, and "?" before
  a differential. "Possible asthma" never looks like "Asthma · Confirmed"
  (brief §9).
- **Detail in place** (brief §18): every field, "Documented during:
  Consultation — 22 Sep 2026", linked vitals readings, the medicines whose
  indication matches (read-only, from `medication_journeys`), and who
  recorded / last changed it.
  - Actions: Edit, Mark inactive, Mark resolved, Mark in remission, Mark
    refuted, Mark entered in error. The last two ask for a reason.
- **Filters and timeline** (brief §25). The timeline groups by onset month,
  newest first, the way the Medications history does.
- **States** (brief §30). Loading: the shared `Loading`. Empty: "No conditions
  recorded" + Add. Error: message + Retry. Unauthorised: the server's 403
  message in the form, as Allergies does.

### 6.2 Add / edit form (the same record panel)
Condition search (curated list + free text, with the two hints) · category ·
status · verification · severity · body site · onset (unknown / year / month
/ exact + optional note) · resolution date (shown when resolved or in
remission) · source · diagnosed by (optional name) · consultation picker
(this patient's consultations, newest first, read-only query) · supporting
vitals readings (optional picker) · notes.

### 6.3 Everywhere else (brief §24)
- **Patient summary card** shows the recorded active conditions. Purchase
  suggestions show only as "N suggested by purchases".
- **Medications context panel and the Review's context block** become one
  compact **Clinical context**: conditions (recorded, active), allergies (as
  today), and the most recent vitals. Each has a link into its tab.
  `medicationContext` returns the recorded conditions, plus the purchase
  inference in a separate, labelled field.
- **Triage seed** reads the problem list as one `profile_conditions` fact,
  the same one-list-one-fact shape allergies needed.
- **Consultation and Pharmacist Triage screens: parked for the Clinics pass**,
  with Medications phase 3 and the allergy indicator, as you decided for
  those.

---

## 7. Who may do what
Same rule as Allergies, for the same reason: **any member** may record a
condition as *Unconfirmed* or *Provisional* (writing down what the patient or
a letter said). **Pharmacist or owner only** may set *Confirmed*,
*Differential*, *Refuted* or *Entered in error*, since those are clinical
judgements.

---

## 8. Not in this change
Automatic diagnosis of any kind, promoting purchase inferences automatically,
vitals-to-diagnosis rules, a laboratory module, SNOMED/ICD search against an
external service, "No known conditions", changes to the purchase engine, and
any Consultation / Triage screen change.

---

## 9. Risks
1. **The chronic switch and Condition filter** read the purchase inference
   only. After this change a pharmacist can record Hypertension and the
   patient still won't appear under "Show only chronic patients", unless the
   filter also reads the record. **Question 2.**
2. **Existing tests that assert purchase-only wording** ("None confirmed from
   purchases", "Confirmed from purchase history, not a diagnosis") get
   rewritten deliberately where a screen's meaning changes. The not-a-diagnosis
   rule for the inference stays tested.
3. **ICD-10 codes in a hand-kept list.** I'll verify each one, and every
   `code` is nullable so a doubtful one can be left out.
4. **`listEncountersForPatient` writes on read.** It is not used; the picker
   gets a read-only query.

---

## 10. Tests (brief §31)
| Brief # | Where |
|---|---|
| 1–12 | `problemInput.test.js` (pure contract, ~16) + `problems.test.js` (DB round trip, ~16) |
| 13 | DB: 409 on a same-code or same-name current record; allowed for an encounter diagnosis, a resolved record, and with `allowDuplicate` |
| 14–15 | DB: resolved and refuted rows stay in history, with the reason, and the DB refuses "refuted + active" |
| 16–17 | DB: `medicationContext` returns recorded conditions, separate from the inference; client: summary card and the Clinical context block |
| 18 | DB: cross-tenant refusal; staff cannot confirm, differential, refute or mark in error |
| 19 | client: error state with Retry; DB: bad encounter / vitals ids refused |
| 20 | DB round trip + browser check |
| — | audit before → after + reason; triage seed; 0059 carry-across run twice; evidence links refused across tenants |

---

## 11. Phasing
| Phase | Contents |
|---|---|
| **1 — the record** | 0059, API, Conditions tab (lists, filters, timeline, add/edit, search, duplicate check, detail, status actions, encounter link, evidence link), audit, roles, triage seed |
| **2 — visible elsewhere** | purchase-suggestion block, summary card, Clinical context in Medications and the Review, (and the chronic switch, if you say so) |
| *(Clinics)* | Consultation and Triage indicators |

---

## 12. Questions
1. **Separate table beside the purchase inference, with "Record as condition"
   to promote a suggestion by hand** (§2): agree?
2. **Chronic switch / Condition filter** (§9.1): should they also count
   *recorded* active conditions (Hypertension, Diabetes), or stay
   purchase-only for now?
3. **Consultation / Triage**: park with the Clinics pass, as for the others?

---

## 13. Built — what changed from this plan, and why

- **A purchase suggestion pre-fills a specific diagnosis only when its house
  code names exactly one.** `DIABETES` covers type 1, type 2 and
  gestational, and purchases can't tell them apart. The first build
  pre-filled "Type 2 diabetes mellitus", which is the software choosing a
  diagnosis. It now pre-fills "Diabetes" and leaves the type to the
  pharmacist. Found while checking the running app.
- **The half-known date reader and the date input are shared.**
  `server/services/clinical/partialDate.js` and
  `client/src/PartialDateInput.jsx` came out of the allergy code rather than
  being copied. Allergies uses them unchanged.
- **The error handler passes a 409's `existing` record** (id and name only),
  so "View existing" knows where to go. Tested in `errorHandler.test.js`.
- **The Review's context block became "Clinical context"** (conditions,
  allergies, recent vitals), and it is neutral rather than amber now that it
  holds more than allergies. The allergy names keep their own amber.
- **The body map's asthma marker was keyed on `ASTHMA`, a code the engine
  never produces.** It now also reads `ASTHMA_OR_COPD`, the code both the
  engine and the problem list use.
