-- 0022 — communication preferences by category, with consent history
--
-- WHY ONE BOOLEAN WAS NEVER GOING TO BE ENOUGH
-- Until now the only question this system could answer was "may we message
-- this person at all". That is sufficient while every message is a reply to
-- something the customer just said. It stops being sufficient the moment
-- anything is sent proactively, because these are not the same question:
--
--   "Your order is ready to collect."          the customer asked for this
--   "Your refill may be due."                  health, not commerce
--   "20% off vitamins this weekend!"           marketing
--
-- Collapsing them means either sending promotions to someone who only wanted
-- order updates, or suppressing a refill reminder because they declined
-- promotions. Both are wrong, and the second is the one that harms someone.
--
-- SEPARATE DIMENSIONS, NOT A COMBINED ENUM
-- Lifecycle status (active/inactive/blocked) and communication preference are
-- kept as independent axes, continuing the decision made in 0015. A single
-- enum would need ACTIVE_MARKETING_OFF, ACTIVE_MARKETING_ON,
-- INACTIVE_MARKETING_OFF and so on — a combinatorial explosion where every
-- new category doubles the states.
--
-- NOTE ON 'opted_out' AS A LIFECYCLE VALUE
-- It deliberately is NOT one. `communication_status` already carries exactly
-- that fact and is what conductPolicy enforces on. Adding it to `status` too
-- would create two sources of truth for one thing, and the first bug would be
-- one of them going stale. The dashboard shows "Opted out" as a badge derived
-- from communication_status, so staff see the state they expect without the
-- schema growing a second place to be wrong.

alter table customers
  -- Replies to something the customer initiated, plus service messages they
  -- would reasonably expect. Defaults on: switching this off means the
  -- pharmacy cannot answer its own customer.
  add column if not exists comm_transactional boolean not null default true,
  -- Order lifecycle: confirmed, ready, cancelled, hold expired.
  add column if not exists comm_order_notifications boolean not null default true,
  -- Refill reminders and medication follow-up (Segment 2). Health
  -- communication, NOT promotion — the distinction that keeps a genuine
  -- refill reminder deliverable to someone who declined marketing.
  add column if not exists comm_medication boolean not null default true,
  -- MUST default false. A customer messaging the pharmacy to ask a price has
  -- not consented to promotions, and defaulting this true would turn every
  -- inbound question into a marketing list subscription.
  add column if not exists comm_marketing boolean not null default false,
  -- Evidence, not just a flag. Needed to answer "why did we send this?"
  -- months later, when the answer matters.
  add column if not exists marketing_consent_source text
    check (marketing_consent_source is null or marketing_consent_source in ('customer', 'staff', 'import')),
  add column if not exists marketing_consent_at timestamptz;

comment on column customers.comm_marketing is
  'Defaults false and must stay that way. Messaging a pharmacy is not consent to be marketed to.';
comment on column customers.comm_medication is
  'Refill and adherence messages. Deliberately independent of marketing so declining promotions does not suppress health communication.';

-- ---------------------------------------------------------------------------
-- preference history
-- ---------------------------------------------------------------------------
--
-- Append-only. The customer row holds the CURRENT answer; this holds how it
-- got there. Without it, "we never subscribed them to that" is unanswerable —
-- and the situations where somebody asks are exactly the situations where a
-- confident answer matters.

create table communication_preference_history (
  id           bigint generated always as identity primary key,
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  -- Which dimension moved: 'marketing', 'medication', 'order_notifications',
  -- 'transactional', or 'whatsapp' for a whole-channel opt-out.
  preference   text not null,
  previous_state text,
  new_state      text not null,
  -- Who caused it. 'customer' covers STOP and an explicit subscribe;
  -- 'system' covers automatic changes; 'staff' covers dashboard edits.
  source       text not null check (source in ('customer', 'staff', 'system', 'campaign')),
  actor_id     uuid references auth.users(id) on delete set null,
  -- The customer's own words when they triggered it (e.g. the STOP message).
  reason       text,
  changed_at   timestamptz not null default now()
);

create index comm_pref_history_customer_idx
  on communication_preference_history (pharmacy_id, customer_id, changed_at desc);

comment on table communication_preference_history is
  'Append-only consent trail. The customers row is the current state; this is how it got there.';

-- ---------------------------------------------------------------------------
-- message classification
-- ---------------------------------------------------------------------------
--
-- Every outbound message records what KIND of communication it was, and the
-- eligibility decision that permitted it. Storing the decision on the message
-- rather than only the preference on the customer is what makes an old send
-- explicable after the customer's preferences have since changed — otherwise
-- unsubscribing tomorrow makes yesterday's legitimate message look like a
-- violation.

alter table messages
  add column if not exists category text
    check (category is null or category in
      ('transactional', 'order_notification', 'medication_related', 'marketing', 'staff_alert')),
  -- The reason string the policy returned at send time. A snapshot, never
  -- recomputed — the point is what was true THEN.
  add column if not exists eligibility_reason text;

comment on column messages.category is
  'What kind of communication this was. Null on inbound and on rows predating 0022; required for every new proactive send.';
comment on column messages.eligibility_reason is
  'Why the policy allowed this send, captured at the time. Not recomputed later — preferences change, and this must still explain the past.';

-- Existing outbound rows are all replies or order updates, none marketing.
-- Backfilled rather than left null so "unclassified" means "new bug", not
-- "old row".
update messages
set category = case
      when author = 'system' and body ilike '%order%' then 'order_notification'
      else 'transactional'
    end,
    eligibility_reason = 'backfilled_pre_0022'
where direction = 'outbound' and category is null;
