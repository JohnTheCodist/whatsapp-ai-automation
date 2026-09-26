-- =====================================================================
-- Medication review findings keep the order they were written in.
-- =====================================================================
--
-- THE BUG THIS FIXES. 0056 ordered a review's problems and interventions by
-- `created_at, id`. Inside a transaction `now()` is the transaction's start
-- time, so every finding saved in one go carries the SAME created_at — and
-- saveReview writes them all in one go. The tiebreak was a random uuid, so
-- the order a review read in was random, and could differ between two loads
-- of the same review.
--
-- WHY THAT MATTERS HERE and not on, say, a list of orders: a pharmacist
-- works down a patient's medicines and writes what they find as they go. The
-- sequence is part of what was recorded. Shuffling it does not lose a fact,
-- but it does mean two people reading the same review read a different
-- account of the same consultation.
--
-- POSITION, NOT A TIMESTAMP. clock_timestamp() would also have separated the
-- rows, but it would leave the order as a side effect of how fast the insert
-- loop ran. A position column says what is actually meant: this is the third
-- thing the pharmacist wrote down.
--
-- DEFAULT 0 for the rows written between 0056 and this migration: they keep
-- the id tiebreak they already had, which is the order they are already
-- being read in. No review is re-ordered by this migration.

alter table medication_review_problems
  add column if not exists position smallint not null default 0;

alter table medication_review_actions
  add column if not exists position smallint not null default 0;

-- The read path is "one review's findings, in order" — the same index the
-- review page and the history both use.
drop index if exists idx_medication_review_problems_review;
create index if not exists idx_medication_review_problems_review
  on medication_review_problems (pharmacy_id, review_id, position);

drop index if exists idx_medication_review_actions_review;
create index if not exists idx_medication_review_actions_review
  on medication_review_actions (pharmacy_id, review_id, position);

comment on column medication_review_problems.position is
  'The order the pharmacist wrote this finding down in. Set from the form on every save, because a save replaces the findings wholesale.';
