-- 0026 — put existing unresolved handoffs into the pharmacist queue
--
-- WHAT WENT WRONG IN 0024
-- Its backfill set every still-open conversation to workflow_state='open' and
-- deliberately refused to infer 'waiting_for_pharmacist', on the reasoning
-- that fabricating a clinical wait would put a false alarm at the top of the
-- inbox.
--
-- That reasoning holds for CLOSED threads, where the handoff is history. It
-- was wrong for open ones. Caught by looking at the actual inbox, which showed
-- a contradiction it is the entire job of workflow_state to prevent:
--
--   header:  "1 waiting for a person"      (counts unresolved handoffs)
--   chip:    "Needs pharmacist"  -> 0      (counts workflow_state)
--   row:     state "Open", handoff "low_confidence · waiting 10h ago"
--
-- Two counters, one truth, different answers. A pharmacist filtering by
-- "Needs pharmacist" would have seen an empty queue while someone had been
-- waiting ten hours.
--
-- WHY THIS IS NOT FABRICATION
-- A row in `handoffs` with resolved_at IS NULL is not an inference. It is the
-- system's own record that a question was escalated and nobody has closed it.
-- Deriving the state from that is reading the evidence, not inventing it —
-- unlike guessing at a thread that was closed months ago, which 0024 was
-- right to refuse.
--
-- Only OPEN conversations are touched. status stays 'open' throughout, so the
-- conversations_workflow_matches_status invariant holds without needing to
-- write status at all.

update conversations c
set workflow_state = 'waiting_for_pharmacist'
where c.status = 'open'
  and c.workflow_state <> 'waiting_for_pharmacist'
  and exists (
    select 1 from handoffs h
    where h.conversation_id = c.id
      and h.pharmacy_id = c.pharmacy_id
      and h.resolved_at is null
  );

-- Going forward this is maintained by conversationService.onHandoffRaised(),
-- called from both handoff-creation sites in worker.js, so the two can only
-- diverge again if a third site is added that writes `handoffs` directly.
