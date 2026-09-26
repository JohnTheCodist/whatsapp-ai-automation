-- =====================================================================
-- Tests: diagnostic tests, their results, and what a lab reported.
-- =====================================================================
--
-- See TESTS_PLAN.md. What this is for: a pharmacist looking at a patient
-- can see what was tested, what came back, and whether it was normal —
-- without opening anything.
--
-- ONE ROW PER TEST EVENT, RESULTS BESIDE IT
-- FHIR splits this into ServiceRequest -> DiagnosticReport -> Observation.
-- In a community pharmacy the request and the report are the same event
-- nearly every time: the pharmacist does the RDT at the counter, or a
-- patient walks in with a result nobody here ordered. So patient_tests is
-- the event — ordered, performed, reported — and patient_test_results holds
-- the values, several per test, because a lipid profile is one test with
-- four numbers. The three LEVELS stay distinct: why it was asked for, what
-- the report says, and each value with its own unit, range and reading.
--
-- A TEST IS NOT A DIAGNOSIS, AND NOTHING HERE MAKES ONE. A result of
-- "positive" or "8.1 %" never creates a condition. The catalogue carries a
-- condition_code only so a test can be shown BESIDE a condition a
-- pharmacist recorded (0059), never to create one.
--
-- A TEST IS NOT A VITAL SIGN. patient_vitals (0054) holds physiological
-- measurements taken in the room — BP, pulse, temperature, SpO2, weight. A
-- glucose TEST belongs here, and 0054 has no glucose column precisely so
-- the two never compete for the same fact.
--
-- NOTHING FINAL IS SILENTLY OVERWRITTEN. Editing a final test snapshots
-- what it said into patient_test_corrections first and moves it to
-- 'corrected', with a reason.

-- ---------------------------------------------------------------------------
-- The catalogue. Data, not code, so it can grow without a deploy.
-- ---------------------------------------------------------------------------
--
-- pharmacy_id IS NULL means a row shipped with the product; a pharmacy may
-- add its own later. Nothing here is a limit: patient_tests.test_name is
-- free text and a catalogue row is optional.
--
-- THE REFERENCE RANGES BELOW ARE DEFAULTS THE FORM PRE-FILLS, NOT RULES.
-- Ranges differ by laboratory, method, sex and age, and the range that
-- MATTERS is the one printed on the report in the patient's hand. That one
-- is stored on the result row. Where a range is genuinely method- or
-- sex-dependent (haematocrit, Widal titres) this table leaves it null
-- rather than shipping a number that would be wrong half the time.
create table if not exists test_definitions (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  code          text not null check (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name          text not null check (length(trim(name)) between 1 and 120),
  category      text not null check (category in (
                  'laboratory', 'rapid_test', 'microbiology', 'haematology',
                  'chemistry', 'serology', 'imaging', 'other')),
  -- quantitative  a number with a unit
  -- coded         one of a short list (Positive / Negative …)
  -- text          a report in words
  -- panel         several analytes, each with its own value
  result_type   text not null check (result_type in ('quantitative', 'coded', 'text', 'panel')),
  specimen_default text check (specimen_default is null or specimen_default in (
                  'blood', 'urine', 'stool', 'saliva', 'swab', 'other', 'not_applicable')),
  unit          text check (unit is null or length(unit) <= 20),
  reference_low  numeric,
  reference_high numeric,
  -- For a coded test: [{ "code": "positive", "display": "Positive" }, …]
  coded_options jsonb not null default '[]'::jsonb,
  -- For a panel: [{ "code": "TC", "name": "Total cholesterol", "unit": "mg/dL", "high": 200 }, …]
  analytes      jsonb not null default '[]'::jsonb,
  -- The house condition code this test RELATES to (0059's local_code), for
  -- showing a recorded condition beside a result. Never for creating one.
  condition_code text check (condition_code is null or condition_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (pharmacy_id, code)
);

-- One partial index per half, because NULL never equals NULL: without this a
-- shipped code could be inserted twice.
create unique index if not exists idx_test_definitions_shipped_code
  on test_definitions (code) where pharmacy_id is null;

create index if not exists idx_test_definitions_pharmacy
  on test_definitions (pharmacy_id, category) where active;

-- ---------------------------------------------------------------------------
-- The test event
-- ---------------------------------------------------------------------------
create table if not exists patient_tests (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,

  -- The catalogue row it came from, if any, and the name AS IT WAS. Renaming
  -- a catalogue entry must not rewrite what a report said last year.
  definition_id uuid references test_definitions(id) on delete set null,
  test_code     text check (test_code is null or length(test_code) <= 40),
  test_name     text not null check (length(trim(test_name)) between 1 and 120),
  category      text not null default 'laboratory' check (category in (
                  'laboratory', 'rapid_test', 'microbiology', 'haematology',
                  'chemistry', 'serology', 'imaging', 'other')),

  -- The lifecycle, FHIR's names. 'final' is shown as "Completed".
  status        text not null default 'ordered' check (status in (
                  'ordered', 'pending', 'preliminary', 'final', 'amended', 'corrected', 'cancelled')),
  priority      text not null default 'routine' check (priority in ('routine', 'urgent')),

  reason        text check (reason is null or length(reason) <= 300),
  specimen      text check (specimen is null or specimen in (
                  'blood', 'urine', 'stool', 'saliva', 'swab', 'other', 'not_applicable')),

  ordered_on    date,
  ordered_by    uuid references auth.users(id) on delete set null,
  -- Who asked for it, when that was not someone here ("Dr Okafor, LUTH").
  orderer_name  text check (orderer_name is null or length(orderer_name) <= 200),

  -- When it was performed, at the precision known: a result a patient brings
  -- from last year is often just "Jun 2026".
  performed_at  timestamptz,
  performed_precision text check (performed_precision is null or performed_precision in ('day', 'month', 'year')),
  performed_by_name text check (performed_by_name is null or length(performed_by_name) <= 200),

  source        text not null default 'rxmax_clinic' check (source in (
                  'rxmax_clinic', 'external_lab', 'hospital', 'patient_reported', 'imported', 'other')),
  -- Which lab, and its own reference for the report ("Synlab · 2026-0918-441").
  source_name   text check (source_name is null or length(source_name) <= 200),
  -- An old result being entered for the record, said so by a person. Never
  -- inferred from a date.
  historical    boolean not null default false,

  encounter_id  uuid references clinical_encounters(id) on delete set null,
  -- What the report says overall, in the lab's words.
  report_summary text check (report_summary is null or length(report_summary) <= 2000),
  notes         text check (notes is null or length(notes) <= 2000),
  status_reason text check (status_reason is null or length(status_reason) <= 500),

  recorded_by   uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A date travels with its precision.
  constraint patient_tests_performed_pair check ((performed_at is null) = (performed_precision is null)),
  -- A result that is in anybody's hands was performed at some point.
  constraint patient_tests_reported_has_date check (
    status not in ('preliminary', 'final', 'amended', 'corrected') or performed_at is not null
  ),
  -- Saying a report was cancelled, amended or corrected always says why.
  constraint patient_tests_status_reason check (
    status not in ('cancelled', 'amended', 'corrected') or status_reason is not null
  )
);

create index if not exists idx_patient_tests_patient
  on patient_tests (pharmacy_id, customer_id, performed_at desc nulls last, created_at desc);
-- The trend query: this patient's values for one test over time.
create index if not exists idx_patient_tests_code
  on patient_tests (pharmacy_id, customer_id, test_code) where test_code is not null;

-- ---------------------------------------------------------------------------
-- The values
-- ---------------------------------------------------------------------------
--
-- One row per analyte. A single-value test has one; a lipid profile has four.
-- EXACTLY ONE KIND OF VALUE per row: a number, a code, or words. A row
-- carrying both a number and a code would be two claims with no way to say
-- which one the lab made.
create table if not exists patient_test_results (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  test_id       uuid not null references patient_tests(id) on delete cascade,

  analyte_name  text not null check (length(trim(analyte_name)) between 1 and 120),
  analyte_code  text check (analyte_code is null or length(analyte_code) <= 40),
  position      smallint not null default 0,

  value_number  numeric,
  unit          text check (unit is null or length(unit) <= 20),
  value_code    text check (value_code is null or length(value_code) <= 40),
  value_display text check (value_display is null or length(value_display) <= 120),
  value_text    text check (value_text is null or length(value_text) <= 2000),

  -- The range THIS result was read against — the lab's own, when it printed
  -- one. Never a product-wide threshold.
  reference_low  numeric,
  reference_high numeric,
  reference_text text check (reference_text is null or length(reference_text) <= 120),

  -- What a person concluded from the value. The form offers one for a number
  -- with a range (arithmetic, not diagnosis); what is stored is what the
  -- pharmacist confirmed. 'critical_*' is only ever chosen by a person.
  interpretation text check (interpretation is null or interpretation in (
                  'normal', 'high', 'low', 'critical_high', 'critical_low',
                  'positive', 'negative', 'abnormal', 'indeterminate', 'not_interpretable')),
  notes         text check (notes is null or length(notes) <= 1000),
  created_at    timestamptz not null default now(),

  constraint patient_test_results_one_value check (
    (case when value_number is not null then 1 else 0 end)
    + (case when value_code is not null then 1 else 0 end)
    + (case when value_text is not null then 1 else 0 end) = 1
  ),
  -- A number without its unit is not a result anybody can act on, unless the
  -- test genuinely has none (a ratio, an index).
  constraint patient_test_results_range_order check (
    reference_low is null or reference_high is null or reference_low <= reference_high
  )
);

create index if not exists idx_patient_test_results_test
  on patient_test_results (pharmacy_id, test_id, position);

-- ---------------------------------------------------------------------------
-- What a report said before it was corrected
-- ---------------------------------------------------------------------------
--
-- Append-only. Written BEFORE a final report is changed, so "it used to say
-- 8.1 %" is answerable — which is the whole point of correcting rather than
-- overwriting (brief §27).
create table if not exists patient_test_corrections (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  test_id       uuid not null references patient_tests(id) on delete cascade,
  -- The test row and its results exactly as they were.
  snapshot      jsonb not null,
  reason        text not null check (length(trim(reason)) between 1 and 500),
  corrected_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_patient_test_corrections_test
  on patient_test_corrections (pharmacy_id, test_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0058 / 0059
-- ---------------------------------------------------------------------------
alter table test_definitions enable row level security;
alter table patient_tests enable row level security;
alter table patient_test_results enable row level security;
alter table patient_test_corrections enable row level security;

-- The shipped catalogue is readable by every tenant; a pharmacy's own rows
-- are its own.
drop policy if exists tenant_isolation on test_definitions;
create policy tenant_isolation on test_definitions
  using (pharmacy_id is null or pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_tests;
create policy tenant_isolation on patient_tests
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_test_results;
create policy tenant_isolation on patient_test_results
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
drop policy if exists tenant_isolation on patient_test_corrections;
create policy tenant_isolation on patient_test_corrections
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- The shipped catalogue
-- ---------------------------------------------------------------------------
--
-- Common community-pharmacy tests in Nigeria. Idempotent: re-running the
-- migration updates the shipped rows and leaves a pharmacy's own alone.
insert into test_definitions
  (pharmacy_id, code, name, category, result_type, specimen_default, unit,
   reference_low, reference_high, coded_options, analytes, condition_code)
values
  -- ---- rapid tests done at the counter ----
  (null, 'MAL_RDT', 'Malaria RDT', 'rapid_test', 'coded', 'blood', null, null, null,
   '[{"code":"positive","display":"Positive"},{"code":"negative","display":"Negative"},{"code":"invalid","display":"Invalid"}]'::jsonb, '[]'::jsonb, null),
  (null, 'PREG_TEST', 'Pregnancy test', 'rapid_test', 'coded', 'urine', null, null, null,
   '[{"code":"positive","display":"Positive"},{"code":"negative","display":"Negative"}]'::jsonb, '[]'::jsonb, null),
  (null, 'HIV_SCREEN', 'HIV screening', 'rapid_test', 'coded', 'blood', null, null, null,
   '[{"code":"reactive","display":"Reactive"},{"code":"non_reactive","display":"Non-reactive"},{"code":"indeterminate","display":"Indeterminate"}]'::jsonb, '[]'::jsonb, null),
  (null, 'HBSAG', 'Hepatitis B surface antigen', 'serology', 'coded', 'blood', null, null, null,
   '[{"code":"positive","display":"Positive"},{"code":"negative","display":"Negative"}]'::jsonb, '[]'::jsonb, null),
  (null, 'HCV_SCREEN', 'Hepatitis C screening', 'serology', 'coded', 'blood', null, null, null,
   '[{"code":"positive","display":"Positive"},{"code":"negative","display":"Negative"}]'::jsonb, '[]'::jsonb, null),
  (null, 'SICKLING', 'Sickling test', 'haematology', 'coded', 'blood', null, null, null,
   '[{"code":"positive","display":"Positive"},{"code":"negative","display":"Negative"}]'::jsonb, '[]'::jsonb, null),
  (null, 'GENOTYPE', 'Genotype (haemoglobin electrophoresis)', 'haematology', 'coded', 'blood', null, null, null,
   '[{"code":"AA","display":"AA"},{"code":"AS","display":"AS"},{"code":"AC","display":"AC"},{"code":"SS","display":"SS"},{"code":"SC","display":"SC"}]'::jsonb, '[]'::jsonb, null),
  (null, 'BLOOD_GROUP', 'Blood group', 'haematology', 'coded', 'blood', null, null, null,
   '[{"code":"O_POS","display":"O positive"},{"code":"O_NEG","display":"O negative"},{"code":"A_POS","display":"A positive"},{"code":"A_NEG","display":"A negative"},{"code":"B_POS","display":"B positive"},{"code":"B_NEG","display":"B negative"},{"code":"AB_POS","display":"AB positive"},{"code":"AB_NEG","display":"AB negative"}]'::jsonb, '[]'::jsonb, null),

  -- ---- numbers ----
  (null, 'FBG', 'Fasting blood glucose', 'chemistry', 'quantitative', 'blood', 'mg/dL', 70, 99, '[]'::jsonb, '[]'::jsonb, 'DIABETES'),
  (null, 'RBG', 'Random blood glucose', 'chemistry', 'quantitative', 'blood', 'mg/dL', null, null, '[]'::jsonb, '[]'::jsonb, 'DIABETES'),
  (null, 'HBA1C', 'HbA1c', 'chemistry', 'quantitative', 'blood', '%', 4.0, 5.6, '[]'::jsonb, '[]'::jsonb, 'DIABETES'),
  (null, 'HB', 'Haemoglobin', 'haematology', 'quantitative', 'blood', 'g/dL', null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'PCV', 'PCV (haematocrit)', 'haematology', 'quantitative', 'blood', '%', null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'CREATININE', 'Serum creatinine', 'chemistry', 'quantitative', 'blood', 'mg/dL', 0.6, 1.2, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'UREA', 'Serum urea', 'chemistry', 'quantitative', 'blood', 'mg/dL', 15, 45, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'URIC_ACID', 'Uric acid', 'chemistry', 'quantitative', 'blood', 'mg/dL', 3.5, 7.2, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'ALT', 'ALT (SGPT)', 'chemistry', 'quantitative', 'blood', 'U/L', 7, 56, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'AST', 'AST (SGOT)', 'chemistry', 'quantitative', 'blood', 'U/L', 10, 40, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'TSH', 'TSH', 'chemistry', 'quantitative', 'blood', 'mIU/L', 0.4, 4.0, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'PSA', 'PSA', 'chemistry', 'quantitative', 'blood', 'ng/mL', null, 4.0, '[]'::jsonb, '[]'::jsonb, null),

  -- ---- panels ----
  (null, 'LIPID', 'Lipid profile', 'chemistry', 'panel', 'blood', null, null, null, '[]'::jsonb,
   '[{"code":"TC","name":"Total cholesterol","unit":"mg/dL","high":200},
     {"code":"HDL","name":"HDL cholesterol","unit":"mg/dL","low":40},
     {"code":"LDL","name":"LDL cholesterol","unit":"mg/dL","high":100},
     {"code":"TRIG","name":"Triglycerides","unit":"mg/dL","high":150}]'::jsonb, 'DYSLIPIDEMIA'),
  (null, 'FBC', 'Full blood count', 'haematology', 'panel', 'blood', null, null, null, '[]'::jsonb,
   '[{"code":"HB","name":"Haemoglobin","unit":"g/dL"},
     {"code":"WBC","name":"White cell count","unit":"x10^9/L","low":4,"high":11},
     {"code":"PLT","name":"Platelets","unit":"x10^9/L","low":150,"high":400},
     {"code":"PCV","name":"PCV","unit":"%"}]'::jsonb, null),
  (null, 'LFT', 'Liver function tests', 'chemistry', 'panel', 'blood', null, null, null, '[]'::jsonb,
   '[{"code":"ALT","name":"ALT","unit":"U/L","low":7,"high":56},
     {"code":"AST","name":"AST","unit":"U/L","low":10,"high":40},
     {"code":"ALP","name":"ALP","unit":"U/L"},
     {"code":"TBIL","name":"Total bilirubin","unit":"mg/dL","low":0.1,"high":1.2}]'::jsonb, null),
  (null, 'EUCR', 'Electrolytes, urea and creatinine', 'chemistry', 'panel', 'blood', null, null, null, '[]'::jsonb,
   '[{"code":"NA","name":"Sodium","unit":"mmol/L","low":135,"high":145},
     {"code":"K","name":"Potassium","unit":"mmol/L","low":3.5,"high":5.1},
     {"code":"UREA","name":"Urea","unit":"mg/dL","low":15,"high":45},
     {"code":"CREAT","name":"Creatinine","unit":"mg/dL","low":0.6,"high":1.2}]'::jsonb, null),

  -- ---- reports in words ----
  (null, 'URINALYSIS', 'Urinalysis', 'laboratory', 'text', 'urine', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'STOOL_MCS', 'Stool microscopy and culture', 'microbiology', 'text', 'stool', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'URINE_MCS', 'Urine microscopy and culture', 'microbiology', 'text', 'urine', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'WIDAL', 'Widal test', 'serology', 'text', 'blood', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'ECG', 'ECG', 'other', 'text', 'not_applicable', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'CXR', 'Chest X-ray', 'imaging', 'text', 'not_applicable', null, null, null, '[]'::jsonb, '[]'::jsonb, null),
  (null, 'USS_ABDO', 'Abdominal ultrasound', 'imaging', 'text', 'not_applicable', null, null, null, '[]'::jsonb, '[]'::jsonb, null)
on conflict (code) where pharmacy_id is null do update set
  name = excluded.name,
  category = excluded.category,
  result_type = excluded.result_type,
  specimen_default = excluded.specimen_default,
  unit = excluded.unit,
  reference_low = excluded.reference_low,
  reference_high = excluded.reference_high,
  coded_options = excluded.coded_options,
  analytes = excluded.analytes,
  condition_code = excluded.condition_code;

comment on table patient_tests is
  'One diagnostic test event: ordered, performed, reported. Results live in patient_test_results. Never a diagnosis and never a vital sign — see 0060 header.';
