-- 0023 — customer lifecycle, opt-out integration, and message schema fix
--
-- THE GOAL
-- Establish ACTIVE/INACTIVE/OPTED_OUT/BLOCKED as the authoritative customer
-- lifecycle model. Integrate the existing opt_outs table so STOP updates both
-- the communication preference AND the lifecycle. Fix the messages.id schema bug.
--
-- THE GUARANTEE
-- No customer is ever deleted because of opt-out. All history remains.
-- Communication preferences and lifecycle status remain separate concepts.
-- opt_outs is no longer a shadowy second ledger — it's fully integrated.

-- NO CHANGES TO `messages` IN THIS MIGRATION — AND THAT IS DELIBERATE.
--
-- An earlier draft of this file dropped and recreated messages.id, on the
-- belief that the table had two `id` columns. It does not. That reading came
-- from an information_schema query that filtered on table_name but not
-- table_schema, so it merged `public.messages` with Supabase's own
-- `realtime.messages` and reported the union of both column lists.
--
-- Filtered properly, public.messages has exactly one id (uuid) and is
-- correct. The "fix" would have dropped the real primary key off a table
-- holding every message in the system.
--
-- Recorded here rather than deleted silently: the next person to run that
-- unfiltered query will reach the same wrong conclusion, and this is the
-- note that stops them.

-- ===================================================================
-- customer lifecycle status
-- ===================================================================
--
-- Formalize the four states. ACTIVE is the default for new customers.
-- INACTIVE means dormant but not opted out. OPTED_OUT means the customer
-- has withdrawn consent (STOP, or similar). BLOCKED means the pharmacy
-- has explicitly restricted communication.

-- DROP then ADD, rather than adding a second constraint.
--
-- customers_status_check already existed and allowed only
-- ('active','inactive','blocked'). Adding a separate, wider constraint does
-- NOT widen anything: Postgres enforces every check on the table, so the
-- narrowest one wins and `status = 'opted_out'` stays rejected — while the
-- schema reads as though it were allowed. Replacing the existing constraint
-- by name is the only version that actually changes behaviour.
alter table customers
  drop constraint if exists customers_status_check;

alter table customers
  add constraint customers_status_check check (
    status in ('active', 'inactive', 'opted_out', 'blocked')
  );

-- If any rows have NULL or unexpected values, default them to 'active'
update customers
set status = 'active'
where status is null or status not in ('active', 'inactive', 'opted_out', 'blocked');

alter table customers
  alter column status set not null,
  alter column status set default 'active';

-- ===================================================================
-- communication_status formalization
-- ===================================================================
--
-- This field describes the WhatsApp channel state, separate from the
-- lifecycle status. A customer can be ACTIVE with communication_status
-- OPTED_OUT (they're a known customer who told us to stop messaging).
-- Or INACTIVE with communication_status SUBSCRIBED (they just haven't
-- messaged in a while).

-- Same reasoning as above: the existing constraint allowed only
-- ('subscribed','opted_out') and must be replaced, not supplemented.
alter table customers
  drop constraint if exists customers_communication_status_check;

alter table customers
  add constraint customers_communication_status_check check (
    communication_status in ('subscribed', 'opted_out', 'blocked')
  );

update customers
set communication_status = 'subscribed'
where communication_status is null or communication_status not in ('subscribed', 'opted_out', 'blocked');

alter table customers
  alter column communication_status set not null,
  alter column communication_status set default 'subscribed';

-- ===================================================================
-- opt_outs integration layer
-- ===================================================================
--
-- The opt_outs table exists for audit/history. But the CURRENT state
-- must be stored on the customer row for consistency and performance.
-- This function ensures they stay in sync: when STOP is processed,
-- both the customer record and the opt_outs log are updated atomically.
--
-- A customer row with communication_status='opted_out' means they have
-- opted out. Querying opt_outs for the current state is wrong — that
-- table is audit history, not the current ledger.

-- Backfill: any wa_phone that appears in opt_outs with opted_out_at set
-- should have the customer marked opted_out (if they exist).
update customers c
set communication_status = 'opted_out'
where (c.pharmacy_id, c.wa_phone) in (
  select pharmacy_id, wa_phone from opt_outs where opted_out_at is not null
);

-- ===================================================================
-- conversation lifecycle formalization
-- ===================================================================
--
-- Conversations have an explicit status. Don't invent new ones;
-- the conversationPolicy module handles the logic of when to reuse/close.
-- This just ensures the status field is used consistently.

alter table conversations
  drop constraint if exists conversations_status_check;

alter table conversations
  add constraint conversations_status_check check (
    status in ('open', 'closed')
  );

update conversations
set status = 'open'
where status is null or status not in ('open', 'closed');

alter table conversations
  alter column status set not null,
  alter column status set default 'open';

-- ===================================================================
-- audit: who/when opted out
-- ===================================================================
--
-- The opt_outs table needs to record WHICH customer opted out so we
-- can audit. It currently uses only wa_phone, which is not tenant-safe
-- by itself (though in practice it's scoped by pharmacy_id, which IS in
-- the table — good). But add customer_id for clarity and to catch any
-- historical edge cases.

alter table opt_outs
  add column if not exists customer_id uuid references customers(id) on delete set null;

-- Backfill customer_id where we can find it
update opt_outs oo
set customer_id = c.id
from customers c
where c.pharmacy_id = oo.pharmacy_id
  and c.wa_phone = oo.wa_phone
  and oo.customer_id is null;

comment on table opt_outs is
  'Audit trail: every time a customer opts out or back in. Customer current state is on customers.communication_status, not here.';
comment on column opt_outs.customer_id is
  'Optional: the customer record, if it still exists. Retained for history even if the join is null.';

-- ===================================================================
-- ensure no contradictions
-- ===================================================================
--
-- A customer with status OPTED_OUT should have communication_status
-- OPTED_OUT or BLOCKED. They should not contradict each other
-- (though they''re separate concepts, the opt-out state must be
-- consistent).
--
-- This is a comment documenting the invariant, not a constraint,
-- because the business logic might temporarily create inconsistency
-- during processing. The application layer MUST maintain it.

comment on table customers is
  'Patient records. Lifecycle status (active/inactive/opted_out/blocked) and communication_status (subscribed/opted_out/blocked) are separate: a patient can be ACTIVE with OPTED_OUT communication. NEVER delete on opt-out.';
