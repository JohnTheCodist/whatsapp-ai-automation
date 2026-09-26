-- =====================================================================
-- Follow-up: one task table for the patient, not two.
-- =====================================================================
--
-- See FOLLOWUP_PLAN.md. 0061 created care_program_activities as this
-- product's FIRST task concept, with a due date, an assignee, a status, a
-- recurrence and a completion. Its header said a general Tasks module should
-- grow from that table rather than arrive beside it. This is that growth.
--
-- WHY A RENAME AND NOT A SECOND TABLE
-- A follow-up raised from a consultation and an activity inside a care
-- programme are the same kind of row: a thing to be done for this patient, on
-- a date, by somebody, possibly repeating. Two tables would give "what does
-- this patient need next?" two answers, two overdue calculations and two
-- due-today lists — the mistake 0055 avoided when it extended
-- medication_journeys rather than adding patient_medications beside it.
--
--   program_id IS NULL      a follow-up raised on its own
--   program_id IS NOT NULL  a care-programme activity, which is also a
--                           follow-up and appears in the same queue
--
-- THE CARE PROGRAMME'S BEHAVIOUR DOES NOT CHANGE. Every query that reads a
-- programme's plan already filters on program_id, so a patient-level
-- follow-up can never appear in a programme's task list or its progress
-- counts.
--
-- customer_id IS THE IMPORTANT ADDITION. A task used to reach its patient
-- through its programme. A follow-up has no programme, so the patient id
-- moves onto the row — backfilled below, then made NOT NULL. It is also what
-- makes "this patient's action queue" one indexed query.
--
-- NOTHING CLINICAL IS STORED HERE, still. A follow-up records that a blood
-- pressure should be repeated; the reading itself belongs to patient_vitals
-- and is pointed at by linked_type/linked_id.
--
-- Forward-only: 0061 is never edited.

-- ---------------------------------------------------------------------------
-- The rename, and the patient
-- ---------------------------------------------------------------------------
alter table if exists care_program_activities rename to patient_tasks;

alter table patient_tasks alter column program_id drop not null;

alter table patient_tasks add column if not exists customer_id uuid;

-- Every existing row belongs to a programme, and the programme knows whose it
-- is. Written before the NOT NULL below so the constraint can be trusted.
update patient_tasks t
   set customer_id = p.customer_id
  from patient_care_programs p
 where p.id = t.program_id
   and t.customer_id is null;

-- A task with no programme AND no patient belongs to nobody. There are none —
-- every row came from a programme — so this is safe to enforce now.
alter table patient_tasks alter column customer_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'patient_tasks_customer_fk'
  ) then
    alter table patient_tasks
      add constraint patient_tasks_customer_fk
      foreign key (customer_id) references customers(id) on delete cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- What a follow-up needs that an activity did not
-- ---------------------------------------------------------------------------
alter table patient_tasks
  -- WHY it needs to happen (brief §2.2, §7). Free text: "BP was elevated at
  -- the last consultation" is the sentence that makes the task actionable
  -- three weeks later, and no list of codes would carry it.
  add column if not exists reason text,
  add column if not exists priority text not null default 'routine',
  -- WHAT RAISED IT (§8) — distinct from linked_type/linked_id, which already
  -- means what the task PRODUCED (§12). Cause and result are different facts
  -- and a row can carry both: "raised by the consultation on 6 Sep, produced
  -- the reading on 24 Sep".
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  -- How it turned out (§13). Only ever set by a person completing it.
  add column if not exists outcome text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  -- Moved how many times (§14). The audit trail holds every move with its
  -- dates; this is here so "rescheduled three times" is visible in a list
  -- without reading the trail.
  add column if not exists rescheduled_count smallint not null default 0,
  -- Optional (§7). OVERDUE STAYS A DATE COMPARISON: a task due at 17:00 is
  -- not late at 09:00, and the Lagos-day rule the rest of this product uses
  -- would have to become a clock rule to say otherwise.
  add column if not exists due_time time;

alter table patient_tasks
  add constraint patient_tasks_reason_len check (reason is null or length(reason) <= 500) not valid;
alter table patient_tasks validate constraint patient_tasks_reason_len;

alter table patient_tasks
  add constraint patient_tasks_priority check (priority in ('routine', 'urgent')) not valid;
alter table patient_tasks validate constraint patient_tasks_priority;

alter table patient_tasks
  add constraint patient_tasks_source_type check (source_type is null or source_type in (
    'consultation', 'medication_review', 'care_program', 'test', 'vitals',
    'condition', 'triage', 'manual', 'other')) not valid;
alter table patient_tasks validate constraint patient_tasks_source_type;

-- An id with no kind points at nothing anybody can resolve. A KIND with no id
-- is fine: "raised at a consultation" is true even when nobody picked which.
alter table patient_tasks
  add constraint patient_tasks_source_pair check (source_id is null or source_type is not null) not valid;
alter table patient_tasks validate constraint patient_tasks_source_pair;

alter table patient_tasks
  add constraint patient_tasks_outcome check (outcome is null or outcome in (
    'completed', 'improved', 'stable', 'no_improvement', 'worsened',
    'unable_to_assess', 'did_not_attend', 'referred', 'needs_further_followup',
    'other')) not valid;
alter table patient_tasks validate constraint patient_tasks_outcome;

-- An outcome describes something that was done or deliberately not done. A
-- task still waiting has no outcome, and a cancelled one has a reason instead.
alter table patient_tasks
  add constraint patient_tasks_outcome_when check (
    outcome is null or status in ('completed', 'skipped')) not valid;
alter table patient_tasks validate constraint patient_tasks_outcome_when;

-- Cancelling says when, as completing already says when (§15). The reason is
-- carried by status_reason, which 0061 already requires for a cancelled row.
alter table patient_tasks
  add constraint patient_tasks_cancelled_has_time check (
    status <> 'cancelled' or cancelled_at is not null) not valid;
alter table patient_tasks validate constraint patient_tasks_cancelled_has_time;

-- ---------------------------------------------------------------------------
-- One vocabulary of kinds (§6)
-- ---------------------------------------------------------------------------
--
-- The nine a care-programme activity had, plus the seven the follow-up brief
-- names that were not already there. ONE list, because "what kind of thing is
-- this" is one question — a programme activity may perfectly well be a
-- medication review, and a follow-up may perfectly well be a vaccination.
alter table patient_tasks drop constraint if exists care_program_activities_kind_check;
alter table patient_tasks
  add constraint patient_tasks_kind check (kind in (
    'assessment', 'review', 'monitoring', 'counselling', 'test',
    'follow_up', 'vaccination', 'referral', 'other',
    'clinical_review', 'medication_review', 'condition_monitoring',
    'adherence', 'lifestyle', 'care_program_review', 'appointment')) not valid;
alter table patient_tasks validate constraint patient_tasks_kind;

-- ---------------------------------------------------------------------------
-- Names that would otherwise lie, and the queue's index
-- ---------------------------------------------------------------------------
alter index if exists idx_care_program_activities_program rename to idx_patient_tasks_program;
alter index if exists idx_care_program_activities_due rename to idx_patient_tasks_due;

alter table patient_tasks rename constraint care_program_activities_completed_has_time
  to patient_tasks_completed_has_time;
alter table patient_tasks rename constraint care_program_activities_skip_has_reason
  to patient_tasks_skip_has_reason;
alter table patient_tasks rename constraint care_program_activities_link_pair
  to patient_tasks_link_pair;
alter table patient_tasks rename constraint care_program_activities_recurrence_shape
  to patient_tasks_recurrence_shape;

-- The queue: this patient's open tasks, oldest due first. The 0061 index is
-- pharmacy-wide by due date; this one is what the Follow-up section reads.
create index if not exists idx_patient_tasks_patient
  on patient_tasks (pharmacy_id, customer_id, status, due_on);

create index if not exists idx_patient_tasks_source
  on patient_tasks (pharmacy_id, source_type, source_id)
  where source_id is not null;

-- RLS and its policy follow the table through a rename; this is here so a
-- reader of 0062 alone can see the scoping is still in place.
drop policy if exists tenant_isolation on patient_tasks;
create policy tenant_isolation on patient_tasks
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

comment on table patient_tasks is
  'Everything that needs to happen next for a patient. program_id null = a follow-up raised on its own; set = a care-programme activity. Holds no clinical values - see the 0062 header.';
