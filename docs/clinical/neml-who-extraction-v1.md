# Clinical Knowledge Extraction — NEML 8th Ed (2024) + WHO Malaria Guidelines 3rd Ed (2015)

**Status: DRAFT — NOT CLINICALLY VALIDATED — NOT ACTIVE — NOT PATIENT-FACING**

Supersedes nothing; complements `nnatg-extraction-v1.md`. Every rule cites a
verified PDF page. Nothing supplemented from general medical knowledge.

---

## A. DOCUMENT METADATA

### A1 — Nigeria Essential Medicines List for Adults, 8th Edition

| Field | Value |
|---|---|
| Title | Nigeria Essential Medicines List for Adults |
| Edition | **8th Edition, 2024** |
| Issuer | **Federal Ministry of Health and Social Welfare, Nigeria** |
| Statutory basis | Decree 43 of 1989 → **Act CAP 252 LFN 2004**; Health Act 2014 |
| Authoring body | National Drug Formulary / Essential Drug List (NDF/EDL) Review Committee |
| Signed | Prof. John O. Ohaju-Obodo (Chairman), **January 2024**; Foreword: Prof. Muhammad Ali Pate, Coordinating Minister |
| Supersedes | 7th edition (2020) |
| Derived from | 3rd edition Nigeria Standard Treatment Guidelines; WHO updating procedure |
| **Population scope** | **ADULTS ONLY** — paediatric NEML is a separate document, **not supplied** |
| Pages | 105 |
| Classification | `origin: nigerian_guidance` · `strength: authoritative_guideline` · also `regulatory_source` |

**Admissible.** Meets every provenance requirement the slide deck failed.

### A2 — WHO Guidelines for the Treatment of Malaria, 3rd Edition

| Field | Value |
|---|---|
| Title | Guidelines for the Treatment of Malaria |
| Edition | **Third edition** |
| Issuer | **World Health Organization**, Global Malaria Programme |
| Date | **2015** |
| ISBN | **978 92 4 154912 7** (NLM: WC 770) |
| Pages | 305 |
| Classification | `origin: global_guidance` · `strength: authoritative_guideline` |

> ⚠️ **The filename is misleading.** `nigeria treatment of malaria by who r.pdf`
> contains **no Nigeria-specific content**. It is WHO's *global* guideline.
> Under the evidence hierarchy (Part 2 §10), it ranks **below** Nigerian
> guidance where the two overlap.
>
> ⚠️ **Superseded.** This is the 2015 3rd edition. WHO has since issued a 4th
> edition and the consolidated *WHO Guidelines for Malaria* (2021 onward,
> periodically updated). Treat as **historical** pending confirmation.

---

## B. THE CENTRAL FINDING — THE THREE DOCUMENTS DO DIFFERENT JOBS

| Document | Answers | Does NOT answer |
|---|---|---|
| **NEML 2024** (Nigerian, authoritative) | *Which* antimalarials are approved in Nigeria, and at *what strengths* | Any dose, regimen, or duration |
| **WHO 2015** (global, authoritative, superseded) | *How* to dose, with graded evidence | Which ACT **Nigeria** selects — explicitly a *menu* |
| **Slide deck** (inadmissible) | Claims Nigeria's first line is AL | — |

> **WHO §4.3.1, verbatim:** *"The guideline development group decided to
> recommend a menu of approved combinations, from which countries can select
> first- and second-line treatment."*

**Therefore: no admissible source in hand states Nigeria's first-line ACT.**
The slide deck asserts artemether–lumefantrine, but fails admissibility. NEML
lists seven treatment ACTs without ranking them. WHO deliberately declines to
choose for a country.

**Still required:** the NMEP/FMoH *National Guidelines for Diagnosis and
Treatment of Malaria* — the document that makes Nigeria's selection.

---

## C. NEML §5.7 — ANTIMALARIAL MEDICINES (PDF p18, printed p9)

### C1 — §5.7.1 Treatment

| Medicine | Formulation & strength (verbatim) |
|---|---|
| Artemether | Injection: 80 mg/mL in 1-mL ampoule |
| **Artemether + Lumefantrine** | **Tablet: 20 mg + 120 mg; 40 mg + 240 mg; 80 mg + 480 mg** |
| Artesunate | Powder for injection: 60 mg/mL in vial + 1 mL 5% sodium bicarbonate solvent |
| Artesunate + Amodiaquine | Tablet: 25 mg + 67.5 mg; 50 mg + 135 mg; 100 mg + 270 mg |
| Artesunate + Pyronaridine tetraphosphate | Tablet: 60 mg + 180 mg |
| Dihydroartemisinin + Piperaquine phosphate | Tablet: 20 mg + 160 mg; 40 mg + 320 mg |
| Doxycycline** | Capsule: 100 mg (hydrochloride or hyclate). ** **For use only in combination with quinine** |
| Quinine | Injection: 300 mg/mL (dihydrochloride) in 2-mL ampoule. Tablet: 300 mg (quinine sulfate) or 300 mg (quinine bisulfate) |

### C2 — §5.7.2 Prophylaxis (see restricted medicines list)

| Medicine | Strength |
|---|---|
| Proguanil | Tablet: 100 mg |
| Sulfadoxine + Pyrimethamine | Tablet: 500 mg + 25 mg |

### C3 — Notes

- **RESOLVES the deck's blocking gap:** AL tablet strengths are now established from an authoritative Nigerian source.
- NEML is a **formulary**. It contains **no doses, regimens, durations, or indications**. `NOT_SPECIFIED_IN_SOURCE` for all of those.
- **Doxycycline is restricted** to combination with quinine — an explicit constraint.
- Prophylaxis agents are on the **restricted** list.
- **OCR artifacts** in extraction: "S.7" for "5.7", "Prophylu:is" for "Prophylaxis". Drug names and strengths render cleanly; the artifacts are in headings only.

---

## D. WHO — DEFINITIONS

| Concept | Definition (verbatim) | Cite |
|---|---|---|
| Uncomplicated malaria | "A patient who presents with symptoms of malaria and a positive parasitological test (microscopy or RDT) but with no features of severe malaria" | §4.1, p34 |
| Cure | "elimination of all parasites from the body" | §4.2, p34 |

> **This resolves the deck's missing "confirmed malaria" definition.** WHO
> requires a **positive parasitological test** — clinical suspicion alone is
> not confirmation.

---

## E. WHO — GRADED TREATMENT RECOMMENDATIONS (uncomplicated P. falciparum)

| ID | Recommendation | Grade | Cite |
|---|---|---|---|
| WHO_R_001 | Treat children and adults with uncomplicated P. falciparum malaria **(except pregnant women in their first trimester)** with one of five ACTs | **Strong, high-quality evidence** | §4.3.1, p34–35 |
| WHO_R_002 | ACT regimens should provide **3 days'** treatment with an artemisinin derivative | **Strong, high-quality evidence** | §4.3.2, p35 |
| WHO_R_003 | Children **< 25 kg** on DHA+piperaquine: minimum **2.5 mg/kg/day** DHA + **20 mg/kg/day** piperaquine, daily × 3 days | **Strong, based on PK modelling** | §4.3, p35 |
| WHO_R_004 | Low-transmission areas: single **0.25 mg/kg** primaquine with ACT to reduce transmission — **except pregnant women, infants < 6 months, women breastfeeding infants < 6 months**. G6PD testing not required | **Strong, low-quality evidence** | §4.3, p35 |

**The five recommended ACTs** (§4.3.1): artemether+lumefantrine · artesunate+amodiaquine · artesunate+mefloquine · artesunate+SP · dihydroartemisinin+piperaquine

**Explicitly NOT recommended:** courses of 1–2 days — "less effective, have less effect on gametocytes and provide less protection for the slowly eliminated partner drug" (§4.3.2).

---

## F. WHO — ARTEMETHER + LUMEFANTRINE DOSING (§4.3.3)

**Formulations:** dispersible or standard tablets, 20 mg artemether + 120 mg lumefantrine
**Target dose range:** total 5–24 mg/kg bw artemether and 29–144 mg/kg bw lumefantrine

| Body weight (kg) | Dose (mg) twice daily × 3 days |
|---|---|
| 5 to < 15 | 20 + 120 |
| 15 to < 25 | 40 + 240 |
| 25 to < 35 | 60 + 360 |
| ≥ 35 | 80 + 480 |

> **Verification note.** `pdftotext -layout` rendered this table with the dose
> column offset by one row. Re-extracted in raw reading order, which returned
> four weight bands then four doses in matching sequence, confirming the
> pairing above. **A layout artifact here would have shifted every dose by one
> weight band** — checked deliberately rather than assumed.

**Dosing principle (§4.3.3):** weight-based dosing is preferred; age-based
dosing "can result in underdosing or over-dosing" unless region-specific
weight-for-age data exist.

### F1 — Administration and exposure factors

- **Take with food or a fat-containing drink (e.g. milk)**, particularly on days 2 and 3 — fat enhances lumefantrine absorption
- **Decreased** lumefantrine exposure (→ increased treatment-failure risk, monitor closely): children < 3 years; pregnant women; large adults; patients on mefloquine, rifampicin or efavirenz; smokers
- **Increased** exposure with lopinavir/ritonavir-based ARVs — **no dose adjustment indicated**
- Rifampicin is a potent CYP3A4 inducer with weak antimalarial activity (p54)
- Lumefantrine has never been available or used as monotherapy

### F2 — Other ACT dosing captured

| Regimen | Weight bands → dose |
|---|---|
| Artesunate + mefloquine (daily × 3 days) | 5–<9 kg: 25+55 · 9–<18 kg: 50+110 · 18–<30 kg: 100+220 · ≥30 kg: 200+440 |
| Artesunate + amodiaquine | Fixed-dose tablets: 25+67.5 · 50+135 · 100+270 mg |

**Mefloquine note:** associated with increased nausea, vomiting, dizziness,
dysphoria, sleep disturbance in trials — "seldom debilitating"; total dose
preferably split over 3 days.

---

## G. GAPS FROM THE FIRST EXTRACTION — STATUS AFTER THESE SOURCES

| # | Blocking gap (from `nnatg-extraction-v1.md` §M) | Status now |
|---|---|---|
| 1 | AL tablet strength unspecified | ✅ **RESOLVED** — NEML §5.7.1 + WHO §4.3.3 |
| 2 | Quinine IV maintenance "10mg" vs "10mg/kg" | ⚠️ **NOT RESOLVED** — WHO severe-malaria section (§7) not extracted |
| 3 | Severe anaemia threshold | ⚠️ **NOT RESOLVED** — in WHO §7.1, not extracted |
| 4 | Hyperparasitaemia threshold | ⚠️ **NOT RESOLVED** — in WHO §7.1, not extracted |
| 5 | "Multiple convulsions" count | ⚠️ **NOT RESOLVED** |
| 6 | Contraindications | 🟡 **PARTIAL** — WHO gives 1st-trimester exclusion, primaquine exclusions, doxycycline/quinine restriction. No comprehensive list extracted |
| 7 | Pregnancy treatment | 🟡 **PARTIAL** — WHO excludes 1st trimester from ACTs; what to give *instead* not extracted |
| 8 | < 5 kg / < 6 months dosing | ❌ **STILL ABSENT** — WHO table starts at 5 kg; NEML is adults-only |

**Honest scope statement:** WHO 2015 is 305 pages. I extracted §4 (uncomplicated
falciparum) in depth and confirmed provenance. **§7 (severe malaria), §8
(pregnancy/special populations), and the annexes were not extracted** — gaps
2–5 and 7 live there and remain open.

---

## H. POPULATION SEPARATION

| Population | Source support |
|---|---|
| **Adult** | NEML 2024 (adults, formulary) + WHO ≥35 kg band |
| **Child ≥ 5 kg** | WHO weight bands only — **NEML adult edition does not cover children** |
| **Infant < 5 kg / < 6 months** | `INSUFFICIENT_SOURCE_INFORMATION` |
| **Pregnant — 1st trimester** | **EXCLUDED from ACTs** (WHO_R_001). Alternative not extracted → `REQUIRES_REVIEW` |
| **Pregnant — 2nd/3rd trimester** | Not separately extracted → `REQUIRES_REVIEW` |
| **Breastfeeding infant < 6 months** | Excluded from primaquine (WHO_R_004) |
| **G6PD deficiency** | WHO: G6PD testing *not required* before single low-dose primaquine. Broader G6PD guidance not extracted |

---

## I. CONFLICTS REQUIRING REVIEW

### CONFLICT-005 — Nigeria's first-line ACT is unestablished
- **A:** Slide deck — "Recommended in Nigeria is Artemethor - Lumefantrine" (inadmissible source)
- **B:** WHO §4.3.1 — menu of five; countries select
- **C:** NEML §5.7.1 — lists seven treatment ACTs, unranked
- **Resolution:** obtain NMEP National Guidelines. **STATUS: REQUIRES_REVIEW**

### CONFLICT-006 — NEML lists ACTs WHO does not, and vice versa
- **A:** NEML includes **artesunate + pyronaridine tetraphosphate** (60+180 mg) — not among WHO 2015's five
- **B:** WHO includes **artesunate + SP** — not listed in NEML §5.7.1
- **Resolution:** likely reflects the 9-year gap (NEML 2024 vs WHO 2015) and national formulary choices. Confirms WHO 2015 is outdated. **STATUS: REQUIRES_REVIEW**

### CONFLICT-007 — WHO edition is superseded
- **A:** Supplied WHO 3rd ed, 2015
- **B:** WHO consolidated *Guidelines for Malaria* (2021+) supersede it
- **Resolution:** obtain current WHO edition before activating any WHO-derived rule. **STATUS: REQUIRES_REVIEW**

### CONFLICT-008 — Document scope vs filename
- **A:** Filename `nigeria treatment of malaria by who r.pdf`
- **B:** Content is WHO's global guideline; no Nigeria-specific content
- **Risk:** mis-classification as `nigerian_guidance` would wrongly elevate it in the evidence hierarchy. **STATUS: REQUIRES_REVIEW**

---

## J. CANDIDATE EVIDENCE SOURCE RECORDS (draft — not created)

```
evidence_source: neml_adult_8th_2024
  title:     Nigeria Essential Medicines List for Adults, 8th Edition
  publisher: Federal Ministry of Health and Social Welfare, Nigeria
  origin:    nigerian_guidance
  strength:  authoritative_guideline
  version:   8.0 (2024)
  status:    draft  ← requires pharmacist approval
  scope:     ADULTS ONLY; formulary — no dosing

evidence_source: who_malaria_treatment_3rd_2015
  title:     WHO Guidelines for the Treatment of Malaria, 3rd Edition
  publisher: World Health Organization, Global Malaria Programme
  origin:    global_guidance          ← NOT nigerian, despite filename
  strength:  authoritative_guideline
  version:   3.0 (2015)  [ISBN 978 92 4 154912 7]
  status:    draft  ← and flagged SUPERSEDED
```

**Neither should be approved until §K is signed off.**

---

## K. CLINICAL REVIEW CHECKLIST

- [ ] **1.** Obtain NMEP/FMoH *National Guidelines for Diagnosis and Treatment of Malaria* — the only document that can settle CONFLICT-005.
- [ ] **2.** Obtain current WHO edition (2021+) — CONFLICT-007.
- [ ] **3.** Obtain **paediatric** NEML — the supplied edition is adults-only.
- [ ] **4.** Confirm WHO 2015 classified `global_guidance`, **not** `nigerian_guidance` — CONFLICT-008.
- [ ] **5.** Extract WHO §7 (severe malaria) — resolves gaps 2–5.
- [ ] **6.** Extract WHO §8 (pregnancy/special populations) — resolves gap 7.
- [ ] **7.** Confirm AL weight-band pairing in §F against the printed PDF (layout artifact was corrected — verify independently).
- [ ] **8.** Decide whether artesunate+pyronaridine (NEML-listed, not in WHO 2015) may be used — CONFLICT-006.
- [ ] **9.** Confirm the doxycycline/quinine-only restriction is enforced.
- [ ] **10.** Confirm no `MEDICATION_RECOMMENDATION` is activated until 1–9 close.
- [ ] **11.** Decide policy for < 5 kg / < 6 months — currently out of scope for every source held.
- [ ] **12.** Confirm first-trimester pregnancy routes to escalation, not to an ACT.

---

## L. SOURCE TRACEABILITY

| Rule prefix | Source | Version | Cite |
|---|---|---|---|
| NEML §5.7.x | Nigeria Essential Medicines List for Adults | 8th Ed, 2024 | PDF p18 (printed p9) |
| WHO_R_00x | WHO Guidelines for the Treatment of Malaria | 3rd Ed, 2015 | §4.1–4.3, PDF p34–37 |
| MAL_RF_0xx, MAL_ESC_00x | Slide deck (inadmissible) | UNKNOWN | see `nnatg-extraction-v1.md` |

**No rule recorded without a source reference.**

---

## M. WHAT IS STILL NOT ACTIVATABLE

Despite two authoritative documents, **no medication recommendation may yet be
enabled**, because:

1. Nigeria's first-line selection is unestablished (CONFLICT-005)
2. The WHO edition held is superseded (CONFLICT-007)
3. Severe-malaria thresholds remain unextracted (gaps 2–5)
4. First-trimester alternative is unextracted (gap 7)
5. No pharmacist has approved either source

The engine's correct output for a malaria query remains
**`CONTINUE_ASSESSMENT`**, **`PHARMACIST_REVIEW`**, or **`URGENT_REFERRAL`**.
