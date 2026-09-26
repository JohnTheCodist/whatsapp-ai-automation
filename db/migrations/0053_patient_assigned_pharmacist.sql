-- =====================================================================
-- Each patient may have one assigned pharmacist.
-- =====================================================================
--
-- WHY ON customers AND NOT patient_profiles
-- Assignment is a care-relationship fact about the patient ("Mrs Bello is
-- Pharm. Ade's patient"), wanted on the patient list and its filters for
-- everyone. patient_profiles is the clinical record, created lazily the
-- first time a consultation needs it — most patients have none, and a
-- filter that joined through it would silently lose them.
--
-- The only assignment before this was conversations.assigned_to (0023):
-- who is handling one conversation. A patient with no open conversation had
-- no pharmacist at all, which is most of them.
--
-- THE DATABASE ENFORCES "SAME PHARMACY"
-- A composite foreign key onto pharmacy_members (pharmacy_id, user_id) —
-- unique since 0001 — means an assignee must be a member of THIS patient's
-- pharmacy. A service check alone would be one forgotten WHERE away from
-- assigning pharmacy A's patient to pharmacy B's pharmacist.
--
-- When the pharmacist leaves the pharmacy (their membership row goes), the
-- patient becomes unassigned rather than blocking the removal or pointing at
-- someone who no longer works there. `on delete set null (column)` nulls
-- only the assignee — the plain form would try to null pharmacy_id too,
-- which is not null. Column-list SET NULL needs PostgreSQL 15+.
--
-- Role (pharmacist vs owner vs staff) is checked in the service, not here:
-- a role can change after assignment, and a pharmacist moved to "staff"
-- should keep their existing patients until someone reassigns them.

alter table customers
  add column if not exists assigned_pharmacist_id uuid;

alter table customers
  drop constraint if exists customers_assigned_pharmacist_fk;
alter table customers
  add constraint customers_assigned_pharmacist_fk
  foreign key (pharmacy_id, assigned_pharmacist_id)
  references pharmacy_members (pharmacy_id, user_id)
  on delete set null (assigned_pharmacist_id);

-- The filter ("my patients", "unassigned") and the pharmacist's own list.
create index if not exists idx_customers_assigned_pharmacist
  on customers (pharmacy_id, assigned_pharmacist_id);
