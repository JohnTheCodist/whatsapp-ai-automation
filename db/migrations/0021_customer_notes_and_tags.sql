-- 0021 — internal staff notes, customer tags, and an explicit internal/
--        customer-visible split on the event stream
--
-- THE POINT OF THIS MIGRATION IS A BOUNDARY, NOT TWO FEATURES
--
-- Notes and tags are the first data in this system that staff write ABOUT a
-- customer rather than facts the customer gave or the system observed. That
-- makes them the first thing that would do real damage by leaking into an
-- assistant reply:
--
--   "Customer prefers pickup."        -> "I know you prefer pickup"
--   "Suspected reselling"             -> unusable, and a complaint
--   HIGH_VALUE                        -> quietly different treatment
--   PHARMACIST_FOLLOW_UP              -> read by the model as an instruction
--
-- The last one is the subtle one and the reason tags are not a text column on
-- customers. Anything sitting on the customer row tends to get selected by a
-- future `select *` and handed to whatever needs "the customer". A separate
-- table has to be joined deliberately, so leaking it becomes something
-- somebody has to actively write rather than something they forget to remove.
--
-- The enforcement is not this comment. It is:
--   - separate tables, never joined into the assistant's query
--   - respond() taking explicitly enumerated fields (it already does)
--   - a test that plants a sentinel note and fails if it ever reaches the
--     model (server/tests/crmBoundary.test.js)

-- ---------------------------------------------------------------------------
-- internal notes
-- ---------------------------------------------------------------------------

create table patient_notes (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  -- Nullable: DEV_AUTH_BYPASS has no real user, and a note whose author we
  -- cannot name is still worth keeping. Never inferred or faked.
  author_id   uuid references auth.users(id) on delete set null,
  content     text not null check (length(trim(content)) between 1 and 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index patient_notes_customer_idx on patient_notes (pharmacy_id, customer_id, created_at desc);

comment on table patient_notes is
  'Staff-only. Never enters LLM context, never shown to a customer — see 0021 and crmBoundary.test.js.';

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
--
-- Two tables rather than a text[] or a comma-separated column. The join table
-- is what makes "which customers are REFILL_CUSTOMER" an index lookup instead
-- of a string scan, and what lets a tag be renamed without rewriting every
-- customer row. It is also, deliberately, one more join the assistant's query
-- would have to add on purpose.

create table tags (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  -- What staff see. Editable without breaking anything that references slug.
  name        text not null check (length(trim(name)) between 1 and 40),
  -- Stable machine name. A future automation ("attach REFILL_DUE") matches on
  -- this, so renaming the label never breaks the rule that sets it.
  slug        text not null check (slug ~ '^[a-z0-9_]+$'),
  -- Seeded vocabulary vs. something this pharmacy invented. Kept so a later
  -- feature can offer the standard set without clobbering custom tags.
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (pharmacy_id, slug)
);

create table patient_tags (
  customer_id uuid not null references customers(id) on delete cascade,
  tag_id      uuid not null references tags(id) on delete cascade,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  -- The requirement that a tag cannot be attached twice. Enforced here rather
  -- than by checking first, for the same reason every other uniqueness in this
  -- schema is: two staff clicking at once must not both succeed.
  primary key (customer_id, tag_id)
);

create index patient_tags_tag_idx on patient_tags (pharmacy_id, tag_id);

comment on table tags is
  'Pharmacy-scoped CRM metadata. NOT model instructions: HIGH_VALUE must never change pricing, PHARMACIST_FOLLOW_UP must never become a prompt line.';

-- ---------------------------------------------------------------------------
-- event visibility
-- ---------------------------------------------------------------------------
--
-- The event stream now carries two genuinely different kinds of fact. "The
-- customer asked about Coartem" is something the customer did and could be
-- shown their own copy of. "Jane tagged them HIGH_VALUE" is not.
--
-- Defaulting to 'customer_visible' keeps every existing row correct — all of
-- them describe real customer-facing activity. Internal is opt-in, so a new
-- internal event type that forgets to set it fails safe in the direction of
-- being visible to STAFF, never the direction of being sent to a customer:
-- nothing in this system sends events to customers at all, and the timeline
-- these appear on is the staff dashboard.
alter table customer_events
  add column if not exists visibility text not null default 'customer_visible'
    check (visibility in ('customer_visible', 'internal'));

comment on column customer_events.visibility is
  'internal = staff-only CRM activity (notes, tags). Filterable so a future customer-facing history cannot accidentally include it.';

-- ---------------------------------------------------------------------------
-- seed the starting vocabulary for existing pharmacies
-- ---------------------------------------------------------------------------
--
-- is_system so a pharmacy can rename or ignore them, and a later migration can
-- tell what it originally installed from what staff added themselves.

insert into tags (pharmacy_id, name, slug, is_system)
select p.id, v.name, v.slug, true
from pharmacies p
cross join (values
  ('New customer',        'new_customer'),
  ('Repeat customer',     'repeat_customer'),
  ('High value',          'high_value'),
  ('Refill customer',     'refill_customer'),
  ('Pharmacist follow-up','pharmacist_follow_up'),
  ('Delivery customer',   'delivery_customer')
) as v(name, slug)
on conflict (pharmacy_id, slug) do nothing;
