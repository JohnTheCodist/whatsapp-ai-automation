-- 0014 — reminders for consultations nobody has picked up
--
-- One alert on escalation is not enough. The alert arrives while the
-- pharmacist is serving someone at the counter, gets glanced at, and the
-- customer waits. The first clinical escalation in this system waited 46
-- hours.
--
-- WHY THIS IS BOUNDED RATHER THAN TRULY ENDLESS
-- An alert that repeats forever gets muted, and a muted alert protects
-- nobody — the failure mode is worse than the one it was added to fix,
-- because the pharmacy then believes it is covered. So it escalates and
-- then stops: four reminders over roughly two hours, after which the queue
-- badge and the dashboard chime are the remaining signals. If a consultation
-- is still unhandled two hours in, the problem is not that nobody was told.

alter table handoffs
  add column if not exists reminder_count integer not null default 0,
  add column if not exists last_reminded_at timestamptz;

comment on column handoffs.reminder_count is
  'Reminders sent for this unhandled consultation. Capped — an alert that repeats forever gets muted, and a muted alert is worse than none because it feels like coverage.';

-- The reminder sweep runs on a timer and must not scan the table each pass.
create index if not exists handoffs_unresolved_reminder_idx
  on handoffs (pharmacy_id, requested_at) where resolved_at is null;
