-- Billing: what a pharmacy pays, and what serving them costs us.
--
-- TWO SEPARATE THINGS, DELIBERATELY NOT ONE
-- The obvious build is a prepaid wallet: a naira balance, decremented per
-- conversation. It was the first design and it was wrong, because it welds
-- the PRICING MODEL into the SCHEMA. Change from per-conversation to a
-- monthly plan and you are migrating a ledger, reconciling half-spent
-- balances, and explaining to pharmacies why their money moved.
--
-- So:
--   BILLING   what the pharmacy owes and has paid. A subscription.
--   METERING  what it costs us to serve them. Internal, never shown.
--
-- Nothing is deducted from anything. The meter counts; the subscription
-- gates. Changing the price later is a config change with no data migration,
-- because no row anywhere holds a balance that a price change would falsify.
--
-- PILOT TERMS (set 2026-08-30, deliberately discounted)
--   ₦5,000/month or ₦50,000/year. No conversation limit, no allowance, no
--   throttle — a pilot pharmacy that uses the assistant heavily is the
--   outcome being paid for, not a cost to be contained.
--
-- MONEY IS INTEGER KOBO throughout, same as orders (see 0001's header). No
-- floats anywhere near a figure a person will be charged.

-- =====================================================================
-- SUBSCRIPTION STATE — on the tenant row, because there is exactly one
-- per pharmacy and a join for a single status would be a join written
-- wrong eventually.
-- =====================================================================
alter table pharmacies
  add column if not exists plan text not null default 'pilot_monthly'
    check (plan in ('pilot_monthly', 'pilot_annual')),

  -- trialing  never paid, inside the free window
  -- active    paid, inside the paid period
  -- past_due  trial or period ended with no payment — the assistant stops
  -- cancelled deliberately ended; kept distinct from past_due so "they left"
  --           and "they forgot" are never confused in a retention number
  add column if not exists subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'cancelled')),

  -- THE TRIAL CLOCK STARTS AT WHATSAPP CONNECTION, NOT AT SIGN-UP.
  -- A pharmacy that creates an account on Monday and connects WhatsApp on
  -- Friday has had no product for four days. Starting the clock at sign-up
  -- bills them for our onboarding friction, and it is the kind of detail a
  -- pilot customer notices and remembers.
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,

  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end timestamptz;

comment on column pharmacies.trial_ends_at is
  'Set when WhatsApp first connects, not at sign-up — a tenant with no connected number has no product to trial.';
comment on column pharmacies.subscription_status is
  'past_due and cancelled are deliberately distinct: "they forgot to pay" and "they left" must never be confused in a retention number.';

-- =====================================================================
-- MONEY THAT ACTUALLY MOVED
--
-- Append-only. A payment is a fact about the past; correcting one means
-- writing an adjustment, never editing the original row — the same
-- discipline as order_status_history.
-- =====================================================================
create table if not exists billing_events (
  id            bigint generated always as identity primary key,
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,

  -- payment     money received
  -- refund      money returned
  -- adjustment  a correction, with a reason, by a human
  -- grant       free time given deliberately (pilot extension, apology)
  kind          text not null check (kind in ('payment', 'refund', 'adjustment', 'grant')),

  amount_kobo   bigint not null,

  -- Paystack's reference. The unique index below is the idempotency
  -- guarantee: a webhook delivered twice — which Paystack WILL do — must
  -- not credit the pharmacy twice.
  reference     text,
  provider      text not null default 'paystack',

  -- What this payment bought. Null for adjustments that buy no time.
  period_start  timestamptz,
  period_end    timestamptz,

  -- Who did it, for the ones a person did.
  actor_id      uuid references auth.users(id) on delete set null,
  note          text,

  created_at    timestamptz not null default now()
);

create index if not exists idx_billing_events_pharmacy
  on billing_events (pharmacy_id, created_at desc);

-- Idempotency. Partial because only payments carry a provider reference —
-- an adjustment written by hand has no external id to collide on.
create unique index if not exists idx_billing_events_reference
  on billing_events (provider, reference) where reference is not null;

-- =====================================================================
-- THE METER — internal cost discovery, never shown to a pharmacy.
--
-- WHY IT EXISTS WHEN NOBODY IS BILLED PER CONVERSATION
-- Because ₦5,000/month is a guess. It is a deliberately discounted pilot
-- price set before anyone knew what a pharmacy's real traffic looks like,
-- and the only way to find out what the next price should be is to have
-- been counting all along. Starting the meter later means starting the
-- data later.
--
-- notional_cost_kobo is NOT a charge. It is what this conversation would
-- have cost at the internal reference price, recorded per row so that
-- changing the reference price later does not silently rewrite history.
-- =====================================================================
create table if not exists usage_records (
  id                  bigint generated always as identity primary key,
  pharmacy_id         uuid not null references pharmacies(id) on delete cascade,
  conversation_id     uuid not null references conversations(id) on delete cascade,

  -- 7500 = ₦75. Stamped at write time, never recomputed.
  notional_cost_kobo  integer not null,

  -- Which billing period this fell in, resolved at write time. Recomputing
  -- it later from created_at would be wrong the moment a period boundary
  -- moves (an extension, a plan change, a grant).
  period_start        timestamptz,

  created_at          timestamptz not null default now()
);

-- ONE CHARGE PER CONVERSATION, ENFORCED BY THE DATABASE.
--
-- This is the whole correctness guarantee of the meter, and it belongs here
-- rather than in application code: the write happens inside the outbound
-- message transaction, which retries, and a conversation that a customer
-- returns to after an hour must not count twice. `on conflict do nothing`
-- against this index makes a second attempt a silent no-op rather than a
-- duplicate or an error thrown into the send path.
create unique index if not exists idx_usage_one_per_conversation
  on usage_records (conversation_id);

create index if not exists idx_usage_pharmacy_period
  on usage_records (pharmacy_id, created_at desc);

-- =====================================================================
-- RLS — same model as everything else. Infrastructure tables the service
-- role writes; a browser has no business reading either directly.
-- =====================================================================
alter table billing_events enable row level security;
alter table usage_records  enable row level security;

create policy tenant_read on billing_events
  for select using (is_pharmacy_member(pharmacy_id));

-- usage_records gets RLS with NO client policy at all. The notional cost is
-- an internal figure, and a pharmacy reading it would be reading a price
-- they are not being charged — a number that can only mislead.

-- =====================================================================
-- BACKFILL
--
-- Every existing pharmacy starts a fresh 7-day trial from now, rather than
-- being written straight to past_due by the migration that introduced
-- billing. Nobody should lose their assistant because we shipped a feature.
-- =====================================================================
update pharmacies
set trial_started_at = coalesce(trial_started_at, now()),
    trial_ends_at    = coalesce(trial_ends_at, now() + interval '7 days')
where trial_ends_at is null;
