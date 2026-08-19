-- 0030 — distinguish a cancelled handoff from a completed one.
--
-- THE GAP
-- `handoffs.resolved_at` has meant "this handoff is closed" since it was
-- introduced, for two genuinely different reasons that were never told
-- apart: a customer declining an offered pharmacist ("No thanks"), and a
-- pharmacist actually completing a review. Both set the same column.
--
-- That was harmless while the only consumer of "is this open" was `resolved_at
-- is null` (worker.js, the inbox). It stops being harmless the moment
-- something needs to answer spec §12's question — was this handoff
-- COMPLETED or CANCELLED — and pharmacistHandoffService.deriveHandoffStatus
-- is exactly that something.
--
-- WHY A NEW NULLABLE COLUMN, NOT A NEW MEANING FOR resolved_at
-- Every existing read of resolved_at (worker.js's decline path, the /resolve
-- route, the inbox's open-handoff count) keeps working unchanged — none of
-- them cared WHY it was resolved, only THAT it was. Repurposing the column
-- to carry that distinction would risk exactly the kind of silent behaviour
-- change item 24 of the Stage 1 spec warns against. Additive only.

alter table handoffs
  add column if not exists cancelled_at timestamptz;

comment on column handoffs.cancelled_at is
  'Set ALONGSIDE resolved_at (never instead of it) when a handoff closed as declined/cancelled rather than completed. Both null = still open. resolved_at set + cancelled_at null = completed. Both set = cancelled. See pharmacistHandoffService.deriveHandoffStatus.';
