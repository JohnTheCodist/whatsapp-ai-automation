-- 0024 — the conversation workflow axis
--
-- WHAT THIS ADDS, AND WHY IT IS A SEPARATE COLUMN
-- The existing columns each answer one question and answer it well:
--
--   status  open | closed     is this thread still running?
--   mode    bot  | human      who is replying?
--
-- Neither answers the question a pharmacist opens the dashboard to ask:
-- WHAT NEEDS ME? "Open" covers both a thread the assistant is handling fine
-- and a person waiting on a clinical answer, and those are not remotely the
-- same job.
--
-- WHY NOT ONE ENUM OF SIX
-- The six workflow states span two orthogonal axes. open/resolved/archived is
-- lifecycle; ai_handling/waiting_for_customer/waiting_for_pharmacist is whose
-- turn it is. Collapsing them into `status` would recreate precisely the bug
-- migration 0023 removed: `mode` used to carry a 'closed' value that nothing
-- ever wrote, because closing is not a kind of replier. In the same way,
-- "waiting for the customer" is not a kind of lifecycle.
--
-- HOW THE TWO ARE KEPT HONEST
-- A separate column invites a second source of truth, so the relationship is
-- enforced rather than documented: the CHECK below makes it impossible to
-- store a resolved thread that is still marked open, or an ai_handling thread
-- marked closed. Both columns move in one write, from applyTransition() in
-- services/whatsapp/conversationState.js.
--
-- Nothing here breaks the existing path. The ingest resolver and the worker's
-- idle sweep both key off `status`, which keeps its exact current meaning.

alter table conversations
  add column if not exists workflow_state text not null default 'open';

-- Backfill BEFORE constraining, so existing rows cannot violate it.
--
-- Every currently-open thread becomes 'open' rather than 'ai_handling': we
-- know these threads are running, but we do not know from the row alone
-- whether the assistant had actually taken one up. 'open' is the honest
-- answer, and the first inbound message moves it on.
update conversations
set workflow_state = case when status = 'closed' then 'resolved' else 'open' end
where workflow_state is null or workflow_state = 'open';

-- A thread already closed while someone was waiting on a pharmacist would be
-- the one genuinely alarming row. Surfaced as 'resolved' above rather than
-- invented as 'waiting_for_pharmacist', because fabricating a clinical wait
-- that no longer exists would put a false alarm at the top of the inbox.

alter table conversations
  drop constraint if exists conversations_workflow_state_check;

alter table conversations
  add constraint conversations_workflow_state_check check (
    workflow_state in (
      'open', 'ai_handling', 'waiting_for_customer',
      'waiting_for_pharmacist', 'resolved', 'archived'
    )
  );

-- The invariant that stops the two columns drifting apart. This is the whole
-- reason a second column is safe to add.
alter table conversations
  drop constraint if exists conversations_workflow_matches_status;

alter table conversations
  add constraint conversations_workflow_matches_status check (
    (workflow_state in ('open', 'ai_handling', 'waiting_for_customer', 'waiting_for_pharmacist')
       and status = 'open')
    or
    (workflow_state in ('resolved', 'archived') and status = 'closed')
  );

-- The inbox's primary query: "what needs a human, oldest first", scoped to a
-- pharmacy. Partial, because archived threads are the bulk of the table over
-- time and never appear in the working inbox.
create index if not exists conversations_workflow_inbox_idx
  on conversations (pharmacy_id, workflow_state, last_message_at desc)
  where workflow_state <> 'archived';

comment on column conversations.workflow_state is
  'Whose turn it is. Groups the pharmacist inbox. Transitions go through conversationState.applyTransition — never written ad hoc.';
comment on column conversations.status is
  'Lifecycle only: is the thread running. Kept in step with workflow_state by conversations_workflow_matches_status.';
