# Allergies — architecture plan

**Status: APPROVED 2026-09-22 — phases 1 and 2 BUILT (0058). Consultation/Triage indicators parked for the Clinics pass.** Decisions: the record lives in the patient record's Allergies tab (owner); dedicated tables (§2, technical default); pharmacist/owner-only confirm · refute · entered-in-error · NKA (§7); amber + ⚠ + words, red stays reserved (§5.1); Consultation/Triage indicators parked for the Clinics pass with Medications phase 3 (§6).
Brief: the owner's 28-section Allergies brief, 2026-09-22.
House rules: `AGENTS.md` (one behaviour per change, never weaken a test,
baseline moves in the same commit), `design.md` (locked look), GOLDEN-001
(tenant scope in the WHERE clause).

---

## 1. What already exists — and what I had wrong

`MEDICATIONS_PLAN.md` §7 said "allergies do not exist". **That was wrong, and
it changes this design.** There is an allergy concept, it is just thin and
nothing in the product writes to it:

| Thing | Where | What it is | Matters because |
|---|---|---|---|
| `patient_clinical_facts` | `db/migrations/0029_clinical_foundation.sql:88-133` | One row per fact; `fact_type` in `allergy / condition / medication / safety_info` (:117); a single text `value`; `status` reported / confirmed / unknown (:119); `source`; `recorded_by` | The only allergy storage today. **No reactions, severity, criticality, category, verification, dates.** |
| Its writer | `server/services/clinical/patientProfileService.js:163` `recordFact` | Inserts a fact | **Called only from tests.** Nothing in the product writes an allergy. Local DB: 0 fact rows. |
| Its reader | `server/services/clinical/clinicalFactService.js:291-305` `seedFromProfile` | Copies profile facts into a triage encounter as `profile_allergy` | **Triage already reads allergies from here.** Whatever becomes the allergy record must feed this. |
| `clinical_encounters.allergies_reported` | `0029_clinical_foundation.sql:251` | Free text: what the patient said *this episode* | Episode snapshot, deliberately separate from the persistent list. **Left alone.** |
| Audit trail | `server/services/clinical/clinicalAudit.js:32-67` | `recordClinicalEvent` → `customer_events`, staff-only, type-checked registry | §26's audit trail. **Reused, not rebuilt.** |
| Patient profile | `0029_clinical_foundation.sql:51-80`, `getOrCreateProfile` | 1:1 clinical identity per customer | Home for the "No known allergies" assertion (§5.2) |
| Roles | `db/migrations/0001_init.sql:46`, `server/middleware/auth.js:270` `requireRole` | owner / pharmacist / staff | §9 decision on who may confirm or refute |
| Drug register | `server/services/ingestion/nafdacLookup.js:273` `lookupByGeneric` | 6,670 NAFDAC records, in memory | Medication allergen search without touching Stock |
| The "not recorded" placeholders | `server/services/clinical/medications.js:320`, `client/src/Medications.jsx:186-192`, `client/src/patientSummaryModel.js:94-103`, `client/src/patientRecordTabs.js:33` (`built: false`) | Say "Not recorded", never "None" | Each becomes a real status. Their tests change deliberately (§10). |

---

## 2. The central decision: a dedicated allergy table

**Chosen: `patient_allergies` + `patient_allergy_reactions`, new tables.**
Existing allergy facts (if any exist anywhere) are carried across by the
migration, and `seedFromProfile` switches to reading the new table.

**Rejected: extend `patient_clinical_facts`.** It is a generic table for four
kinds of fact. Adding criticality, verification, category, exposure route and
two dates would mean conditions, medications and safety notes all carry a
dozen allergy-only columns that are always null. Brief §23 names exactly this
("do not create a giant Clinical Information record"). The medications record
has already moved out of this shape (0055 extends `medication_journeys`), so
allergies following it is consistent, not new.

**Rejected: FHIR's nested shape verbatim** (an allergy → reaction *events* →
each with its own manifestations and severity). A community pharmacist records
one history ("rash and facial swelling after amoxicillin"), not a series of
dated episodes. §3 keeps FHIR's concepts but one level flatter. If a second
distinct reaction event ever needs recording, it is a later migration, not a
rewrite.

---

## 3. Data model — migration `0058_patient_allergies.sql`

### `patient_allergies`
| Column | Type / values | Brief § | Note |
|---|---|---|---|
| `id`, `pharmacy_id`, `customer_id` | uuid, FKs | 21 | Tenant + patient, as every clinical table |
| `allergen_name` | text, 1–200, required | 6 | What is displayed. Free text always allowed |
| `allergen_code` | text, nullable | 6 | Set when picked from the register/list, e.g. `nafdac:<generic>` or `common:peanut`. Never required |
| `category` | medication · food · environmental · biologic · other · unknown | 7 | |
| `type` | allergy · intolerance · unknown | 7, 22 | Default **unknown**, never assumed to be an allergy |
| `clinical_status` | active · inactive · resolved | 12 | See note on status below |
| `verification_status` | unconfirmed · confirmed · refuted · entered_in_error | 11 | Default **unconfirmed** |
| `criticality` | low · high · unable_to_assess, nullable | 10 | Separate from severity, as FHIR does |
| `severity` | mild · moderate · severe · unknown, nullable | 9 | Severity of the reaction that happened |
| `exposure_route` | oral · topical · injection · inhaled · other, nullable | 21 | |
| `onset_date` + `onset_precision` | date + day · month · year | 13 | "About 5 years ago" is stored as year 2021, shown "~2021". Both null = unknown |
| `last_occurrence_date` + `last_occurrence_precision` | same | 13 | |
| `source` | patient · guardian · previous_record · prescriber · pharmacist · other | 14 | Who reported it |
| `notes` | text ≤ 2000 | 15 | Alongside the structured fields, never instead of them |
| `recorded_by`, `updated_by` | uuid → auth.users, nullable (DEV_AUTH_BYPASS) | 14 | The existing user model, nothing new |
| `status_reason` | text ≤ 500 | 11, 16 | Required when refuting or marking entered-in-error: *why* |
| `created_at`, `updated_at` | timestamptz | 26 | |

**Status, one decision worth knowing.** The brief lists Refuted and Entered in
error under *both* status (§12) and verification (§11). FHIR keeps them in
verification only, because they describe whether the record is *true*, not
whether the allergy is *current*. I follow FHIR: `clinical_status` is
active / inactive / resolved, and a refuted or erroneous record is identified
by `verification_status`. The screen still shows it the way the brief asks
("Refuted", "Entered in error") and files it under History. This removes an
impossible state (active + refuted). A CHECK enforces it: a refuted or
entered-in-error record is never `active`.

**Nothing is deleted.** There is no DELETE route. Refute, entered-in-error
and resolve are all updates that keep the row.

### `patient_allergy_reactions` (one row per manifestation)
`id`, `pharmacy_id`, `allergy_id` → cascade, `manifestation` (the 15 codes in
brief §8, `other` included), `description` (required when `other`; optional
otherwise), `position` (the order entered — the 0057 lesson),
`unique (allergy_id, manifestation)` for everything but `other`.

### The overall state — derived, with one stored assertion
| State | Rule |
|---|---|
| **Known allergies** | at least one row where verification is not refuted / entered_in_error and clinical status is `active` |
| **No known allergies** | none of the above, **and** a pharmacist has asserted NKA |
| **Not assessed** | neither. The default. An empty list is never read as NKA |

Stored: `patient_profiles.nka_asserted_at` / `nka_asserted_by` (+ nullable
columns). Recording an active allergy **clears the assertion in the same
transaction**, so a stale NKA cannot resurface when that allergy is later
refuted. The patient then goes back to Not assessed, which is honest: someone
has to assess them again.

RLS, indexes and tenant scoping follow 0054/0056 exactly.

**Carrying old facts across.** 0058 copies any `patient_clinical_facts` rows
with `fact_type = 'allergy'` into `patient_allergies` (name = value,
category/type unknown, verification = unconfirmed, or confirmed if the fact
was, source mapped). The old rows stay put and are not deleted. Locally there
are none. On production I would check with a read-only query before 0058
ships, **and I will not run anything against production**. It goes out with
the normal deploy.

---

## 4. API — `server/routes/allergies.js`, mounted before `routes/customers.js`

| Route | Does |
|---|---|
| `GET /:id/allergies` | `{ state, allergies[], history[], nka: { at, by } }` — the one read every screen uses |
| `GET /:id/allergies/options` | the vocabulary (categories, types, statuses, reactions…), so forms cannot offer a value the server refuses |
| `GET /:id/allergies/allergens?q=` | search: NAFDAC generic names + a short fixed list of common non-drug allergens (peanut, shellfish, egg, milk, latex, pollen, dust, bee sting…). A vocabulary, not patient data |
| `POST /:id/allergies` | create (clears NKA) |
| `GET /:id/allergies/:allergyId` | detail, with who recorded / last changed it |
| `PATCH /:id/allergies/:allergyId` | edit, including status and verification; reactions replaced wholesale, like the review's findings |
| `PUT /:id/allergies/status` | `{ assert: 'no_known' }` or `{ assert: 'clear' }` — the NKA assertion. Refused with 409 while active allergies exist |

Contract in `allergyInput.js` (pure), queries in `allergies.js`, audit via
`recordClinicalEvent` with new registered types: `ALLERGY_RECORDED`,
`ALLERGY_UPDATED`, `ALLERGY_STATUS_CHANGED` (resolve / inactivate / refute /
entered-in-error, with the reason), `ALLERGY_NKA_ASSERTED`,
`ALLERGY_NKA_CLEARED`. Each event carries before → after for what changed,
so "who refuted the penicillin allergy, when, and why" is answerable (§26).

---

## 5. Screens

### 5.1 The Allergies tab (`client/src/Allergies.jsx`)
Built in the Medications tab's existing idiom (table, in-place detail, the
record panel for add/edit), so nothing about it looks new:

```
Allergies                                         [ + Add allergy ]
┌──────────────────────────────────────────────────────────────────┐
│ ⚠ 2 known allergies                         last updated 22 Sep │   ← the state, first
└──────────────────────────────────────────────────────────────────┘
Active
 Allergen      Reaction                 Severity  Criticality  Verified      Last
 Penicillin    Rash · Facial swelling   Moderate  High         Confirmed     2023
  Medication · Allergy
 Peanuts       Wheezing                 Severe    High         Unconfirmed   ~2019
  Food · Allergy
History (resolved, inactive, refuted, entered in error)   ▸ 1
```
- Allergen and reaction lead, as §5/§24 ask. Metadata is secondary text.
- **Colour.** `design.md` reserves red for "a person is waiting", so this is
  a decision for you (Q3). My recommendation: criticality **High** and the
  *Known allergies* state use the amber attention tone plus a ⚠ icon and the
  word. Colour is never the only signal.
- A row opens the detail in place (§16), with Edit, Mark resolved / inactive,
  Mark refuted, Mark entered in error. The last two ask for a reason.
- **States (§25).** Loading: the app's `Loading`. NKA: "✓ No known allergies"
  + `Update allergy status`. Not assessed: "? Allergy status not assessed" +
  `Assess allergy status`, which opens a two-way choice: record an allergy, or
  confirm NKA. Error: the message plus Retry.

### 5.2 Add / edit form (the record panel `Medications.jsx` uses)
Allergen search box (free text allowed) · category · allergy / intolerance /
unknown · reactions as toggle chips (multi-select) + "Other reaction" text ·
severity · criticality **with its helper line** ("How clinically significant
could future exposure be?") · verification · onset and last occurrence, each
as *exact date / month / year / unknown* · source · notes. Defaults stay
honest: type Unknown, verification Unconfirmed, and no severity or
criticality pre-picked.

### 5.3 Visible everywhere in the record (§17)
A compact strip at the top of every patient-record tab, beside "Back to
patients": `⚠ Allergies: Penicillin, Peanuts` / `✓ No known allergies` /
`? Allergies not assessed`. Clicking it opens the Allergies tab. One
component, fed by `GET /:id/allergies`, so Medications, the Review and Vitals
all get it without duplicating anything.

### 5.4 Medication review (§18, acceptance criterion)
- `medicationContext` (`medications.js:320`) returns the real state and active
  allergies in place of the stub.
- The Medications context panel shows them (`Medications.jsx:186`).
- **The review editor gets a "Patient safety" block** at its top: each active
  allergy with its reactions. Today the editor hides the context panel
  entirely, and that is exactly when a pharmacist needs this.
- **No blocking, no warnings computed against medicines.** There is no
  clinically validated rules engine, so the software shows the allergy and
  the pharmacist decides (§18).

### 5.5 Patient summary
The Allergies card (`patientSummaryModel.js:94`) shows the state and names,
and the tab flips to `built: true`.

---

## 6. Consultation and Pharmacist Triage (§17) — proposed deferral

Your instruction today parks Medications phase 3 (Consultation / Triage entry
points) until the Clinics module work. Allergies in Consultation and Triage is
the same kind of change on the same screens, so **I propose it joins that
pass** rather than being bolted onto screens that are about to be rebuilt.
Two pieces still happen **now**, because without them the data would be split:
- `seedFromProfile` (`clinicalFactService.js:291`) reads `patient_allergies`,
  so triage's existing allergy context stays correct from day one.
- The strip in §5.3 already covers anyone looking at the patient record.

---

## 7. Who may do what (§9 decision, Q2)

Recommended:
- **Any member** (including staff) may record an allergy. It saves as
  *Unconfirmed*: a counter assistant writing down what the patient said is
  useful and honest.
- **Pharmacist or owner only** may set *Confirmed*, *Refuted* or *Entered in
  error*, or assert *No known allergies*. Those are clinical judgements, and
  NKA is the one that tells the next person "safe to give".

This is the first role rule on a clinical route. It uses the existing
`requireRole` / `req.pharmacyRole`, not a new permission system.

---

## 8. Explicitly not in this change
Automatic allergy-vs-medicine checks, blocking medication entry, cross-
sensitivity (e.g. penicillin → cephalosporin) suggestions, AI extraction into
the allergy record, SNOMED/RxNorm coding, a separate adverse-drug-reaction
module (the Allergy / Intolerance / Unknown distinction covers §22), and any
change to the medication record, vitals, conditions or consultations beyond
the read-only indicator.

---

## 9. Risks
1. **The placeholders' tests assert "Not recorded".** `medications.test.js:279`
   and `patientSummaryModel.test.js:36` hold today's honest wording. They will
   be *rewritten* to the new three-state rule, in the same commit and with the
   reason, not weakened. The rule they protect ("empty ≠ none") becomes
   stricter, not looser.
2. **Triage behaviour moves.** `seedFromProfile` changes source. Its existing
   tests (`clinicalFoundationE2E`, `soreThroatAssessmentV1` TEST 11) must keep
   passing, and a new test proves a `patient_allergies` row reaches a triage
   encounter.
3. **Role rule is new ground.** Under DEV_AUTH_BYPASS the dev user's role
   decides what the demo can do. I will check which role that resolves to so
   the demo is not silently read-only.
4. **Approximate dates are new.** No existing date model supports them, so the
   precision columns are introduced here. They are kept to two columns per
   date, with no fuzzy-date library.

---

## 10. Tests (brief §27 → where each lives)
| # | Brief | Test |
|---|---|---|
| 1–7, 10–12 | create, edit, multiple reactions, severity, criticality, verification, status, refuted, entered-in-error, source | `allergyInput.test.js` (pure contract, ~16) + `allergies.test.js` (DB, ~14) |
| 8–9 | NKA, Not assessed | DB: the three-state derivation; NKA refused while active allergies exist; recording one clears NKA; refuting the last one returns to Not assessed |
| 13 | patient context | client: `allergyFormat.test.js` (the strip's three wordings; "none" never appears) |
| 14 | medication review | DB: `medicationContext` returns real allergies; client: the review's safety block |
| 15 | authorization | DB: cross-tenant refusal on both tables; route: staff cannot confirm, refute or assert NKA |
| 16 | API failure | client: the error state renders with Retry |
| 17 | persistence after refresh | DB round trip: every field saved comes back as saved; plus a browser check on the running app |
| — | audit | DB: each status change writes one `customer_events` row with before → after and reason |
| — | triage | DB: an allergy reaches `seedFromProfile` |

Then: lint, client suite, full server suite with and without a database,
baseline + `AGENTS.md`, `check-baseline`, and a walk-through in the browser.

---

## 11. Phasing
| Phase | Contents | Brief acceptance |
|---|---|---|
| **1 — the record** ✅ built | 0058, API, Allergies tab (states, list, add/edit, detail, resolve / refute / error, NKA), audit, triage seed | §28 first block, in full |
| **2 — visible elsewhere** ✅ built | the record-wide strip, summary card, Medications context panel, Review safety block | §28 "Patient → Medication Review" |
| *(with Clinics)* ⏸ parked | Consultation and Triage indicators | §17 |

Phases 1 and 2 are small enough to build back to back. They are split only so
each has its own commit and baseline.

---

## 12. Questions before I start
1. **Dedicated table + carry old facts across** (§2) — agree?
2. **Roles** (§7): staff record as Unconfirmed; only pharmacist / owner
   confirm, refute or assert NKA — agree?
3. **Colour** (§5.1): amber + ⚠ + words for high criticality / known allergies
   (keeps `design.md`'s red rule), or do you want red here?
4. **Consultation / Triage** (§6): join the Clinics pass with Medications
   phase 3 — agree?

---

## 13. Built — what changed from this plan, and why

- **Triage gets ONE fact for the allergy list** (`profile_allergies`), not one
  per allergy. `recordFact` keeps one live value per concept, so two allergies
  under one concept would have been read as a *conflict* between sources. The
  same latent shape exists for conditions and medications in
  `seedFromProfile`; nothing writes those today, so it is noted, not changed.
- **Drug classes in the allergen list.** The NAFDAC register lists generics, not
  classes, and allergies are often recorded by class ("penicillins", "sulfa").
  Five classes sit in `COMMON_ALLERGENS`, marked `drugClass`; no individual
  medicine does.
- **`nafdacLookup.genericNames()`**, a read-only export: the register's
  own search matches whole words only, which cannot serve type-ahead.
- **The allergen code has no length cap of its own** beyond the field's 200
  characters: five combination-vitamin names in the register run past 190.
