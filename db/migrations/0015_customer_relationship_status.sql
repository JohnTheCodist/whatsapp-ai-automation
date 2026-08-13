-- 0015 — customer relationship status, separate from communication status
--
-- THREE THINGS THAT LOOK LIKE ONE THING AND ARE NOT
--
--   status               the pharmacy's relationship with this person.
--                         active / inactive / blocked. A business fact,
--                         changed deliberately (by staff, or by an explicit
--                         batch reclassification — never inferred from a
--                         single message).
--
--   communication_status  whether we may currently message them on
--                         WhatsApp. subscribed / opted_out. A CHANNEL fact,
--                         not a relationship fact — someone can opt out of
--                         WhatsApp messages and still be an active customer
--                         who buys in person.
--
--   opt_outs (existing)   the audit trail and the enforcement layer.
--                         conductPolicy reads THIS table, not the column
--                         above — communication_status is a read-shortcut
--                         cache of it, not a replacement for it. Losing the
--                         column would cost a display convenience; losing
--                         the table would lose the evidence of consent.
--
-- Conflating the first two was the trap here: a customer who stops
-- replying is not the same fact as a customer who typed STOP, and a status
-- enum that means both is a status enum a later feature will misread.
--
-- WHY "INACTIVE" IS NOT DERIVED FROM last_seen_at HERE
-- last_seen_at already exists on this table and keeps meaning exactly what
-- it always has: the last time this person was heard from. It is tempting
-- to have a cron flip status to 'inactive' after N quiet days, but that
-- makes 'inactive' a fact nobody decided — indistinguishable in the data
-- from a staff member deliberately archiving a relationship. Classifying
-- dormancy from last_seen_at is done at READ time instead (see
-- server/services/customers/customerActivity.js), as a pure function over
-- the timestamp. If an automatic bulk reclassification job is wanted later,
-- it should call that function and write status explicitly and
-- auditably — not thread the decision through every inbound message.
--
-- WHY metadata IS jsonb AND NOT MORE COLUMNS
-- Free-form and not yet decided what goes in it, matching conversations.context
-- elsewhere in this schema. Deliberately NOT where future consent
-- granularity lives — see below.
--
-- THE EXTENSION PATH FOR CONSENT, WITHOUT REWRITING THIS TABLE
-- "Transactional / medication-journey / marketing" consent is not built
-- now, but the shape it will take is: a `customer_consents` table keyed on
-- (customer_id, consent_type), consent_type open text the same way
-- blocked_senders.reason is open text rather than a fixed enum. That table
-- can be added independently, later, touching nothing here — which is what
-- makes communication_status safe to ship today as a single WhatsApp-level
-- flag instead of trying to guess the future taxonomy now.

alter table customers
  add column if not exists status text not null default 'active'
    check (status in ('active', 'inactive', 'blocked')),
  add column if not exists communication_status text not null default 'subscribed'
    check (communication_status in ('subscribed', 'opted_out')),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column customers.status is
  'The pharmacy relationship lifecycle. Set deliberately (staff action or an explicit batch job) — never inferred from a single message or a quiet period. See customerActivity.js for read-time dormancy classification, which does not write here.';
comment on column customers.communication_status is
  'Current WhatsApp messaging permission only. A cache of opt_outs for cheap querying — opt_outs remains the source of truth and the audit trail. Not a relationship signal: an opted-out customer can still be active.';
comment on column customers.metadata is
  'Open extension point, undecided shape. Consent granularity (transactional/medication-journey/marketing) is NOT planned to live here — that gets its own customer_consents table later, added without touching this one.';

-- ---------------------------------------------------------------------------
-- retire the old boolean this replaces
-- ---------------------------------------------------------------------------
--
-- `blocked` was never read anywhere in the application (verified before
-- writing this migration) — the only reference to "blocked" in code is the
-- unrelated ingestion-scope `blocked_senders` table. Backfilled into the new
-- enum rather than dropped silently, so no history is lost even though
-- nothing was depending on it.

update customers set status = 'blocked' where blocked = true;
alter table customers drop column blocked;

-- ---------------------------------------------------------------------------
-- backfill communication_status from existing opt_outs
-- ---------------------------------------------------------------------------
--
-- Exact string match on wa_phone is safe here specifically because
-- normalizeMsisdn() is idempotent on the format Baileys hands us (digits
-- with country code, no leading zero) — verified against senderIdentity.js
-- before relying on it. Going forward this column is written at the same
-- moment opt_outs is (see worker.js), by customer id rather than by phone
-- match, so this backfill only ever has to run once.

update customers c
set communication_status = 'opted_out'
from opt_outs o
where o.pharmacy_id = c.pharmacy_id and o.wa_phone = c.wa_phone;

create index if not exists customers_status_idx on customers (pharmacy_id, status);
create index if not exists customers_communication_status_idx on customers (pharmacy_id, communication_status);
