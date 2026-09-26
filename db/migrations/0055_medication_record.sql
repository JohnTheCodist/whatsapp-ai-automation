-- =====================================================================
-- Medications, phase 1: the clinical medication record.
-- =====================================================================
--
-- WHY THIS EXTENDS medication_journeys INSTEAD OF ADDING A TABLE
-- 0052 already models "this patient takes this medicine, and here is its
-- status". Six things read it: the refill call list, the patient search's
-- Medication filter and its medications column, the patient timeline, the
-- profile payload, and the summary's Meds card. A parallel
-- patient_medications table would mean a patient's amlodipine exists twice
-- and "what is this patient taking" has two answers, which drift the first
-- time one is edited and the other is not. That is the split-identity
-- failure 0037 refuses when it declines to create a parallel patient table.
-- The decision, its rejected alternatives and the risks are written up in
-- MEDICATIONS_PLAN.md, approved 2026-09-21.
--
-- WHAT A JOURNEY NOW IS
-- Still one row per patient per medicine they are on. It gains the clinical
-- columns a pharmacist needs to answer "what exactly are they taking, who
-- said so, and why" — strength, form, dose, route, frequency, duration,
-- indication, prescriber, instructions — and a wider status.
--
-- STOCK IS NOT TOUCHED. product_id stays a nullable reference with the name
-- snapshotted beside it (0052). No price, batch, expiry, quantity, supplier
-- or reorder level is read or written here. A medicine a patient takes and a
-- pack on a shelf are different facts about the same word.

alter table medication_journeys
  -- ---- what it is -------------------------------------------------
  -- Free text, not an enum: "20 mg/5 mL" and "0.05% w/w" are both real, and
  -- a strength this system refuses to store is a prescription it cannot
  -- record. The FORM is a short controlled list because it drives nothing
  -- but display and a wrong one is a typo, not a clinical fact.
  add column if not exists strength        text check (strength is null or length(trim(strength)) between 1 and 60),
  add column if not exists form            text check (form is null or form in (
    'tablet', 'capsule', 'syrup', 'suspension', 'cream', 'ointment', 'gel',
    'injection', 'inhaler', 'drops', 'patch', 'suppository', 'powder', 'other')),
  add column if not exists generic_name    text check (generic_name is null or length(trim(generic_name)) between 1 and 200),
  add column if not exists brand_name      text check (brand_name is null or length(trim(brand_name)) between 1 and 200),

  -- ---- how it is taken --------------------------------------------
  add column if not exists dose            text check (dose is null or length(trim(dose)) between 1 and 80),
  add column if not exists route           text check (route is null or route in (
    'oral', 'topical', 'im', 'iv', 'sc', 'inhaled', 'ophthalmic', 'otic',
    'nasal', 'rectal', 'vaginal', 'sublingual', 'other')),
  add column if not exists frequency       text check (frequency is null or frequency in (
    'once_daily', 'twice_daily', 'three_times_daily', 'four_times_daily',
    'every_4_hours', 'every_6_hours', 'every_8_hours', 'every_12_hours',
    'weekly', 'as_needed', 'other')),
  add column if not exists timing          text check (timing is null or length(trim(timing)) <= 120),

  -- ---- how long ----------------------------------------------------
  -- Null duration means ongoing, which is the normal case for the chronic
  -- medicines this pharmacy follows. DISTINCT FROM refills.days_supply: this
  -- is the course that was PRESCRIBED, that is what was physically HANDED
  -- OVER. A 30-day course dispensed fortnightly is two refills against one
  -- duration, and collapsing them would have the refill engine computing
  -- run-out dates from a quantity nobody dispensed.
  add column if not exists duration_days   integer check (duration_days is null or duration_days between 1 and 3650),
  add column if not exists ended_on        date,

  -- ---- why ---------------------------------------------------------
  -- Free text, because a pharmacist writes "pain" or "chest infection" and
  -- refusing anything outside a code list loses the reason entirely. The
  -- optional code links it to patient_condition (0037) when it happens to be
  -- one this system already tracks; it is never required and never inferred.
  add column if not exists indication      text check (indication is null or length(trim(indication)) <= 200),
  add column if not exists condition_code  text check (condition_code is null or condition_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),

  -- ---- who said so -------------------------------------------------
  -- TWO COLUMNS ON PURPOSE. A community pharmacy mostly sees prescriptions
  -- written by people who will never have a login here. Forcing "Dr John at
  -- LUTH" through a foreign key means either inventing user rows for
  -- strangers or losing the prescriber's name; the pair keeps the in-house
  -- case relational and the external case honest. No foreign key on
  -- prescriber_id beyond auth.users, and ON DELETE SET NULL: a prescriber
  -- who leaves does not take the record of what they prescribed with them.
  add column if not exists prescriber_id   uuid references auth.users(id) on delete set null,
  add column if not exists prescriber_name text check (prescriber_name is null or length(trim(prescriber_name)) between 1 and 120),

  -- ---- what was said -----------------------------------------------
  -- instructions are FOR THE PATIENT ("take after food"); notes are the
  -- pharmacist's own. Kept apart because one of them may end up on a label
  -- and the other must never.
  add column if not exists instructions    text check (instructions is null or length(instructions) <= 1000),
  add column if not exists notes           text check (notes is null or length(notes) <= 2000),

  -- ---- where it came from -------------------------------------------
  -- The distinction the brief exists for: a community pharmacist routinely
  -- discovers a patient is taking something that is in no prescription
  -- record. 'prescribed' is the default only because it is the commonest —
  -- it is never inferred from the absence of an answer.
  add column if not exists source          text not null default 'prescribed' check (source in (
    'prescribed', 'patient_reported', 'pharmacist_added', 'imported', 'historical')),

  -- The consultation it came out of, when it came out of one.
  add column if not exists encounter_id    uuid references clinical_encounters(id) on delete set null,

  add column if not exists updated_by      uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The wider status
-- ---------------------------------------------------------------------------
--
--   draft      being written up; not yet part of the patient's medication
--   active     the patient is taking it
--   completed  the course finished as intended
--   stopped    it was ended early, and stop_reason says why
--   cancelled  it should never have been recorded (a mistake, not an event)
--
-- WHAT DOES NOT CHANGE: every existing query means `status = 'active'` and
-- still does. completed / cancelled / draft are all NOT active, so the refill
-- call list, the Medication filter and the medications column keep exactly
-- the behaviour they had — a finished course stops being chased without its
-- refill history being deleted.
alter table medication_journeys drop constraint if exists medication_journeys_status_check;
alter table medication_journeys add constraint medication_journeys_status_check
  check (status in ('draft', 'active', 'completed', 'stopped', 'cancelled'));

-- The old rule was "a stopped journey records when it stopped; an active one
-- cannot". Widened to: anything that has ENDED records when, and anything
-- still running cannot. cancelled is an ending too — the record was withdrawn
-- at a moment, and that moment is worth keeping.
alter table medication_journeys drop constraint if exists medication_journeys_check;
alter table medication_journeys add constraint medication_journeys_ended_at_check
  check (
    (status in ('draft', 'active') and stopped_at is null)
    or (status in ('completed', 'stopped', 'cancelled') and stopped_at is not null)
  );

-- A prescribed medicine should say who prescribed it — one of the two
-- columns, not both. Enforced only for `source = 'prescribed'`: a medicine
-- the patient reported has no prescriber by definition, and demanding one
-- would push staff into inventing a name.
alter table medication_journeys drop constraint if exists medication_journeys_prescriber_check;
alter table medication_journeys add constraint medication_journeys_prescriber_check
  check (prescriber_id is null or prescriber_name is null);

-- An end date cannot precede the start.
alter table medication_journeys drop constraint if exists medication_journeys_dates_check;
alter table medication_journeys add constraint medication_journeys_dates_check
  check (ended_on is null or ended_on >= started_on);

-- The one-active-per-medicine index (0052) is unchanged and still correct:
-- it is partial on `status = 'active'`, so a completed or cancelled course
-- does not block the patient starting the same medicine again — which is
-- exactly what a repeat prescription is.

-- History is read newest-first per patient, across every status.
create index if not exists idx_medication_journeys_history
  on medication_journeys (pharmacy_id, customer_id, started_on desc);

comment on table medication_journeys is
  'A medicine a patient is on, or has been on: what it is, how it is taken, why, who prescribed it, and its status. Clinical record — NOT inventory. Stock lives on products; product_id here is a reference with the name snapshotted beside it.';
