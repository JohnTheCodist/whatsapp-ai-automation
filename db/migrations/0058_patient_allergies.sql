-- =====================================================================
-- Allergies: the patient's allergy and intolerance record.
-- =====================================================================
--
-- See ALLERGIES_PLAN.md. What this is for, in one line: a pharmacist about
-- to hand over a medicine can see, in seconds and with its provenance,
-- whether this patient reacts to anything and how badly.
--
-- WHY NEW TABLES, NOT patient_clinical_facts (0029)
-- That table holds four kinds of fact with one text `value` each. An allergy
-- needs a category, an allergy-vs-intolerance distinction, reactions,
-- severity, criticality, verification and two dates. Putting those columns
-- on the generic table would give every condition and medication row a
-- dozen columns that are always null. Existing allergy facts are carried
-- across at the foot of this file, and the old rows are left where they are.
--
-- FHIR-SHAPED, ONE LEVEL FLATTER
-- The concepts are FHIR AllergyIntolerance's: clinical status, verification
-- status, type, category, criticality, and reactions with manifestations. A
-- community pharmacist records ONE history ("rash and facial swelling after
-- amoxicillin"), not a series of dated reaction episodes, so severity,
-- exposure route and the dates sit on the allergy and the reactions are its
-- manifestations. A second, distinct episode is a later migration if it is
-- ever needed.
--
-- SEVERITY IS NOT CRITICALITY. Severity is how bad the reaction that
-- happened was. Criticality is how dangerous the NEXT exposure could be. A
-- mild rash to penicillin can still be high criticality. Two columns.
--
-- NOTHING IS DELETED. A wrong record is REFUTED or ENTERED IN ERROR and
-- kept, so the history reads honestly: "someone thought this, and a
-- pharmacist found it was not so". There is no delete route.
--
-- NOTHING HERE IS COMPUTED. No risk score, no cross-sensitivity, no check
-- against the medication list. The pharmacist records; the software shows.

create table if not exists patient_allergies (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  customer_id         uuid not null references customers(id) on delete cascade,

  -- What is shown. Free text is ALWAYS allowed: plenty of real allergens
  -- ("the blue cough syrup", a local herb) are in no list.
  allergen_name       text not null check (length(trim(allergen_name)) between 1 and 200),
  -- Set when the allergen was picked from a list: 'nafdac:<generic>' or
  -- 'common:<key>'. Never required.
  allergen_code       text check (allergen_code is null or length(allergen_code) <= 200),

  category            text not null default 'unknown'
                      check (category in ('medication', 'food', 'environmental', 'biologic', 'other', 'unknown')),
  -- Not every adverse reaction is an allergy. Defaults to 'unknown', never
  -- to 'allergy': nausea from metformin is an intolerance, and recording it
  -- as an allergy teaches the next pharmacist to avoid a drug the patient
  -- can take.
  type                text not null default 'unknown'
                      check (type in ('allergy', 'intolerance', 'unknown')),

  -- Is it CURRENT? (FHIR clinicalStatus.)
  clinical_status     text not null default 'active'
                      check (clinical_status in ('active', 'inactive', 'resolved')),
  -- Is it TRUE? (FHIR verificationStatus.) Refuted and entered-in-error
  -- live here, not in clinical_status, because they describe the record's
  -- truth rather than the allergy's currency — see the CHECK below.
  verification_status text not null default 'unconfirmed'
                      check (verification_status in ('unconfirmed', 'confirmed', 'refuted', 'entered_in_error')),

  criticality         text check (criticality is null or criticality in ('low', 'high', 'unable_to_assess')),
  severity            text check (severity is null or severity in ('mild', 'moderate', 'severe', 'unknown')),
  exposure_route      text check (exposure_route is null or exposure_route in ('oral', 'topical', 'injection', 'inhaled', 'other')),

  -- Dates a patient often only half-knows. "About five years ago" is stored
  -- as that year with precision 'year' and shown as "~2021". Both null means
  -- unknown, which is a real and common answer.
  onset_date          date,
  onset_precision     text check (onset_precision is null or onset_precision in ('day', 'month', 'year')),
  last_occurrence_date      date,
  last_occurrence_precision text check (last_occurrence_precision is null
                                  or last_occurrence_precision in ('day', 'month', 'year')),

  -- WHO SAID SO. The person who typed it is recorded_by, below.
  source              text not null default 'patient'
                      check (source in ('patient', 'guardian', 'previous_record', 'prescriber', 'pharmacist', 'other')),
  notes               text check (notes is null or length(notes) <= 2000),
  -- Why it was refuted, marked in error, resolved or made inactive.
  status_reason       text check (status_reason is null or length(status_reason) <= 500),

  -- Nullable for the same reason as every clinical author column here:
  -- DEV_AUTH_BYPASS has no real user.
  recorded_by         uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A record that is not true cannot be a current allergy. This is the one
  -- impossible state the FHIR split exists to rule out.
  constraint patient_allergies_untrue_not_active check (
    verification_status not in ('refuted', 'entered_in_error') or clinical_status <> 'active'
  ),
  -- Saying a record is wrong always says why.
  constraint patient_allergies_untrue_has_reason check (
    verification_status not in ('refuted', 'entered_in_error') or status_reason is not null
  ),
  -- A date and its precision travel together.
  constraint patient_allergies_onset_pair check ((onset_date is null) = (onset_precision is null)),
  constraint patient_allergies_last_pair check (
    (last_occurrence_date is null) = (last_occurrence_precision is null)
  )
);

-- The read every screen makes: this patient's allergies.
create index if not exists idx_patient_allergies_patient
  on patient_allergies (pharmacy_id, customer_id, clinical_status);

-- ---------------------------------------------------------------------------
-- The manifestations of the reaction
-- ---------------------------------------------------------------------------
create table if not exists patient_allergy_reactions (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  allergy_id      uuid not null references patient_allergies(id) on delete cascade,
  manifestation   text not null check (manifestation in (
    'rash', 'hives', 'itching', 'swelling', 'facial_swelling', 'lip_tongue_swelling',
    'wheezing', 'shortness_of_breath', 'nausea', 'vomiting', 'diarrhoea',
    'dizziness', 'fainting', 'anaphylaxis', 'other')),
  -- What exactly. Required for 'other' — "other" alone tells nobody anything.
  description     text check (description is null or length(description) <= 300),
  -- The order they were entered in. Written in one transaction, so
  -- created_at cannot order them (the 0057 lesson).
  position        smallint not null default 0,
  created_at      timestamptz not null default now(),

  constraint patient_allergy_reactions_other_described check (
    manifestation <> 'other' or (description is not null and length(trim(description)) > 0)
  )
);

-- The same manifestation twice on one allergy is a double-click. 'other'
-- may repeat, because two different "other" reactions are two facts.
create unique index if not exists idx_patient_allergy_reactions_unique
  on patient_allergy_reactions (allergy_id, manifestation)
  where manifestation <> 'other';

create index if not exists idx_patient_allergy_reactions_allergy
  on patient_allergy_reactions (pharmacy_id, allergy_id, position);

-- ---------------------------------------------------------------------------
-- "No known allergies" — the one thing about allergy status that is STORED
-- ---------------------------------------------------------------------------
--
-- The overall state is derived, never stored:
--   KNOWN ALLERGIES   an active allergy whose record is not refuted / in error
--   NO KNOWN          none of those, AND a pharmacist has asserted NKA
--   NOT ASSESSED      neither — the default
-- An empty list is NEVER read as "no allergies". NKA is a claim a person
-- makes, with a name and a time, and recording an allergy withdraws it.
alter table patient_profiles
  add column if not exists nka_asserted_at timestamptz;
alter table patient_profiles
  add column if not exists nka_asserted_by uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0054 / 0056
-- ---------------------------------------------------------------------------
alter table patient_allergies enable row level security;
alter table patient_allergy_reactions enable row level security;

drop policy if exists tenant_isolation on patient_allergies;
create policy tenant_isolation on patient_allergies
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_allergy_reactions;
create policy tenant_isolation on patient_allergy_reactions
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Carry existing allergy facts across (0029 → here)
-- ---------------------------------------------------------------------------
--
-- Nothing in the product writes these today, so this normally copies
-- nothing. It exists so that if any DO exist, they are not left behind in a
-- table no allergy screen reads. The old rows stay where they are.
-- Idempotent: a fact already carried across (matched on patient + name) is
-- not copied twice.
insert into patient_allergies
  (pharmacy_id, customer_id, allergen_name, verification_status, source, recorded_by, created_at, notes)
select
  f.pharmacy_id,
  p.customer_id,
  left(trim(f.value), 200),
  case when f.status = 'confirmed' then 'confirmed' else 'unconfirmed' end,
  case when f.source = 'pharmacist_recorded' then 'pharmacist' when f.source = 'patient_reported' then 'patient' else 'other' end,
  f.recorded_by,
  f.created_at,
  'Carried across from the earlier clinical facts record.'
from patient_clinical_facts f
join patient_profiles p on p.id = f.patient_profile_id and p.pharmacy_id = f.pharmacy_id
where f.fact_type = 'allergy'
  and f.status in ('reported', 'confirmed')
  and not exists (
    select 1 from patient_allergies a
    where a.pharmacy_id = f.pharmacy_id and a.customer_id = p.customer_id
      and lower(a.allergen_name) = lower(left(trim(f.value), 200))
  );

comment on table patient_allergies is
  'A patient''s allergies and intolerances, FHIR AllergyIntolerance concepts. Never deleted: a wrong record is refuted or entered in error. Nothing computed — see 0058 header.';
