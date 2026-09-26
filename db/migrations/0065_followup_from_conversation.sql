-- =====================================================================
-- A follow-up can be raised from a conversation.
-- =====================================================================
--
-- MESSAGES_PLAN.md §5, the brief's §23:
--
--   Patient: "I can come next week for a BP check."
--        ↓   a pharmacist presses Create follow-up
--   Follow-up: Repeat BP, due next week
--
-- 0062 gave `patient_tasks` a `source_type` / `source_id` pair for exactly
-- this — what raised this follow-up — and constrained the kind to the nine
-- things that could raise one at the time. A conversation was not one of
-- them, because the Messages section did not exist.
--
-- This is its own migration rather than a section of 0064 because it changes
-- a DIFFERENT module's vocabulary. 0064 adds two tables Messages owns; this
-- widens a constraint the follow-up queue owns, and a reviewer should be able
-- to see which is which.
--
-- WIDENING ONLY. Every value already accepted is still accepted, so no
-- existing row can violate the new constraint and nothing that writes a
-- follow-up today needs to change. Forward-only, per the runner's rule: 0062
-- is not edited.
--
-- NOTHING IS CREATED AUTOMATICALLY. §23 is explicit — "Do not automatically
-- create a Follow-up just because a message was sent. Make it an explicit
-- action." The column records that a pharmacist raised one FROM a
-- conversation; it does not make one happen. That is the same rule the signed
-- medication review follows (follow-ups phase 2): the system offers, a
-- pharmacist presses.

alter table patient_tasks
  drop constraint if exists patient_tasks_source_type;

alter table patient_tasks
  add constraint patient_tasks_source_type check (source_type is null or source_type in (
    'consultation', 'medication_review', 'care_program', 'test', 'vitals',
    'condition', 'conversation', 'triage', 'manual', 'other')) not valid;

-- Validated immediately: every existing row already satisfies it, because the
-- change only adds a permitted value.
alter table patient_tasks validate constraint patient_tasks_source_type;
