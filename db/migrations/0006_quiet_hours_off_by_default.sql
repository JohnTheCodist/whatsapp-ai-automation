-- 0006 — quiet hours off by default
--
-- 0005 shipped quiet hours ON at 22:00-06:00. Within hours it silently
-- swallowed a real test message at 04:53, and the only way to find out why
-- was to read the server log. That is the wrong default for three reasons.
--
-- It is the weakest of the anti-ban controls. The load-bearing ones are
-- reactive-only, rate limiting, and never initiating contact — those remove
-- the behaviours that actually get numbers actioned. "Does not reply at 4am"
-- is a much smaller signal, and it is the only one of the set that costs the
-- product real conversations.
--
-- It is not ours to decide. Plenty of Nigerian pharmacies trade late or
-- around the clock, and a customer asking about medicine at 4am may have a
-- genuine need. A pharmacy that wants overnight silence can switch it on;
-- assuming it for them is a business decision made in a migration.
--
-- And it fails invisibly. A suppressed reply looks identical to a broken
-- assistant from the outside. Anything that silently drops customer messages
-- has to be something the owner chose, so they know to look.
--
-- The capability stays. Only the default changes.

alter table pharmacies alter column quiet_hours_enabled set default false;

-- Existing rows were opted in by 0005 without anyone asking. Clear that.
-- Safe to apply broadly: no pharmacy has yet had a way to set this
-- deliberately, so every `true` here is the old default rather than a choice.
update pharmacies set quiet_hours_enabled = false where quiet_hours_enabled = true;

comment on column pharmacies.quiet_hours_enabled is
  'Off by default. When on, the assistant is silent between quiet_hours_start and quiet_hours_end — a suppressed reply is indistinguishable from a broken assistant, so this must be a deliberate choice.';
