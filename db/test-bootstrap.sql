-- Test-database bootstrap — the small piece of Supabase that db/migrations
-- assumes exists, recreated on a plain Postgres.
--
-- DELIBERATELY NOT IN db/migrations/.
-- The migration runner applies everything in that directory to whatever
-- DATABASE_URL points at, which in production is the real Supabase project.
-- Creating a fake `auth.users` there would collide with the genuine one and
-- an `auth.uid()` that returns null would silently disable every RLS policy
-- in the database. This file is applied by hand, to a test database, once —
-- and living outside the migrations directory is what makes it impossible to
-- apply anywhere else by accident.
--
-- WHAT SUPABASE ACTUALLY PROVIDES THAT THE SCHEMA NEEDS
-- Audited across all 48 migrations, and it is a short list:
--
--   auth.users(id, email)   14 foreign keys reference it (pharmacy_members,
--                           catalogue_uploads.uploaded_by, handoffs.accepted_by,
--                           order_status_history.changed_by, audit_logs.actor_id,
--                           patient_notes.author_id, and others)
--   auth.uid()              used only by the RLS policies in 0001 and by
--                           is_pharmacy_member()
--   pgcrypto, pg_trgm       both ship with the stock postgres image
--
-- Nothing else in the schema touches Supabase. That is why a local Postgres
-- is a viable test target at all.
--
-- USAGE
--   npm run migrate:test
--
-- That applies this file automatically, but ONLY when the target has no auth
-- schema, and only after the guard in server/tests/helpers/testDb.js has
-- proven the target is not the production database. There is no separate step
-- to remember, and no psql: this project is developed on Windows where psql is
-- not installed, and a setup step nobody can run is a setup step that does not
-- happen.
--
-- NOT NEEDED if TEST_DATABASE_URL points at a second Supabase project — that
-- already has a real auth schema. Running it there would fail on the existing
-- auth.users, which is the correct outcome rather than a problem to work around.

-- ---------------------------------------------------------------------------
-- Extensions. 0001 creates these itself, but doing it here too means a
-- freshly-created database is usable before the migrations run, which is what
-- makes a failure at this step legible ("extension not available in this
-- image") rather than surfacing 400 lines into 0001.
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- The auth schema.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

-- Only the two columns the application actually reads. Supabase's real
-- auth.users has around thirty, and reproducing them would be a fiction that
-- drifts: the moment this file pretends to model Supabase's schema, somebody
-- will believe it. Every foreign key in db/migrations references auth.users(id)
-- and nothing else; isolation.test.js and authStore.test.js insert `id` and
-- `email`. That is the entire contract.
create table if not exists auth.users (
  id     uuid primary key,
  email  text unique
);

-- auth.uid() — the current request's user id.
--
-- Returns NULL here, and that is correct rather than a limitation. The
-- application connects with the service_role key, which BYPASSES RLS
-- entirely (see 0001's header), so the policies are defence-in-depth that
-- the test suite never exercises through this path. A null uid means
-- is_pharmacy_member() is false for everyone, which is the safe direction:
-- a test cannot accidentally pass because a permissive stub let a query
-- through that production would have refused.
--
-- If a future test needs to prove the RLS layer itself, it should set a real
-- uid explicitly rather than this default becoming quietly permissive.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
