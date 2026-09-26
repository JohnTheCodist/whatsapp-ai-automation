-- =====================================================================
-- Care programs: enrolling a patient in a course of care, and the plan.
-- =====================================================================
--
-- See CARE_PROGRAM_PLAN.md. What this is for: a pharmacist looking at a
-- patient can see which programmes of care that person is in, what the
-- goals are, what is due, and what has already been done -- over months,
-- not per visit.
--
-- IT ORGANISES THE OTHER RECORDS. IT NEVER COPIES THEM.
-- No blood pressure, no medicine, no test result and no diagnosis is stored
-- in any table here. A monitoring panel READS patient_vitals (0054) and
-- patient_tests (0060); a goal's current value is read the same way at
-- display time, so a goal can never disagree with the record it is about.
-- Conditions stay in patient_problems (0059), medicines in
-- medication_journeys (0055), allergies in patient_allergies (0058).
--
-- A DEFINITION IS A TEMPLATE, AN ENROLMENT IS A PATIENT'S.
-- care_program_definitions is a catalogue, like test_definitions (0060):
-- data, not code, with pharmacy_id null meaning it shipped. Enrolling copies
-- the template's goals and activities into the patient's own rows -- editable
-- from that moment on -- and snapshots the program NAME, so renaming a
-- template never rewrites what a patient was enrolled in.
--
-- AN ACTIVITY IS THE TASK. There is no separate task table, here or anywhere
-- else in this product: care_program_activities is the first task concept it
-- has, and a future general Tasks module grows from this table rather than
-- arriving beside it. A "follow-up" is an activity with a due date; no
-- appointment store is created (the plan, section 5).
--
-- NOTHING IS DELETED BY CHANGING ITS STATUS. A completed program keeps its
-- goals and every activity; a discontinued one records why and when. The
-- history is the point.
--
-- NOTHING HERE IS COMPUTED AND STORED. Progress is counted on read. There is
-- no progress column, no percentage, and no "current value" on a goal.

-- ---------------------------------------------------------------------------
-- The templates
-- ---------------------------------------------------------------------------
--
-- goals / activities / monitoring are the template's content. Their shapes:
--
--   goals      [{ "title": "HbA1c below 7%", "measure": "HbA1c",
--                 "source": "test", "code": "HBA1C", "unit": "%",
--                 "targetValue": 7, "targetText": null, "targetDays": 90 }]
--   activities [{ "kind": "monitoring", "title": "Check blood pressure",
--                 "offsetDays": 0, "recurrence": { "every": 1, "unit": "month" } }]
--   monitoring [{ "source": "vitals", "code": "systolic", "label": "Blood pressure" }]
--
-- `source` is 'vitals' (a vitalRanges key, or 'bmi') or 'test' (a
-- test_definitions code). Nothing else reads them, and an unknown code is
-- skipped rather than guessed at.
create table if not exists care_program_definitions (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  code          text not null check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name          text not null check (length(trim(name)) between 1 and 120),
  description   text check (description is null or length(description) <= 1000),
  -- The house condition code this programme is about (0059's local_code), so
  -- a recorded condition can be shown beside it. Never to create one.
  condition_code text check (condition_code is null or condition_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  goals         jsonb not null default '[]'::jsonb,
  activities    jsonb not null default '[]'::jsonb,
  monitoring    jsonb not null default '[]'::jsonb,
  -- How long until the programme itself should be reviewed. A default the
  -- enrolment screen pre-fills, never a rule.
  default_review_days smallint check (default_review_days is null or default_review_days between 1 and 730),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (pharmacy_id, code)
);

-- NULL never equals NULL, so the unique constraint above does not stop a
-- shipped code being inserted twice. This does.
create unique index if not exists idx_care_program_definitions_shipped_code
  on care_program_definitions (code) where pharmacy_id is null;

create index if not exists idx_care_program_definitions_pharmacy
  on care_program_definitions (pharmacy_id) where active;

-- ---------------------------------------------------------------------------
-- The enrolment
-- ---------------------------------------------------------------------------
create table if not exists patient_care_programs (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,

  -- The template it came from, if any, and the name AS IT WAS at enrolment.
  definition_id uuid references care_program_definitions(id) on delete set null,
  program_code  text check (program_code is null or length(program_code) <= 40),
  program_name  text not null check (length(trim(program_name)) between 1 and 120),
  condition_code text check (condition_code is null or condition_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),

  -- planned        agreed, not started
  -- active         being followed
  -- on_hold        paused, with a reason, and coming back
  -- completed      finished, with an outcome
  -- discontinued   stopped before finishing, with a reason
  -- cancelled      enrolled in error
  status        text not null default 'active' check (status in (
                  'planned', 'active', 'on_hold', 'completed', 'discontinued', 'cancelled')),

  enrolled_on   date not null default current_date,
  start_date    date,
  next_review_on date,
  end_date      date,

  -- The pharmacist responsible. The NAME is kept beside the id because staff
  -- leave and a programme's history should still say who was looking after it.
  responsible_user_id uuid references auth.users(id) on delete set null,
  responsible_name text check (responsible_name is null or length(responsible_name) <= 200),

  reason        text check (reason is null or length(reason) <= 500),
  notes         text check (notes is null or length(notes) <= 2000),

  -- How it ended, in the pharmacist's words plus one of a short list.
  outcome       text check (outcome is null or outcome in (
                  'achieved', 'partially_achieved', 'not_achieved', 'transferred', 'other')),
  outcome_notes text check (outcome_notes is null or length(outcome_notes) <= 2000),
  follow_up_recommendation text check (follow_up_recommendation is null or length(follow_up_recommendation) <= 1000),
  discontinuation_reason text check (discontinuation_reason is null or discontinuation_reason in (
                  'patient_withdrew', 'transferred_care', 'no_longer_applicable',
                  'lost_to_follow_up', 'clinical_decision', 'other')),
  status_reason text check (status_reason is null or length(status_reason) <= 500),

  recorded_by   uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Ending a programme always says how it ended. A completed programme with
  -- no outcome is the row that makes a care record worthless six months on.
  constraint patient_care_programs_completed_has_outcome check (
    status <> 'completed' or (end_date is not null and outcome is not null)
  ),
  constraint patient_care_programs_discontinued_has_reason check (
    status <> 'discontinued' or (end_date is not null and discontinuation_reason is not null)
  ),
  constraint patient_care_programs_cancelled_has_reason check (
    status <> 'cancelled' or (end_date is not null and status_reason is not null)
  ),
  -- An open programme has not ended.
  constraint patient_care_programs_open_has_no_end check (
    status in ('completed', 'discontinued', 'cancelled') or end_date is null
  ),
  constraint patient_care_programs_date_order check (
    end_date is null or start_date is null or end_date >= start_date
  ),
  -- Paused always says why.
  constraint patient_care_programs_hold_has_reason check (
    status <> 'on_hold' or status_reason is not null
  )
);

create index if not exists idx_patient_care_programs_patient
  on patient_care_programs (pharmacy_id, customer_id, status, enrolled_on desc);
-- The review list: whose programme is due to be looked at.
create index if not exists idx_patient_care_programs_review
  on patient_care_programs (pharmacy_id, next_review_on)
  where status in ('planned', 'active') and next_review_on is not null;

-- One open enrolment per patient per template. Two live "Diabetes care"
-- programmes on one person are not two courses of care, they are a
-- double-click; the service answers 409 and offers the existing one. A
-- programme with no template (free text) is not covered, deliberately: those
-- are named by hand and the pharmacist can see them on the list.
create unique index if not exists idx_patient_care_programs_one_open
  on patient_care_programs (pharmacy_id, customer_id, definition_id)
  where definition_id is not null and status in ('planned', 'active', 'on_hold');

-- ---------------------------------------------------------------------------
-- Goals
-- ---------------------------------------------------------------------------
--
-- A goal is what this programme is trying to achieve, stated so that somebody
-- can tell whether it happened. THE CURRENT VALUE IS NOT STORED:
-- measure_source + measure_code say where to read it (patient_vitals or
-- patient_tests), and it is read on display. A stored copy would be a second
-- version of a clinical number, going stale from the moment it was written.
create table if not exists care_program_goals (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  program_id    uuid not null references patient_care_programs(id) on delete cascade,

  title         text not null check (length(trim(title)) between 1 and 200),
  description   text check (description is null or length(description) <= 1000),
  status        text not null default 'planned' check (status in (
                  'planned', 'in_progress', 'achieved', 'not_achieved', 'cancelled')),

  -- What is being measured, and where it is read from.
  measure       text check (measure is null or length(measure) <= 120),
  measure_source text check (measure_source is null or measure_source in ('vitals', 'test')),
  measure_code  text check (measure_code is null or length(measure_code) <= 40),
  unit          text check (unit is null or length(unit) <= 20),

  baseline_value numeric,
  baseline_on   date,
  -- A numeric target, or one in words ("walks 30 minutes most days"), or
  -- neither: a goal a pharmacist can judge but not measure is still a goal.
  target_value  numeric,
  target_text   text check (target_text is null or length(target_text) <= 300),
  target_date   date,

  achieved_on   date,
  status_reason text check (status_reason is null or length(status_reason) <= 500),
  position      smallint not null default 0,
  notes         text check (notes is null or length(notes) <= 1000),

  recorded_by   uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A measure that names a source names what to read from it, and vice versa.
  constraint care_program_goals_measure_pair check (
    (measure_source is null) = (measure_code is null)
  ),
  -- Settled either way, and the date it settled is known.
  constraint care_program_goals_settled_has_date check (
    status not in ('achieved', 'not_achieved') or achieved_on is not null
  )
);

create index if not exists idx_care_program_goals_program
  on care_program_goals (pharmacy_id, program_id, position, created_at);

-- ---------------------------------------------------------------------------
-- Activities -- the care plan, and the task list
-- ---------------------------------------------------------------------------
--
-- One row per thing to do. `recurrence` makes it repeat: completing a
-- recurring activity writes EXACTLY ONE next occurrence, due one interval
-- later, with recurrence_of pointing back at the one it followed. The
-- completed one is kept. That is the whole mechanism -- nothing schedules
-- itself ahead of time, so a programme cannot grow a hundred rows nobody
-- asked for.
--
-- linked_type/linked_id record what the activity PRODUCED -- the reading, the
-- test, the consultation. There is no foreign key because the target is one of
-- five tables; the service checks the id against the right table AND this
-- pharmacy before storing it, which is the same guarantee a foreign key would
-- give and the only shape that works polymorphically.
create table if not exists care_program_activities (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  program_id    uuid not null references patient_care_programs(id) on delete cascade,
  -- The goal it serves, if it serves one. Deleting a goal leaves the activity.
  goal_id       uuid references care_program_goals(id) on delete set null,

  title         text not null check (length(trim(title)) between 1 and 200),
  description   text check (description is null or length(description) <= 1000),
  kind          text not null default 'other' check (kind in (
                  'assessment', 'review', 'monitoring', 'counselling', 'test',
                  'follow_up', 'vaccination', 'referral', 'other')),
  status        text not null default 'not_started' check (status in (
                  'not_started', 'in_progress', 'completed', 'skipped', 'cancelled')),

  due_on        date,
  assigned_to_user_id uuid references auth.users(id) on delete set null,
  assigned_to_name text check (assigned_to_name is null or length(assigned_to_name) <= 200),

  completed_at  timestamptz,
  completed_by  uuid references auth.users(id) on delete set null,
  outcome_note  text check (outcome_note is null or length(outcome_note) <= 1000),

  -- { "every": 1, "unit": "day" | "week" | "month" }
  recurrence    jsonb,
  recurrence_of uuid references care_program_activities(id) on delete set null,

  linked_type   text check (linked_type is null or linked_type in (
                  'vitals', 'test', 'medication', 'condition', 'encounter')),
  linked_id     uuid,

  status_reason text check (status_reason is null or length(status_reason) <= 500),
  position      smallint not null default 0,
  notes         text check (notes is null or length(notes) <= 1000),

  recorded_by   uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint care_program_activities_completed_has_time check (
    status <> 'completed' or completed_at is not null
  ),
  -- Skipping or cancelling a planned piece of care always says why.
  constraint care_program_activities_skip_has_reason check (
    status not in ('skipped', 'cancelled') or status_reason is not null
  ),
  constraint care_program_activities_link_pair check (
    (linked_type is null) = (linked_id is null)
  ),
  -- A repeat says how often and in what unit. The input contract checks the
  -- numbers; this stops a shape nothing can read from being stored at all.
  constraint care_program_activities_recurrence_shape check (
    recurrence is null or (
      jsonb_typeof(recurrence) = 'object'
      and recurrence ? 'every' and recurrence ? 'unit'
      and jsonb_typeof(recurrence->'every') = 'number'
      and recurrence->>'unit' in ('day', 'week', 'month')
    )
  )
);

create index if not exists idx_care_program_activities_program
  on care_program_activities (pharmacy_id, program_id, position, created_at);
-- The task list: what is due, oldest first.
create index if not exists idx_care_program_activities_due
  on care_program_activities (pharmacy_id, due_on)
  where status in ('not_started', 'in_progress') and due_on is not null;

-- ---------------------------------------------------------------------------
-- Links to records that already exist
-- ---------------------------------------------------------------------------
--
-- What a pharmacist attached to this programme by hand: "this programme is
-- about that condition", "this is the medicine it is managing". Nothing
-- clinical is copied -- only the id, and only after the service has checked it
-- belongs to this pharmacy and this patient.
create table if not exists care_program_links (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  program_id    uuid not null references patient_care_programs(id) on delete cascade,
  kind          text not null check (kind in ('condition', 'medication', 'test', 'vitals', 'encounter')),
  ref_id        uuid not null,
  note          text check (note is null or length(note) <= 300),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (program_id, kind, ref_id)
);

create index if not exists idx_care_program_links_program
  on care_program_links (pharmacy_id, program_id, kind);

-- ---------------------------------------------------------------------------
-- RLS -- the same shape as 0058 / 0059 / 0060
-- ---------------------------------------------------------------------------
alter table care_program_definitions enable row level security;
alter table patient_care_programs enable row level security;
alter table care_program_goals enable row level security;
alter table care_program_activities enable row level security;
alter table care_program_links enable row level security;

-- The shipped catalogue is readable by every tenant; a pharmacy's own rows are
-- its own.
drop policy if exists tenant_isolation on care_program_definitions;
create policy tenant_isolation on care_program_definitions
  using (pharmacy_id is null or pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_care_programs;
create policy tenant_isolation on patient_care_programs
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on care_program_goals;
create policy tenant_isolation on care_program_goals
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on care_program_activities;
create policy tenant_isolation on care_program_activities
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on care_program_links;
create policy tenant_isolation on care_program_links
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- The shipped templates
-- ---------------------------------------------------------------------------
--
-- Seven programmes a Nigerian community pharmacy actually runs. Idempotent:
-- re-running the migration updates the shipped rows and leaves a pharmacy's
-- own alone. NOTHING IN THE UI IS HARD-CODED TO THESE -- a programme can also
-- be enrolled with a typed name and no template at all.
insert into care_program_definitions
  (pharmacy_id, code, name, description, condition_code, goals, activities, monitoring, default_review_days)
values
  (null, 'DIABETES_CARE', 'Diabetes care',
   'Ongoing management for a patient with diabetes: glucose control, blood pressure, medicines and self-care.',
   'DIABETES',
   '[{"title":"HbA1c below 7%","measure":"HbA1c","source":"test","code":"HBA1C","unit":"%","targetValue":7,"targetDays":90},
     {"title":"Fasting glucose under 110 mg/dL","measure":"Fasting blood glucose","source":"test","code":"FBG","unit":"mg/dL","targetValue":110,"targetDays":30},
     {"title":"Takes medicines as prescribed","targetText":"No missed doses reported at review","targetDays":30}]'::jsonb,
   '[{"kind":"monitoring","title":"Check blood pressure","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"test","title":"HbA1c test","offsetDays":0,"recurrence":{"every":3,"unit":"month"}},
     {"kind":"counselling","title":"Diet and physical activity counselling","offsetDays":0},
     {"kind":"assessment","title":"Ask about foot problems and vision","offsetDays":0,"recurrence":{"every":6,"unit":"month"}},
     {"kind":"review","title":"Medication review","offsetDays":0,"recurrence":{"every":6,"unit":"month"}},
     {"kind":"review","title":"Programme review","offsetDays":90}]'::jsonb,
   '[{"source":"test","code":"HBA1C","label":"HbA1c"},
     {"source":"test","code":"FBG","label":"Fasting blood glucose"},
     {"source":"vitals","code":"systolic","label":"Systolic BP"},
     {"source":"vitals","code":"weight","label":"Weight"}]'::jsonb,
   90),

  (null, 'HYPERTENSION_CARE', 'Hypertension management',
   'Blood pressure control: monthly readings, medicines, and the checks that go with them.',
   'HYPERTENSION',
   '[{"title":"Blood pressure below 140/90","measure":"Systolic BP","source":"vitals","code":"systolic","unit":"mmHg","targetValue":140,"targetDays":30},
     {"title":"Takes medicines as prescribed","targetText":"No missed doses reported at review","targetDays":30}]'::jsonb,
   '[{"kind":"monitoring","title":"Check blood pressure","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"counselling","title":"Salt, weight and activity counselling","offsetDays":0},
     {"kind":"review","title":"Medication review","offsetDays":0,"recurrence":{"every":6,"unit":"month"}},
     {"kind":"test","title":"Kidney function and electrolytes","offsetDays":0,"recurrence":{"every":12,"unit":"month"}},
     {"kind":"review","title":"Programme review","offsetDays":30}]'::jsonb,
   '[{"source":"vitals","code":"systolic","label":"Systolic BP"},
     {"source":"vitals","code":"diastolic","label":"Diastolic BP"},
     {"source":"vitals","code":"pulse","label":"Pulse"},
     {"source":"vitals","code":"weight","label":"Weight"}]'::jsonb,
   30),

  (null, 'WEIGHT_PROGRAM', 'Weight management',
   'Working towards a weight the patient and pharmacist agreed, with regular weigh-ins.',
   null,
   '[{"title":"Reach the agreed weight","measure":"Weight","source":"vitals","code":"weight","unit":"kg","targetDays":180},
     {"title":"BMI below 25","measure":"BMI","source":"vitals","code":"bmi","unit":"kg/m2","targetValue":25,"targetDays":180}]'::jsonb,
   '[{"kind":"monitoring","title":"Weigh-in","offsetDays":0,"recurrence":{"every":2,"unit":"week"}},
     {"kind":"counselling","title":"Diet counselling","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"review","title":"Review the plan with the patient","offsetDays":30,"recurrence":{"every":1,"unit":"month"}}]'::jsonb,
   '[{"source":"vitals","code":"weight","label":"Weight"},
     {"source":"vitals","code":"bmi","label":"BMI"},
     {"source":"vitals","code":"systolic","label":"Systolic BP"}]'::jsonb,
   30),

  (null, 'MED_MANAGEMENT', 'Medication management',
   'For a patient on several medicines: reviews, adherence, and knowing what each one is for.',
   null,
   '[{"title":"No missed doses reported","targetText":"Patient reports taking every dose","targetDays":30},
     {"title":"Knows what each medicine is for","targetText":"Can name each medicine and its purpose","targetDays":90}]'::jsonb,
   '[{"kind":"review","title":"Medication review","offsetDays":0,"recurrence":{"every":3,"unit":"month"}},
     {"kind":"follow_up","title":"Adherence check","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"follow_up","title":"Refill due check","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"counselling","title":"Go through the medicines with the patient","offsetDays":0}]'::jsonb,
   '[]'::jsonb,
   90),

  (null, 'FAMILY_PLANNING', 'Family planning',
   'Supporting a patient on a chosen family-planning method, including when the next one is due.',
   null,
   '[{"title":"Continues the chosen method","targetText":"Method continued without a gap","targetDays":90}]'::jsonb,
   '[{"kind":"follow_up","title":"Next dose or refill due","offsetDays":84,"recurrence":{"every":3,"unit":"month"}},
     {"kind":"assessment","title":"Ask about side effects","offsetDays":30},
     {"kind":"review","title":"Review the method with the patient","offsetDays":0,"recurrence":{"every":3,"unit":"month"}}]'::jsonb,
   '[{"source":"vitals","code":"systolic","label":"Systolic BP"},
     {"source":"vitals","code":"weight","label":"Weight"}]'::jsonb,
   90),

  (null, 'VACCINATION_FOLLOWUP', 'Vaccination follow-up',
   'Finishing a course of vaccination: the next dose, the card, and how the patient felt after.',
   null,
   '[{"title":"Course completed","targetText":"Every dose in the course given","targetDays":180}]'::jsonb,
   '[{"kind":"vaccination","title":"Next dose due","offsetDays":28},
     {"kind":"follow_up","title":"Check for side effects","offsetDays":3},
     {"kind":"other","title":"Update the patient card","offsetDays":0}]'::jsonb,
   '[{"source":"vitals","code":"temperature","label":"Temperature"}]'::jsonb,
   30),

  (null, 'CHRONIC_MONITORING', 'Chronic disease monitoring',
   'Regular checks for a patient with a long-term condition that does not have its own programme here.',
   null,
   '[{"title":"Seen every three months","targetText":"No gap longer than three months","targetDays":90}]'::jsonb,
   '[{"kind":"monitoring","title":"Vitals check","offsetDays":0,"recurrence":{"every":1,"unit":"month"}},
     {"kind":"review","title":"Medication review","offsetDays":0,"recurrence":{"every":6,"unit":"month"}},
     {"kind":"test","title":"Routine tests","offsetDays":0,"recurrence":{"every":12,"unit":"month"}},
     {"kind":"review","title":"Programme review","offsetDays":90}]'::jsonb,
   '[{"source":"vitals","code":"systolic","label":"Systolic BP"},
     {"source":"vitals","code":"pulse","label":"Pulse"},
     {"source":"vitals","code":"weight","label":"Weight"}]'::jsonb,
   90)
on conflict (code) where pharmacy_id is null do update set
  name = excluded.name,
  description = excluded.description,
  condition_code = excluded.condition_code,
  goals = excluded.goals,
  activities = excluded.activities,
  monitoring = excluded.monitoring,
  default_review_days = excluded.default_review_days;

comment on table patient_care_programs is
  'One patient enrolled in one course of care. Organises the other clinical records and copies none of them - see the 0061 header.';
comment on table care_program_activities is
  'The care plan and the task list. This is the first task concept in this product; a general Tasks module grows from here rather than beside it.';
