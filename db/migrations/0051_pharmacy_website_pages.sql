-- =====================================================================
-- A pharmacy website is more than one page.
-- =====================================================================
--
-- pharmacy_websites.published_html holds ONE rendered page, which was right
-- while a site was one page. It cannot hold /about/, /services/,
-- /services/blood-pressure-check/ and /location/, and those pages are the
-- entire reason a pharmacy wants a website: people do not search for a
-- pharmacy by name, they search for "blood pressure check in Ikeja".
--
-- WHY A TABLE AND NOT A JSONB MAP ON THE EXISTING ROW
-- Serving one page would mean loading every page. A pharmacy with a dozen
-- pages at ~8KB each is ~100KB read, parsed and discarded to answer a request
-- for one of them — on every request, including the crawler traffic this
-- feature exists to attract. A primary key on (pharmacy_id, path) reads
-- exactly the row asked for.
--
-- WHY published_html STAYS
-- It remains the home page's cache, so nothing that reads it today changes
-- behaviour, and a site published before this migration keeps serving while
-- the rows below are backfilled by its next publish. Removing it would make
-- this migration a rewrite of the publish path rather than an addition to it.
--
-- REGENERABLE, NOT SOURCE OF TRUTH. Every row here is derived from
-- pharmacy_websites.published_data and the live pharmacy_profile. Losing the
-- table costs a re-render, not content — same contract as published_html.

create table if not exists pharmacy_website_pages (
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,

  -- The URL path, always with a leading and trailing slash: '/', '/about/',
  -- '/services/blood-pressure-check/'. Stored exactly as it is served so a
  -- lookup is an equality test and never a normalisation guess — the router
  -- and the sitemap must agree byte for byte or one of them is lying.
  path        text not null,

  -- What the page IS, so a renderer change can target one kind and the
  -- sitemap can weight them. Constrained because an unknown kind means a
  -- code path nobody wrote.
  kind        text not null
              check (kind in ('home', 'about', 'services', 'service',
                              'location', 'contact', 'healthIndex', 'health')),

  -- The complete rendered document. Self-contained: no external stylesheet
  -- and no script, exactly as published_html has always been.
  html        text not null,

  -- Carried alongside the HTML rather than parsed back out of it. The
  -- sitemap and any future index page need them, and re-deriving them from
  -- markup would be a parser nobody should have to maintain.
  title       text,
  updated_at  timestamptz not null default now(),

  primary key (pharmacy_id, path)
);

-- The public read: "give me this path for the pharmacy at this address".
-- Covered by the primary key, so this index is for the OTHER direction —
-- deleting or listing every page of one pharmacy during a publish.
create index if not exists idx_website_pages_pharmacy
  on pharmacy_website_pages (pharmacy_id);

comment on table pharmacy_website_pages is
  'Rendered public pages, one row per URL. Regenerable from pharmacy_websites.published_data plus the live profile; never edited directly.';

-- =====================================================================
-- ROW-LEVEL SECURITY (defence in depth — see 0001_init.sql's header)
-- =====================================================================
--
-- The API connects as service_role and BYPASSES all of this; the real
-- boundary is the explicit `where pharmacy_id = $1` in every query, guarded
-- by assertPharmacyId. Written the same way as every other tenant table so
-- there is one pattern to check rather than two.
--
-- Dropped and recreated rather than guarded with `if not exists`, which
-- Postgres does not offer for policies — the same idempotency trick 0049
-- uses, so re-running this file is safe.

alter table pharmacy_website_pages enable row level security;

drop policy if exists tenant_isolation on pharmacy_website_pages;
create policy tenant_isolation on pharmacy_website_pages
  using (pharmacy_id = current_setting('app.pharmacy_id', true)::uuid);
