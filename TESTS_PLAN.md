# Tests — architecture plan

**Status: APPROVED 2026-09-23 — phases 1 and 2 BUILT (0060).** Decisions (owner): one row per test event with result rows beside it (§2); attachments NOT in this pass — a test names its lab and report number for now, the private bucket waits (§5); the record nav is renamed "Tests" (§12.3).
Brief: the owner's 34-section Tests brief, 2026-09-23.
House rules: `AGENTS.md`, `design.md`, GOLDEN-001. Built in the pattern of
Allergies (0058) and Conditions (0059), which are working, so the tabs behave
alike.

---

## 1. What already exists

| Thing | Where | Matters because |
|---|---|---|
| The tab | `client/src/patientRecordTabs.js:31` — `{ id: 'results', label: 'Test results', built: false }` | The section already has its place in the record. §12 below asks about its name |
| **Nothing records a test result today** | — | No table, no service, no concept. `patient_vitals` (0054) holds BP, pulse, temperature, SpO₂, weight, height, MUAC — and **no glucose**, so the brief's Vitals/Tests split (§16) already holds |
| Consultations | `clinical_encounters` (0029), `problems.js#encounterChoices` | §18's link. The read-only picker written for Conditions is reused |
| Conditions | `patient_problems` (0059), `local_code` | §17: a test may be shown BESIDE a condition through the house code, never turned into one |
| Medications | `medication_journeys.condition_code` (0055) | Same: related, never merged |
| Chart | `client/src/VitalsChart.jsx` — `series[{label, points[{at, value}]}]`, `unit`, an optional `ranges` band | §22's trend, reused as-is. No new chart library |
| Reference ranges, precedent | `services/clinical/vitalRanges.js` | Vitals ranges are **age rules in code**. A test's range is **per result, often printed by the lab**, so it is stored on the result (§13) — a different thing, deliberately |
| Audit, roles | `clinicalAudit.js`, `req.pharmacyRole` | Reused unchanged |
| Partial dates | `services/clinical/partialDate.js`, `client/src/PartialDateInput.jsx` | Historical results (§21) are often known only as "Jun 2026" |
| **File storage** | `services/website/assetStore.js` → Supabase Storage, **bucket `pharmacy-assets`, PUBLIC base URL, images only** (`pharmacy_assets`: logo/hero/gallery/service, jpeg/png/webp) | §24's attachments. **A lab report is confidential and cannot go in a public image bucket.** See §5 |

There is no patient-document architecture. That is the one part of this brief
the product cannot simply reuse.

---

## 2. The central decision: one row per test, with its results beside it

The brief (§25) names ServiceRequest → DiagnosticReport → Observation.

**Chosen: `patient_tests` (the test event) + `patient_test_results` (one row
per value).** The order and the report are the SAME row at different points
in its life: a test starts as *Ordered* with no results, and gains results,
a performer and a status. `patient_test_results` is the Observation level —
several per test, so a lipid profile is one test with four values.

- **Why not a separate order table.** In a community pharmacy, an order and
  its report are one event nearly every time: the pharmacist does the RDT, or
  a patient walks in with a result for a test nobody here ordered. Two tables
  would mean an empty shell row for every walk-in result, a join for every
  read, and two statuses to keep consistent. The FHIR separation earns its
  keep in a hospital where ordering and performing are different departments
  with different systems.
- **What is kept from the model that matters**: the three LEVELS stay
  distinct — the request (why, who asked, priority, specimen), the report
  (status, when performed, by whom, source), and the values (each with its
  own unit, range and interpretation). One row carries the first two; the
  result rows carry the third.
- **If a test is never performed**, it ends *Cancelled*, with a reason. It is
  not deleted.

---

## 3. Data model — migration `0060_patient_tests.sql`

### `test_definitions` — the catalogue, which grows as data
`id`, `pharmacy_id` **nullable** (null = shipped with the product, a row = a
pharmacy's own), `code` (house code, e.g. `FBG`, `HBA1C`, `MAL_RDT`),
`name`, `category`, `result_type` (`quantitative` · `coded` · `text` ·
`panel`), `specimen_default`, `unit`, `reference_low`, `reference_high`,
`coded_options` (jsonb, e.g. Positive/Negative), `analytes` (jsonb, for a
panel like a lipid profile), `condition_code` (the house code a result
relates to, e.g. `DIABETES` for HbA1c — §17's link), `active`.

Seeded with ~25: malaria RDT, blood glucose (fasting/random), HbA1c, lipid
profile, pregnancy test, urinalysis, HIV screening, hepatitis B screening,
PCV/haemoglobin, full blood count, LFT, RFT/electrolytes, uric acid, TSH,
sickling test, typhoid (Widal), stool microscopy, ECG, chest X-ray,
abdominal ultrasound, and others. **A test is never limited to the list**:
`patient_tests.test_name` is free text, and a catalogue row is optional.

### `patient_tests` — one test event
| Column | Notes | Brief § |
|---|---|---|
| `id`, `pharmacy_id`, `customer_id` | | 26 |
| `definition_id` nullable, `test_code` nullable, `test_name` required | The name is snapshotted: renaming a catalogue entry must not rewrite history | 6, 25 |
| `category` | laboratory · rapid_test · microbiology · haematology · chemistry · serology · imaging · other | 7 |
| `status` | `ordered · pending · preliminary · final · amended · corrected · cancelled` (the brief's list, FHIR's names; "Completed" is how *final* is shown) | 5, 27 |
| `priority` | routine · urgent | 8 |
| `reason`, `notes` | why it was asked for | 8, 17 |
| `specimen` | blood · urine · stool · saliva · swab · other · not_applicable, nullable | 9 |
| `ordered_on` date, `ordered_by` user, `orderer_name` | who asked | 8 |
| `performed_at` timestamptz + `performed_precision`, `performed_by_name` | historical results are often "Jun 2026" | 10, 21 |
| `source` | rxmax_clinic · external_lab · hospital · patient_reported · imported · other, and `source_name` ("Synlab, Ikeja") | 19, 20 |
| `historical` boolean | marked by the pharmacist, never inferred | 21 |
| `encounter_id` → `clinical_encounters` | the consultation it belongs to | 18 |
| `report_summary` text | a lab's overall comment | 11 |
| `status_reason` | required for cancelled / corrected / amended | 27 |
| `recorded_by`, `updated_by`, timestamps | | 27 |

CHECKs: a test with results is never `ordered`; `cancelled`/`corrected`/
`amended` carry a reason; `performed_at` travels with its precision; a final
test has a `performed_at`.

### `patient_test_results` — one row per value
`test_id` → cascade, `analyte_name`, `analyte_code`, `position`,
`value_number` + `unit`, `value_code` + `value_display`, `value_text`,
`reference_low`, `reference_high`, `reference_text` (a lab's own wording),
`interpretation` (`normal · high · low · critical_high · critical_low ·
positive · negative · abnormal · indeterminate · not_interpretable`),
`notes`. A CHECK requires **exactly one kind of value** per row.

### `patient_test_corrections` — what a result said before
`test_id`, `snapshot` jsonb (the test row and its results as they were),
`reason`, `corrected_by`, `created_at`. Written whenever a **final** test is
edited, before the change. Nothing final is ever silently overwritten (§27),
and the detail view can show "Corrected on … — previously 8.1 %".

RLS, indexes and tenant scoping follow 0059. `test_definitions` policy also
allows the shipped rows (`pharmacy_id is null`).

---

## 4. Interpretation, ranges, and the line this must not cross

- **The range lives on the result**, not in global config: typed by the
  pharmacist or copied from the lab's printout, per test (§13). No product-
  wide thresholds, and none invented.
- **The form OFFERS an interpretation** for a quantitative value once a range
  is present — value below low → "Low", above high → "High" — as a
  **pre-filled, editable field**. Comparing a number to a range the user just
  typed is arithmetic, not diagnosis. What is stored is what the pharmacist
  confirmed, and the server never overrides it.
- **Critical** is only ever chosen by a person (§23). Nothing computes it.
- **No test ever creates or changes a condition** (§15, §17). The detail view
  may show related recorded conditions through the catalogue's
  `condition_code`, read-only, and says "Related", never "Diagnosis".

---

## 5. Attachments (§24) — the one thing that cannot be reused

The only file store is `pharmacy-assets`: **public URLs, images only,
pharmacy-level**. A patient's lab report is confidential and patient-level, so
it needs its own private bucket with signed, expiring URLs — the same
`assetStore` seam (injectable backend, so it stays testable without a
Supabase project), a new `patient-documents` bucket, `patient_test_attachments`
(test_id, storage_path, filename, mime in pdf/jpeg/png, bytes, uploaded_by),
and an upload route with magic-byte validation.

That is real work and a real risk surface (a leaked URL is a patient's blood
results). **Recommendation: it is its own phase, built last, after the record
itself is working.** Question 2 asks whether to include it in this pass.
Until it exists, a test can name its report ("Synlab report 2026-0918-441")
in `source_name` and `report_summary`.

---

## 6. API — `server/routes/tests.js`, mounted before `routes/customers.js`

| Route | Does |
|---|---|
| `GET /:id/tests` | the list, with counts per filter |
| `GET /:id/tests/options` | the vocabulary (categories, statuses, specimens, sources, interpretations) |
| `GET /:id/tests/catalogue?q=` | the test catalogue, searched |
| `GET /:id/tests/trend?code=` | a quantitative analyte's history, for the chart |
| `POST /:id/tests` | order a test, or record a completed one in a single step |
| `GET /:id/tests/:testId` | one test: results, corrections, encounter, related conditions and medicines |
| `PATCH /:id/tests/:testId` | edit; results replaced wholesale; a **final** test is snapshotted first and becomes *corrected* |
| `POST /:id/tests/:testId/results` | record results against an ordered test (the "+ Record result" path) |
| *(phase 3)* `POST /:id/tests/:testId/attachments`, `GET …/attachments/:attachmentId` | upload, and a signed URL |

Contract in `testInput.js` (pure), queries in `tests.js`, audit via
`recordClinicalEvent` with `TEST_ORDERED`, `TEST_RESULT_RECORDED`,
`TEST_UPDATED`, `TEST_STATUS_CHANGED`, `TEST_CORRECTED`.

**Roles**, as for the other two records: anyone may order a test or enter a
result as *preliminary*; **pharmacist or owner** may set *final*, *amended*,
*corrected* or *cancelled*.

---

## 7. Screens (`client/src/Tests.jsx`)

```
Tests                                   [ + Order test ]  [ + Record result ]
All 7 · Ordered 1 · Pending 1 · Completed 4 · Abnormal 2 · Historical 3
[ All categories ▾ ]  [ Search a test ]

 Test                  Category     Date        Status      Result      Interpretation  Source
 Malaria RDT           Rapid test   22 Sep 26   Completed   Negative    Normal          RxNaija clinic
 Fasting blood glucose Laboratory   20 Sep 26   Completed   108 mg/dL   High ▲          Synlab
 Lipid profile         Laboratory   18 Sep 26   Pending     —           —               Synlab
```
- The result and its interpretation are IN THE ROW (§30): no click to see the
  number. Abnormal wears the amber attention tone with an arrow and the word;
  **critical** is the one place red is allowed — design.md reserves red for
  "a person is waiting", and a critical result is exactly that.
- A row opens in place: every field, all result rows with their ranges, the
  correction history, the consultation, related conditions and medicines, and
  the trend chart when the same analyte has three or more values.
- **Two entry points, one form.** "Order test" opens it with no result
  section; "Record result" opens it with results and asks when it was
  performed. An ordered test's detail has "Add result".
- Actions: Edit · Add result · Correct result · Cancel. Correcting a final
  test asks for a reason and keeps the old values.
- Empty: "No tests recorded" + both buttons. Ordered with nothing back:
  "Test ordered — result pending". Failure: message + Retry. No chart is ever
  drawn from one point.

**Elsewhere (phase 2):** the summary card ("2 recent, 1 abnormal"), and a
"Recent tests" column in the Review's Clinical context block beside
conditions, allergies and vitals. Consultation and Triage stay parked with
the Clinics pass, like the others.

---

## 8. Not in this change
Diagnosis from results, automatic conditions, computed critical thresholds, a
hospital LIS (analysers, worklists, accessioning, billing), lab interfacing
(HL7/FHIR endpoints), inventory of test kits, and any Consultation/Triage
screen change.

---

## 9. Risks
1. **Attachments are a privacy surface.** A public bucket would be a leak of
   patient results. If phase 3 is approved it gets its own private bucket,
   signed URLs, magic-byte checks and its own tests. Nothing partial ships.
2. **The interpretation pre-fill must stay a suggestion.** The form fills it;
   the pharmacist can change it; the server stores only what was sent. Tested
   both ways.
3. **Status is easy to get wrong.** One table carries a lifecycle that FHIR
   splits across two, so the CHECKs and the tests carry the weight: results
   without a status move, a final test with no performed date, an edit to a
   final test that skips the snapshot.
4. **The catalogue is seeded data.** Reference ranges for common tests vary
   by lab and by method. The catalogue's defaults are a convenience the form
   pre-fills, always editable, and the range that is STORED is the one shown.

---

## 10. Tests (brief §33 → where each lives)
| # | Where |
|---|---|
| 1–8, 11 | `testInput.test.js` (pure, ~16) + `tests.test.js` (DB, ~18) |
| 9, 13, 15 | DB: the status rules; a final test edited is snapshotted and becomes corrected, old values readable; one test with four analytes |
| 10, 12 | DB: historical marked and dated at its precision; client: abnormal and critical wording and tone |
| 14, 16 | client: the detail view and the trend series (three or more points, never fewer) |
| 17 | DB: the consultation link, and another patient's consultation refused |
| 18 | DB: cross-tenant refusal; staff cannot finalise, amend, correct or cancel |
| 19 | DB round trip + a browser walk-through |
| 20 | client: load and save failures show with a retry, never only in the console |
| — | audit before → after; the catalogue's shipped rows readable by every pharmacy and writable by none |

---

## 11. Phasing
| Phase | Contents |
|---|---|
| **1 — the record** ✅ built | 0060, the catalogue, the API, the Tests tab (list, filters, search, order, record result, detail, corrections, trend), audit, roles |
| **2 — visible elsewhere** ✅ built | summary card, Recent tests in the Review's clinical context |
| **3 — attachments** ⏸ not in this pass (owner) | private bucket, upload and signed-URL routes, the attachment list on a test |
| *(Clinics)* | Consultation and Triage, parked with the others |

---

## 12. Questions
1. **One row per test event, with result rows beside it** (§2) — agree, rather
   than a separate order table and report table?
2. **Attachments** (§5): include as phase 3 in this pass (new private bucket,
   signed URLs), or leave for later and let a test name its report for now?
3. **The nav still says "Test results"** while the page says "Tests". Rename
   the nav entry to **Tests**?

---

## 13. Built — what changed from this plan, and why

- **A corrected report SAYS it was corrected, whatever the caller sends.** The
  first build only defaulted the status when the patch carried none — so the
  form, which round-trips the status it loaded, kept "Completed" on a report
  whose value had just changed. Found driving the browser. The service now
  forces `corrected` whenever a finalised report changes, unless the caller
  explicitly asks for `amended` or `cancelled`.
- **"Nothing changed" is decided before the correction rules.** Re-saving a
  finalised report unchanged used to demand a reason for a change nobody made.
- **Recording a result is its own audit event**, even though it also moves the
  status: `TEST_RESULT_RECORDED` wins over `TEST_STATUS_CHANGED`, because
  that is what happened.
- **Picking from the catalogue only fills EMPTY result rows.** The guard meant
  to protect entered values also blocked the blank row the form starts with.
- **The trend takes the ranges from the result itself**, and refuses to mix
  units: an HbA1c in `%` and one in `mmol/mol` are not one line.
- **No attachments in this pass** (owner's decision): a test names its
  laboratory and report reference in `sourceName` until the private bucket
  exists.
