# Ported code — provenance and status

The catalogue ingestion stack under `server/services/ingestion/` is ported
from the RxNaija Analytics codebase. It is proven code, but it was written
to ingest **sales transaction exports**, and this product ingests **product
catalogues**. Those are not the same problem, and pretending otherwise is
how a port becomes a liability.

Nothing here is wired into a route yet. Treat every file below as *present
and compiling*, not *working in this product*, until its adaptation task in
`ARCHITECTURE.md` is done and tested.

## Mechanical changes already applied

| Change | Why |
|---|---|
| `organizationId` → `pharmacyId` | The tenant is the pharmacy in this product. One name for one concept. |
| `organization_id` → `pharmacy_id` | Matches `db/migrations/0001_init.sql`. |
| `assertOrgId` → `assertPharmacyId` | Same guard, new name; see `server/services/db.js`. |
| `require('./db')` → `require('../db')` | Files moved down into `services/ingestion/`. |
| NAFDAC CSV path | Asset now lives at `server/data/pharma_nafdac_dataset.csv`. |

## Port status per file

### Drop-in — pure functions, no tenant or schema assumptions

| File | Does |
|---|---|
| `dataCleaner.js` | Type coercion, currency/number parsing, whitespace and encoding repair |
| `productNormalizer.js` | Canonicalises drug names for matching |
| `productParser.js` | Splits `"Augmentin 625mg x14"` into name / strength / pack |
| `drugClassifier.js` | Therapeutic category from product name |
| `sheetJoiner.js` | Multi-sheet workbook handling |
| `dictionary.js` | Canonical field vocabulary and header synonyms |

`dictionary.js` compiles as-is but its field list is sales-shaped
(`transaction_date`, `revenue`, `quantity_sold`). It needs catalogue fields
added — see the adaptation list.

### Needs adaptation — carries sales-transaction assumptions

| File | What breaks | Adaptation |
|---|---|---|
| `schemaDetector.js` | Detects `transaction_date`, `revenue`, `employee`, `branch` — none of which appear in a catalogue | Extend detection for `expiry_date`, `pack_size`, `barcode`; demote transaction fields to signals that the wrong file was uploaded |
| `columnMapper.js` | `DOMAIN_REQUIREMENTS` demands a date and a quantity column | New requirement set: product identity + price required, stock optional |
| `validator.js` / `dataQuality.js` | Quality rules score a sales dataset | Rewrite rules around catalogue truth: missing price, negative stock, expired date, duplicate identity |
| `datasetClassifier.js` | Classifies sales vs inventory | Repurpose as the "you uploaded a sales export, not a catalogue" guard — genuinely useful, small change |
| `productIdentityResolver.js` | Sound logic, but resolves against the analytics `product` table | Repoint at the new `products` table and its `natural_key` |
| `llmMapper.js` | Prompt describes sales columns | Rewrite the prompt; keep the call/parse/validate structure, which is the valuable part |
| `nafdacLookup.js` | Loads a bundled CSV at startup, blocking | Keep the lookup, make the load lazy — 1.1 MB parsed synchronously on require delays the health check during boot. Licence now confirmed; see the note at the end of this file. |
| `columnAlias.js` | Fine as-is | None beyond the rename already applied |

### Deliberately NOT ported

**`normalizer.js`** (974 lines). It is the orchestrator for the whole
pipeline, and every stage of it assumes it is producing sales fact rows —
resolving branches, employees, calendar dates, and revenue lines. A
catalogue import produces one product row per input row and needs none of
that. Copying it would mean deleting most of it and inheriting the shape of
what remained.

A new `catalogueIngestion.js` will orchestrate the ported stages instead.
Read `normalizer.js` in the analytics repo for its *structure* — the
detect → map → confirm → clean → validate → persist sequence is right, and
worth following.

**`analyticsQueries`, `factStore`, `metrics`, `businessHealth`, the
intelligence layer.** Different product. Not needed to answer "do you have
Augmentin".

## Licence note

`server/data/pharma_nafdac_dataset.csv` came across with the port.
Redistribution was **confirmed permissible by the project owner on
2026-08-09**, ahead of this repository being made public.

Provenance, column-level caveats, and staleness behaviour are documented in
[`server/data/README.md`](server/data/README.md). The source URL is still
blank there and should be filled in — a public repo that ships a dataset
without saying where it came from puts the burden on everyone downstream.
