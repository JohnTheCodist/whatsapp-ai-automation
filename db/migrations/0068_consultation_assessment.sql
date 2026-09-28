-- =====================================================================
-- The consultation's assessment — the column 0067 forgot.
-- =====================================================================
--
-- 0067 gave the note a reason, a subjective, an objective and a plan, and no
-- place to write the assessment. Every shipped consultation type lists
-- `assessment` in its `required_sections`, and §23 of the brief sets the
-- minimum for even the simplest consultation at reason + assessment + plan —
-- so as shipped, 0067 created a note that could never be finalised.
--
-- This is a separate migration rather than an edit to 0067 because migrations
-- here are forward-only and 0067 had already been applied. AGENTS.md: "A bad
-- migration is fixed by writing the next one. Never edit an applied
-- migration." The untidiness of two migrations for one phase is the honest
-- record of what happened.
--
-- WHY FREE TEXT, WHEN §12 WANTS A PROBLEM LIST
-- Both, and they are not alternatives. §11 asks for a pharmacist's clinical
-- impression — reasoning, in words, including the uncertainty that matters
-- ("possible", "provisional", "needs evaluation"). §12 asks for a numbered
-- problem list where each entry can point at a Condition, a Medication, a
-- Test or a Vitals reading. Phase 2 adds `consultation_problems` for the
-- second; this is the first, and a note carrying only a problem list would
-- lose the reasoning that connects the problems to what the patient said.
--
-- `sectionFilled('assessment')` in consultationInput.js already treats either
-- as sufficient, so a phase-2 note whose assessment is entirely structured
-- finalises correctly without this column being filled.

alter table pharmacist_consultations
  add column if not exists assessment_text text;

comment on column pharmacist_consultations.assessment_text is
  'The pharmacist''s clinical impression in their own words, including uncertainty. The structured problem list is consultation_problems (phase 2); a note may carry either or both.';
