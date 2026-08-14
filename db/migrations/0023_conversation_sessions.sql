-- 0023 — make a conversation a session, not a synonym for the patient
--
-- WHAT WAS ACTUALLY WRONG
-- The tables were already right: patient -> conversations -> messages, with
-- orders and handoffs referencing both. The BEHAVIOUR was not. Conversation
-- selection was "the newest conversation whose mode is not closed", and
-- nothing in the codebase ever set mode to 'closed', so that clause always
-- matched. Measured in live data before this migration:
--
--   patient 2349013993683 -> 1 conversation, 143 messages, 5 days
--
-- One thread holding an order enquiry, a clinical escalation, a vitamin
-- question and a complaint. The inbox showed "1 conversation" for a week of
-- activity, and "which conversation produced this order" had one useless
-- answer.
--
-- WHY status IS SEPARATE FROM mode
-- `mode` answers "who is replying" — bot or human. `status` answers "is this
-- thread still running". They are independent: a conversation can be open
-- with a human replying, or open with the bot replying, and closing is about
-- neither. Overloading mode with 'closed' is what produced a value nothing
-- ever wrote, because closing is not a kind of replier.
--
-- The old 'closed' mode is migrated to status and mode is left alone for
-- backward compatibility — every existing query filtering `mode <> 'closed'`
-- keeps working while callers move to status.

alter table conversations
  add column if not exists status text not null default 'open'
    check (status in ('open', 'closed')),
  add column if not exists closed_at timestamptz,
  add column if not exists closed_reason text,
  -- Set when a conversation is handed to a specific person. Null while the
  -- assistant is handling it or while it sits in the shared queue.
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  -- A context optimisation, NEVER a replacement for the messages. Stored
  -- here rather than as a message with author='assistant', because an
  -- internal summary that looks like an outbound message would appear in the
  -- transcript as something the pharmacy actually said to the customer.
  add column if not exists summary text,
  add column if not exists summary_updated_at timestamptz;

comment on column conversations.status is
  'Session lifecycle: open or closed. Independent of `mode`, which is about who replies. Overloading mode with a closed value is what left it never written.';
comment on column conversations.summary is
  'Optional context optimisation. Never replaces the messages, and deliberately not stored as an assistant message — an internal summary must not read as something sent to the customer.';

-- Any conversation already marked closed via mode carries that over.
update conversations set status = 'closed', closed_at = coalesce(closed_at, last_message_at)
where mode = 'closed' and status <> 'closed';

create index if not exists conversations_open_idx
  on conversations (pharmacy_id, customer_id, last_message_at desc) where status = 'open';

-- ---------------------------------------------------------------------------
-- message type
-- ---------------------------------------------------------------------------
--
-- Media is not implemented in this segment, but the schema must not force
-- every future message to be text. `media_url` already exists; this names
-- what the row IS so a document and an image are distinguishable without
-- parsing a URL.
--
-- 'system' covers messages the pharmacy never typed — an expiry notice, a
-- handoff acknowledgement — which are already stored with author='system'
-- but were indistinguishable in type from something a human wrote.

alter table messages
  add column if not exists message_type text not null default 'text'
    check (message_type in ('text', 'image', 'document', 'audio', 'video', 'location', 'system'));

comment on column messages.message_type is
  'What kind of content this row holds. Defaults to text; media handling is a later segment, but the column exists so adding it is not a schema migration on a live message table.';

-- ---------------------------------------------------------------------------
-- backfill: split the existing mega-threads into sessions
-- ---------------------------------------------------------------------------
--
-- The 143-message thread is real history and must not be discarded, but
-- leaving it as one conversation would mean this migration fixed the schema
-- and not the problem.
--
-- Rather than retroactively inventing session boundaries — which would mean
-- guessing where one enquiry ended and the next began, and rewriting
-- conversation_id on orders, handoffs and events that point at them — the
-- existing threads are CLOSED where they are idle. The next message from
-- each patient then starts a genuine new conversation under the new policy,
-- and every existing reference stays valid.
--
-- This is the conservative choice on purpose: no message changes
-- conversation, no order loses its originating thread, and the split happens
-- going forward where the timestamps are real rather than reconstructed.

update conversations c
set status = 'closed',
    closed_at = c.last_message_at,
    closed_reason = 'idle_at_migration_0023'
where c.status = 'open'
  and c.mode <> 'human'
  and c.last_message_at < now() - interval '24 hours'
  and not exists (
    select 1 from handoffs h
    where h.conversation_id = c.id and h.resolved_at is null
  );
