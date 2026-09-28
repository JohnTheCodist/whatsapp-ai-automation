-- =====================================================================
-- Consultation phase 2: the problems, what was done, and where it went.
-- =====================================================================
--
-- See CONSULTATION_PLAN.md §4 and §10. Two tables and some additive columns.
-- `clinical_encounters` is untouched again, and so is every module this points
-- at: Vitals, Tests, Conditions, Medications, Follow-ups and Care programmes
-- are READ and referenced, never copied (§3 of the brief).
--
-- WHY TWO TABLES AND NOT ARRAYS ON THE NOTE
-- The same question the medication review (0056) settled: a problem is about a
-- MEDICINE or a CONDITION, and an intervention is about a PROBLEM. Held as
-- jsonb arrays on one row, "which problem did you counsel about" has no
-- answer. §12 asks for a numbered problem list and §14 for multiple
-- interventions each with their own note; those are rows.
--
-- NOTHING CLINICAL IS STORED IN EITHER OF THEM. A problem row holds a LABEL,
-- a certainty and a POINTER. The blood pressure lives in Vitals, the diagnosis
-- in Conditions, the result in Tests. §36 is explicit, and a test asserts
-- neither table has a column that could hold a measurement.

-- ---------------------------------------------------------------------------
-- consultation_problems — §12's numbered problem list
-- ---------------------------------------------------------------------------
--
-- WHY CERTAINTY IS A COLUMN
-- §11 is emphatic that a pharmacist must not be forced into a definitive
-- diagnosis: "possible", "provisional", "suspected", "needs evaluation" are
-- the real answers most of the time. Free text would make that unsearchable
-- and, worse, would let a screen render a guess in the same weight as a
-- confirmed condition. Separating it means the UI can show uncertainty AS
-- uncertainty.
--
-- WHY A POINTER AND NOT A FOREIGN KEY
-- The target is one of four tables. The same shape `care_program_links`
-- (0061), `patient_tasks.source_type` (0062) and `conversation_links` (0064)
-- use: the CHECK constrains the KIND, and `clinicalRefs.assertRecord` proves
-- the id is this patient's in this pharmacy before the row is written.
--
-- WHY `position` EXISTS
-- 0057's lesson. `medication_reviews` ordered findings by `created_at, id`,
-- but every row written in one transaction shares `now()`, so the tiebreak
-- was a random uuid and a review read back in a different order on different
-- loads. §12 numbers the problems; the number has to be stable.

create table if not exists consultation_problems (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  consultation_id  uuid not null references pharmacist_consultations(id) on delete cascade,
  -- Denormalised on purpose: every read is "this patient's", and carrying the
  -- patient means the scope lives in this table's own WHERE clause rather
  -- than in a join somebody has to remember — GOLDEN-001.
  customer_id      uuid not null references customers(id) on delete cascade,

  position         integer not null default 0,
  label            text not null check (length(btrim(label)) > 0),

  certainty        text not null default 'possible' check (certainty in (
    'possible', 'provisional', 'suspected', 'established', 'needs_evaluation'
  )),
  -- §12's example statuses. `under_assessment` is the honest default for
  -- something a pharmacist has just raised and not yet concluded.
  status           text not null default 'under_assessment' check (status in (
    'active', 'monitoring', 'under_assessment', 'resolved'
  )),

  -- The record this problem is about, when it is about one.
  ref_kind         text check (ref_kind is null or ref_kind in (
    'condition', 'medication', 'test', 'vitals'
  )),
  ref_id           uuid,
  note             text check (note is null or length(note) <= 2000),
  created_at       timestamptz not null default now(),

  -- An id with no kind points at nothing anybody can resolve, and a kind with
  -- no id names a table and no row. Either alone is a half-written pointer.
  constraint consultation_problems_ref_pair check (
    (ref_kind is null and ref_id is null) or (ref_kind is not null and ref_id is not null)
  )
);

create index if not exists consultation_problems_consultation_idx
  on consultation_problems (pharmacy_id, consultation_id, position, created_at);

-- ---------------------------------------------------------------------------
-- consultation_interventions — §14's "what the pharmacist did"
-- ---------------------------------------------------------------------------
--
-- Each may point at ONE of the problems above, which is the question arrays
-- could not answer. It may also point at nothing: "patient counselling" that
-- was general rather than about a particular problem is a real intervention.

create table if not exists consultation_interventions (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  consultation_id  uuid not null references pharmacist_consultations(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,

  position         integer not null default 0,
  kind             text not null check (kind in (
    'patient_counselling', 'medication_counselling', 'adherence_counselling',
    'lifestyle_counselling', 'otc_recommendation', 'self_care_advice',
    'device_education', 'administration_education', 'mrp_identified',
    'prescription_clarification', 'prescriber_contacted', 'referral',
    'monitoring_advised', 'no_intervention', 'other'
  )),

  -- Which problem this was about. Null is allowed and means "not about one in
  -- particular", not "unknown".
  problem_id       uuid references consultation_problems(id) on delete set null,
  note             text check (note is null or length(note) <= 2000),
  created_at       timestamptz not null default now()
);

create index if not exists consultation_interventions_consultation_idx
  on consultation_interventions (pharmacy_id, consultation_id, position, created_at);

-- ---------------------------------------------------------------------------
-- Referral (§17), the prescription check (§16), and where the note went
-- ---------------------------------------------------------------------------
--
-- THE DISTINCTION THAT MATTERS MOST HERE:
--
--   referral_destination IS NULL      nobody considered referral
--   referral_destination = 'none'     a pharmacist considered it and decided
--                                     it was not required
--
-- Those are different facts and the summary must not confuse them. "Referral:
-- not required" on a note where referral was never considered is a clinical
-- decision the software invented — the same rule the allergy record has
-- followed since 0058 and the follow-up card had to be fixed to follow.

alter table pharmacist_consultations
  add column if not exists referral_destination text
    check (referral_destination is null or referral_destination in (
      'none', 'physician', 'hospital', 'laboratory', 'specialist', 'emergency', 'other'
    )),
  add column if not exists referral_reason text,
  add column if not exists referral_urgency text
    check (referral_urgency is null or referral_urgency in ('routine', 'soon', 'urgent', 'emergency')),
  add column if not exists referral_notes text,

  -- §16. The issue types a pharmacist ticked, and what the prescriber said if
  -- they were contacted. This records that a clarification HAPPENED; it does
  -- not imply RxMax changed an external prescription, because there is no
  -- prescribing workflow here to change one with.
  add column if not exists prescription_issues jsonb not null default '[]'::jsonb,
  add column if not exists prescriber_contacted_at timestamptz,
  add column if not exists prescriber_outcome text,

  -- §21. The programme this consultation belongs to, when it is part of one.
  -- A POINTER: the programme keeps its own plan, goals and activities, and
  -- nothing here duplicates them.
  add column if not exists care_program_id uuid references patient_care_programs(id) on delete set null;

-- A referral that names somewhere must say why. "Refer to hospital" with no
-- reason is the note failing the person who reads it next — 0060's rule
-- ("saying a report was cancelled, amended or corrected always says why"),
-- applied to the decision that sends somebody somewhere.
alter table pharmacist_consultations
  drop constraint if exists pharmacist_consultations_referral_reason;
alter table pharmacist_consultations
  add constraint pharmacist_consultations_referral_reason check (
    referral_destination is null
    or referral_destination = 'none'
    or (referral_reason is not null and length(btrim(referral_reason)) > 0)
  ) not valid;
alter table pharmacist_consultations validate constraint pharmacist_consultations_referral_reason;

create index if not exists pharmacist_consultations_care_program_idx
  on pharmacist_consultations (care_program_id) where care_program_id is not null;

-- ---------------------------------------------------------------------------
-- RLS — the same shape as every clinical table since 0058
-- ---------------------------------------------------------------------------
alter table consultation_problems enable row level security;
alter table consultation_interventions enable row level security;

drop policy if exists tenant_isolation on consultation_problems;
create policy tenant_isolation on consultation_problems
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

drop policy if exists tenant_isolation on consultation_interventions;
create policy tenant_isolation on consultation_interventions
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

comment on table consultation_problems is
  'The pharmacist''s numbered problem list for one consultation. A label, a certainty and a POINTER — never a copy of what the record says.';
comment on table consultation_interventions is
  'What the pharmacist did, one row each, optionally about one of the problems. Nothing here is generated.';
comment on column pharmacist_consultations.referral_destination is
  'NULL means referral was never considered. ''none'' means a pharmacist considered it and decided against. The two must never be rendered the same way.';
