-- 0031 — let the assistant resume when a pharmacist goes quiet, WITHOUT
--        losing the fact that a pharmacist is still needed.
--
-- THE PROBLEM
-- POST /takeover sets conversations.mode = 'human', which mutes the
-- assistant. That is correct while a pharmacist is actually replying. But
-- nothing ever un-mutes it automatically: a pharmacist who takes a
-- conversation and then gets pulled onto the counter leaves the customer
-- messaging a number that has silently stopped answering — the exact
-- failure the hybrid-handoff work was meant to end, just moved one step
-- later in the flow.
--
-- WHY A COLUMN AND NOT "just look at the last staff message"
-- A pharmacist who takes over and reads for four minutes without typing has
-- not gone away. Deriving idleness purely from messages would also treat a
-- long, careful clinical reply as inactivity. handoff_last_activity_at is
-- stamped on the actions that actually mean "a human is engaged here" —
-- taking over, and sending a staff reply — so the sweep measures the right
-- thing rather than a proxy for it.
--
-- WHAT THE TAKEBACK DELIBERATELY DOES NOT DO
-- It does NOT resolve or cancel the handoff. The pharmacist is still needed;
-- the thread stays open, stays WAITING_FOR_PHARMACIST, and stays at the top
-- of the inbox. Only `mode` returns to 'bot'. That combination —
-- handoff still PENDING, owner back to AI — is exactly why handoff status
-- and conversation ownership are two separate axes and not one field.

alter table handoffs
  add column if not exists handoff_last_activity_at timestamptz;

comment on column handoffs.handoff_last_activity_at is
  'When a human last actively worked this handoff (took it over, or sent a staff reply). Null until someone takes it. Drives the idle-takeback sweep in worker.js — see 0031.';

-- Backfill: any handoff already accepted gets its acceptance time as its
-- last activity, so an in-flight one is measured from something real rather
-- than looking idle since epoch the moment this ships.
update handoffs
set handoff_last_activity_at = accepted_at
where accepted_at is not null and handoff_last_activity_at is null;
