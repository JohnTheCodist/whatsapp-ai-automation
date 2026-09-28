-- =====================================================================
-- Consultation: what the PHARMACIST assessed and did.
-- =====================================================================
--
-- See CONSULTATION_PLAN.md. Phase 1 of the owner's 43-section brief.
--
-- WHY A NEW TABLE AND NOT MORE COLUMNS ON clinical_encounters
-- 0029's `clinical_encounters` is the EPISODE: what the patient reported in a
-- WhatsApp conversation, how long the symptom had lasted, which red flag
-- fired, which protocol ran. It is written by the assistant during a live
-- conversation — `clinicalEncounterService`, `recommendationService` and
-- `routes/conversations.js` all write it while a patient is mid-thread.
--
-- What the pharmacist decides afterwards is a different record, by a different
-- author, with a different life:
--
--   the encounter      written by the engine, during the conversation,
--                      already `completed` by the time anybody reviews it
--   the consultation   written by a person, possibly days later, drafted,
--                      finalised, and amendable only with a reason
--
-- It is also one-to-many: a long episode can carry more than one pharmacist
-- assessment, and one row cannot hold two. This is the split the brief itself
-- names from Medplum — Encounter beside ClinicalImpression — and it is the
-- reason the live path needs no change at all for this feature.
--
-- ENCOUNTER IS OPTIONAL, DELIBERATELY (owner's decision, plan §11.1).
-- Most community-pharmacy consultations happen at the counter with no WhatsApp
-- thread behind them. A module that could only document the minority which
-- began in a chat would be the wrong module. Where there IS an encounter, the
-- consultation points at it and the triage summary is read from it; where
-- there is not, that section is absent rather than invented.
--
-- NOTHING CLINICAL IS DUPLICATED HERE. A blood pressure lives in Vitals, a
-- diagnosis in Conditions, a result in Tests, a medicine in Medications. This
-- table holds the pharmacist's narrative and their decisions. §36 of the brief
-- is explicit and it is also the house rule since 0059: an inference is shown
-- as a labelled suggestion and becomes a record only when somebody writes it
-- down.

-- ---------------------------------------------------------------------------
-- consultation_definitions — the types, as DATA (§24)
-- ---------------------------------------------------------------------------
--
-- The pattern `test_definitions` (0060) and `care_program_definitions` (0061)
-- already use: shipped rows carry `pharmacy_id is null` and are readable by
-- every tenant; a pharmacy may add its own.
--
-- A type does not create a separate form. It says which sections are
-- EMPHASISED and which must be filled before the note can be finalised — §24
-- says conditional rendering, not separate systems. `required_sections` is the
-- whole of §23's "conditional requirements": a minor ailment needs a reason,
-- an assessment and a plan; a chronic-disease review also needs the objective
-- findings that make it a review.

create table if not exists consultation_definitions (
  id                 uuid primary key default gen_random_uuid(),
  pharmacy_id        uuid references pharmacies(id) on delete cascade,
  slug               text not null,
  label              text not null,
  -- Which sections this type puts in front of the pharmacist first. Ordering
  -- only — every section remains reachable.
  emphasis           jsonb not null default '[]'::jsonb,
  -- Which sections must carry something before `completed` is allowed.
  required_sections  jsonb not null default '["reason","assessment","plan"]'::jsonb,
  sort_order         integer not null default 100,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (pharmacy_id, slug)
);

-- One shipped row per slug, and a pharmacy may shadow it with its own.
create unique index if not exists consultation_definitions_shipped_slug
  on consultation_definitions (slug) where pharmacy_id is null;

-- ---------------------------------------------------------------------------
-- pharmacist_consultations — the note
-- ---------------------------------------------------------------------------
--
-- WHY THE STATUS SET IS FOUR AND NOT MORE
-- draft / in_progress / completed / entered_in_error, which is §39 and is what
-- Medplum's ClinicalImpression carries. A finalised note is NOT deleted — the
-- medication review (0056) settled that for this codebase: "a signed review is
-- the record of a professional act. It is not deleted." Entered-in-error is
-- how a note that should never have existed is retired, visibly.
--
-- Amendment is phase 3 and is not faked here: this migration gives the note
-- `finalised_at`/`finalised_by` and the CHECKs that keep them honest, and
-- phase 3 adds the snapshot table that lets a finalised note be corrected with
-- a reason rather than overwritten.

create table if not exists pharmacist_consultations (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  customer_id         uuid not null references customers(id) on delete cascade,

  -- The episode this belongs to, when there is one. Null for a consultation
  -- that happened at the counter — which is most of them.
  encounter_id        uuid references clinical_encounters(id) on delete set null,

  -- The type, by slug rather than by id: a pharmacy shadowing a shipped type
  -- must not silently change what an existing note was recorded as.
  consultation_type   text not null,

  status              text not null default 'draft'
                      check (status in ('draft', 'in_progress', 'completed', 'entered_in_error')),

  -- ---- §7 reason -------------------------------------------------------
  reason_code         text,
  reason_text         text,
  duration_text       text,
  patient_goal        text,

  -- ---- §8 / §9 the narrative ------------------------------------------
  --
  -- Free text on purpose, and this is the one place in the module where that
  -- is right: §38 says structured fields for anything that will later be
  -- searched, filtered or graphed, and free text for clinical reasoning and
  -- the patient's narrative. A blood pressure is not stored here — it is
  -- recorded in Vitals and pointed at.
  subjective          text,
  objective           text,
  -- §9's focused findings, kept apart from the free narrative so a screen can
  -- show them as fields without parsing prose. Community-pharmacy scope only:
  -- there is no review of systems and no full physical examination (§35).
  focused_findings    jsonb not null default '{}'::jsonb,

  -- ---- §18 plan --------------------------------------------------------
  plan_text           text,
  plan_actions        jsonb not null default '[]'::jsonb,

  notes               text,

  -- ---- who and when (§32) ---------------------------------------------
  started_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  completed_at        timestamptz,
  finalised_by        uuid references auth.users(id) on delete set null,
  -- Why a note was retired. Required when it is, for the same reason 0060
  -- requires a reason on a corrected report: "saying a report was cancelled,
  -- amended or corrected always says why".
  error_reason        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A completed note has a completion time and the person who finalised it;
  -- an open one has neither. The same shape as medication_reviews' signing
  -- CHECK, which is what stops "completed" becoming a label nothing enforces.
  constraint pharmacist_consultations_completion check (
    (status in ('draft', 'in_progress') and completed_at is null and finalised_by is null)
    or (status = 'completed' and completed_at is not null)
    or (status = 'entered_in_error' and error_reason is not null)
  )
);

create index if not exists pharmacist_consultations_patient_idx
  on pharmacist_consultations (pharmacy_id, customer_id, started_at desc);
create index if not exists pharmacist_consultations_open_idx
  on pharmacist_consultations (pharmacy_id, status) where status in ('draft', 'in_progress');
create index if not exists pharmacist_consultations_encounter_idx
  on pharmacist_consultations (encounter_id) where encounter_id is not null;
-- §40's history filters: by type, and by the pharmacist who wrote it.
create index if not exists pharmacist_consultations_type_idx
  on pharmacist_consultations (pharmacy_id, consultation_type, started_at desc);

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0058 / 0059 / 0060 / 0061 / 0064
-- ---------------------------------------------------------------------------
alter table pharmacist_consultations enable row level security;
alter table consultation_definitions enable row level security;

drop policy if exists tenant_isolation on pharmacist_consultations;
create policy tenant_isolation on pharmacist_consultations
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- The shipped catalogue is readable by every tenant; a pharmacy's own rows are
-- its own. Identical to test_definitions and care_program_definitions.
drop policy if exists tenant_isolation on consultation_definitions;
create policy tenant_isolation on consultation_definitions
  using (pharmacy_id is null or pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- The shipped types (§24)
-- ---------------------------------------------------------------------------
--
-- Idempotent, and DATA rather than code so a pharmacy can add its own without
-- a deploy. `required_sections` is the honest minimum for each: §23 says do
-- not force unnecessary fields, and a minor ailment that took ninety seconds
-- should not demand the same note as a chronic-disease review.

insert into consultation_definitions (pharmacy_id, slug, label, emphasis, required_sections, sort_order)
values
  (null, 'minor_ailment', 'Minor ailment',
   '["subjective","objective","assessment"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 10),
  (null, 'medication_review', 'Medication review',
   '["medications","assessment","interventions"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 20),
  (null, 'chronic_disease_review', 'Chronic disease review',
   '["vitals","medications","assessment","plan"]'::jsonb,
   '["reason","objective","assessment","plan"]'::jsonb, 30),
  (null, 'bp_review', 'Blood pressure review',
   '["vitals","assessment","plan"]'::jsonb,
   '["reason","objective","assessment","plan"]'::jsonb, 40),
  (null, 'glucose_review', 'Blood glucose review',
   '["vitals","tests","assessment","plan"]'::jsonb,
   '["reason","objective","assessment","plan"]'::jsonb, 50),
  (null, 'weight_management', 'Weight management',
   '["vitals","plan"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 60),
  (null, 'prescription_review', 'Prescription review',
   '["medications","assessment","interventions"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 70),
  (null, 'adverse_drug_reaction', 'Adverse drug reaction',
   '["medications","subjective","assessment","referral"]'::jsonb,
   '["reason","subjective","assessment","plan"]'::jsonb, 80),
  (null, 'otc_consultation', 'OTC consultation',
   '["subjective","assessment","interventions"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 90),
  (null, 'health_screening', 'Health screening',
   '["vitals","tests","plan"]'::jsonb,
   '["reason","objective","plan"]'::jsonb, 100),
  (null, 'followup_consultation', 'Follow-up consultation',
   '["assessment","plan"]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 110),
  (null, 'other', 'Other',
   '[]'::jsonb,
   '["reason","assessment","plan"]'::jsonb, 200)
on conflict do nothing;

comment on table pharmacist_consultations is
  'What the PHARMACIST assessed and did. The episode itself is clinical_encounters (0029); this is the assessment beside it, and it may stand alone for a counter consultation.';
comment on column pharmacist_consultations.encounter_id is
  'The WhatsApp episode this assessment belongs to, when there is one. Null for a consultation that happened at the counter.';
comment on table consultation_definitions is
  'Consultation types as DATA. A type controls emphasis and what must be filled to finalise — never a separate form.';
