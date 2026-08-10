-- 0009 — new-number warm-up
--
-- A number that has never sent a message and then starts sending at normal
-- volume on its first day is itself a signal, independent of what the
-- messages say. This matters here specifically because of Door A: the
-- pharmacy connects a CLEAN number with no history, which is exactly the
-- profile that gets looked at hardest.
--
-- The ramp is stored per-pharmacy rather than derived from message counts,
-- because "when did this number start" is not the same question as "how many
-- rows are in messages". A re-pair, a database restore, or importing an
-- existing number would all give the wrong answer, and the wrong answer here
-- means either a pointless week of throttling or no protection at all.
--
-- NOT included, deliberately: fabricated typos, fake read-gaps, or device
-- fingerprint spoofing. Those defeat a classifier by lying about what
-- happened rather than by genuinely being low-volume traffic. Ramping real
-- volume is a fact about the account; inventing human error is a claim about
-- it that is not true.

alter table pharmacies
  -- When this number began sending. NULL means it has not started yet — set
  -- on the first successful outbound send, not at connect, because a socket
  -- that opened and never sent anything has not begun anything.
  add column if not exists warmup_started_at timestamptz,
  -- Off means no ramp. Correct for a number that already has months of
  -- ordinary history (a Door B / coexistence migration), where throttling
  -- would be the anomaly rather than the protection.
  add column if not exists warmup_enabled boolean not null default true,
  -- Day-one ceiling. Grows over the warm-up window; see warmupPolicy.js.
  add column if not exists warmup_day1_limit integer not null default 20
    check (warmup_day1_limit between 1 and 500),
  add column if not exists warmup_days integer not null default 7
    check (warmup_days between 1 and 30);

comment on column pharmacies.warmup_started_at is
  'First successful outbound send. NULL = not started. Set once, never reset — a warm number does not become cold by reconnecting.';
comment on column pharmacies.warmup_enabled is
  'Ramp outbound volume over the first days. Turn OFF for a number that already has real history, where throttling would itself be the anomaly.';
