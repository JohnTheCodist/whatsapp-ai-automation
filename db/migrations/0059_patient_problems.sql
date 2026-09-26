-- =====================================================================
-- Conditions: the patient's problem list — conditions a person ASSERTS.
-- =====================================================================
--
-- See CONDITIONS_PLAN.md. The screen calls these Conditions; the table is
-- the problem list, the clinical term for the same thing.
--
-- WHY NOT patient_condition (0037)
-- patient_condition is the purchase engine's INFERENCE: "purchase history is
-- consistent with this condition — not a diagnosis". Its own header warns
-- against mixing an inference into an asserted record, its unique key allows
-- one row per condition (so "malaria, resolved" and "malaria, active again"
-- cannot both exist), and the engine upserts those rows. So the two sit side
-- by side: the engine keeps inferring, a pharmacist records, and an
-- inference becomes a record only when a person chooses to write it down.
--
-- WHY NOT "patient_conditions"
-- One letter from patient_condition, with the opposite meaning. That is an
-- accident waiting to be typed.
--
-- FHIR Condition concepts: clinical status, verification status, category,
-- severity, body site, onset, abatement, asserter, recorder, encounter.
--
-- NOTHING IS DELETED. A wrong record is refuted or entered in error, kept,
-- and says why. NOTHING IS COMPUTED: no diagnosis from a symptom, a vital
-- sign or a purchase.

create table if not exists patient_problems (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  customer_id         uuid not null references customers(id) on delete cascade,

  -- What is displayed. Free text is always allowed.
  condition_name      text not null check (length(trim(condition_name)) between 1 and 200),
  -- A standard code when there is one (e.g. icd10 / I10). Both null until a
  -- terminology service fills them; neither is ever required.
  code_system         text check (code_system is null or code_system in ('icd10', 'snomed', 'other')),
  code                text check (code is null or length(code) <= 40),
  -- The house code patient_condition and medication_journeys.condition_code
  -- already use (HYPERTENSION, DIABETES…), so the record, the inference and a
  -- medicine's indication can be matched without being merged.
  local_code          text check (local_code is null or local_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),

  category            text not null default 'problem_list'
                      check (category in ('problem_list', 'chronic', 'acute', 'encounter_diagnosis', 'other')),
  -- Is it current? The screen groups these as Active (active, recurrence,
  -- relapse) / Inactive / Resolved or in remission.
  clinical_status     text not null default 'active'
                      check (clinical_status in ('active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved')),
  -- Is it true, and how sure? Defaults to unconfirmed: someone said it,
  -- nobody has checked.
  verification_status text not null default 'unconfirmed'
                      check (verification_status in (
                        'confirmed', 'provisional', 'unconfirmed', 'differential', 'refuted', 'entered_in_error')),
  severity            text check (severity is null or severity in ('mild', 'moderate', 'severe', 'unknown')),
  body_site           text check (body_site is null or length(body_site) <= 100),

  -- Onset a patient often only half-knows: a date at its precision, and a
  -- note for what no date can say ("since childhood").
  onset_date          date,
  onset_precision     text check (onset_precision is null or onset_precision in ('day', 'month', 'year')),
  onset_note          text check (onset_note is null or length(onset_note) <= 100),
  -- When it resolved or went into remission.
  abatement_date      date,
  abatement_precision text check (abatement_precision is null or abatement_precision in ('day', 'month', 'year')),

  source              text not null default 'patient'
                      check (source in ('patient', 'previous_record', 'prescriber', 'pharmacist', 'laboratory', 'other')),
  -- WHO made the diagnosis, when it came from outside ("Dr Okafor, LUTH").
  -- recorded_by is who typed it.
  asserted_by_name    text check (asserted_by_name is null or length(asserted_by_name) <= 200),
  -- Documented during this consultation. A consultation deleted later does
  -- not take the condition with it.
  encounter_id        uuid references clinical_encounters(id) on delete set null,

  notes               text check (notes is null or length(notes) <= 2000),
  status_reason       text check (status_reason is null or length(status_reason) <= 500),

  recorded_by         uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A record that is not true is not a current condition, and says why.
  constraint patient_problems_untrue_not_current check (
    verification_status not in ('refuted', 'entered_in_error')
    or clinical_status not in ('active', 'recurrence', 'relapse')
  ),
  constraint patient_problems_untrue_has_reason check (
    verification_status not in ('refuted', 'entered_in_error') or status_reason is not null
  ),
  -- A current condition has not abated (FHIR: abatement implies inactive,
  -- remission or resolved).
  constraint patient_problems_abatement_not_current check (
    abatement_date is null or clinical_status in ('inactive', 'remission', 'resolved')
  ),
  constraint patient_problems_abatement_after_onset check (
    abatement_date is null or onset_date is null or abatement_date >= onset_date
  ),
  constraint patient_problems_onset_pair check ((onset_date is null) = (onset_precision is null)),
  constraint patient_problems_abatement_pair check ((abatement_date is null) = (abatement_precision is null)),
  constraint patient_problems_code_pair check ((code is null) = (code_system is null))
);

create index if not exists idx_patient_problems_patient
  on patient_problems (pharmacy_id, customer_id, clinical_status);
-- The duplicate check and the chronic switch look up by house code.
create index if not exists idx_patient_problems_local_code
  on patient_problems (pharmacy_id, local_code)
  where local_code is not null;

-- ---------------------------------------------------------------------------
-- Supporting evidence — links, never copies (brief §16)
-- ---------------------------------------------------------------------------
--
-- One typed column per kind of record, not a polymorphic "any id", so the
-- database itself refuses a link to a row that does not exist. Only vitals
-- today: consultations link through patient_problems.encounter_id, and there
-- are no laboratory results in the product yet. When there are, they get a
-- column here.
create table if not exists patient_problem_evidence (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  problem_id  uuid not null references patient_problems(id) on delete cascade,
  vitals_id   uuid not null references patient_vitals(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (problem_id, vitals_id)
);

create index if not exists idx_patient_problem_evidence_problem
  on patient_problem_evidence (pharmacy_id, problem_id);

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0054 / 0056 / 0058
-- ---------------------------------------------------------------------------
alter table patient_problems enable row level security;
alter table patient_problem_evidence enable row level security;

drop policy if exists tenant_isolation on patient_problems;
create policy tenant_isolation on patient_problems
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_problem_evidence;
create policy tenant_isolation on patient_problem_evidence
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Carry existing condition facts across (0029 → here)
-- ---------------------------------------------------------------------------
--
-- Nothing in the product writes these today, so this normally copies
-- nothing. Idempotent: a fact already carried across (same patient, same
-- name) is not copied twice. The old rows stay where they are.
insert into patient_problems
  (pharmacy_id, customer_id, condition_name, verification_status, source, recorded_by, created_at, notes)
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
where f.fact_type = 'condition'
  and f.status in ('reported', 'confirmed')
  and not exists (
    select 1 from patient_problems x
    where x.pharmacy_id = f.pharmacy_id and x.customer_id = p.customer_id
      and lower(x.condition_name) = lower(left(trim(f.value), 200))
  );

comment on table patient_problems is
  'The problem list: conditions a person asserted, FHIR Condition concepts. Separate from patient_condition (the purchase inference). Never deleted — see 0059 header.';
