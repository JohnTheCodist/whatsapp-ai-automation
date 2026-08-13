-- 0018 — an explicit idempotency key, and a vocabulary that can grow
--
-- TWO PROBLEMS WITH 0017, BOTH ARCHITECTURAL RATHER THAN COSMETIC.
--
-- 1. THE COMPOSITE UNIQUE KEY SILENTLY DROPS REPEATABLE EVENTS
--
-- 0017 deduplicated on (pharmacy_id, event_type, entity_type, entity_id).
-- That is correct only while every event is about a single-use entity:
--
--     MESSAGE_RECEIVED + message:123   each message has its own id     fine
--     ORDER_CONFIRMED  + order:abc     an order is confirmed once      fine
--
-- and quietly wrong the moment an event can legitimately recur about the
-- SAME entity:
--
--     PRODUCT_VIEWED           + product:xyz   second view -> discarded
--     REFILL_REQUESTED         + journey:j1    second refill -> discarded
--     MEDICATION_REMINDER_SENT + journey:j1    every reminder after the
--                                              first -> discarded
--
-- Those are exactly the Segment 2/3 events this layer exists to support, and
-- the failure mode is the bad one: no error, just history missing. The key
-- was conflating "this is a duplicate delivery" with "this entity already
-- has an event of this type" — different questions.
--
-- An explicit idempotency_key lets the CALLER say what makes an event unique,
-- because only the caller knows. A message delivery is unique by message id;
-- a monthly refill is unique by journey plus period; a reminder is unique by
-- schedule occurrence. None of that is derivable from the entity alone.
--
-- 2. A CHECK CONSTRAINT MAKES EVERY NEW EVENT TYPE A MIGRATION
--
-- The requirement for this layer is that a future feature records a new kind
-- of event without a schema change. A CHECK listing valid event types
-- contradicts that directly. The vocabulary moves to
-- server/services/customers/patientEventTypes.js, and recordEvent() rejects
-- anything not in it.
--
-- This is a real trade: the database will now accept an event_type string
-- the registry would refuse. It is acceptable here only because nothing
-- writes to this table directly — every insert goes through recordEvent(),
-- which validates the type, the actor, the entity, and the tenant. Moving a
-- check from the database to a single enforced chokepoint is defensible;
-- deleting it would not be.

alter table customer_events
  add column if not exists idempotency_key text;

-- Backfill: reproduce exactly what the old constraint enforced, so existing
-- rows keep their identity and a replay of an old event still deduplicates.
update customer_events
set idempotency_key = event_type || ':' || entity_type || ':' || entity_id
where idempotency_key is null;

alter table customer_events
  alter column idempotency_key set not null;

-- The new uniqueness rule. Scoped per pharmacy so two tenants can never
-- collide on a key either of them generated.
create unique index if not exists customer_events_idempotency_idx
  on customer_events (pharmacy_id, idempotency_key);

-- Retire the constraint this replaces. Keeping both would preserve the exact
-- bug described above — the old key would still reject the second legitimate
-- PRODUCT_VIEWED regardless of what idempotency_key said.
--
-- NOTE THE NAME. Postgres truncates generated identifiers at 63 characters,
-- so this is `..._entity_i_key`, not the `..._entity_id_key` you get by
-- writing out the column list. `drop constraint if exists` on the wrong name
-- succeeds silently and leaves the constraint in place — the bug would then
-- show up as "the second PRODUCT_VIEWED still vanishes" long after this
-- migration was believed to have fixed it. Verified against pg_constraint.
alter table customer_events
  drop constraint if exists customer_events_pharmacy_id_event_type_entity_type_entity_i_key;

-- Retire the closed vocabulary. patientEventTypes.js is the registry now.
alter table customer_events
  drop constraint if exists customer_events_event_type_check;

-- Same reasoning for entity types, and not optional: the registry adds
-- `product` (for PRODUCT_VIEWED) plus reserved types for medication
-- journeys, refills, payments and delivery. The 0017 CHECK lists none of
-- them, so leaving it would reject the first PRODUCT_VIEWED ever recorded.
alter table customer_events
  drop constraint if exists customer_events_entity_type_check;

comment on column customer_events.idempotency_key is
  'Caller-supplied uniqueness. Only the caller knows what makes its event unique — a message by message id, a monthly refill by journey+period. Derived from the entity alone this was wrong for any event that can legitimately recur.';
