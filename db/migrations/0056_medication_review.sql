-- =====================================================================
-- Medications, phase 2: the pharmacist's medication review.
-- =====================================================================
--
-- WHAT THIS RECORDS
-- A pharmacist sitting down with a patient's medicines and writing what they
-- found: how the patient is actually taking them, what is wrong, what was
-- done about it, and when to look again. It is the record of a professional
-- act, not a form the software fills in.
--
-- THREE TABLES, NOT ONE ROW WITH ARRAYS
-- A PROBLEM is about a MEDICINE. An INTERVENTION is about a PROBLEM. Held as
-- arrays on the review, "which interaction did you ring the prescriber
-- about" is unanswerable — and that question is the whole reason an
-- intervention is worth recording. So:
--
--   medication_reviews           one sitting
--   medication_review_problems   one row per problem found, optionally naming
--                                the medicine it is about
--   medication_review_actions    one row per thing the pharmacist did,
--                                optionally naming the problem it answers
--
-- RECONCILIATION IS NOT A FOURTH TABLE. "Is this prescribed, patient
-- reported, OTC, herbal?" is `medication_journeys.source` (0055), set on the
-- medicine itself during the review. One fact, one place — a reconciliation
-- table would be a second, staler copy of it.
--
-- NOTHING HERE IS COMPUTED. No score, no risk level, no severity, no
-- suggested intervention. The software records what the pharmacist decided;
-- it does not decide. See customerProfile.js's header for the line this
-- product draws.

create table if not exists medication_reviews (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  customer_id    uuid not null references customers(id) on delete cascade,

  -- The day the review happened, as a Lagos calendar day — not a timestamp,
  -- for the same reason refills use `date` (0052): "which day was this
  -- patient reviewed" must not depend on the timezone of whoever reads it.
  reviewed_on    date not null default (now() at time zone 'Africa/Lagos')::date,
  -- Nullable for the same reason as patient_notes.author_id: DEV_AUTH_BYPASS
  -- has no real user, and an unattributed review is still a review that
  -- happened.
  reviewer_id    uuid references auth.users(id) on delete set null,

  -- How the patient is actually taking their medicines, as ASSESSED by the
  -- pharmacist. 'unknown' is a real answer and the default: a review that
  -- could not establish adherence recorded that, and forcing a guess would
  -- put "good" against patients nobody asked.
  adherence      text not null default 'unknown'
                 check (adherence in ('good', 'partial', 'poor', 'unknown')),
  adherence_notes text check (adherence_notes is null or length(adherence_notes) <= 1000),
  notes          text check (notes is null or length(notes) <= 4000),

  -- Where the review left things.
  outcome        text check (outcome is null or outcome in (
                   'resolved', 'monitoring', 'prescriber_follow_up', 'referred', 'pending')),

  follow_up_on   date,
  follow_up_reason text check (follow_up_reason is null or length(follow_up_reason) <= 300),
  follow_up_notes  text check (follow_up_notes is null or length(follow_up_notes) <= 1000),

  -- draft   being written, and editable
  -- signed  the pharmacist finished it
  --
  -- A signed review is the record of a professional act. It is not deleted
  -- and not silently rewritten; a later correction is a NEW review, which is
  -- also how the history reads honestly.
  status         text not null default 'draft' check (status in ('draft', 'signed')),
  signed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  check ((status = 'draft' and signed_at is null) or (status = 'signed' and signed_at is not null)),
  -- A follow-up date with no reason is a date nobody can act on, and a
  -- reason with no date never comes round.
  check ((follow_up_on is null and follow_up_reason is null)
      or (follow_up_on is not null and follow_up_reason is not null))
);

create index if not exists idx_medication_reviews_patient
  on medication_reviews (pharmacy_id, customer_id, reviewed_on desc);

-- Who is due to be looked at again, across the whole pharmacy. The one query
-- a follow-up list is built from.
create index if not exists idx_medication_reviews_follow_up
  on medication_reviews (pharmacy_id, follow_up_on)
  where follow_up_on is not null and status = 'signed';

-- ---------------------------------------------------------------------------
-- What was found
-- ---------------------------------------------------------------------------
create table if not exists medication_review_problems (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  review_id      uuid not null references medication_reviews(id) on delete cascade,
  -- WHICH MEDICINE, when the problem is about one. Nullable because "patient
  -- cannot afford their medicines" is about the patient, not a row. ON DELETE
  -- SET NULL: a medicine removed from the record does not erase the problem
  -- that was found with it.
  journey_id     uuid references medication_journeys(id) on delete set null,

  problem        text not null check (problem in (
    'non_adherence', 'incorrect_dose', 'incorrect_frequency', 'duplicate_therapy',
    'potential_interaction', 'adverse_effect', 'contraindication_concern',
    'unnecessary_medication', 'therapeutic_duplication', 'drug_not_effective',
    'access_cost', 'patient_misunderstanding', 'other')),
  notes          text check (notes is null or length(notes) <= 1000),
  created_at     timestamptz not null default now(),

  -- The same problem twice against the same medicine in one sitting is a
  -- double-click, not two findings.
  unique (review_id, problem, journey_id)
);

create index if not exists idx_medication_review_problems_review
  on medication_review_problems (pharmacy_id, review_id);

-- ---------------------------------------------------------------------------
-- What the pharmacist did about it
-- ---------------------------------------------------------------------------
create table if not exists medication_review_actions (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  review_id      uuid not null references medication_reviews(id) on delete cascade,
  -- WHICH PROBLEM this answers. Nullable — "counselling provided" may be
  -- general — but when it is set, the record can finally answer "which
  -- interaction did you ring the prescriber about".
  problem_id     uuid references medication_review_problems(id) on delete set null,

  action         text not null check (action in (
    'counselling_provided', 'dose_clarification', 'adherence_counselling',
    'prescriber_contacted', 'medication_stopped', 'medication_changed',
    'referral_made', 'monitoring_recommended', 'follow_up_scheduled')),
  notes          text check (notes is null or length(notes) <= 1000),
  created_at     timestamptz not null default now(),

  unique (review_id, action, problem_id)
);

create index if not exists idx_medication_review_actions_review
  on medication_review_actions (pharmacy_id, review_id);

-- Same policy shape as every other patient table here: the tenant is the one
-- in the session setting, never a Supabase role name that does not exist on a
-- plain Postgres (see 0054's note).
alter table medication_reviews enable row level security;
alter table medication_review_problems enable row level security;
alter table medication_review_actions enable row level security;

drop policy if exists tenant_isolation on medication_reviews;
create policy tenant_isolation on medication_reviews
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on medication_review_problems;
create policy tenant_isolation on medication_review_problems
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on medication_review_actions;
create policy tenant_isolation on medication_review_actions
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

comment on table medication_reviews is
  'One pharmacist medication review: adherence assessed, problems found, interventions made, outcome and follow-up. A record of a professional act — nothing in it is computed by the software.';
