-- 0025 — repoint the one-open-conversation index at `status`
--
-- THE BUG, FOUND BY A TEST AND CONFIRMED ON LIVE DATA
--
--   CREATE UNIQUE INDEX idx_conversations_one_open
--     ON conversations (customer_id) WHERE mode <> 'closed'
--
-- It keys on `mode`. Migration 0023 moved closing OFF `mode` and onto
-- `status`, deliberately, because closing is not a kind of replier — and left
-- `mode` alone for backward compatibility. The consequence was not backward
-- compatible at all: nothing writes mode='closed' any more, so the predicate
-- matches EVERY row, and the index degenerates into
--
--   one conversation per customer, forever
--
-- which is precisely the condition 0023 existed to end. Reproduced against
-- production data before writing this: a conversation with status='closed',
-- workflow_state='resolved', mode='bot' still blocked the insert of a new one.
--
-- So the segmentation shipped in 0023 was dead on arrival. The worker's idle
-- sweep dutifully set status='closed', resolveConversation() dutifully
-- returned action='new', and the INSERT then failed on this index. Every
-- returning customer hit it.
--
-- WHY IT WAS INVISIBLE
-- The failure is a thrown unique violation inside the ingest transaction, so
-- it looks like a transient write error rather than a design fault, and the
-- only symptom in the data is what we already measured and misread as merely
-- historical: one patient, one conversation, 143 messages.
--
-- THE FIX
-- Point the predicate at the column that now carries the fact. `status` is
-- exactly two values and is written by conversationService in the same
-- statement as workflow_state, so "open" cannot go stale here.
--
-- The invariant itself is worth keeping: without it, two messages arriving
-- together can still create two conversations for one customer, which is the
-- concurrency case the ingest path's `for update` and this index defend
-- together.

drop index if exists idx_conversations_one_open;

create unique index idx_conversations_one_open
  on conversations (customer_id)
  where status = 'open';

comment on index idx_conversations_one_open is
  'At most one OPEN conversation per customer. Keyed on status, not mode — see 0025: keying on mode made it "one conversation ever" once 0023 moved closing to status.';
