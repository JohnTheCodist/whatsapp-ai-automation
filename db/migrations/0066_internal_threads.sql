-- =====================================================================
-- Messages phase 3: internal threads that CANNOT reach a patient.
-- =====================================================================
--
-- See MESSAGES_PLAN.md §4 and §14 of the brief: "Internal messages must never
-- become visible to the patient."
--
-- THE DANGER, STATED PLAINLY
-- Every outbound message in this product ends at one function,
-- `sendAndRecordOutbound`, and a conversation row is a conversation row. If
-- an internal thread were only a flag that callers were expected to check,
-- then one missing WHERE clause sends a pharmacist's private note about a
-- patient TO that patient. That is not a bug you apologise for.
--
-- So the guarantee is built from three things that each have to fail before a
-- leak is possible:
--
--   1. `conversations.channel` — an internal thread is a different KIND of
--      row, not a flagged one.
--   2. The CHECKs below — an internal thread cannot hold the things a send
--      needs, and an internal message cannot hold the things a sent message
--      has. There is nowhere to put a provider id or a delivery status.
--   3. The guard in `sendAndRecordOutbound`, which reads the channel and
--      refuses BEFORE it looks at consent or touches the transport — and
--      GOLDEN-007, which asserts that guard exists and runs first.
--
-- WHY THIS IS SAFE FOR THE ASSISTANT
-- Checked before writing it: the AI's conversation history is loaded as
-- `select direction, body from messages where conversation_id = ...` in
-- services/worker.js. It is scoped BY CONVERSATION. An internal thread is its
-- own conversation, so an internal note cannot enter the model's context — it
-- is not merely filtered out, it is never in the set.
--
-- ---------------------------------------------------------------------------
-- 1. The channel
-- ---------------------------------------------------------------------------

alter table conversations
  add column if not exists channel text not null default 'whatsapp'
    check (channel in ('whatsapp', 'internal'));

-- An internal thread has no provider reply window, because there is no
-- provider: nothing about it is subject to WhatsApp's 24-hour rule, and a
-- non-null window here would be a row claiming a send is permitted.
--
-- And the assistant never handles one. `mode = 'human'` is not decoration:
-- the worker takes up threads whose mode is 'bot', so an internal thread in
-- bot mode is a thread the assistant would try to answer.
alter table conversations
  drop constraint if exists conversations_internal_has_no_provider;
alter table conversations
  add constraint conversations_internal_has_no_provider check (
    channel <> 'internal'
    or (window_expires_at is null and mode = 'human')
  ) not valid;
alter table conversations validate constraint conversations_internal_has_no_provider;

-- ---------------------------------------------------------------------------
-- 2. The one-open index, NARROWED rather than removed
-- ---------------------------------------------------------------------------
--
-- `idx_conversations_one_open` is the invariant whose violation dropped 16
-- messages from a live patient over three days (0025, and AGENTS.md's
-- conversationPolicy entry). It must keep holding for WhatsApp exactly as it
-- does today.
--
-- But a patient can legitimately have one open WhatsApp thread AND internal
-- threads about them at the same time — those are not competing for the same
-- inbound message, because an internal thread never receives one. So the
-- predicate gains `and channel = 'whatsapp'`.
--
-- THIS CHANGES NOTHING FOR EXISTING ROWS. Every conversation that exists has
-- channel = 'whatsapp' (the default above), so the new predicate matches
-- exactly the same set as the old one. It is a narrowing of WHERE the rule
-- applies, never a weakening of the rule.

drop index if exists idx_conversations_one_open;

create unique index idx_conversations_one_open
  on conversations (customer_id)
  where status = 'open' and channel = 'whatsapp';

-- Internal threads are found by patient and channel.
create index if not exists idx_conversations_internal
  on conversations (pharmacy_id, customer_id, last_message_at desc)
  where channel = 'internal';

-- ---------------------------------------------------------------------------
-- 3. Internal messages
-- ---------------------------------------------------------------------------
--
-- WHY A THIRD DIRECTION AND NOT 'outbound'
-- `direction` says which way a message travelled between the pharmacy and the
-- patient. An internal note travelled neither way. Recording it as 'outbound'
-- would make it indistinguishable, in the one column that answers "did this
-- go to the patient", from a message that did.

alter table messages drop constraint if exists messages_direction_check;
alter table messages
  add constraint messages_direction_check
    check (direction in ('inbound', 'outbound', 'internal')) not valid;
alter table messages validate constraint messages_direction_check;

-- Who wrote it. Outbound messages are written by 'staff' as a CATEGORY, which
-- is all a patient needs to know; an internal note is read by colleagues, and
-- "who said this" is the point of it.
alter table messages
  add column if not exists author_user_id uuid references auth.users(id) on delete set null;

-- An internal note was never sent anywhere, so it cannot carry the evidence of
-- having been sent. This is the CHECK that makes a leak visible as a
-- constraint violation rather than as a message arriving on someone's phone.
alter table messages
  drop constraint if exists messages_internal_was_never_sent;
alter table messages
  add constraint messages_internal_was_never_sent check (
    direction <> 'internal'
    or (provider_message_id is null and delivery_status is null and category is null)
  ) not valid;
alter table messages validate constraint messages_internal_was_never_sent;

create index if not exists idx_messages_internal_author
  on messages (conversation_id, author_user_id)
  where direction = 'internal';

comment on column conversations.channel is
  'whatsapp or internal. An internal thread is a different KIND of conversation, not a flagged one, and cannot be sent to a patient.';
comment on column messages.author_user_id is
  'Who wrote an internal note. Null for patient-facing messages, where `author` (customer/assistant/staff/system) is what matters.';
