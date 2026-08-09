# NAFDAC product registration dataset

`pharma_nafdac_dataset.csv` is a point-in-time snapshot of Nigerian drug
registrations. The ingestion pipeline uses it to resolve messy pharmacy
catalogue rows ("amox 500", "AMOXIL CAP 500MG x100") to a canonical product
identity, so two pharmacies spelling the same drug differently still map to
the same thing.

## Provenance and redistribution

- **Source:** NAFDAC's public product registration database.
- **Source URL:** *(to fill in — the specific portal page or export this was taken from)*
- **Snapshot date:** unknown; inherited from the `rxnaija-analytics` project.
- **Redistribution:** confirmed permissible by the project owner, 2026-08-09.

That confirmation is recorded here because this repository is public. Anyone
reusing this file in their own project should check NAFDAC's current terms
themselves rather than relying on a third party's note.

## Shape

6,671 rows, 12 columns:

| Column | Notes |
|---|---|
| `brand_name` | Registered trade name. The primary match target. |
| `generic` | Active ingredient. Sparse and inconsistent — some rows carry a dosage form here instead. |
| `category` | Broad class, e.g. `Drugs`. |
| `nafdac_no` | Registration number. **Not reliable as a key** — some values have been mangled into dates by a spreadsheet round-trip (`2-Apr`), which is why identity resolution matches on name rather than this. |
| `form`, `route`, `strength` | Frequently empty. |
| `registration_date` | Year only in most rows. |
| `status` | `Active` and others. |
| `therapeutic_group`, `therapeutic_subgroup` | Heavily defaulted to `Other`. |
| `company` | Marketing authorisation holder. |

The data is dirty in ways worth knowing before trusting a column: the
`nafdac_no` corruption above is the clearest example, and the therapeutic
groupings are too sparse to drive any clinical logic. Treat this as a name
dictionary, not a clinical reference.

## Who reads it

`server/services/ingestion/nafdacLookup.js`, which builds an in-memory index
at load time and is called by `productIdentityResolver.js`.

`PORTING.md` flags the blocking load as an item to make lazy — 1.1 MB parsed
synchronously on require is fine for a script and wrong for a web process
that needs to answer a health check during boot.

## Staleness

Registrations are added, renewed, and withdrawn continuously, so this
snapshot drifts from reality from the day it was taken. Nothing in the
pipeline detects that. A product missing from the snapshot degrades to an
unresolved identity — safe, but lossy: the catalogue row still imports, it
just doesn't get a canonical match.

Refreshing means replacing the file with a newer export in the same column
order. There is no migration to run.
