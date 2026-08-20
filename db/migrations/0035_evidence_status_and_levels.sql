-- 0035 — evidence STATUS, recommendation LEVELS, and full source traceability.
--
-- WHY evidence_status IS NOT DERIVED FROM evidence strength
-- `strength` (0033) describes the SOURCE: how authoritative the document is.
-- `evidence_status` describes THIS RECOMMENDATION: how well that document
-- actually supports this specific piece of guidance. They are different
-- questions and a strong source does not make every claim drawn from it
-- strongly supported — a passage may mention something in passing, or apply
-- to a different population.
--
-- So evidence_status is AUTHORED and reviewed, not computed. It is however
-- CEILINGED by source strength in recommendationService: you cannot claim
-- STRONGLY_SUPPORTED from an `unverified` source. Authored, then bounded.
--
-- WHY 'continue_assessment' IS A NEW EVALUATION STATUS
-- Until now, incomplete information produced `requires_review` with a medium
-- escalation — i.e. it paged a pharmacist every time the assistant had not
-- yet finished asking questions. That is precisely the alert flood the
-- product decision rejects: "MAXIMIZE SAFE AUTOMATION, not MAXIMIZE
-- PHARMACIST ALERTS". Not knowing something yet is a reason to ask, not a
-- reason to interrupt a pharmacist. `continue_assessment` gives that outcome
-- its own name instead of overloading a review status that nobody requested.

-- ---------------------------------------------------------------------------
-- 1. protocol_recommendations.evidence_status — authored, reviewed
-- ---------------------------------------------------------------------------

alter table protocol_recommendations
  add column if not exists evidence_status text not null default 'unknown'
    check (evidence_status in (
      'strongly_supported', 'supported', 'limited_support',
      'not_supported', 'conflicting', 'unknown'
    ));

comment on column protocol_recommendations.evidence_status is
  'How well the cited evidence supports THIS recommendation — authored and reviewed, not derived from source strength (which describes the document, not the claim). Defaults to unknown so an unreviewed row cannot produce guidance. Only strongly_supported/supported may yield direct AI guidance.';

-- ---------------------------------------------------------------------------
-- 2. recommendation_evaluations — level, evidence status, full traceability
-- ---------------------------------------------------------------------------

alter table recommendation_evaluations
  add column if not exists recommendation_level text
    check (recommendation_level is null or recommendation_level in (
      'level_1_guideline_supported', 'level_2_uncertain', 'level_3_high_risk'
    ));

alter table recommendation_evaluations
  add column if not exists evidence_status text;

-- §6 traceability: the section and population are what let a reviewer find
-- the exact passage relied on, rather than the document as a whole.
alter table recommendation_evaluations
  add column if not exists evidence_source_section text;

alter table recommendation_evaluations
  add column if not exists patient_population text;

-- The recommendation row's own version at evaluation time. protocol_version
-- pins the protocol; this pins the RULE, so editing a recommendation later
-- cannot rewrite what an old evaluation was based on.
alter table recommendation_evaluations
  add column if not exists rule_version text;

comment on column recommendation_evaluations.recommendation_level is
  'level_1 = guideline-supported, deliverable to the patient. level_2 = uncertain/incomplete, ask more (NO pharmacist alert). level_3 = high risk, escalate. See safetyGate.deriveLevel.';

-- ---------------------------------------------------------------------------
-- 3. status gains 'continue_assessment'
-- ---------------------------------------------------------------------------
--
-- Rebuilt rather than added to, because a CHECK constraint cannot be extended
-- in place. Existing rows keep their values — every current value remains
-- legal, so this widens the domain without touching data.

alter table recommendation_evaluations
  drop constraint if exists recommendation_evaluations_status_check;

alter table recommendation_evaluations
  add constraint recommendation_evaluations_status_check
    check (status in ('eligible', 'blocked', 'requires_review', 'not_applicable', 'continue_assessment'));

create index if not exists recommendation_evaluations_level_idx
  on recommendation_evaluations (pharmacy_id, recommendation_level, created_at desc);
