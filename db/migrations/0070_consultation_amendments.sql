-- ---------------------------------------------------------------------------
-- 0070 — amending a finalised consultation (CONSULTATION_PLAN.md phase 3, §32)
-- ---------------------------------------------------------------------------
--
-- §32 asks for "a correction/amendment mechanism rather than silently
-- overwriting". This is that mechanism, and it is the shape 0060 settled for
-- diagnostic reports: SNAPSHOT FIRST, with a reason the database itself
-- requires, then edit.
--
-- WHY THIS ADDS NO STATUS VALUE
--
-- The obvious design is a fifth status, `amended`. It was rejected twice over:
--
--   1. A note that has been reopened for amendment is NOT finished. Labelling
--      it `amended` would show a half-rewritten clinical record as though it
--      were signed, which is the opposite of what §32 is for. Amending returns
--      the note to `in_progress` — it really is in progress — and re-finalising
--      puts it back to `completed` through the SAME gate, so an amended note
--      must still satisfy everything its type requires.
--
--   2. "Has this note been amended, and how often?" is answered by COUNTING
--      the rows below, on every read. A status value would answer it only
--      until the next amendment, and a stored counter is one more thing that
--      can disagree with the rows it counts. Nothing in this feature stores a
--      derived answer — see the consultation summary, which is built on every
--      read for the same reason.
--
-- So 0067's status CHECK is untouched. In fact 0067 already ENFORCES this
-- design: `status in ('draft','in_progress') and completed_at is null and
-- finalised_by is null` means reopening a note must clear both, which is
-- exactly right — the note is not finalised any more, and saying who finalised
-- it would name somebody for a signature that has been withdrawn. Who signed
-- the version being replaced is in the snapshot, where it stays true.
--
-- WHAT THE SNAPSHOT HOLDS
--
-- The whole note as it read when it was finalised: its own columns, its
-- problems, its interventions and its referral decision. Not a diff. A diff
-- of a clinical record is only readable next to the thing it applies to, and
-- once there are two amendments nobody can reconstruct the middle version
-- without replaying them in order and getting it right. The point of §32 is
-- that what the note SAID is recoverable, and a full copy is the only form of
-- that which cannot be got wrong.
--
-- This is the one place in the feature that deliberately COPIES clinical
-- values rather than pointing at them. Everywhere else a copy would go stale;
-- here going stale is the entire purpose — the snapshot must keep saying what
-- the note said in 2026, even after the medicine it named has been edited.

create table if not exists consultation_amendments (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  consultation_id uuid not null references pharmacist_consultations(id) on delete cascade,

  -- The note exactly as it read before this amendment.
  snapshot        jsonb not null,

  -- Never optional. 0060's rule: saying a record was amended always says why.
  reason          text not null check (length(trim(reason)) between 3 and 500),

  amended_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- The history panel reads newest-first for one note.
create index if not exists idx_consultation_amendments_note
  on consultation_amendments (pharmacy_id, consultation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0058 / 0059 / 0060 / 0067 / 0069
-- ---------------------------------------------------------------------------
alter table consultation_amendments enable row level security;

drop policy if exists tenant_isolation on consultation_amendments;
create policy tenant_isolation on consultation_amendments
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

comment on table consultation_amendments is
  'What a consultation SAID before it was amended, with the reason. A full copy on purpose — the one place in this feature that copies clinical values rather than pointing at them, because here going stale is the point.';
