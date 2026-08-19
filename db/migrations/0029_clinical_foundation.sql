-- 0029 — Clinical AI Stage 1: foundation only, no treatment intelligence.
--
-- WHAT THIS DOES NOT DO
-- No diagnosis logic, no drug recommendation, no dosing, no protocol
-- content. Every clinical_protocols row this migration seeds is metadata —
-- a name and a version, nothing that tells the assistant what to say about
-- a disease. That is deliberate: this migration is data structure, later
-- work is medical judgement, and the two must not ship in the same change.
--
-- WHAT ALREADY EXISTED AND IS DELIBERATELY REUSED, NOT DUPLICATED
--   - Audit trail: customer_events + recordEvent() (0017/Segment 1.5).
--     actor_type already distinguishes 'ai' / 'pharmacist' / 'staff' /
--     'customer' / 'system' — exactly the actor vocabulary this stage
--     needs, so no new audit table is created. Clinical event types are
--     added to PATIENT_EVENTS (patientEventTypes.js), not a parallel enum.
--   - Handoff mechanics: the `handoffs` table plus conversationState's
--     deriveOwnership() already implement PENDING-vs-ACCEPTED-vs-ACTIVE
--     correctly (Segment "Hybrid Pharmacist/Team Handoff") — a handoff
--     being raised does not mute the assistant; only an explicit
--     POST /:id/takeover does. This migration adds ONE nullable column
--     (encounter_id) to `handoffs` so a clinical escalation can carry its
--     structured context, rather than building a second handoff table that
--     would immediately drift from the first.
--   - Customer identity: `customers` remains the WhatsApp identity. Nothing
--     here duplicates wa_phone/identity_key resolution.
--
-- WHAT IS GENUINELY NEW
--   patient_profiles              persistent clinical identity for a customer
--   patient_clinical_facts        allergies/conditions/medications, WITH
--                                  provenance (reported vs confirmed, and by
--                                  whom) — see the header comment on that
--                                  table for why this cannot be a JSON blob
--                                  on patient_profiles
--   clinical_encounters           one clinical episode; temporary/episode
--                                  data lives HERE, not on the profile
--   clinical_protocols            versioned metadata only — no content
--   protocol_red_flags            versioned rule metadata only — no content

-- ---------------------------------------------------------------------------
-- patient_profiles
-- ---------------------------------------------------------------------------
--
-- 1:1 with a customer for Stage 1 (UNIQUE customer_id below). A customer
-- ordering on behalf of someone else — a parent for a child — is real and
-- explicitly out of scope here: modelling "who is this encounter actually
-- about" as a distinct person from "who is texting us" is a real feature,
-- not a column, and building it now on a guess would be exactly the
-- overbuilding Stage 1 was told not to do. The 1:1 constraint is the
-- honest boundary; loosening it later is a migration, not a rewrite.

create table patient_profiles (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,

  -- Deliberately NOT duplicating customer.full_name — that is the account
  -- holder's name, verified by isGroundedIn() against what they actually
  -- typed (Segment 1.7). This field exists only for the rare case the
  -- clinical name differs (a pharmacist correction, a formal name for
  -- records) and stays null until someone actually sets it.
  clinical_name text,
  date_of_birth date,
  -- Age as reported, for when a customer will not give a birth date but
  -- will say "I'm 34". Never both trusted equally — age_reported_at exists
  -- so a stale "34" from eight years ago is not read as current.
  age_years     integer check (age_years is null or age_years between 0 and 130),
  age_reported_at timestamptz,
  sex           text check (sex is null or sex in ('male', 'female', 'unknown')),

  -- Free-text only for information that has NO structured home yet — an
  -- allergy or a current medication belongs in patient_clinical_facts
  -- below, with provenance. This field is for a pharmacist's own prose note
  -- ("family history of hypertension") that does not fit that shape.
  important_safety_information text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (pharmacy_id, customer_id)
);

create index patient_profiles_customer_idx on patient_profiles (pharmacy_id, customer_id);

comment on table patient_profiles is
  'Persistent clinical identity for a customer. Episode-specific facts (today''s symptoms) belong in clinical_encounters, not here — see 0029 header.';

-- ---------------------------------------------------------------------------
-- patient_clinical_facts — allergies, conditions, medications, WITH PROVENANCE
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS A TABLE AND NOT THREE JSONB ARRAYS ON patient_profiles
-- "I think I'm allergic to penicillin" and a pharmacist confirming it later
-- are two different facts in this system's eyes, not one field overwritten.
-- A JSON array of strings has nowhere to put status or source without
-- inventing an ad-hoc object shape per array entry — the same reasoning
-- that made tags a join table instead of a comma-separated column
-- (Segment 1.8). A row per fact gives status and source first-class
-- columns, an index, and a place for a pharmacist's confirmation to be its
-- own auditable event rather than a silent overwrite.
--
-- status: what this fact's confidence actually is right now.
-- source:  WHO said so. AI_EXTRACTED exists and is used carefully: it marks
--          the AI's own reading of what the customer said, always starting
--          at status='reported', NEVER 'confirmed' — only a pharmacist
--          action can move a fact to confirmed. See §16/§17 of the spec
--          this migration implements; enforced in clinicalEncounterService,
--          not by a trigger here, so the reasoning stays readable in code.

create table patient_clinical_facts (
  id                  uuid primary key default gen_random_uuid(),
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  patient_profile_id  uuid not null references patient_profiles(id) on delete cascade,
  -- Which encounter surfaced this, if any. Nullable: a pharmacist can add a
  -- fact directly against the patient with no encounter in progress.
  encounter_id        uuid,

  fact_type   text not null check (fact_type in ('allergy', 'condition', 'medication', 'safety_info')),
  value       text not null check (length(trim(value)) between 1 and 500),
  status      text not null default 'reported' check (status in ('reported', 'confirmed', 'unknown')),
  source      text not null check (source in ('patient_reported', 'pharmacist_recorded', 'system_imported', 'ai_extracted')),

  recorded_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index patient_clinical_facts_profile_idx
  on patient_clinical_facts (pharmacy_id, patient_profile_id, fact_type);

comment on table patient_clinical_facts is
  'One row per clinical fact, never overwritten silently. status distinguishes what the patient said from what a pharmacist confirmed — see 0029 header. AI_EXTRACTED facts must start status=reported; only a pharmacist action may set confirmed.';

-- ---------------------------------------------------------------------------
-- clinical_protocols — versioned METADATA ONLY. No treatment content.
-- ---------------------------------------------------------------------------
--
-- Every text column below is a LABEL or a rule about WHEN a protocol
-- applies and who must review it — never what to do clinically. `questions`
-- and `permitted_advice` are jsonb and empty by default on purpose: Stage 1
-- creates the shape a future stage fills in, under its own review, not this
-- migration's.

create table clinical_protocols (
  id                   uuid primary key default gen_random_uuid(),
  pharmacy_id          uuid references pharmacies(id) on delete cascade,
  -- Nullable pharmacy_id: a protocol may eventually be a platform-wide
  -- default every pharmacy starts from. Stage 1 does not decide that policy;
  -- it just does not foreclose it by forcing every protocol to belong to
  -- one tenant.
  slug                 text not null check (slug ~ '^[a-z0-9_]+$'),
  name                 text not null check (length(trim(name)) between 1 and 120),
  description          text,
  -- The clinical domain this protocol covers, e.g. 'fever' — a label for
  -- routing and display, not a diagnosis.
  condition_domain     text,
  version              text not null check (version ~ '^[0-9]+\.[0-9]+$'),
  status               text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  source               text,
  source_reference     text,
  effective_date       date,
  review_date          date,
  population           text,
  -- Structured content placeholders. Empty by default; a later stage
  -- populates these under clinical governance, not this migration.
  required_information jsonb not null default '[]'::jsonb,
  questions             jsonb not null default '[]'::jsonb,
  exclusion_criteria    jsonb not null default '[]'::jsonb,
  pharmacist_review_rules jsonb not null default '[]'::jsonb,
  referral_rules         jsonb not null default '[]'::jsonb,
  permitted_advice       jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A protocol identity is (slug, version) — "fever" has many rows, one per
  -- version, each independently referenceable so an old encounter's
  -- protocol_version keeps meaning something after the slug moves on.
  unique (pharmacy_id, slug, version)
);

create index clinical_protocols_slug_idx on clinical_protocols (pharmacy_id, slug, status);

comment on table clinical_protocols is
  'Versioned protocol METADATA ONLY (Stage 1). required_information/questions/exclusion_criteria/pharmacist_review_rules/referral_rules/permitted_advice are empty placeholders — a future stage populates content under clinical governance, not this migration.';

-- ---------------------------------------------------------------------------
-- protocol_red_flags — versioned rule METADATA ONLY. No clinical rules yet.
-- ---------------------------------------------------------------------------

create table protocol_red_flags (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  protocol_id   uuid not null references clinical_protocols(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 200),
  description   text,
  severity      text not null default 'review' check (severity in ('review', 'urgent', 'emergency')),
  -- Mirrors the future action vocabulary named in the spec. No trigger
  -- condition is stored yet — "when does this fire" is Stage 4's question.
  action        text not null default 'pharmacist_review'
    check (action in ('pharmacist_review', 'urgent_referral', 'emergency_referral')),
  active        boolean not null default false,
  source        text,
  source_reference text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index protocol_red_flags_protocol_idx on protocol_red_flags (protocol_id, active);

comment on table protocol_red_flags is
  'Versioned red-flag rule METADATA ONLY (Stage 1). active defaults false — nothing here fires until a later stage defines real trigger conditions and a clinician turns it on deliberately.';

-- ---------------------------------------------------------------------------
-- clinical_encounters
-- ---------------------------------------------------------------------------
--
-- EPISODE-specific data lives here — see 0029 header. "I've had a fever for
-- two days" is a clinical_encounters row, never a patient_profiles column;
-- the distinction is what makes it possible to see a patient's persistent
-- allergy list without it being buried in six months of one-off symptom
-- reports.

create table clinical_encounters (
  id                    uuid primary key default gen_random_uuid(),
  pharmacy_id           uuid not null references pharmacies(id) on delete cascade,
  patient_profile_id    uuid not null references patient_profiles(id) on delete cascade,
  -- Nullable: a conversation MAY create an encounter (spec §7), not every
  -- conversation is one, and (in principle) a pharmacist could open an
  -- encounter with no live conversation behind it.
  conversation_id       uuid references conversations(id) on delete set null,

  status                text not null default 'active' check (status in (
    'active', 'waiting_for_patient', 'pharmacist_review_required',
    'pharmacist_active', 'referred', 'completed', 'cancelled'
  )),

  -- Episode-reported clinical content. Free text by design for Stage 1 —
  -- structured capture is Stage 3's "dynamic clinical questioning", and
  -- forcing a rigid shape on it now, before that engine exists, would mean
  -- redesigning this table the moment it does.
  presenting_complaint  text,
  reported_symptoms     text,
  symptom_duration      text,
  severity              text,
  relevant_history       text,
  -- Snapshots of what THIS encounter reported, independent of
  -- patient_clinical_facts' persistent list — a customer's answer today can
  -- differ from what is on file, and both must be visible: what they said
  -- now, and what is on record.
  current_medications_reported text,
  allergies_reported     text,
  relevant_observations  text,
  patient_concerns       text,

  -- Nothing here is a diagnosis. jsonb array of flag identifiers/labels
  -- detected — empty until Stage 4 defines real detection.
  red_flags_detected    jsonb not null default '[]'::jsonb,

  protocol_id           uuid references clinical_protocols(id) on delete set null,
  -- Denormalised alongside protocol_id on purpose: if the protocol row is
  -- ever deleted, this encounter must still say what version was active
  -- when it happened (spec §9's whole point).
  protocol_slug          text,
  protocol_version        text,

  assessment_status      text,
  pharmacist_review_status text,
  referral_status         text,

  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index clinical_encounters_patient_idx
  on clinical_encounters (pharmacy_id, patient_profile_id, started_at desc);
create index clinical_encounters_conversation_idx
  on clinical_encounters (conversation_id) where conversation_id is not null;
create index clinical_encounters_status_idx
  on clinical_encounters (pharmacy_id, status) where status not in ('completed', 'cancelled');

comment on table clinical_encounters is
  'One clinical episode. red_flags_detected/protocol_id are Stage-1 PLUMBING — nothing populates them with real clinical judgement yet. See 0029 header for what patient_profiles vs this table each own.';

-- ---------------------------------------------------------------------------
-- handoffs: one additive column, linking a handoff to its clinical context
-- ---------------------------------------------------------------------------
--
-- Deliberately the ONLY change to an existing, working table. Everything
-- else about how a handoff is raised, notified, accepted and released
-- already works (see handoffService.js, conversationState.deriveOwnership,
-- routes/conversations.js /takeover and /release) and none of it needed to
-- change for this stage — a clinical handoff is still a handoff, it just
-- now MAY carry a pointer to the structured encounter behind it.

alter table handoffs
  add column if not exists encounter_id uuid references clinical_encounters(id) on delete set null;

create index if not exists handoffs_encounter_idx on handoffs (encounter_id) where encounter_id is not null;

comment on column handoffs.encounter_id is
  'Optional link to the clinical_encounters row this handoff concerns. Null for non-clinical handoffs (order issues, "speak to a person"). The handoff''s own accepted_at/resolved_at remain the single source of truth for PENDING vs ACCEPTED vs ACTIVE vs COMPLETED — see conversationState.deriveOwnership.';
