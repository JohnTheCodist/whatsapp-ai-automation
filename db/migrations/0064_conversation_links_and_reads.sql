-- =====================================================================
-- Messages phase 2: what a conversation was ABOUT, and who has read it.
-- =====================================================================
--
-- See MESSAGES_PLAN.md §5 and §12. Two new tables. Neither touches
-- `conversations` or `messages`, which receive live WhatsApp traffic — the
-- only change 0063 made to those was one nullable column, and phase 2 adds
-- none at all.
--
-- ---------------------------------------------------------------------------
-- conversation_links — the clinical context of a conversation (§13)
-- ---------------------------------------------------------------------------
--
-- A REFERENCE, NEVER A COPY. §13 is explicit: "Do NOT duplicate those clinical
-- records inside Messages. Store references to them." So this table holds a
-- kind and an id and nothing else about the record — no medicine name, no
-- result value, no date. The screen reads those from the section that owns
-- them, through `clinicalRefs.describeRecord`, which returns a LABEL and never
-- a clinical value.
--
-- That is not tidiness. A conversation that stored "Amlodipine 10 mg" would
-- still say 10 mg after the dose was changed, and a pharmacist reading the
-- thread would be reading a stale prescription with a patient in front of
-- them.
--
-- WHY NOT A FOREIGN KEY
-- The target is one of eight tables. The same problem `care_program_links`
-- (0061) and `patient_tasks.source_type/source_id` (0062) have, solved the
-- same way: the CHECK constrains the KIND, and `clinicalRefs.assertRecord`
-- proves the id is this patient's, in this pharmacy, before the row is
-- written. The check IS the guarantee.
--
-- WHY customer_id IS HERE AS WELL AS conversation_id
-- Denormalised on purpose. Every read of this table is "this patient's links",
-- and carrying the patient means the scope lives in this table's own WHERE
-- clause rather than in a join somebody has to remember — GOLDEN-001.

create table if not exists conversation_links (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  kind            text not null check (kind in (
                    'condition', 'medication', 'test', 'vitals',
                    'consultation', 'care_program', 'medication_review', 'followup')),
  ref_id          uuid not null,
  note            text check (note is null or length(note) <= 300),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- The same record attached twice is one attachment. Detaching and
  -- reattaching is allowed, and is a new row with a new timestamp.
  unique (conversation_id, kind, ref_id)
);

create index if not exists idx_conversation_links_conversation
  on conversation_links (pharmacy_id, conversation_id);
create index if not exists idx_conversation_links_patient
  on conversation_links (pharmacy_id, customer_id, kind);

-- ---------------------------------------------------------------------------
-- conversation_read_marks — unread, per person (§17)
-- ---------------------------------------------------------------------------
--
-- WHY A MARK PER USER AND NOT A FLAG PER MESSAGE
-- "Unread" is not a property of a message, it is a relationship between a
-- message and a reader. A flag on the message means the first pharmacist to
-- open a thread clears the badge for the colleague who was about to answer
-- it — and the colleague never learns the patient was waiting.
--
-- One row per (conversation, user), holding the moment that person last read
-- it. Unread is then COUNTED on read: inbound messages newer than the mark.
-- No counter to drift, no backfill, and a user who has never opened a thread
-- has no row — which correctly means everything in it is unread.
--
-- §17: "Do not automatically mark messages as read before they are viewed."
-- Nothing writes here except an explicit request from a screen that has
-- actually rendered the transcript. No GET in this product updates it.

create table if not exists conversation_read_marks (
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists idx_conversation_read_marks_user
  on conversation_read_marks (pharmacy_id, user_id);

-- ---------------------------------------------------------------------------
-- RLS — the same shape as 0058 / 0059 / 0060 / 0061
-- ---------------------------------------------------------------------------
alter table conversation_links enable row level security;
alter table conversation_read_marks enable row level security;

drop policy if exists tenant_isolation on conversation_links;
create policy tenant_isolation on conversation_links
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

drop policy if exists tenant_isolation on conversation_read_marks;
create policy tenant_isolation on conversation_read_marks
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);

comment on table conversation_links is
  'What a conversation was about: a kind and an id, never a copy of what the record says. The owning section is where clinical values are read.';
comment on table conversation_read_marks is
  'When each user last read each conversation. Unread is counted from this, never stored as a flag on a message.';
