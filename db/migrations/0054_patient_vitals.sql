-- =====================================================================
-- Vitals and biometrics (Patients → the record's Vitals section).
-- =====================================================================
--
-- WHAT THIS RECORDS
-- One row per ENCOUNTER AT THE COUNTER: what a member of staff measured,
-- when, and who measured it. Nothing here is inferred and nothing is
-- imported; a vital sign exists because a person put a cuff on an arm.
--
-- ONE ROW PER SET, NOT ONE ROW PER MEASUREMENT
-- A blood pressure, a pulse and a temperature taken together are one
-- reading of one person at one moment, and they are read back together on
-- one line of a chart. Split into a row per measurement, every read becomes
-- a pivot and "the 05:28 observation" stops being a thing the schema can
-- express. Any single column may be null: staff record what they took.
--
-- BMI IS NOT A COLUMN
-- It is weight and height, and it is computed at read time
-- (services/clinical/vitalRanges.js). A stored BMI is wrong from the moment
-- either measurement is corrected — which is exactly when somebody is
-- looking at it. Same rule as refill status in 0052.
--
-- WHAT IS DELIBERATELY ABSENT
-- No interpretation, no severity, no "normal/abnormal" column. Whether a
-- number is outside the usual adult range is decided at read time from
-- reference ranges held in one place in code, because those bounds are a
-- judgement that may be revised and a stored judgement cannot be.
--
-- UNITS ARE FIXED BY THE COLUMN NAME, NOT STORED PER ROW
-- temperature_c is Celsius, weight_kg is kilograms, height_cm is
-- centimetres. A unit column invites two rows in two units and a chart that
-- plots them on one axis.

create table if not exists patient_vitals (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  -- The patient is the existing customer, as in 0037 and 0052. A parallel
  -- patient table would split one person into two identities.
  customer_id    uuid not null references customers(id) on delete cascade,

  -- When the measurement was TAKEN, which is not always when it was typed:
  -- staff write up a busy counter afterwards. Defaults to now, and the form
  -- lets it be set back.
  recorded_at    timestamptz not null default now(),
  -- Who took it. Kept as a plain uuid with no foreign key to
  -- pharmacy_members: a member who leaves the pharmacy must not take the
  -- measurements they recorded with them, and the reading is still a fact
  -- about the patient after the person who took it is gone.
  recorded_by    uuid,

  -- ---- vitals -------------------------------------------------------
  -- smallint everywhere a reading is a whole number. The CHECKs are
  -- PLAUSIBILITY bounds, not reference ranges: they refuse a typo (a pulse
  -- of 900, a systolic of 12) while allowing every reading a real patient
  -- can present with, including the alarming ones. A schema that refuses to
  -- store a dangerous observation is a schema that loses the observation.
  systolic          smallint check (systolic is null or systolic between 50 and 300),
  diastolic         smallint check (diastolic is null or diastolic between 30 and 200),
  pulse             smallint check (pulse is null or pulse between 20 and 250),
  spo2              smallint check (spo2 is null or spo2 between 50 and 100),
  respiratory_rate  smallint check (respiratory_rate is null or respiratory_rate between 4 and 80),
  temperature_c     numeric(4,1) check (temperature_c is null or temperature_c between 30 and 45),

  -- ---- biometrics ---------------------------------------------------
  weight_kg      numeric(5,1) check (weight_kg is null or weight_kg between 0.5 and 400),
  height_cm      numeric(4,1) check (height_cm is null or height_cm between 30 and 250),
  muac_cm        numeric(4,1) check (muac_cm is null or muac_cm between 5 and 60),

  notes          text,
  created_at     timestamptz not null default now(),

  -- A row of nothing but a timestamp is a mis-submitted form, not an
  -- observation, and it would still appear on the chart as a date with no
  -- readings. Refused here so that no read path has to filter them out.
  constraint patient_vitals_not_empty check (
    systolic is not null or diastolic is not null or pulse is not null
    or spo2 is not null or respiratory_rate is not null or temperature_c is not null
    or weight_kg is not null or height_cm is not null or muac_cm is not null
  )
);

-- The one query this table exists for: this patient's readings, newest
-- first. pharmacy_id leads because every read is scoped to a tenant before
-- it is scoped to a patient.
create index if not exists idx_patient_vitals_patient
  on patient_vitals (pharmacy_id, customer_id, recorded_at desc);

alter table patient_vitals enable row level security;

-- The same policy shape as 0052: the tenant is the one in the session
-- setting, not a Supabase role name. service_role does not exist on a plain
-- Postgres, and a migration that names it cannot be applied to the test
-- database — which is where every tenant-isolation test runs.
drop policy if exists tenant_isolation on patient_vitals;
create policy tenant_isolation on patient_vitals
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
