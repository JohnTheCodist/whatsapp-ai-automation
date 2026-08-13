-- 0017 — a normalized customer activity event stream
--
-- Segment 1.3's Customer 360 timeline was built by re-querying orders,
-- order_status_history, messages and handoffs at READ time and merging them
-- in JS. That was the right amount of engineering for "show a timeline" —
-- it is the wrong foundation for "every future feature adds its own real
-- events to the same timeline without a rewrite", which is what this
-- segment explicitly asks for. So the event stream becomes a real table,
-- written at the moment each fact happens, read straight off with one
-- indexed query instead of four merged ones.
--
-- "PATIENT" IN THE SPEC IS "CUSTOMER" IN THIS SCHEMA
-- Segment 1.1 deliberately kept the `customers` table rather than
-- introducing a parallel `patients` domain. Same decision here:
-- customer_events, customer_id — not patients/patient_id.
--
-- ENTITY_ID IS TEXT, DELIBERATELY
-- messages.id and order_status_history.id are bigint; orders.id, handoffs.id,
-- opt_outs.id and customers.id are uuid. A single polymorphic reference
-- column spanning both types has to pick one representation — text is the
-- simple, honest choice, cast at the point of insert, rather than adding a
-- second entity_id_bigint column nothing else in this schema does.
--
-- THE UNIQUE CONSTRAINT IS THE IDEMPOTENCY MECHANISM
-- Not an application-level "check before insert" — the same class of bug
-- that pattern invites everywhere else in this codebase (see inbound_events,
-- messages.provider_message_id, the customers upsert). Every write is
-- INSERT ... ON CONFLICT DO NOTHING against (pharmacy_id, event_type,
-- entity_type, entity_id). A retried job, a reconnect replay, a duplicate
-- webhook — all become a no-op by construction, not by remembering to check.
--
-- WHY event_type IS A CLOSED LIST THAT ALREADY NAMES EVENTS NOT YET EMITTED
-- ORDER_STOCK_HELD, ORDER_SENT_TO_PHARMACY and CONVERSATION_RESOLVED are
-- listed here as reserved vocabulary but the application code never inserts
-- them today: stock-hold and pharmacy-visibility happen in the exact same
-- atomic transaction as order creation in this system, so a separate row
-- with the same timestamp would present one action as three sequential
-- ones — exactly the kind of manufactured-looking history this product
-- has refused to do everywhere else (see: "reserved" only being said once
-- a human actually confirms). CONVERSATION_RESOLVED has no writer because
-- conversations.mode never actually transitions to 'closed' anywhere in
-- this codebase yet. Reserving the names now means the day either of those
-- becomes real, it's a code change, not a migration.

create table customer_events (
  id           bigint generated always as identity primary key,
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  event_type   text not null check (event_type in (
    'PATIENT_CREATED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT',
    'CONVERSATION_STARTED', 'CONVERSATION_RESOLVED',
    'ORDER_CREATED', 'ORDER_STOCK_HELD', 'ORDER_SENT_TO_PHARMACY',
    'ORDER_CONFIRMED', 'ORDER_REJECTED', 'ORDER_READY',
    'ORDER_COMPLETED', 'ORDER_CANCELLED', 'ORDER_HOLD_EXPIRED',
    'PHARMACIST_HANDOFF', 'PHARMACIST_RESPONDED', 'COMMUNICATION_OPTED_OUT'
  )),
  -- The actual time the thing happened, not when this row was written.
  -- Async processing (a worker retry, a delayed job) can persist events out
  -- of the order they occurred — the timeline sorts on this, never on id or
  -- created_at, or a late-processed early event would jump to the top.
  occurred_at  timestamptz not null,
  actor_type   text not null check (actor_type in ('customer', 'ai', 'pharmacist', 'staff', 'system')),
  -- Populated only when it adds information beyond customer_id/actor_type —
  -- e.g. WHICH staff member confirmed an order. Null for customer/ai/system
  -- events, where it would only restate the actor_type.
  actor_id     uuid,
  entity_type  text not null check (entity_type in (
    'message', 'order', 'order_status_history', 'conversation', 'handoff', 'opt_out', 'customer'
  )),
  entity_id    text not null,
  -- Structured facts needed to RENDER the event — product name, quantity,
  -- amount, a message preview. Never AI-generated prose: every value here
  -- traces back to a column on the entity it references.
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),

  unique (pharmacy_id, event_type, entity_type, entity_id)
);

-- The timeline query: this customer's events, newest first, cursor-paginated
-- on occurred_at. One index serves the whole read path.
create index customer_events_timeline_idx
  on customer_events (pharmacy_id, customer_id, occurred_at desc);

comment on table customer_events is
  'Normalized activity stream. Every future feature (medication journeys, refills, payments) adds its own event types here rather than the timeline re-querying that feature''s tables — see 0017.';
comment on column customer_events.entity_id is
  'Text, not uuid: entity_type determines whether this is really a bigint (message, order_status_history) or a uuid (order, handoff, opt_out, customer) id.';
