-- What a pharmacy's website actually did for them.
--
-- THE NUMBER THIS TABLE EXISTS TO PRODUCE is "47 people tapped WhatsApp from
-- your website this month". That is the pharmacy's return on the whole
-- feature, and it is the difference between renewing and not. Page views
-- alone do not say it; a view that led nowhere is not worth anything to a
-- pharmacy.
--
-- COUNTS PER DAY, NOT ONE ROW PER VISITOR.
--
-- This is a privacy decision before it is a performance one. There is no
-- column here for an IP address, a user agent, a session, a referrer or a
-- cookie — so there is no per-visitor record to leak, to subpoena, or to have
-- to delete on request. A patient visiting a pharmacy website is a sensitive
-- fact about a person's health, and the safest way to hold that data is to
-- never hold it: this table cannot answer "who visited", only "how many".
--
-- It is also bounded. Five kinds times 365 days times the number of
-- pharmacies is a table that stays small forever, versus an event log that
-- grows with traffic and needs a retention policy nobody writes.
--
-- WRITES ARE BUFFERED IN THE PROCESS AND FLUSHED PERIODICALLY.
-- One upsert per page view would put a write on the 15-connection pool for
-- every visitor, competing with the WhatsApp sockets. services/website/
-- analytics.js accumulates in memory and flushes on a timer, which turns a
-- burst of traffic into one statement. The cost is that a restart loses up to
-- one flush interval of counts — acceptable for a number that is read as a
-- trend, and stated here so nobody later mistakes a small discrepancy for a
-- bug.

create table if not exists website_events (
  id           bigint generated always as identity primary key,
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,

  -- view        the page was served
  -- whatsapp    a customer tapped a WhatsApp button
  -- phone       tapped a phone number
  -- directions  tapped the maps link
  -- email       tapped an email address
  --
  -- Everything except `view` is a CONVERSION: the visitor did the thing the
  -- website exists to make them do. Kept as separate kinds rather than a
  -- single "click" so a pharmacy can see which call to action is working.
  kind         text not null check (kind in ('view', 'whatsapp', 'phone', 'directions', 'email')),

  -- date, not timestamptz. The grain IS the day — storing an instant would
  -- imply a precision this table deliberately does not have, and would invite
  -- somebody to try to reconstruct individual visits from it.
  day          date not null,
  count        integer not null default 0,

  -- The upsert target. One row per pharmacy per kind per day, so a flush is
  -- an increment rather than an insert.
  unique (pharmacy_id, kind, day)
);

-- The only query this table serves: one pharmacy, a date range, all kinds.
create index if not exists idx_website_events_pharmacy_day
  on website_events(pharmacy_id, day desc);

alter table website_events enable row level security;

create policy tenant_read on website_events
  for select using (is_pharmacy_member(pharmacy_id));
-- No write policy, deliberately. These rows are written only by the service
-- role, from the public site route — a browser session has no business
-- inserting analytics about itself.
