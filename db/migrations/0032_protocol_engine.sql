-- 0032 — Stage 2 Part 1: the clinical protocol foundation.
--
-- STILL NO TREATMENT INTELLIGENCE. Nothing here diagnoses, recommends a
-- medicine, selects a dose, or lets a model write a clinical rule. What this
-- adds is the machinery for a VERSIONED, CODE-CONTROLLED protocol to ask
-- structured questions and record structured answers with their provenance.
-- The LLM's only role remains conversational: it may phrase a question and
-- read back an answer, but the question set, the order, the validation and
-- every state transition are decided here, in application code, from a
-- protocol definition a pharmacist can read.
--
-- THREE PLACES STAGE 2 CONTRADICTS STAGE 1, AND WHAT WAS DONE
--
-- 1. VERSION FORMAT. 0029 constrained version to `major.minor` ("1.0").
--    Stage 2 asks for "1.0.0". Existing rows are migrated by appending
--    ".0" BEFORE the constraint is tightened, so no row is left violating
--    it — a constraint swap that would fail on live data is not a
--    migration, it is an outage.
--
-- 2. ONE ACTIVE VERSION. 0029 deliberately allowed two versions of a slug
--    to be active at once, and said so in its header: silently retiring the
--    incumbent looked like a policy decision an infrastructure stage should
--    not make. Stage 2 makes that decision explicitly — one ACTIVE per
--    identity. The partial unique index below enforces it, and
--    activateProtocol() now demotes the incumbent to `deprecated` in the
--    same transaction. This REPLACES the earlier choice; it does not
--    accidentally contradict it.
--
-- 3. WHAT A "CLINICAL FACT" IS. 0029's patient_clinical_facts holds facts
--    that OUTLIVE an encounter — an allergy, a chronic condition, a regular
--    medication — and its fact_type is a closed enum of exactly those. A
--    fever severity of 7/10 reported this morning is not one of those
--    things: it is an observation about one episode, true today and
--    meaningless next month. Forcing it into that table would mean widening
--    a deliberately closed enum AND making listFacts() start returning
--    today's symptoms alongside a penicillin allergy — a real behaviour
--    change for every existing caller. encounter_facts below is therefore a
--    SEPARATE table, related by patient_profile_id, and the two are linked
--    (encounter_facts.profile_fact_id) wherever an episode fact was reused
--    from the persistent profile. See §6's conflict handling.

-- ---------------------------------------------------------------------------
-- 1. clinical_protocols — semver, a DEPRECATED state, one ACTIVE per identity
-- ---------------------------------------------------------------------------

-- Data first, constraint second (see note 1 above).
update clinical_protocols
set version = version || '.0'
where version ~ '^[0-9]+\.[0-9]+$';

alter table clinical_protocols drop constraint if exists clinical_protocols_version_check;
alter table clinical_protocols
  add constraint clinical_protocols_version_check
  check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

alter table clinical_protocols drop constraint if exists clinical_protocols_status_check;
alter table clinical_protocols
  add constraint clinical_protocols_status_check
  check (status in ('draft', 'active', 'deprecated', 'retired'));

-- One ACTIVE version per (pharmacy, slug). Partial index: draft and
-- deprecated versions may coexist freely — it is only "which one is live
-- right now" that must be unambiguous.
create unique index if not exists clinical_protocols_one_active_idx
  on clinical_protocols (pharmacy_id, slug)
  where status = 'active';

comment on column clinical_protocols.status is
  'draft -> active -> deprecated -> retired. Only ONE version per (pharmacy_id, slug) may be active — enforced by clinical_protocols_one_active_idx and by clinicalProtocolService.activateProtocol, which demotes the incumbent in the same transaction. Deprecated means superseded but still referenced by historical encounters; retired means withdrawn.';

-- ---------------------------------------------------------------------------
-- 2. protocol_questions — the question set, owned by a protocol VERSION
-- ---------------------------------------------------------------------------
--
-- Questions belong to a version, not to a slug. That is what makes an old
-- encounter reconstructable: the questions it was asked are the ones that
-- existed in the version it recorded, even after the wording changes.
--
-- `applicability` and `validation` are jsonb holding a small, CLOSED
-- vocabulary interpreted by protocolExecutionService — not free-form logic,
-- and emphatically not anything a model may write. See that service for the
-- exact shapes; anything it does not recognise is rejected rather than
-- guessed at.

create table protocol_questions (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  protocol_id   uuid not null references clinical_protocols(id) on delete cascade,

  -- Stable across versions where the question is conceptually "the same
  -- question" — so answers remain comparable when wording changes.
  question_key  text not null check (question_key ~ '^[a-z0-9_]+$'),
  text          text not null check (length(trim(text)) between 1 and 500),
  help_text     text,

  answer_type   text not null check (answer_type in (
    'text', 'number', 'boolean', 'date', 'duration',
    -- A 1-10 self-reported gauge. Deliberately NOT a thermometer reading:
    -- asking a customer for degrees Celsius returns a guess wearing the
    -- costume of a measurement, and a guess recorded as `measured` is worse
    -- than no reading at all. See the fever protocol's severity question.
    'scale',
    'single_choice', 'multi_choice'
  )),

  -- The encounter_facts.concept this question's answer becomes. One
  -- question -> one concept; a question that would produce two facts is two
  -- questions.
  fact_concept  text not null check (fact_concept ~ '^[a-z0-9_]+$'),
  unit          text,

  required      boolean not null default true,
  -- Lower runs first. Ties break on question_key so ordering is total and
  -- deterministic — "next question" must never depend on row insertion order.
  priority      integer not null default 100,

  validation    jsonb not null default '{}'::jsonb,
  -- e.g. {"all_of":[{"concept":"has_fever","equals":true}]} — evaluated by
  -- protocolExecutionService against facts already collected. Empty = always
  -- applicable.
  applicability jsonb not null default '{}'::jsonb,
  choices       jsonb not null default '[]'::jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (protocol_id, question_key)
);

create index protocol_questions_protocol_idx on protocol_questions (protocol_id, priority, question_key);

comment on table protocol_questions is
  'Question definitions owned by a protocol VERSION (Stage 2). Never written by an LLM — a protocol is authored in code/seed and reviewed by a pharmacist. validation/applicability use a closed vocabulary interpreted by protocolExecutionService.';

-- ---------------------------------------------------------------------------
-- 3. protocol_executions — one protocol run inside one encounter
-- ---------------------------------------------------------------------------
--
-- Separate from clinical_encounters.status on purpose, and for the same
-- reason handoff status and conversation ownership are separate axes: an
-- encounter's status is about the CARE (who owns it, is it done), while an
-- execution's state is about the PROTOCOL RUN (have we asked everything).
-- An encounter can be pharmacist_active while its protocol run sits at
-- awaiting_information, and both statements are true at once.

create table protocol_executions (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  encounter_id  uuid not null references clinical_encounters(id) on delete cascade,
  protocol_id   uuid not null references clinical_protocols(id),

  -- Denormalised beside protocol_id, exactly as clinical_encounters does, so
  -- "which version ran" survives the protocol row being deleted.
  protocol_slug    text not null,
  protocol_version text not null,

  state         text not null default 'not_started' check (state in (
    'not_started', 'in_progress', 'awaiting_information',
    'ready_for_review', 'escalated', 'completed', 'cancelled'
  )),

  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One run of a given protocol per encounter. A second fever assessment for
  -- the same episode is the same run resumed, not a new one.
  unique (encounter_id, protocol_id)
);

create index protocol_executions_encounter_idx on protocol_executions (encounter_id);
create index protocol_executions_open_idx on protocol_executions (pharmacy_id, state)
  where state not in ('completed', 'cancelled');

comment on table protocol_executions is
  'Deterministic execution state of one protocol version within one encounter. Only protocolExecutionService may change `state` — never an LLM, never a route handler directly.';

-- ---------------------------------------------------------------------------
-- 4. encounter_answers — the ORIGINAL words, kept beside the parsed value
-- ---------------------------------------------------------------------------
--
-- raw_response is never overwritten and never normalised in place. "Since
-- Monday" and the duration_days=4 derived from it are both kept, because the
-- normalisation can be wrong and the sentence is the evidence. A pharmacist
-- reviewing later needs to see what the person actually typed.

create table encounter_answers (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  execution_id  uuid not null references protocol_executions(id) on delete cascade,
  question_id   uuid not null references protocol_questions(id),
  question_key  text not null,

  raw_response  text,
  -- The parsed value, or null when status is unknown/declined/unparsable.
  normalized_value text,
  normalized_number numeric,
  unit          text,

  status        text not null default 'answered' check (status in (
    'answered', 'unknown', 'declined', 'unparsable'
  )),

  asked_at      timestamptz,
  answered_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index encounter_answers_execution_idx on encounter_answers (execution_id, question_key);

comment on column encounter_answers.raw_response is
  'What the patient actually said, verbatim. Never overwritten by normalisation — the parse can be wrong and this is the evidence.';

-- ---------------------------------------------------------------------------
-- 5. encounter_facts — episode observations, with provenance and conflicts
-- ---------------------------------------------------------------------------
--
-- See note 3 in this file's header for why this is not patient_clinical_facts.
--
-- NOTHING HERE IS A CONCLUSION. `concept` names an observation
-- ('fever_severity_gauge'), never an interpretation ('has_malaria'). The
-- check constraint cannot enforce that — it is enforced by protocol
-- definitions being the only writer of concepts, and by review.

create table encounter_facts (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  encounter_id  uuid not null references clinical_encounters(id) on delete cascade,
  patient_profile_id uuid not null references patient_profiles(id) on delete cascade,

  concept       text not null check (concept ~ '^[a-z0-9_]+$'),
  value         text not null check (length(trim(value)) between 1 and 1000),
  value_number  numeric,
  unit          text,

  source        text not null check (source in (
    'patient_reported', 'pharmacist_reported', 'measured',
    'system_derived', 'ai_extracted', 'profile_reused', 'unknown'
  )),

  status        text not null default 'active' check (status in (
    -- current best value for this concept in this encounter
    'active',
    -- replaced by a later value; kept, never deleted
    'superseded',
    -- disagrees with another fact or with the profile; needs a human
    'conflicted',
    -- the patient does not know / would rather not say. A real answer.
    'unknown', 'declined'
  )),

  -- 0..1. Null where the notion does not apply (a direct answer to a direct
  -- question is not "80% confident", it is simply what they said).
  confidence    numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),

  answer_id     uuid references encounter_answers(id) on delete set null,
  -- Set when this fact was carried in from the persistent profile at
  -- encounter start (§6), so its origin stays visible.
  profile_fact_id uuid references patient_clinical_facts(id) on delete set null,
  -- Set on BOTH sides of a disagreement so either row leads to the other.
  conflicts_with_fact_id uuid references encounter_facts(id) on delete set null,

  collected_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index encounter_facts_encounter_idx on encounter_facts (encounter_id, concept);
create index encounter_facts_conflicts_idx on encounter_facts (pharmacy_id, encounter_id)
  where status = 'conflicted';

comment on table encounter_facts is
  'Episode-scoped observations with provenance (Stage 2). Distinct from patient_clinical_facts, which holds facts that outlive an encounter — see 0032 header note 3. A superseded or conflicted fact is kept, never deleted.';
