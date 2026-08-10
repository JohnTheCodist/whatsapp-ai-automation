-- 0010 — real stock reservation, staff alerts
--
-- Until now `create_order` only READ stock. Two customers could order the
-- last pack a minute apart and both succeed, because nothing was held.
--
-- THE TWO-STAGE MODEL, AND WHY
--
--   order created  -> stock is DECREMENTED (a hold), order is `pending`,
--                     customer is told it was sent to the pharmacy
--   pharmacist confirms -> the hold becomes a promise, and only NOW is the
--                     customer told anything is reserved for them
--   rejected/cancelled/expired -> stock is RESTORED
--
-- Holding at creation rather than at confirmation is what stops the
-- pharmacist confirming a pack that was already promised to someone else
-- while they were deciding. Telling the customer only at confirmation is
-- what stops the product promising something no human has agreed to. Both
-- halves are needed; either alone is broken.
--
-- EXPIRY IS NOT OPTIONAL. A hold nobody confirms is stock the pharmacy
-- cannot sell to the person standing in front of them. Without a deadline,
-- one abandoned WhatsApp conversation quietly removes inventory forever.

alter table orders
  -- When a pending hold lapses. NULL once the order leaves `pending` —
  -- a confirmed order is not on a countdown.
  add column if not exists reserved_until timestamptz,
  -- Idempotency guard for the restore path. Rejecting an already-expired
  -- order must not hand the same units back twice, which would silently
  -- inflate stock — a wrong number in the direction that causes overselling.
  add column if not exists stock_released boolean not null default false,
  -- Whether this order ever held stock at all. An order for an untracked
  -- product holds nothing, and must not be "restored" on cancellation.
  add column if not exists stock_held boolean not null default false;

comment on column orders.stock_released is
  'True once held units were returned. Guards against double-restore, which would inflate stock and cause overselling.';
comment on column orders.reserved_until is
  'Deadline for a pending hold. Held stock with no deadline is inventory the pharmacy cannot sell to someone standing at the counter.';

create index if not exists orders_pending_expiry_idx
  on orders (status, reserved_until) where status = 'pending';

-- ---------------------------------------------------------------------------
-- per-pharmacy settings
-- ---------------------------------------------------------------------------

alter table pharmacies
  -- How long a pending hold survives without a decision.
  add column if not exists reservation_hold_minutes integer not null default 120
    check (reservation_hold_minutes between 5 and 1440),
  -- Where to alert staff about a new order. This is the pharmacy messaging
  -- its OWN staff member — a known contact at low volume, not outreach — but
  -- it is still business-initiated, so it is opt-in and explicit rather than
  -- inferred from any number we happen to know.
  add column if not exists notify_phone text,
  add column if not exists notify_on_new_order boolean not null default true;

comment on column pharmacies.notify_phone is
  'Staff WhatsApp number for new-order alerts. Explicitly configured, never inferred — this is the one place the system initiates contact.';
