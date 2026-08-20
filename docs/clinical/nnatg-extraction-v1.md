# Clinical Knowledge Extraction — "Nigerian National Antimalaria Treatment guidelines"

**Status: DRAFT — NOT CLINICALLY VALIDATED — NOT ACTIVE — NOT PATIENT-FACING**

Extracted from `server/nigerian-national-antimalaria-treatment-guidelines.pdf`
(16 pages, ~5,900 characters). Every rule below cites the page it came from.
Nothing in this document has been supplemented from general medical knowledge.

---

## ⚠️ BLOCKING FINDING — READ BEFORE ANYTHING ELSE

**The supplied file is not a national treatment guideline. It is an
undated, unattributed 16-slide presentation deck.**

This is not a stylistic complaint. It fails the basic admissibility tests
that RxNaija's own evidence model requires, and the architecture built in
Stage 2 Part 2 exists specifically to refuse sources like this:

| Requirement (`evidence_sources`) | This document |
|---|---|
| Issuing organization | **ABSENT** — no ministry, agency, or author named anywhere |
| Publication date | **ABSENT** |
| Version / edition | **ABSENT** |
| Document identifier | **ABSENT** |
| Section numbering | **ABSENT** — slides only, no citable sections |
| References / bibliography | **ABSENT** |
| Review or approval record | **ABSENT** |

**Drug names are misspelled throughout**, including in dosing content:
"Artemisimin", "Artemethor", "Artemeter", "artemethe" (four spellings of
artemether), "Qinine", "amodiaquinne", "parasitemine", "parastemine".
A controlled clinical source does not misspell the medicines it doses.

**Recommended classification:** `strength: unverified`, `status: draft`.
It must not be classified as `authoritative_guideline` or
`nigerian_guidance` on the strength of its filename.

**Recommended action:** obtain the actual FMoH/NMEP *National Guidelines for
Diagnosis and Treatment of Malaria* (a ~100+ page document with edition,
date and ISBN) and re-run this extraction against it. The extraction below
is preserved as a structural exercise and as a record of what this file
does and does not contain — **not** as a usable clinical knowledge base.

---

## A. DOCUMENT METADATA

| Field | Value |
|---|---|
| Title (cover, p1) | "Nigerian National Antimalaria Treatment guidelines" |
| Issuing organization | **UNKNOWN** |
| Country | Nigeria (from title and p3 "In Nigeria P. Falciparum causes 98%") |
| Publication date | **UNKNOWN** |
| Version | **UNKNOWN** |
| Edition | **UNKNOWN** |
| Document identifier | **UNKNOWN** |
| Stated purpose (p2) | "To provide guidelines for the treatment of malaria in **Pregnant women** in Nigeria" |
| Actual population covered | General — incl. paediatric weight bands from 5kg (p7). **Conflicts with stated purpose — see N/CONFLICT-001** |
| Healthcare setting | **NOT_SPECIFIED** — IV/IM therapy implies inpatient, never stated |
| Source location | `server/nigerian-national-antimalaria-treatment-guidelines.pdf` |
| Page count | 16 |

---

## B. CLINICAL TOPICS PRESENT

| Topic | Page | Key content | Status |
|---|---|---|---|
| Malaria definition & species | 3 | 4 Plasmodium spp.; P. falciparum = 98% of Nigerian cases | Guideline-supported |
| Transmission | 3 | Anopheles mosquito; blood transfusion; mother-to-child in utero | Guideline-supported |
| Definitions (uncomplicated / severe) | 4 | See §C | Guideline-supported |
| Disease classification / diagnosis | 5 | History, signs, clinical + lab diagnosis | Guideline-supported |
| Uncomplicated malaria treatment | 6–7 | ACT; AL dosing chart; alternatives | Guideline-supported |
| Follow-up | 8 | Return criteria; actions on return | Guideline-supported |
| Severe malaria definition | 9 | 12 listed features | Guideline-supported |
| Severe malaria treatment | 10–14 | Quinine IV/IM; artesunate; artemether | Guideline-supported |
| Severe malaria algorithm | 15 | Decision flow on oral intake | Guideline-supported |

**Topics ABSENT** (do not assume coverage): prevention/IPTp, malaria in
pregnancy treatment, treatment failure definition, contraindications,
adverse effects, drug interactions, special populations beyond weight bands,
prophylaxis, resistance monitoring, referral criteria beyond p8.

---

## C. CLINICAL DEFINITIONS

| Concept | Definition (verbatim meaning preserved) | Page |
|---|---|---|
| Malaria | "An infectious disease caused by plasmodium" — P. falciparum, P. vivax, P. ovale, P. malariae | 3 |
| Uncomplicated malaria | "Fever, no life threatening manifestations" | 4 |
| Severe malaria | "Fever, presence of P. Falciparium asexual parasitemia – no other cause of observed symptoms and presence of life threatening clinical or laboratory features" | 4 |
| Severe malaria (operational) | Asexual parasitaemia + fever + no other cause + ≥1 of the 12 features in §D | 9 |
| Suspected malaria | **NOT_SPECIFIED** — no definition given |
| Confirmed malaria | **NOT_SPECIFIED** — no explicit confirmation rule |
| Treatment failure | **NOT_SPECIFIED** — p8 gives a return trigger, not a failure definition |

---

## D. RED FLAGS (severe malaria features)

All twelve from **page 9**. Source: same document, page 9, "Assessment and
management of severe malaria".

| ID | Feature (as written) | Severity | Action |
|---|---|---|---|
| MAL_RF_001 | Prostration | severe | URGENT_REFERRAL |
| MAL_RF_002 | Impaired consciousness | severe | URGENT_REFERRAL |
| MAL_RF_003 | Respiratory distress | severe | URGENT_REFERRAL |
| MAL_RF_004 | Multiple convulsions | severe | URGENT_REFERRAL |
| MAL_RF_005 | Severe anaemia | severe | URGENT_REFERRAL |
| MAL_RF_006 | Circulatory collapse (shock) | severe | URGENT_REFERRAL |
| MAL_RF_007 | Pulmonary oedema | severe | URGENT_REFERRAL |
| MAL_RF_008 | Abnormal bleeding | severe | URGENT_REFERRAL |
| MAL_RF_009 | Jaundice | severe | URGENT_REFERRAL |
| MAL_RF_010 | Haemoglobinuria | severe | URGENT_REFERRAL |
| MAL_RF_011 | Hyperparasitaemia ("Hyper parastemine") | severe | URGENT_REFERRAL |
| MAL_RF_012 | Renal failure | severe | URGENT_REFERRAL |

**Critical gaps — no thresholds are given:**
- MAL_RF_005 "Severe anaemia" — **no Hb/PCV value specified**
- MAL_RF_011 "Hyperparasitaemia" — **no parasite % specified**
- MAL_RF_004 "Multiple convulsions" — **no count/timeframe specified**

These three are **NOT MACHINE-EVALUABLE** as written. They require a
clinician-supplied threshold before they can become executable rules.

**Additional escalation trigger (p8):** "Immediately if conditions gets
worse or develops signs of severe malaria."

---

## E. SEVERITY CLASSIFICATION

Two classes only, per pages 4 and 9:

1. **Uncomplicated** — fever, no life-threatening manifestations
2. **Severe** — parasitaemia + fever + no other cause + ≥1 feature from §D

No intermediate/moderate class. No risk stratification by age, pregnancy
or comorbidity is provided.

---

## F. TREATMENT PATHWAYS

### F1 — Uncomplicated malaria (p6–7)

**Objectives (p6):** cure the malaria; prevent further transmission;
prevent resistance to drugs.

**Principle (p6):** ACT — "Artemisinin derivative and another effective
antimalarial drug." First-line named for Nigeria: **Artemether–Lumefantrine**.

**Explicit prohibition (p7):** "Mono therapy is not recommended."

### F2 — Severe malaria (p10–15)

**Objectives (p10):** save life; prevent recrudescence; avoid minor adverse
side effects.

**Drug of choice (p10):** "Parenteral quinine or artemisinin derivative."

**Algorithm (p15):**
```
Impaired consciousness
        ↓
IV/IM Quinine OR IM Artemether OR IV Artesunate + other supportive care
        ↓
Is oral drug intake possible?
   NO → Complete treatment with ACT or oral quinine once oral intake begins
   YES → Give ACT and treat complications
```

---

## G. MEDICATION RULES

### G1 — Artemether–Lumefantrine (first line, uncomplicated) — p7

| Weight (Age) | Dose |
|---|---|
| 5–14 kg (6 months – 3 yrs) | 1 tab twice daily × 3 days |
| 15–24 kg (4–8 yrs) | 2 tabs twice daily × 3 days |
| 25–34 kg (9–14 yrs) | 3 tabs twice daily × 3 days |
| > 35 kg (> 14 yrs) | 4 tabs twice daily × 3 days |

> ⚠️ **TABLET STRENGTH IS `NOT_SPECIFIED_IN_SOURCE`.** The chart gives tablet
> *counts* with no mg content. A dose in "tablets" is not executable without
> the strength, and it must not be inferred. **BLOCKS all AL rules.**
>
> ⚠️ **< 5 kg / < 6 months is NOT COVERED.** No guidance for neonates/small
> infants. `INSUFFICIENT_SOURCE_INFORMATION`.

### G2 — Alternatives, uncomplicated (p7)

| Regimen | Dose |
|---|---|
| Artesunate + amodiaquine | Artesunate 4 mg/kg + amodiaquine 10 mg base/kg daily × 3 days |
| Artesunate + mefloquine | Artesunate 4 mg/kg once daily × 3 days + mefloquine 25 mg base/kg (15 mg/kg day 2, 10 mg/kg day 3) |

### G3 — Quinine dihydrochloride, IV (severe) — p11–12

- Loading: **20 mg/kg of salt, max 1.2 g**, diluted in 10 ml/kg isotonic fluid, IV infusion over 4 hrs
- 8 hrs later: "give **10mg** salt to a max of **600mg**" over 4 hrs, every 8 hrs, until oral intake possible
  > ⚠️ **AMBIGUOUS** — written as "10mg", not "10mg/kg". Given the max of
  > 600mg and the later oral "10mg/kg", this is *probably* a typo for
  > mg/kg — **but that is an inference and is NOT resolved here.**
  > See N/CONFLICT-002. **BLOCKS this rule.**
- Then: tablets 10 mg/kg, 8-hourly, to complete **7 days total**; OR full dose artemether–lumefantrine
- **If IV quinine required > 48 hrs:** reduce dose to 5–7 mg/kg to avoid toxicity (e.g. reduce frequency to every 12 hrs) — p12
- **Do NOT use loading dose if quinine given in previous 24 hrs** — p12

### G4 — Quinine dihydrochloride, IM (severe) — p13

- Loading: 20 mg/kg salt, diluted to 60–100 mg/ml, IM in divided sites
- 8 hrs after loading: 10 mg/kg 8-hourly until oral intake starts
- Then: quinine tablets 10 mg/kg 8-hourly to complete 7 days; OR full dose artemether–lumefantrine
- **Administration:** "Give sterile IM injections into the anterior thigh. **DO NOT GIVE AT BUTTOCK.**"

### G5 — Artesunate (severe) — p14

- 2.4 mg/kg IV bolus; repeat 1.2 mg/kg after 12 hrs
- Then 1.2 mg/kg daily × 6 days
- If oral possible: full dose artemether–lumefantrine

### G6 — Artemether (severe) — p14

- 3.2 mg/kg loading; then 1.6 mg/kg daily × 6 days
- Once orally capable: full dose artemether–lumefantrine

### G7 — Universally absent for every drug above

`NOT_SPECIFIED_IN_SOURCE` for all of: contraindications, precautions,
adverse effects, drug interactions, maximum cumulative dose, renal/hepatic
adjustment, pregnancy restrictions, age restrictions beyond the weight
chart, formulation, brand/quality standard.

---

## H. ADULT RULES

- Uncomplicated: AL, > 35 kg (> 14 yrs) → 4 tabs twice daily × 3 days (p7) — **blocked by missing tablet strength**
- Severe: §G3–G6 apply; no adult-specific variation is stated
- No adult-specific contraindications given

---

## I. PAEDIATRIC RULES

- Weight bands from 5 kg / 6 months (p7) — see G1
- **< 5 kg or < 6 months: `INSUFFICIENT_SOURCE_INFORMATION`**
- Severe malaria doses (§G3–G6) are given as mg/kg with **no stated paediatric
  ceiling other than the adult maxima** — whether the 1.2 g / 600 mg quinine
  caps apply to children is **NOT_SPECIFIED**
- No neonatal guidance
- **Do not extrapolate adult rules to children.**

---

## J. PREGNANCY RULES

> **`INSUFFICIENT_SOURCE_INFORMATION` — and this is the document's most
> serious internal failure.**

The document's stated purpose (p2) is *"treatment of malaria in Pregnant
women in Nigeria."* It then provides **no pregnancy-specific treatment
guidance whatsoever**:

- No trimester-specific drug selection
- No drugs identified as safe or contraindicated in pregnancy
- No IPTp / sulfadoxine-pyrimethamine content
- No pregnancy-specific dosing
- No pregnancy-specific red flags
- No obstetric referral criteria

The **only** pregnancy reference in the entire document is a diagnostic
sign: *"Pallor especially in pregnant women"* (p5).

**No pregnancy treatment rule may be derived from this document.**
Any pregnancy-related malaria query must route to `URGENT_REFERRAL` or
`PHARMACIST_REVIEW`.

---

## K. REFERRAL / ESCALATION RULES

| ID | Trigger | Action | Priority | Page |
|---|---|---|---|---|
| MAL_ESC_001 | Any severe-malaria feature (§D) | URGENT_REFERRAL | urgent | 9 |
| MAL_ESC_002 | Condition worsens, or develops signs of severe malaria | URGENT_REFERRAL — "Immediately" | urgent | 8 |
| MAL_ESC_003 | Fever persists 2 days after starting treatment | Patient to return; repeat blood smear; reassess for other diseases | medium | 8 |
| MAL_ESC_004 | Impaired consciousness | Parenteral therapy + supportive care | urgent | 15 |
| MAL_ESC_005 | Oral intake not possible | Parenteral route | urgent | 15 |
| MAL_ESC_006 | Pregnancy + malaria | **PHARMACIST_REVIEW** (derived from absence of guidance, §J) | high | — |

> MAL_ESC_006 is the one rule here **not** taken from the document's text.
> It is derived from the document's *silence*, and is marked as such. It
> escalates rather than recommends, so it cannot produce treatment advice.

**On patient return (p8):** check treatment compliance; repeat blood smear;
complete assessment to exclude other possible diseases.

---

## L. CONTRAINDICATIONS / EXCLUSIONS

| Item | Status |
|---|---|
| Monotherapy | **PROHIBITED** — "Mono therapy is not recommended" (p7) |
| Quinine loading dose if quinine given in previous 24 hrs | **PROHIBITED** (p12) |
| IM injection at buttock | **PROHIBITED** — "DO NOT GIVE AT BUTTOCK" (p13) |
| All drug contraindications | **NOT_SPECIFIED_IN_SOURCE** |
| Allergy/hypersensitivity | **NOT_SPECIFIED_IN_SOURCE** |
| G6PD deficiency | **NOT_SPECIFIED_IN_SOURCE** |
| Renal/hepatic impairment | **NOT_SPECIFIED_IN_SOURCE** (beyond quinine >48h toxicity note) |
| Pregnancy/breastfeeding | **NOT_SPECIFIED_IN_SOURCE** |

---

## M. UNKNOWN / NOT-SPECIFIED ITEMS

**Blocking (prevent any medication recommendation):**
1. AL tablet strength — G1
2. Quinine maintenance "10mg" vs "10mg/kg" — G3
3. Severe anaemia threshold — MAL_RF_005
4. Hyperparasitaemia threshold — MAL_RF_011
5. "Multiple convulsions" count — MAL_RF_004
6. All contraindications — §L
7. Pregnancy treatment — §J
8. < 5 kg / < 6 months dosing — §I

**Non-blocking but absent:** document date, version, issuer; confirmed vs
suspected malaria definitions; treatment failure definition; when to use RDT
vs microscopy; action when testing unavailable; adverse effects;
interactions; prevention/prophylaxis; follow-up beyond p8.

---

## N. CONFLICTS REQUIRING REVIEW

### CONFLICT-001 — Scope contradiction
- **Location A:** p2 — "Purpose: To provide guidelines for the treatment of malaria in **Pregnant women** in Nigeria"
- **Location B:** p7 — paediatric weight bands from **5 kg (6 months)**
- **Description:** The document declares a pregnancy scope, then delivers general/paediatric content and zero pregnancy treatment guidance.
- **Possible resolution:** the deck is likely a general malaria talk with a mislabelled purpose slide, OR pregnancy slides are missing.
- **STATUS: REQUIRES_REVIEW**

### CONFLICT-002 — Quinine maintenance dose units
- **Location A:** p11 — "give **10mg** salt to a max of 600mg"
- **Location B:** p11 (same slide) — "tablets **10mg/kg**, 8 hourly"; p13 — "**10mg/kg** 8 hourly"
- **Description:** IV maintenance is written without `/kg` while every comparable dose includes it. A 10 mg fixed dose is not plausible against a 600 mg cap, but the correction is not stated.
- **Possible resolution:** likely typo for 10 mg/kg — **must be confirmed against the authoritative source, not assumed.**
- **STATUS: REQUIRES_REVIEW**

### CONFLICT-003 — Drug name spelling instability
- **Location A:** p6 "Artemethor"; p11 "artemethe"; p13 "Artemeter"; p14 "Artemether"
- **Location B:** p6 "Artemisimin"; p14 "Arthemisinin"; p11 "Qinine"; p7 "amodiaquinne"
- **Description:** Medicines are spelled inconsistently, including within dosing instructions.
- **Possible resolution:** transcription errors; confirms this is not a controlled published document.
- **STATUS: REQUIRES_REVIEW**

### CONFLICT-004 — Severe malaria first-line ambiguity
- **Location A:** p10 — "Drug of choice: Parenteral quinine **or** artemisinin derivative" (equal weighting)
- **Location B:** p14 header — "Arthemisinin derivatives in severe malaria **alternative to quinine**" (quinine primary)
- **Description:** Co-equal on one slide, second-line on another.
- **STATUS: REQUIRES_REVIEW**

---

## O. CANDIDATE PROTOCOL

`nigeria_malaria_assessment` **v1.0.0** — **status: DRAFT (must not be activated)**

- **Target population:** persons ≥ 6 months / ≥ 5 kg presenting with fever. Pregnancy → escalate (§J). < 6 months → out of scope.
- **Presenting complaints:** fever; chills; unexplained pallor (p5)
- **Required clinical facts:** age, weight, residence, travel history, fever presence, fever duration, chills, pregnancy status, body temperature, severe-malaria feature screen, parasitological test result (p5, p9)
- **Diagnostic requirement:** clinical (fever, unexplained pallor) + laboratory (microscopy or RDT), p5
- **Red flags:** the 12 features in §D — three not machine-evaluable
- **Escalation rules:** §K
- **Treatment eligibility rules:** **NONE ELIGIBLE.** Every medication rule is blocked by §M items 1–8.
- **Recommendation boundaries:** `PATIENT_INFORMATION`, `CLINICAL_ASSESSMENT`, `PHARMACIST_REVIEW`, `URGENT_REFERRAL` only. **No `MEDICATION_RECOMMENDATION` may be enabled from this source.**
- **Evidence reference:** this document — `strength: unverified`, `status: draft`

### §10 classification of every extractable recommendation

| Content | Classification | Patient-facing? |
|---|---|---|
| Malaria definition, species, transmission (p3) | PATIENT_INFORMATION | Possible after review |
| Diagnosis requires microscopy or RDT (p5) | CLINICAL_ASSESSMENT | Possible after review |
| Severe malaria features (p9) | URGENT_REFERRAL | Yes — as escalation trigger |
| Return if fever persists 2 days (p8) | SELF_CARE_GUIDANCE | Possible after review |
| Return immediately if worse (p8) | URGENT_REFERRAL | Yes |
| Monotherapy not recommended (p7) | NOT_PATIENT_FACING | No — prescriber-directed |
| All AL / artesunate / quinine / artemether dosing | MEDICATION_RECOMMENDATION | **NO — BLOCKED** |
| All parenteral regimens (p11–14) | NOT_PATIENT_FACING | **No — inpatient prescriber content** |

---

## P. CLINICAL REVIEW CHECKLIST

For a qualified pharmacist/clinical reviewer. Each item must be signed off
before any part of this protocol may be activated.

- [ ] **1. Replace the source.** Confirm whether the authoritative FMoH/NMEP national guideline should be used instead of this deck. *(Recommended: yes.)*
- [ ] **2. Document provenance.** Establish issuer, date, edition — or reject the source.
- [ ] **3. CONFLICT-001** — resolve the pregnancy-scope contradiction.
- [ ] **4. CONFLICT-002** — confirm quinine IV maintenance units (10 mg vs 10 mg/kg).
- [ ] **5. CONFLICT-004** — confirm severe malaria first-line drug.
- [ ] **6. AL tablet strength** — supply, or keep all AL rules blocked.
- [ ] **7. Severe anaemia threshold** — supply Hb/PCV value or keep MAL_RF_005 non-evaluable.
- [ ] **8. Hyperparasitaemia threshold** — supply % or keep MAL_RF_011 non-evaluable.
- [ ] **9. "Multiple convulsions"** — define count/timeframe.
- [ ] **10. Paediatric < 5 kg / < 6 months** — supply guidance or keep out of scope.
- [ ] **11. Contraindications** — supply from authoritative source; none exist here.
- [ ] **12. Pregnancy pathway** — supply, or confirm MAL_ESC_006 (escalate-always) is acceptable.
- [ ] **13. Confirm** no `MEDICATION_RECOMMENDATION` is enabled from this source.
- [ ] **14. Confirm** parenteral content is never patient-facing.
- [ ] **15. Confirm** red flags map to `urgent` priority in the safety gate.
- [ ] **16. Sign-off** on evidence strength classification (`unverified` recommended).

---

## Q. SOURCE TRACEABILITY

Every rule ID above resolves to:

| Field | Value |
|---|---|
| SOURCE | "Nigerian National Antimalaria Treatment guidelines" (title as printed, p1) |
| VERSION | **UNKNOWN** — none stated |
| SECTION | Slide titles only; no section numbering exists |
| PAGE | Cited per rule above |
| SOURCE_TEXT_REFERENCE | `server/nigerian-national-antimalaria-treatment-guidelines.pdf`, page N |
| EVIDENCE_STATUS | `unverified` — pending §P review |

**Rules with no source reference: none.** The single rule derived from the
document's silence rather than its text (MAL_ESC_006) is explicitly marked
in §K and escalates rather than recommends.

---

## Other files present (NOT ingested)

`server/` also contains `WHO standard guide malaria treatment.pdf` and
`nigeria treatment of malaria by who r.pdf`. Per the stop condition, neither
was opened or extracted. They may be better candidate sources than the deck
above, but that is a decision for §P item 1.
