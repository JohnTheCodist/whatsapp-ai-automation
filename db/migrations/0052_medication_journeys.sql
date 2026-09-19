-- =====================================================================
-- Medication journeys and refills (Segments 2 and 3).
-- =====================================================================
--
-- WHAT THIS RECORDS
-- A pharmacist telling the system "this patient takes this medicine, and
-- today we gave them N days of it". Nothing here is inferred. The purchase-
-- based condition engine (0037) can suggest who is probably a chronic
-- patient; it cannot know the dose, and a refill date computed from a guessed
-- dose is a reminder at the wrong time. So a journey only exists when a
-- person enrolled it.
--
-- TWO TABLES
-- medication_journeys  one row per patient per medicine they are followed on.
-- refills              one row per SUPPLY: each dispense opens a new row and
--                      closes the previous one. The row count is the refill
--                      history, which is what "completed refills" counts.
--
-- NO STATUS COLUMN FOR DUE / OVERDUE / LAPSED
-- Those are derived at read time from run_out_on and today's Lagos date
-- (services/refills/refillSchedule.js), for the same reason customers.status
-- is never written by a background job: a stored status is wrong from the
-- moment the job that maintains it stops. refills.status only records facts
-- a person caused — this supply is the current one, the patient came back,
-- or the journey was stopped.
--
-- DATES ARE `date`, NOT timestamptz
-- A refill is due on a Lagos calendar day. A timestamp would make "which
-- day" depend on the timezone of whoever reads it.

create table if not exists medication_journeys (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  -- The patient is the existing customer, as in 0037. A parallel patient
  -- table would split one person into two identities.
  customer_id    uuid not null references customers(id) on delete cascade,

  -- Optional link to the catalogue, with the name snapshotted — the same
  -- shape as order_items (product_id set null + name_snapshot). A catalogue
  -- re-upload that archives the product must not erase what the patient is
  -- actually taking.
  product_id     uuid references products(id) on delete set null,
  medicine_name  text not null check (length(trim(medicine_name)) between 1 and 200),

  -- How the patient takes it, when the pharmacist said. Nullable because a
  -- journey enrolled as "a 30-day pack" never stated a daily dose, and a
  -- dose invented to fill the column would later be used to schedule one.
  units_per_day  numeric check (units_per_day is null or units_per_day > 0),

  status         text not null default 'active' check (status in ('active', 'stopped')),
  stop_reason    text check (stop_reason is null or length(stop_reason) <= 500),

  started_on     date not null,
  stopped_at     timestamptz,
  -- Nullable for the same reason as patient_notes.author_id (0021):
  -- DEV_AUTH_BYPASS has no real user, and an unnamed enrolment is still real.
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A stopped journey records when it stopped; an active one cannot.
  check ((status = 'active' and stopped_at is null) or (status = 'stopped' and stopped_at is not null))
);

create index if not exists idx_medication_journeys_customer
  on medication_journeys (pharmacy_id, customer_id);

-- One active journey per patient per medicine. Enrolling the same patient on
-- "Amlodipine 5mg" twice would send them two reminders for one strip and
-- list them twice on the call list; case and surrounding space are not a
-- different medicine. A stopped journey does not block a new one — patients
-- restart medicines.
create unique index if not exists idx_medication_journeys_one_active_per_medicine
  on medication_journeys (pharmacy_id, customer_id, lower(trim(medicine_name)))
  where status = 'active';
create index if not exists idx_medication_journeys_active
  on medication_journeys (pharmacy_id) where status = 'active';

create table if not exists refills (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  journey_id     uuid not null references medication_journeys(id) on delete cascade,
  -- Denormalised from the journey so the call list is one indexed query
  -- without a join back through journeys to find whose phone to ring.
  customer_id    uuid not null references customers(id) on delete cascade,

  -- 1 for the dispense that started the journey, then 2, 3, ...
  cycle          integer not null check (cycle >= 1),
  dispensed_on   date not null,
  days_supply    integer not null check (days_supply between 1 and 180),
  quantity       numeric check (quantity is null or quantity > 0),
  -- The first day with no medicine left. Stored rather than recomputed so an
  -- index can answer "who runs out this week"; it is a pure function of the
  -- two columns above, fixed at insert, and nothing ever updates it.
  run_out_on     date not null,

  -- open       the patient's current supply
  -- completed  they came back and the next supply was dispensed
  -- cancelled  the journey was stopped while this supply was current
  status         text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  closed_at      timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),

  unique (journey_id, cycle),
  check (run_out_on > dispensed_on),
  check ((status = 'open' and closed_at is null) or (status <> 'open' and closed_at is not null))
);

-- One current supply per journey, enforced by the database rather than by
-- remembering to check — the same shape as idx_conversations_one_open. Two
-- open rows would put one patient on the call list twice with two different
-- run-out dates.
create unique index if not exists idx_refills_one_open_per_journey
  on refills (journey_id) where status = 'open';

create index if not exists idx_refills_open_by_run_out
  on refills (pharmacy_id, run_out_on) where status = 'open';
create index if not exists idx_refills_customer
  on refills (pharmacy_id, customer_id, status);

-- Defence in depth, as 0051. The API connects with the service role and
-- scopes every query by pharmacy_id itself; these policies catch anything
-- arriving through the anon key.
alter table medication_journeys enable row level security;
alter table refills enable row level security;

drop policy if exists tenant_isolation on medication_journeys;
create policy tenant_isolation on medication_journeys
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

drop policy if exists tenant_isolation on refills;
create policy tenant_isolation on refills
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
