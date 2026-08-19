-- Purchase-based condition profiles.
--
-- WHAT A ROW HERE MEANS, AND WHAT IT DELIBERATELY DOES NOT CLAIM
-- "This patient's pharmacy purchase history is consistent with this condition,
-- for pharmacy tracking." It is NOT a diagnosis, and nothing built on this
-- table may render it as one. The status value is CONFIRMED_BY_PURCHASE
-- precisely so the evidence basis travels with the claim instead of being lost
-- the moment it reaches a screen.
--
-- This sits alongside the Stage 1/2 clinical stack rather than inside it, and
-- the distinction matters. patient_clinical_facts records what a patient TOLD
-- us, with provenance, and clinical_encounters records an episode a pharmacist
-- can act on. This records an inference drawn from dispensing records — a
-- different kind of claim, from a different source, with a different failure
-- mode. Mixing it into patient_clinical_facts would let a purchase-derived
-- guess sit in the same column as a pharmacist-confirmed fact.
--
-- PHARMACY PURCHASE IS THE ONLY EVIDENCE SOURCE IN THIS VERSION.
-- evidence_type exists anyway, with a check constraint naming the sources a
-- later version may add, so PHARMACIST_CONFIRMED or LABORATORY becomes a new
-- allowed value rather than a redesign of the patient profile.
--
-- TWO TABLES, BECAUSE A DATASET CHANGE MUST NOT REWRITE HISTORY
-- patient_condition holds the CURRENT profile — one row per patient per
-- condition, which is what a profile screen reads.
-- patient_condition_evaluation is append-only: every engine run writes a
-- snapshot stamped with the NAFDAC dataset version and engine version that
-- produced it. When the NAFDAC extract is replaced, the new resolution lands
-- as a NEW evaluation; the old one stays exactly as recorded. That is what
-- makes "why was this patient classified under hypertension in March, on the
-- data we had in March" answerable rather than archaeological.

create table if not exists patient_condition (
  id                          uuid primary key default gen_random_uuid(),
  pharmacy_id                 uuid not null references pharmacies(id) on delete cascade,
  -- The patient is the existing customer. This system already has one identity
  -- for the person who buys medicine; a parallel patient table would split it
  -- and force every join to guess which half it wanted.
  customer_id                 uuid not null references customers(id) on delete cascade,

  condition_code              text not null,
  condition_name              text not null,

  -- PENDING_PURCHASE_EVIDENCE  — qualifying purchases exist but are below the
  --                              configured confirmation threshold.
  -- CONFIRMED_BY_PURCHASE      — threshold met. Never auto-downgraded: a
  --                              patient who stops collecting their medicine
  --                              is not a patient who stopped having the
  --                              condition.
  -- INACTIVE_PURCHASE_EVIDENCE — evidence that never reached confirmation and
  --                              has since gone stale.
  status                      text not null check (status in (
                                'PENDING_PURCHASE_EVIDENCE',
                                'CONFIRMED_BY_PURCHASE',
                                'INACTIVE_PURCHASE_EVIDENCE')),

  evidence_type               text not null default 'PHARMACY_PURCHASE'
                                check (evidence_type in (
                                  'PHARMACY_PURCHASE', 'PATIENT_REPORTED',
                                  'PHARMACIST_CONFIRMED', 'CLINICIAN_CONFIRMED',
                                  'LABORATORY', 'EHR', 'OTHER')),

  evidence_strength           text not null check (evidence_strength in (
                                'NONE', 'WEAK', 'MODERATE', 'STRONG', 'CONFIRMED')),

  -- Purchase exposure, NOT "currently taking". A dispensing record says a pack
  -- left the shelf; it does not say anyone swallowed it.
  purchase_status             text not null default 'ACTIVE_PURCHASE'
                                check (purchase_status in ('ACTIVE_PURCHASE', 'NO_RECENT_PURCHASE')),

  first_observed              date,
  last_observed               date,
  days_since_last_purchase    integer,

  supporting_transaction_count integer not null default 0,
  supporting_product_count     integer not null default 0,
  supporting_products          jsonb   not null default '[]'::jsonb,
  supporting_ingredients       jsonb   not null default '[]'::jsonb,
  therapeutic_subgroups        jsonb   not null default '[]'::jsonb,

  -- Computed from structured purchase evidence by a deterministic formula.
  -- Never an LLM's self-reported certainty.
  confidence                  numeric not null default 0,

  nafdac_dataset_version      text,
  engine_version              text,

  evaluated_at                timestamptz not null default now(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  unique (pharmacy_id, customer_id, condition_code)
);

create index if not exists idx_patient_condition_pharmacy_customer
  on patient_condition(pharmacy_id, customer_id);
create index if not exists idx_patient_condition_pharmacy_code
  on patient_condition(pharmacy_id, condition_code);

-- Append-only. One row per engine run per patient-condition, carrying the full
-- evidence chain: which orders, which source products, which NAFDAC matches,
-- which ingredients, which subgroups.
--
-- evidence_chain is JSONB rather than a third table because it is written once
-- and read whole — "show me why" renders all of it at once, and no query needs
-- to filter across the individual links.
create table if not exists patient_condition_evaluation (
  id                      uuid primary key default gen_random_uuid(),
  pharmacy_id             uuid not null references pharmacies(id) on delete cascade,
  customer_id             uuid not null references customers(id) on delete cascade,

  condition_code          text not null,
  status                  text not null,
  evidence_strength       text not null,
  confidence              numeric not null default 0,

  supporting_transaction_count integer not null default 0,
  supporting_product_count     integer not null default 0,

  -- The complete PATIENT -> ORDER -> SOURCE PRODUCT -> NAFDAC MATCH ->
  -- ACTIVE INGREDIENT -> THERAPEUTIC SUBGROUP -> CONDITION chain, plus the
  -- thresholds in force at evaluation time. Pinned rather than referenced, so
  -- re-reading an old evaluation after a config change still shows the rule it
  -- was actually decided under.
  evidence_chain          jsonb not null default '{}'::jsonb,
  thresholds_applied      jsonb not null default '{}'::jsonb,

  -- Human-readable, generated deterministically from the evidence above.
  -- Stored so the explanation cannot drift from the decision it explains.
  reason                  text,

  nafdac_dataset_version  text,
  engine_version          text,
  evaluated_at            timestamptz not null default now()
);

create index if not exists idx_pce_pharmacy_customer_condition
  on patient_condition_evaluation(pharmacy_id, customer_id, condition_code, evaluated_at desc);
create index if not exists idx_pce_pharmacy_dataset_version
  on patient_condition_evaluation(pharmacy_id, nafdac_dataset_version);
