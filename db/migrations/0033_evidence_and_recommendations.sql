-- 0033 — Stage 2 Part 2: evidence, recommendations and the safety gate.
--
-- WHAT SHIPS EMPTY, AND WHY THAT IS THE POINT
-- This migration creates the machinery for guideline-backed recommendations
-- and loads ZERO of them. No evidence source, no recommendation rule, no
-- clinical content of any kind is seeded. fever_assessment v1.0.0 still
-- produces no recommendation after this migration, because no approved
-- evidence has been loaded for it — and a recommendation without evidence
-- is exactly what this whole structure exists to make impossible.
--
-- The tests seed their own clearly-labelled TEST-ONLY evidence to prove the
-- gate works. Real guidance is a later, pharmacist-supervised task.
--
-- THE CENTRAL CONSTRAINT
-- protocol_recommendations.evidence_reference_id is NOT NULL. A
-- recommendation cannot physically exist in this database without pointing
-- at a specific section of a specific version of an approved source. That
-- is a stronger guarantee than any application check: there is no code path,
-- and no future code path, that can persist an unsourced recommendation.

-- ---------------------------------------------------------------------------
-- 1. evidence_sources — a document, with its provenance and standing
-- ---------------------------------------------------------------------------

create table evidence_sources (
  id            uuid primary key default gen_random_uuid(),
  -- Null = platform-wide source available to every pharmacy. Set = a
  -- pharmacy's own institutional protocol.
  pharmacy_id   uuid references pharmacies(id) on delete cascade,

  source_key    text not null check (source_key ~ '^[a-z0-9_]+$'),
  title         text not null check (length(trim(title)) between 1 and 300),
  publisher     text,

  -- WHERE the guidance comes from. Distinct from `strength` (how much
  -- weight it carries) because they are genuinely independent: a Nigerian
  -- federal guideline and a generic international one can share a strength
  -- while differing in applicability here.
  origin        text not null check (origin in (
    'global_guidance', 'nigerian_guidance', 'local_protocol',
    'regulatory_source', 'institutional_protocol', 'other_approved_source'
  )),

  -- HOW MUCH WEIGHT it carries. Ordering lives in evidenceService.
  -- STRENGTH_RANK, not in this constraint — the hierarchy is configurable
  -- per spec §3, and encoding an order in a CHECK would freeze it.
  strength      text not null check (strength in (
    'authoritative_guideline', 'local_clinical_guideline', 'regulatory_source',
    'established_protocol', 'trusted_reference', 'secondary_reference', 'unverified'
  )),

  version       text not null,
  published_date date,
  review_date   date,
  locator       text,

  -- An evidence source is not usable until a person approves it. Default
  -- 'draft' means an ingested document cannot back a recommendation on the
  -- strength of having been uploaded (spec §11).
  status        text not null default 'draft' check (status in ('draft', 'active', 'deprecated', 'retired')),
  approved_by   uuid references auth.users(id) on delete set null,
  approved_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (pharmacy_id, source_key, version)
);

create index evidence_sources_lookup_idx on evidence_sources (pharmacy_id, source_key, status);

comment on table evidence_sources is
  'An approved clinical document. status defaults to draft — ingesting a document does not make it usable evidence; a person must approve it (spec §11). origin and strength are independent axes: see 0033 header.';

-- ---------------------------------------------------------------------------
-- 2. evidence_references — the specific passage relied upon
-- ---------------------------------------------------------------------------
--
-- A recommendation cites a SECTION, not a whole document. "Supported by the
-- national guideline" is not traceable; "section 4.2, which applies to
-- adults over 12" is.

create table evidence_references (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  source_id     uuid not null references evidence_sources(id) on delete cascade,

  section       text not null check (length(trim(section)) between 1 and 200),
  -- A short summary of what the section says, for pharmacist review. NOT
  -- fed to a model as ground truth, and never the basis for generating new
  -- clinical claims.
  summary       text,
  -- Free-text description of who the passage applies to. Machine-checkable
  -- eligibility lives on the recommendation, not here — this is the human
  -- record of scope.
  population    text,
  locator       text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index evidence_references_source_idx on evidence_references (source_id);

-- ---------------------------------------------------------------------------
-- 3. protocol_recommendations — an authored rule, owned by a protocol VERSION
-- ---------------------------------------------------------------------------
--
-- NOTHING HERE IS GENERATED. Every row is authored by a person and reviewed.
-- The LLM has no write path to this table — see recommendationService, whose
-- only lookup is by key against configured rows, so there is no function
-- anywhere that accepts free-text recommendation content.

create table protocol_recommendations (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  protocol_id   uuid not null references clinical_protocols(id) on delete cascade,

  recommendation_key text not null check (recommendation_key ~ '^[a-z0-9_]+$'),

  -- Deliberately narrow. Anything involving a specific medicine or dose is
  -- absent, and adding one is a decision for a later stage under clinical
  -- governance — not a value someone can quietly append here.
  recommendation_type text not null check (recommendation_type in (
    'self_care_advice',    -- non-pharmacological
    'seek_pharmacist',     -- speak to the pharmacy team
    'seek_medical_care',   -- see a doctor / go to hospital
    'information'          -- factual, non-directive
  )),

  recommendation_text text not null check (length(trim(recommendation_text)) between 1 and 2000),

  -- Machine-checkable conditions, same closed vocabulary the question
  -- engine uses (protocolExecutionService.isApplicable).
  eligibility_conditions jsonb not null default '{}'::jsonb,
  exclusion_conditions   jsonb not null default '{}'::jsonb,

  -- THE CENTRAL CONSTRAINT — see this file's header.
  evidence_reference_id uuid not null references evidence_references(id),

  -- Per-recommendation gate thresholds, so a higher-risk recommendation can
  -- demand better evidence and higher confidence than a benign one.
  min_evidence_strength text not null default 'established_protocol',
  min_clinical_confidence numeric not null default 0.80
    check (min_clinical_confidence >= 0 and min_clinical_confidence <= 1),

  -- May this EVER be delivered without a pharmacist seeing it first? False
  -- by default: autonomy is granted per-recommendation by a person, never
  -- assumed. This is the switch behind spec §6's "routine cases need not
  -- interrupt the pharmacist".
  autonomous_scope boolean not null default false,

  status        text not null default 'draft' check (status in ('draft', 'active', 'retired')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (protocol_id, recommendation_key)
);

create index protocol_recommendations_protocol_idx
  on protocol_recommendations (protocol_id, status);

comment on table protocol_recommendations is
  'Authored, evidence-backed recommendation rules owned by a protocol version. evidence_reference_id is NOT NULL by design — an unsourced recommendation cannot be stored. autonomous_scope defaults false: no recommendation bypasses a pharmacist unless a person explicitly allows it.';

-- ---------------------------------------------------------------------------
-- 4. recommendation_evaluations — what the gate decided, and exactly why
-- ---------------------------------------------------------------------------
--
-- decision_trace is the evaluation itself, not a summary written beside it.
-- The human-readable explanation is RENDERED FROM this column, so an
-- explanation that disagrees with the decision is not something the code can
-- express (spec §9).

create table recommendation_evaluations (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  encounter_id  uuid not null references clinical_encounters(id) on delete cascade,
  execution_id  uuid not null references protocol_executions(id) on delete cascade,
  -- Nullable: an evaluation can conclude "no configured recommendation
  -- applies", which is a real, recordable outcome with no rule attached.
  recommendation_id uuid references protocol_recommendations(id) on delete set null,

  protocol_slug    text not null,
  protocol_version text not null,
  -- Pinned so an evaluation stays reconstructable after the source is
  -- revised, exactly as encounters pin protocol_version.
  evidence_source_key     text,
  evidence_source_version text,
  evidence_strength       text,

  status        text not null check (status in ('eligible', 'blocked', 'requires_review', 'not_applicable')),
  safety_status text not null check (safety_status in ('passed', 'blocked', 'review_required')),

  clinical_confidence numeric check (clinical_confidence is null or (clinical_confidence >= 0 and clinical_confidence <= 1)),

  -- Null when no escalation is warranted — which is the whole point of §6.
  escalation_priority text check (escalation_priority is null or escalation_priority in ('low', 'medium', 'high', 'urgent')),
  pharmacist_review_status text not null default 'not_required'
    check (pharmacist_review_status in ('not_required', 'pending', 'in_review', 'completed')),

  -- Machine-readable, ordered list of every check and its outcome.
  decision_trace jsonb not null default '[]'::jsonb,
  -- Stable codes ('missing_required_information', 'red_flag_present', ...)
  -- for querying and alerting without parsing prose.
  blocking_reasons jsonb not null default '[]'::jsonb,

  created_at    timestamptz not null default now()
);

create index recommendation_evaluations_encounter_idx
  on recommendation_evaluations (encounter_id, created_at desc);
create index recommendation_evaluations_review_idx
  on recommendation_evaluations (pharmacy_id, escalation_priority, created_at desc)
  where pharmacist_review_status = 'pending';

comment on column recommendation_evaluations.decision_trace is
  'The actual ordered evaluation — every gate check, its inputs and its outcome. The human-readable explanation is rendered FROM this, never written separately, so an explanation cannot disagree with the decision (spec §9).';
