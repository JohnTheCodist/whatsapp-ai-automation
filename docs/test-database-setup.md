# Running the database test suites

`TEST_DATABASE_URL` gates 403 of this repository's 1236 tests. Unset, they
skip and prove nothing. This is how the scratch database used on 2026-09-05
was built, so it can be rebuilt in a few minutes.

It needs **no admin rights, installs no Windows service, and touches nothing
outside a scratch directory.** `embedded-postgres` ships real PostgreSQL
binaries through npm; the steps below use those binaries directly rather than
the library's own API, because `pg_ctl` daemonises properly and survives the
shell that started it.

## Build it

```bash
mkdir -p /tmp/pgtest && cd /tmp/pgtest
npm init -y
npm install embedded-postgres@17.10.0-beta.17
```

The binaries land in
`node_modules/@embedded-postgres/windows-x64/native/bin` (swap the platform
package on macOS or Linux). With `BIN` pointing at that directory and `DATA`
at a data directory of your choosing:

```bash
printf 'scratchpw' > pwfile
"$BIN/initdb"  -D "$DATA" -U postgres --auth=scram-sha-256 --pwfile=pwfile --encoding=UTF8
rm pwfile
"$BIN/pg_ctl"  -D "$DATA" -o "-p 55432 -c listen_addresses=127.0.0.1" -l pg.log start
"$BIN/createdb" -h 127.0.0.1 -p 55432 -U postgres rxnaija_test
```

Port **55432**, not 5432, so it cannot collide with a real local Postgres.
`listen_addresses=127.0.0.1` keeps it off the network entirely.

> On Windows/Git Bash, `pg_ctl start` holds the pipe and looks like it has
> hung. It has not — check `pg.log` for "database system is ready to accept
> connections". The server is already up and detached.

## Point the suites at it

In `server/.env`:

```
TEST_DATABASE_URL=postgres://postgres:scratchpw@127.0.0.1:55432/rxnaija_test
```

Then:

```bash
npm run migrate:test
```

That applies `db/test-bootstrap.sql` (the small piece of Supabase the schema
assumes — `auth.users`, `auth.uid()`, `pgcrypto`, `pg_trgm`) and then every
migration. It refuses to run if `TEST_DATABASE_URL` resolves to the same
database as `DATABASE_URL`, including via a port swap — see
`server/tests/helpers/testDb.js`.

## Run

```bash
node --test "server/tests/*.test.js"     # everything
npm run test:ci                          # the gate
```

Expect **1236 / 1232 / 0 / 4** with the database configured, against
1236 / 826 / 403 / 7 without it. The four failures and the one known flaky
test are catalogued in AGENTS.md under "The 9 known failures" and "What a
test database changes".

## Stop, restart, destroy

```bash
"$BIN/pg_ctl" -D "$DATA" status
"$BIN/pg_ctl" -D "$DATA" stop
"$BIN/pg_ctl" -D "$DATA" -o "-p 55432 -c listen_addresses=127.0.0.1" -l pg.log start
```

To destroy it: stop the server and delete the directory. Nothing is left on
the machine — no service, no registry entry, no PATH change. Empty
`TEST_DATABASE_URL` in `server/.env` and the suites go back to skipping
loudly.

## The trap that this setup exposed

Writing a test file this way points it at **production**:

```js
const service = require('../services/thing');        // captures DATABASE_URL
require('./helpers/testDb').useTestDatabase(TEST_URL); // too late
```

`config/env.js` reads `process.env` once, at require time, and
`services/db.js` connects with that captured value. Redirecting `process.env`
afterwards changes nothing. The identity guard still passes — the two URLs
really are different databases — so nothing reports a problem while the
suite runs its DELETEs against live data.

`useTestDatabase` now also corrects an already-loaded `env`, so require order
can no longer decide this. **GOLDEN-004 asserts it.** Write the redirect
above the requires anyway.

---

# Storage: the `pharmacy-assets` bucket

Pharmacy logos and hero images go to Supabase Storage, in a single bucket
named `pharmacy-assets`, at `<pharmacy_id>/<asset_id>.<ext>`.

**The bucket is not created by the application.** Creating it lazily on a
pharmacy's first upload would put an infrastructure change in a customer's
request path, where a permissions problem surfaces as "your logo would not
upload" rather than as a deployment error. It is a one-time setup step:

1. In the Supabase dashboard, **Storage → New bucket**.
2. Name it `pharmacy-assets`.
3. Mark it **public**. The objects are logos on public pharmacy websites —
   they are served to anyone who visits, so a signed URL would add expiry
   handling for content that is not secret.

Tenant isolation does **not** rely on bucket permissions. Every object path is
prefixed with the pharmacy's id, that prefix is built server-side from a
verified session, and the render context only ever contains rows scoped to one
pharmacy — see `server/services/website/assetService.js`.

**Without the bucket**, uploads fail with a clear storage error and everything
else works: a block referencing a missing image renders its text fallback, so
a pharmacy's site still publishes.

## Testing storage without a bucket

There is no test Supabase project, so `server/tests/websiteAssets.test.js`
substitutes an in-memory store through `assetStore.setStore()`. That covers
path prefixing, tenant scoping, the magic-byte checks and logo references. It
does **not** cover the Supabase calls themselves — `put` and `remove` in
`assetStore.js` are the untested surface, and deliberately the thinnest code
in the feature for that reason.

---

# Subdomains: what is still missing

The code resolves `<address>.rxnaija.com` already — `addressFromHost` in
`server/services/website/publicSite.js`, tested against nested labels, foreign
domains, ports, trailing dots and reserved names. It is **inert until
`PUBLIC_SITE_DOMAIN` is set**, and that variable is deliberately unset.

Two facts have to be established first. Neither is a code change, and neither
could be verified from inside this repository:

1. **The production hostname.** `render.yaml` names no custom domain at all,
   so the service is presumably still on its `onrender.com` address. Pharmacy
   subdomains need a domain that is actually ours.

2. **Wildcard DNS and wildcard TLS.** `*.rxnaija.com` must resolve to the
   Render service, and a certificate must cover it. Whether the current
   `starter` plan issues a wildcard certificate is unconfirmed — check it
   against Render's current behaviour rather than against a memory of it.

Turning it on, once both are true:

```
PUBLIC_SITE_DOMAIN=rxnaija.com
```

`resolveSiteKey` then prefers the hostname over the path, so
`ikeja-pharmacy.rxnaija.com` serves Ikeja and
`ikeja-pharmacy.rxnaija.com/p/other-pharmacy` **still** serves Ikeja — the
hostname is the stronger claim and a path must not override it.

**Existing `/p/<address>` links keep working.** They are on flyers and in
WhatsApp messages, so the path form is permanent, not a stepping stone. Adding
subdomains adds a second way to reach the same page; it does not replace the
first.

## What is deliberately not built

A redirect from `/p/<address>` to the subdomain. It would make the shorter
address canonical for SEO, and it would also break every printed flyer the day
DNS has a bad hour. That is a decision to take once subdomains have been live
and boring for a while.
