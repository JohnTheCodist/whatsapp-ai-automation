# Consolidated Malaria Extraction v2 — Nigeria STG 2022 · NEML 2024 · WHO 2025 · WHO 2015

**Status: DRAFT — NOT CLINICALLY VALIDATED — NOT ACTIVE — NOT PATIENT-FACING**

Supersedes `nnatg-extraction-v1.md` and `neml-who-extraction-v1.md` as the
authoritative working extraction. Every rule cites a verified page.

---

## A. SOURCE REGISTER

| # | Document | Origin | Strength | Status |
|---|---|---|---|---|
| **S1** | **Nigeria Standard Treatment Guidelines, 2022** (411 pp) | `nigerian_guidance` | `authoritative_guideline` | ✅ **PRIMARY for Nigeria** |
| **S2** | Nigeria Essential Medicines List for Adults, 8th Ed 2024, FMoH&SW | `nigerian_guidance` | `authoritative_guideline` | ✅ Formulary — strengths only |
| **S3** | **WHO Guidelines for Malaria, 13 Aug 2025** (478 pp, DOI 10.2471/B09514) | `global_guidance` | `authoritative_guideline` | ✅ **CURRENT WHO** |
| **S4** | WHO Guidelines for Treatment of Malaria, 3rd Ed 2015 (ISBN 978 92 4 154912 7) | `global_guidance` | `authoritative_guideline` | ⛔ **SUPERSEDED by S3** |
| **S5** | "Nigerian National Antimalaria Treatment guidelines" slide deck | UNKNOWN | `unverified` | ⛔ **INADMISSIBLE** |

**Precedence:** S1 > S2 > S3 > S4. S5 excluded entirely.
S4 is retained only to document what changed; **no rule may cite S4 alone.**

---

## B. THE CENTRAL QUESTION — NOW ANSWERED

**Nigeria's first-line ACT is Artemether–Lumefantrine.** (S1, printed p244)

> *"Artemisinin-based Combination Therapy (ACTs) are the current recommended
> treatments for uncomplicated malaria globally. ACTs are the recommended
> treatment of uncomplicated malaria **in all trimesters of pregnancy**.
> **Artemether-Lumefantrine (AL) is the medicine of choice** while
> Artesunate-Amodiaquine (AA), Dihydroartemisinin Piperaquine and
> Artesunate-Pyronaridine are alternatives."*

`CONFLICT-005` — **RESOLVED.** The slide deck's claim was correct, but it is
now sourced from an admissible document instead of an unattributed deck.

---

## C. DIAGNOSTIC RULES (S1, printed p243–244)

| ID | Rule | Cite |
|---|---|---|
| MAL_DX_001 | "All patients suspected of malaria should have prompt parasitological confirmation by microscopy or RDTs **before treatment**" | S1 p244 |
| MAL_DX_002 | "Clinical diagnosis alone is presumptive, gives room for over-diagnosis" | S1 p243 |
| MAL_DX_003 | "Confirmatory diagnosis is based on the detection of parasites in the blood" | S1 p243 |
| MAL_DX_004 | "Light microscopy remains the gold standard" | S1 p243 |
| MAL_DX_005 | **"Microscopic diagnosis should not delay appropriate treatment if there is a clinical suspicion of severe malaria"** | S1 p243 |
| MAL_DX_006 | "Rapid Diagnostic Test is used in Primary Health Care levels" | S1 p243 |

**Differential diagnoses (S1 p243):** typhoid fever, meningitis, encephalitis,
septicaemia, other causes of fever.

**Investigations (S1 p244):** blood smear; PCV/Hb; WCC + differentials; blood
sugar; urinalysis; electrolytes/urea/creatinine; stool microscopy (ova, occult
blood); chest radiograph; CSF biochemistry/microscopy/culture/sensitivity.

---

## D. SEVERE MALARIA — DEFINITION WITH THRESHOLDS (S1, printed p242)

> *"Is a medical emergency requiring prompt attention."*

### D1 — Clinical criteria

| ID | Feature | Threshold |
|---|---|---|
| MAL_RF_001 | Prostration | — |
| MAL_RF_002 | Impaired consciousness or unrousable coma | — |
| MAL_RF_003 | Failure to feed | — |
| MAL_RF_004 | Respiratory distress | — |
| MAL_RF_005 | **Multiple convulsions** | **> 2 episodes in 24 hours** ✅ |
| MAL_RF_006 | Circulatory collapse (algid malaria) | — |
| MAL_RF_007 | Pulmonary oedema | radiological |
| MAL_RF_008 | Abnormal bleeding / DIC | — |
| MAL_RF_009 | Jaundice | — |

### D2 — Laboratory criteria

| ID | Feature | Threshold |
|---|---|---|
| MAL_RF_010 | Severe anaemia | ⚠️ see CONFLICT-009 |
| MAL_RF_011 | Hypoglycaemia | **blood glucose < 2.2 mmol/L** ✅ |
| MAL_RF_012 | Acidosis | **HCO₃ < 15 mmol/L** ✅ |
| MAL_RF_013 | Haemoglobinuria (blackwater fever) | — |
| MAL_RF_014 | Renal impairment | **creatinine > 265 µmol/L** ✅ |
| MAL_RF_015 | Hyperlactataemia | **> 5 mmol/L** ✅ |
| MAL_RF_016 | **Hyperparasitaemia** | **> 5% or 250,000/µL** ✅ |

### D3 — Cerebral malaria (S1 p243)

Coma persisting **> 30 min after a seizure**. Usually children and non-immune
adults. Diffuse symmetric encephalopathy; focal neurologic signs unusual.

### D4 — Poor-prognosis indicators (S1 p242, distinct from D1/D2)

Marked agitation · hyperventilation · hypothermia (<36.5°C) · deep coma ·
repeated convulsions · bleeding · anuria · haemodynamic shock ·
hyperparasitaemia >100,000/µL (~2% cells) · >20% late-stage parasites ·
>5% neutrophils with visible pigment · bilirubin >50 µmol/L ·
leukocytosis >12,000/µL · platelets <50,000/µL · prolonged PT ·
decreased fibrinogen · coagulopathy

---

## E. TREATMENT — UNCOMPLICATED (S1 printed p244–245)

### E1 — Artemether–Lumefantrine (medicine of choice), Table 10:7

| Weight | 20/120 mg tab | 40/240 mg tab | 80/480 mg tab |
|---|---|---|---|
| 5 – <15 kg | 1 tab BD × 3 days | NA | NA |
| 15 – <25 kg | 2 tabs BD × 3 days | 1 tab BD × 3 days | NA |
| 25 – <35 kg | 3 tabs BD × 3 days | NA | NA |
| > 35 kg | 4 tabs BD × 3 days | 2 tabs BD × 3 days | 1 tab BD × 3 days |

**Cross-check:** milligram-equivalent to WHO S4 dosing (5–<15 kg = 20+120 mg;
15–<25 kg = 40+240; 25–<35 kg = 60+360; ≥35 kg = 80+480). **Independent
sources agree.** Strengths corroborated by NEML S2 §5.7.1.

### E2 — Artesunate–Amodiaquine (alternative), Table 10.8

| Weight / Age | Strength | Regimen |
|---|---|---|
| 4.5 – <9 kg (2–11 months) | 25/67.5 mg | 1 tab once daily × 3 days |
| 9 – <18 kg (1–5 years) | 50/135 mg | 1 tab once daily × 3 days |
| 18 – <36 kg (6–13 years) | 100/270 mg | 1 tab once daily × 3 days |
| ≥36 kg / ≥14 years | 100/270 mg | 2 tabs once daily × 3 days |

### E3 — Other listed ACTs (S1 p245)

Artesunate–Mefloquine · Dihydroartemisinin–Piperaquine · Artemisinin–Piperaquine

### E4 — Infants < 5 kg ✅ **GAP RESOLVED**

> *"Treat infants less than 5 kg with ACTs **under supervision by the health
> care provider**."* (S1 p245)

Supervision is part of the rule — not a general-public recommendation.

---

## F. TREATMENT — SEVERE (S1 printed p245–246)

### F1 — Pre-referral treatment

> *"As soon as a presumptive diagnosis of severe malaria is made, recommended
> pre-referral treatment options include any of these; rectal Artesunate,
> Artesunate IM, Artemether IM or Quinine IM, **in the order of preference**."*

| Route | Dose |
|---|---|
| IM Artesunate | 3 mg/kg (children <6 yrs or <20 kg); 2.4 mg/kg (older children and adults) |
| Rectal Artesunate | 10 mg/kg single dose |
| IM Artemether | 3.2 mg/kg |
| IM Quinine | 10 mg/kg |

### F2 — Definitive treatment

**Parenteral artesunate is the drug of choice; start without delay.**

| Population | Regimen |
|---|---|
| Adults & children **> 20 kg** | Artesunate **2.4 mg/kg** IV/IM at 0 h, 12 h, 24 h, then once daily. **No upper limit to total artesunate dose.** |
| Children **< 20 kg** | Artesunate **3 mg/kg** IV/IM at 0 h, 12 h, 24 h, then once daily |

**Alternatives if artesunate unavailable:**
- Artemether **3.2 mg/kg** IM on admission, then **1.6 mg/kg/day**
- Quinine **20 mg salt/kg** on admission (IV infusion or divided IM), then **10 mg/kg every 8 hours**; **infusion rate must not exceed 5 mg/kg/hr**

> ✅ **`CONFLICT-002` RESOLVED.** The slide deck's ambiguous "10mg" is
> confirmed as **10 mg/kg every 8 hours** by S1. The deck was a typo.

### F3 — Mandatory minimum duration

> *"Give parenteral antimalarials in the treatment of severe malaria for a
> **minimum of 24 hours** once started (**irrespective of the patient's ability
> to tolerate oral medications earlier**)."* (S1 p246)

### F4 — Follow-on

After ≥24 h parenteral and once oral tolerated: complete a **full 3-day ACT
course** (AL, AA, DHA-PPQ, or Pyronaridine-Artesunate) — *"irrespective of the
number of days for which patient was on parenteral artesunate."*

### F5 — Supportive measures (S1 p246)

Paracetamol (oral/rectal) · if temp >38.5 °C wipe with wet towel and fan ·
**pulmonary oedema:** cardiac position, oxygen, furosemide 2–4 mg/kg IV,
exclude anaemia as cause · **renal failure:** 20 ml/kg NaCl 0.9%, furosemide
1–2 mg/kg, catheterise, refer to nephrologist if no urine in 24 h ·
**profuse bleeding:** transfuse screened fresh whole blood, pre-referral
treatment, refer urgently · suspected meningitis not excludable by LP → give
antibiotics

### F6 — Explicitly NOT recommended

> **"High dose Corticosteroids and other anti-inflammatory agents"** (S1 p246)

---

## G. PREGNANCY ✅ **GAP RESOLVED**

| Source | Position |
|---|---|
| **S1 (Nigeria 2022)** | *"ACTs are the recommended treatment of uncomplicated malaria **in all trimesters of pregnancy**"* (p244) |
| **S3 (WHO 2025)** | *"Pregnant women with uncomplicated P. falciparum malaria should be treated with **artemether-lumefantrine during the first trimester**."* Strong recommendation, low certainty (§5.2.1.4.1, "Treatment in the first trimester (2022)") |
| **S4 (WHO 2015)** | 1st trimester **excluded** from ACTs — **SUPERSEDED** |

**WHO changed position in 2022.** S1 and S3 now agree that ACTs/AL may be used
in the first trimester. The earlier conflict was an artifact of S4.

### G1 — WHO 2025 first-trimester restrictions (S3, more specific than S1)

- **AL is the recommended first-trimester ACT.**
- Other ACTs (AA, AS-MQ, DHA-PPQ): *"evidence is insufficient to make a recommendation for routine use"* in 1st trimester — may be considered only where AL is unavailable
- **Antifolates are contraindicated in the first trimester → ACTs containing sulfadoxine-pyrimethamine are contraindicated**
- **"There is currently no documented record of the use of artesunate-pyronaridine during the first trimester"**
- Footnote: *"Artesunate + sulfadoxine-pyrimethamine and artesunate-pyronaridine are **not recommended** for use in the first trimester"*

> ⚠️ See **CONFLICT-011** — S1's blanket "ACTs in all trimesters" is broader
> than S3's restrictions, and S1 lists Artesunate-Pyronaridine as an
> alternative.

---

## H. CONFLICTS REQUIRING REVIEW

### CONFLICT-009 — Severe anaemia threshold sign is inverted ⚠️ **SAFETY-CRITICAL**
- **Location:** S1 p242, poor-prognosis list — *"Severe anaemia (PCV **>** 15%)"*
- **Problem:** severe anaemia is a **LOW** packed cell volume. As written, "PCV > 15%" would classify almost every patient as severely anaemic and invert the rule.
- **Assessment:** near-certainly a typo for **PCV < 15%**. **NOT corrected here** — a threshold used to trigger emergency referral must be confirmed, not inferred.
- **Effect:** MAL_RF_010 is **NOT MACHINE-EVALUABLE**. **STATUS: REQUIRES_REVIEW**

### CONFLICT-010 — Acidosis criteria contradict between two lists in the same document
- **A:** S1 p242 severe criteria — *"Acidosis (HCO₃ **< 15** mmol/L)"*
- **B:** S1 p242 poor-prognosis — *"Acidosis (arterial PH **> 7.3**, serum HCO₃ **> 15** mmol/L)"*
- **Problem:** B is internally inconsistent with A and with acidosis itself (acidosis is pH **<** 7.35, HCO₃ **<** 15).
- **Assessment:** signs inverted in B. **STATUS: REQUIRES_REVIEW**

### CONFLICT-011 — First-trimester ACT scope: Nigeria broader than WHO
- **A:** S1 p244 — ACTs recommended in **all** trimesters, with AS-Pyronaridine listed as an alternative
- **B:** S3 §5.2.1.4.1 — AS-pyronaridine **not recommended** in 1st trimester ("no documented record"); AS-SP **contraindicated** (antifolate)
- **Risk:** following S1 literally could give a first-trimester patient an agent S3 excludes.
- **Resolution:** in 1st trimester, apply the **more restrictive** rule (AL only). **STATUS: REQUIRES_REVIEW**

### CONFLICT-012 — NEML lists an ACT the STG does not rank, and vice versa
- **A:** S2 §5.7.1 lists Artesunate + Pyronaridine (60+180 mg) and DHA+Piperaquine
- **B:** S1 ranks AL first, then AA / DHA-PPQ / AS-Pyronaridine as alternatives; also names Artemisinin-Piperaquine (p245) which is **absent from NEML**
- **STATUS: REQUIRES_REVIEW**

### CONFLICT-013 — AL 25–<35 kg band has no higher-strength equivalent
- **A:** S1 Table 10:7 — 25–<35 kg = 3 tabs of 20/120 only; 40/240 and 80/480 marked NA
- **Observation:** 3 × 20/120 = 60/360, which is not divisible into whole 40/240 tablets — the NA is arithmetically coherent, not an omission.
- **STATUS: REQUIRES_REVIEW** (confirm intent only)

---

## I. GAP STATUS — ALL PRIOR BLOCKERS

| # | Gap (from v1 extraction) | Status |
|---|---|---|
| 1 | AL tablet strength | ✅ **RESOLVED** — S1 Table 10:7, S2 §5.7.1, S4 |
| 2 | Quinine "10mg" vs "10mg/kg" | ✅ **RESOLVED** — S1 p246: 10 mg/kg q8h, infusion ≤5 mg/kg/hr |
| 3 | Severe anaemia threshold | ⚠️ **BLOCKED** — CONFLICT-009 (sign inverted) |
| 4 | Hyperparasitaemia threshold | ✅ **RESOLVED** — S1 p242: >5% or 250,000/µL |
| 5 | Multiple convulsions count | ✅ **RESOLVED** — S1 p242: >2 episodes / 24 h |
| 6 | Contraindications | 🟡 **PARTIAL** — corticosteroids (S1), antifolates 1st trimester (S3), doxycycline/quinine-only (S2). No comprehensive list |
| 7 | Pregnancy treatment | ✅ **RESOLVED** — S1 all trimesters; S3 AL in 1st trimester (see CONFLICT-011) |
| 8 | < 5 kg / < 6 months | ✅ **RESOLVED** — S1 p245: ACTs under health-care-provider supervision |
| — | Nigeria's first-line ACT | ✅ **RESOLVED** — AL (S1 p244) |
| — | Superseded WHO edition | ✅ **RESOLVED** — S3 obtained |

**Two blockers remain: CONFLICT-009 and CONFLICT-011.**

---

## J. RECOMMENDATION CLASSIFICATION (Part 2 §10)

| Content | Class | Patient-facing? |
|---|---|---|
| Parasitological confirmation required before treatment | CLINICAL_ASSESSMENT | After review |
| Severe malaria features (D1/D2) | URGENT_REFERRAL | ✅ as escalation trigger |
| Cerebral malaria (coma >30 min post-seizure) | URGENT_REFERRAL | ✅ |
| "Medical emergency requiring prompt attention" | URGENT_REFERRAL | ✅ |
| AL / AA dosing tables | MEDICATION_RECOMMENDATION | ⛔ **gate-controlled, not enabled** |
| All parenteral regimens (F1–F2) | NOT_PATIENT_FACING | ⛔ prescriber/inpatient |
| Infants <5 kg — supervision required | PHARMACIST_REVIEW | ⛔ never autonomous |
| First trimester pregnancy | PHARMACIST_REVIEW | ⛔ until CONFLICT-011 closes |
| Supportive measures (F5) | NOT_PATIENT_FACING | ⛔ clinical setting |
| Corticosteroids not recommended | NOT_PATIENT_FACING | ⛔ prescriber-directed |

---

## K. CLINICAL REVIEW CHECKLIST

- [ ] **1.** ⚠️ **CONFLICT-009** — confirm severe anaemia PCV threshold (`<15%` presumed). **Blocks MAL_RF_010.**
- [ ] **2.** ⚠️ **CONFLICT-011** — confirm first-trimester policy; recommend AL-only (more restrictive of S1/S3).
- [ ] **3.** CONFLICT-010 — confirm acidosis criteria direction.
- [ ] **4.** CONFLICT-012 — confirm the approved ACT list reconciling STG and NEML.
- [ ] **5.** CONFLICT-013 — confirm AL 25–<35 kg NA entries are intended.
- [ ] **6.** Confirm S1 (STG 2022) is the current edition — no newer Nigerian STG exists.
- [ ] **7.** Obtain **paediatric NEML** (S2 is adults-only).
- [ ] **8.** Confirm S4 (WHO 2015) is marked superseded and cannot be cited alone.
- [ ] **9.** Confirm S5 (slide deck) is excluded from the evidence store entirely.
- [ ] **10.** Verify AL/AA dosing tables against printed S1 pp244–245 independently (extracted from a table; layout artifacts were corrected once already).
- [ ] **11.** Decide whether **any** MEDICATION_RECOMMENDATION may be autonomous, or whether all malaria dosing requires pharmacist release.
- [ ] **12.** Confirm severe-malaria red flags map to `urgent` priority in the safety gate.
- [ ] **13.** Confirm MAL_DX_001 (test before treat) is enforced before any treatment recommendation can be produced.

---

## L. RECOMMENDED EVIDENCE SOURCE RECORDS (draft — not created)

```
S1  nigeria_stg_2022          origin: nigerian_guidance   strength: authoritative_guideline  status: draft
S2  neml_adult_8th_2024       origin: nigerian_guidance   strength: authoritative_guideline  status: draft
S3  who_malaria_2025_08_13    origin: global_guidance     strength: authoritative_guideline  status: draft
S4  who_malaria_3rd_2015      origin: global_guidance     strength: authoritative_guideline  status: retired  ← superseded
S5  (slide deck)              — DO NOT INGEST —
```

**None approved. No recommendation enabled.**

---

## M. WHAT REMAINS NON-ACTIVATABLE

Despite four admissible documents and nearly all gaps closed, **no medication
recommendation may be enabled**, because:

1. CONFLICT-009 leaves an emergency-referral threshold inverted
2. CONFLICT-011 leaves first-trimester drug selection unsettled
3. No pharmacist has approved any source
4. MAL_DX_001 requires a parasitological test result the WhatsApp channel cannot obtain

Point 4 is structural and worth stating plainly: **S1 requires confirmed
parasitology before treatment.** A WhatsApp assistant cannot perform microscopy
or an RDT. Absent a test result, the correct output for every malaria query
remains **`CONTINUE_ASSESSMENT`**, **`PHARMACIST_REVIEW`**, or
**`URGENT_REFERRAL`** — never a treatment recommendation.
