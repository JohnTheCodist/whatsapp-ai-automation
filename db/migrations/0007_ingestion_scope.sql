-- 0007 — ingestion scope
--
-- Baileys authenticates as a linked device, so it sees EVERYTHING on the
-- account: the owner's personal chats, other companies' bots, family. In
-- testing this was not theoretical — the staff inbox filled up with a
-- friend asking about moving to Australia and a rival health service's
-- assistant trying to sell a consultation.
--
-- Three separate problems, one cause:
--
--   Privacy. The owner's private conversations were being stored in our
--   database and displayed to their staff. Nobody agreed to that.
--
--   Loops. The rival bot is automated. With reply_mode 'all' our assistant
--   would have answered it, and it would have answered back. Only the
--   allowlist prevented that, and the allowlist is a temporary pilot control.
--
--   Cost. Every message anyone sends the owner queued a job and could reach
--   the model.
--
-- The fix is a gate BEFORE storage, not a filter on display. Filtering the
-- inbox would leave the private messages in the database, which is the part
-- that actually matters.
--
-- `reply_mode` and `ingest_mode` are deliberately separate. Who we answer and
-- whose messages we keep are different questions: a pharmacy piloting with a
-- two-number allowlist still wants a record of real customers it did not
-- answer yet, and would be furious to discover those were discarded.

alter table pharmacies
  add column if not exists ingest_mode text not null default 'all'
    check (ingest_mode in ('all', 'allowlist'));

comment on column pharmacies.ingest_mode is
  '''all'' keeps every inbound message. ''allowlist'' keeps only allowlisted senders — correct while a pharmacy is running the assistant on a personal number, where most traffic is not customers.';

-- ---------------------------------------------------------------------------
-- blocked_senders — always dropped, in either mode
-- ---------------------------------------------------------------------------
--
-- Separate from opt_outs, which means "this customer asked us to stop
-- messaging them" and is the customer's decision. This means "this is not a
-- customer" and is the pharmacy's. Conflating them would make an owner
-- hiding a family member's chats look, in the record, like someone who
-- requested no contact.

create table if not exists blocked_senders (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  wa_phone    text not null,
  -- 'personal' | 'bot' | 'spam' | anything the owner types. Not constrained:
  -- guessing the categories in advance would only produce a wrong list.
  reason      text,
  note        text,
  blocked_at  timestamptz not null default now(),
  unique (pharmacy_id, wa_phone)
);

create index if not exists blocked_senders_lookup_idx on blocked_senders (pharmacy_id, wa_phone);
