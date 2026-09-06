-- Pharmacy websites — the record a pharmacy's public site is built from.
--
-- WHAT THE PUBLISHED PAGE ACTUALLY IS
-- Not HTML the browser sent us. The server renders every byte of a published
-- page from `site_data` (structure and copy) plus the pharmacy's profile
-- (facts), through a fixed set of block renderers. `published_html` below is
-- therefore a CACHE of that render, not a source of truth — it can be thrown
-- away and regenerated at any time, and a renderer improvement reaches every
-- existing site by re-rendering rather than by asking owners to republish.
--
-- That is the whole reason there is no HTML sanitiser anywhere in this
-- feature. There is no untrusted markup to sanitise: an owner composes
-- registered blocks and configures their permitted properties, and a block
-- type the renderer does not know renders nothing. The residual surface is
-- owner-typed TEXT, which is escaped at render time.
--
-- ONE AUTHORITATIVE SOURCE PER FACT
--   pharmacies          name, public_whatsapp_number
--   pharmacy_profile    phone, address, hours, services, description, brand
--   site_data           page structure and copy
--   published_html      derived; owns no truth of its own
--
-- A pharmacy that changes its phone number in Settings does not edit its
-- website. The change enqueues a re-render, and the same code path that
-- published the page produces the new one.

-- =====================================================================
-- THE WEBSITE
-- =====================================================================

create table if not exists pharmacy_websites (
  -- PRIMARY KEY, not a surrogate id with a unique constraint. There is
  -- exactly one website per pharmacy, the same one-to-one shape as
  -- pharmacy_profile and for the same reason: a join written for a
  -- one-to-one is a join written wrong eventually. If multiple sites per
  -- pharmacy ever become real they arrive as their own table, rather than
  -- as a nullable column nobody trusts.
  pharmacy_id       uuid primary key references pharmacies(id) on delete cascade,

  -- Which template this site was CLONED from, and at which version.
  -- Recorded rather than referenced: updating a template in the repository
  -- must never alter a site somebody already published. Migration between
  -- versions is opt-in and writes a revision first.
  template_id       text not null,
  template_version  integer not null,

  -- The editable structure: an ordered list of blocks and their properties.
  -- Written by the guided flow AND by the advanced editor, which is what
  -- makes the editor optional — the renderer cannot tell which produced it.
  site_data         jsonb not null default '{}'::jsonb,

  -- Guided-step answers and theme, held SEPARATE from site_data so that
  -- switching template does not discard what the owner typed.
  content           jsonb not null default '{}'::jsonb,
  theme             jsonb not null default '{}'::jsonb,

  -- The published snapshot of site_data. THIS is what the public page is
  -- rendered from — never the draft, so editing a site cannot change what
  -- visitors see until the owner publishes.
  published_data    jsonb,
  -- Cache of the render. Regenerable; see the header.
  published_html    text,
  published_at      timestamptz,

  status            text not null default 'draft'
                    check (status in ('draft', 'published', 'unpublished')),

  -- DELIBERATELY NOT pharmacies.slug. That column is generated from the
  -- pharmacy's name with a random suffix on collision, has no reserved-word
  -- check, and is documented in services/pharmacies.js as "a convenience,
  -- not an identifier". A public hostname is exactly the thing it was not
  -- designed to be, so a site gets its own validated, owner-chosen value.
  subdomain         text unique,
  custom_domain     text unique,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Partial: only published rows are ever looked up by the public route, and
-- only non-null subdomains can be resolved. Indexing the nulls would be
-- indexing the rows this index exists to skip.
create index if not exists idx_pharmacy_websites_subdomain
  on pharmacy_websites(subdomain) where subdomain is not null;
create index if not exists idx_pharmacy_websites_published
  on pharmacy_websites(status) where status = 'published';

-- =====================================================================
-- PUBLISH HISTORY
-- =====================================================================

-- Exists so that publishing is never destructive. The brief asks for safety
-- over automatic updates, and a rollback the owner can reach without
-- support is the cheapest form of that.
--
-- Stores site_data, NOT rendered HTML. The HTML is a cache of this row plus
-- the profile, so keeping it here would be storing a cache of a cache — and
-- one that would go stale against the renderer the moment it improved.
create table if not exists website_revisions (
  id                bigint generated always as identity primary key,
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  site_data         jsonb not null,
  template_id       text not null,
  template_version  integer not null,
  -- Nullable and ON DELETE SET NULL: a member who leaves the pharmacy must
  -- not take the publish history with them.
  published_by      uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_website_revisions_pharmacy
  on website_revisions(pharmacy_id, created_at desc);

-- =====================================================================
-- ASSETS
-- =====================================================================

-- Named pharmacy_assets, NOT website_assets. A logo is a fact about the
-- pharmacy, not about one of its pages, and it will be wanted on the
-- customer QR sheet and on receipts long before there is a second website.
create table if not exists pharmacy_assets (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  kind         text not null check (kind in ('logo', 'hero', 'gallery', 'service')),
  -- Object path inside the bucket, ALWAYS prefixed with pharmacy_id, so the
  -- storage layer can enforce the same boundary the API does and a leaked
  -- URL is traceable to a tenant. Unique because two rows pointing at one
  -- object means deleting either one breaks the other.
  storage_path text not null unique,
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        integer not null,
  width        integer,
  height       integer,
  created_at   timestamptz not null default now()
);

create index if not exists idx_pharmacy_assets_pharmacy
  on pharmacy_assets(pharmacy_id, kind);

-- =====================================================================
-- PROFILE ADDITIONS
-- =====================================================================
--
-- READ THIS BEFORE WIRING ANY OF THESE INTO THE ASSISTANT.
--
-- pharmacy_profile is assistant-facing. extra_info on this table is injected
-- into the assistant's context verbatim, and the columns below sit beside it.
--
-- `description` and `services` are WEBSITE COPY. They are marketing text an
-- owner writes for visitors, and they have had no clinical review. They must
-- NOT be added to the assistant's context as a side effect of the website
-- builder. Making the assistant answer "what services do you offer" from
-- these columns is a good feature and a SEPARATE change, with its own review
-- — the same bar every other thing the assistant may state has had to clear.

alter table pharmacy_profile
  add column if not exists description     text,
  -- [{name:'Prescriptions', note:'...'}, ...] — validated in the service,
  -- not by a check constraint, because the shape will grow.
  add column if not exists services        jsonb not null default '[]'::jsonb,
  add column if not exists logo_asset_id   uuid references pharmacy_assets(id) on delete set null,
  -- #RRGGBB. Validated in the service; stored as text because a colour is
  -- not an enum and Postgres has no colour type worth the migration.
  add column if not exists brand_primary   text,
  add column if not exists brand_secondary text,
  add column if not exists maps_url        text,
  add column if not exists latitude        numeric(9,6),
  add column if not exists longitude       numeric(9,6);

comment on column pharmacy_profile.description is
  'Website copy, written for visitors. NOT reviewed for clinical safety and NOT part of the assistant''s context.';
comment on column pharmacy_profile.services is
  'Website copy, written for visitors. NOT reviewed for clinical safety and NOT part of the assistant''s context.';

-- =====================================================================
-- ROW-LEVEL SECURITY (defence in depth — see 0001_init.sql's header)
-- =====================================================================
--
-- The API connects as service_role and BYPASSES all of this; the real
-- boundary is the explicit `where pharmacy_id = $1` in every query, guarded
-- by assertPharmacyId. These policies are the second layer, and they are
-- written the same way as every other tenant table so there is one pattern
-- to check rather than three.

alter table pharmacy_websites enable row level security;
alter table website_revisions enable row level security;
alter table pharmacy_assets   enable row level security;

-- DROP-THEN-CREATE, not a bare CREATE.
--
-- Every other statement in this file is `if not exists`, so the file claims
-- to be re-runnable. Postgres has no CREATE POLICY IF NOT EXISTS, so a bare
-- create would break that claim: the tables would be skipped on a second run
-- and then the policy statement would abort with "policy already exists".
--
-- That is not hypothetical here. This migration touches four tables, and a
-- run that fails partway through — a lost connection to the pooler, which
-- this project has measured taking ~4.8s to accept a connection — leaves
-- exactly that half-applied state. The runner wraps each file in a
-- transaction, so the retry is the same file again, and it has to work.
--
-- `drop policy if exists` is safe on a fresh database (nothing to drop) and
-- on a re-run (replaces the identical policy).
do $$
declare t text;
begin
  foreach t in array array['pharmacy_websites', 'website_revisions', 'pharmacy_assets'] loop
    execute format('drop policy if exists tenant_read on %I', t);
    execute format(
      'create policy tenant_read on %I for select using (is_pharmacy_member(pharmacy_id))', t);

    execute format('drop policy if exists tenant_write on %I', t);
    execute format(
      'create policy tenant_write on %I for insert with check (is_pharmacy_member(pharmacy_id))', t);

    execute format('drop policy if exists tenant_update on %I', t);
    execute format(
      'create policy tenant_update on %I for update using (is_pharmacy_member(pharmacy_id)) with check (is_pharmacy_member(pharmacy_id))', t);
  end loop;
end $$;
