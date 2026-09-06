# RxNaija Pharmacy Website Builder — Architecture Plan

**Status:** proposal, not implemented. Phase 0 deliverable.
**Audited:** 2026-09-05, against `main` at `6cc7d19`.
**Scope:** everything asked for in the engineering brief §22. No production
code has been changed.

> **Partially superseded by `WEBSITE_BUILDER_DECISIONS.md` (2026-09-05).**
> Two things in this document were overtaken by empirical verification and a
> review round, and following them would be a mistake:
>
> - **The version pin in §B6 and the Appendix does not install.**
>   `@grapesjs/react@2.0.0` peers on `grapesjs@^0.22.5`, which excludes 0.23.6.
> - **The publishing mechanism in §B4 and §B5 was replaced.** The server now
>   renders HTML from structured data; the client never supplies HTML. The
>   sanitiser and the `data-rx-bind` rewriter described here are no longer
>   part of the design, and the tasks building them are cancelled.
>
> The audit in Part A, the security model in §B8, the domain strategy in §B7,
> the template architecture in §B10, and the risk register in §C1 all stand.

---

## 0. Summary of the recommendation

Consume GrapesJS from npm as a lazy-loaded dependency of the existing
dashboard. Add one table for the site, one for revisions, one for assets, and
eight columns to `pharmacy_profile`. Publish by exporting HTML in the browser,
sanitising it on the server, and storing the result as a static string. Serve
it first at `rxnaija.com/p/<slug>` and add subdomains as a second, separable
step.

The three decisions that carry the most weight, stated up front:

1. **Do not fork, do not modify GrapesJS core, and do not depend on the
   GitHub fork.** Pin `grapesjs@0.23.6` and `@grapesjs/react@2.0.0` from npm.
2. **Publish to a stored HTML snapshot, not a per-request render.** The
   public site must not put a database query in front of every visitor —
   this process shares a 15-connection pooler with every pharmacy's live
   WhatsApp socket.
3. **Keep pharmacy data live in the snapshot through bound spans**, not
   through re-rendering. A profile change rewrites the text inside
   `data-rx-bind` elements in the stored HTML. Nothing re-runs GrapesJS on
   the server.

---

# PART A — ARCHITECTURE AUDIT

What exists today. Every claim here was read out of the repository, with file
and line references so it can be checked rather than believed.

## A1. Frontend architecture

React 18.3.1, Vite 5.4, Tailwind 4 (via the `@tailwindcss/vite` plugin, not a
PostCSS config). 36 flat modules in `client/src` — no subdirectories at all.

**Navigation is not a router.** `client/package.json` lists
`react-router-dom@^6.26.0` as a dependency, but nothing in `client/src`
imports it — it is dead weight in the lockfile. Actual navigation is a single
`tab` string in `App.jsx`, mirrored into the URL query string with
`history.replaceState` (`client/src/App.jsx:221`). The left rail is driven by
the `SECTIONS` array at `client/src/App.jsx:44`, with `SETUP` and `BILLING`
deliberately held out of it and pinned to the foot of the rail.

This matters for the Website tab: **adding a section is an entry in
`SECTIONS`, a `SUBTITLE` line, and a branch in the canvas switch.** There is
no route to register. It also means the builder cannot own a nested URL space
(`/website/editor/page-2`) without introducing routing that does not exist
yet — so the builder's internal navigation should be component state, not URL
state, in the first release.

**Design system:** `DashboardKit.jsx` (173 lines) exports `Panel`,
`PanelHead`, `Headline`, `Bar`, `Spark`, `Trend`, and the `naira`/`pct`
formatters. Icons are hand-rolled SVG components in `Icons.jsx`. There is no
component library and no CSS-in-JS — Tailwind classes inline.

**Auth on the client is invisible to callers.** `installAuthFetch()` in
`auth.js` monkey-patches global `fetch` before React mounts
(`client/src/main.jsx:10`) so that every `fetch('/api/...')` carries the
Supabase bearer token automatically. Website API calls need no auth plumbing
of their own.

**Bundle today:** one chunk, 606 KB (`client/dist/assets/index-BqwR2YeN.js`,
built 2026-08-30). This is the single most important number for the GrapesJS
decision — see §C1 risk 1.

## A2. Backend architecture

Modular monolith. One Express 4 process, CommonJS, Node ≥ 22.12 (a hard
floor: Baileys 7 is ESM and `require()`-ing it only works from 22.12).

Routers in `server/routes/`, business logic in `server/services/<domain>/`.
Routers are mounted per prefix in `server/index.js`. **Auth is applied
per-route inside each router, never as a blanket `app.use('/api', requireAuth)`**
— the comment at `server/index.js:139` explains why: a blanket gate needs an
exempt list, and an exempt list is where a route quietly ends up
unauthenticated.

Error handling: `asyncRoute(fn)` wraps handlers so a rejected promise reaches
`next`, and `HttpError(status, message, code)` carries a status
(`server/middleware/errorHandler.js:53`).

**The same process serves the dashboard.** `express.static(client/dist)` with
`extensions: ['html']`, followed by an SPA fallback that answers every
unmatched GET with `index.html`. The fallback's exclusion regex is
`/^\/(?!api\/|webhooks\/|pdf\/).*/`. Anything the public website route needs
must be excluded there too, or it will silently return the dashboard shell —
this is the exact bug the `/download/:file` route was already written to
avoid, and the comment above it says so.

**There is already a precedent for public HTML.** `client/public/` holds
`home.html` (152 KB), `about.html`, `company.html` and `download.html`,
served as static files. Published pharmacy sites are the same shape of thing,
generated rather than hand-written.

**Background work exists.** A `jobs` table (kind, payload, attempts,
`run_after`, `locked_by`) and an in-process worker at
`server/services/worker.js`. Republish-on-profile-change should use it rather
than inventing a second mechanism.

## A3. Authentication

Supabase Auth. Tokens are verified **server-side** with the service-role key
in `server/middleware/auth.js`, which is the most carefully written file in
the repository and should not be touched by this work.

The chain: `requireAuth` → `verifyUser` (8 s timeout; a timeout answers 503
`AUTH_UNAVAILABLE`, deliberately not 401, because telling someone their
session is invalid sends them to sign in through the service that just
stopped answering) → `getMemberships(user.id)` → `selectTenant(memberships,
x-pharmacy-id)` → sets `req.pharmacyId`, `req.pharmacyRole`,
`req.pharmacyStatus`, `req.memberships`.

`selectTenant` is a **pure function** and exhaustively unit-tested. An
`X-Pharmacy-Id` header is honoured only as a selection among memberships the
caller provably holds; a header naming a pharmacy the caller does not belong
to is 403, never 404, because confirming a tenant id exists is itself a
disclosure.

Also available: `requireAuthOnly` (session, no membership — for tenant
creation) and `requireRole(...roles)` for owner-only actions.

`DEV_AUTH_BYPASS` resolves every request to the first pharmacy with no
credential check. Gated twice and refuses to boot in production.

**Consequence for this work: no new authentication code is needed or wanted.**
Every website route uses `requireAuth`, and the mutating ones add
`requireRole`.

## A4. Pharmacy / tenant model

| Table | Key fields |
|---|---|
| `pharmacies` | `id`, `name`, `slug` (unique), `status` (onboarding/active/suspended/closed), `plan`, `subscription_status`, `trial_started_at`, `trial_ends_at`, `current_period_*`, `public_whatsapp_number` |
| `pharmacy_members` | `pharmacy_id`, `user_id` → `auth.users`, `role` ∈ owner/pharmacist/staff |
| `pharmacy_profile` | `pharmacy_id` (PK), `address_line`, `city`, `state`, `landmark`, `phone`, `opening_hours` jsonb, `delivers`, `delivery_note`, `extra_info` |

Ceiling of 5 pharmacies per user (`MAX_PHARMACIES_PER_USER`).

`pharmacy_profile` is a **one-to-one table keyed on `pharmacy_id`**, split
from `pharmacies` because it is assistant-facing content that changes often
while the tenant row is identity that almost never changes. The website table
should follow the same shape and the same reasoning.

`pharmacies.slug` is generated by `slugify(name)` with a random 4-char suffix
on collision. **It has no reserved-word check and was never designed to be
publicly visible.** See §B7 — it must not become the subdomain.

## A5. Database

Postgres on Supabase, `postgres.js` driver, transaction-mode pooler on port
6543 with `prepare: false` (session mode's hard 15-backend cap was the
original problem; the pooler's ~4.8 s connection accept is why the pool is
warmed at boot and kept alive).

**Pool ceiling: 15 connections for the entire process** — every pharmacy's
WhatsApp traffic, the job worker, the dashboard, and now public website
traffic. This is a shared, finite resource and it constrains the publishing
design (§B5).

48 migrations, `NNNN_name.sql`, applied by `scripts/migrate.js`. Recent ones
use `add column if not exists`, so they are re-runnable.

**Two isolation layers, and neither may be relied on alone** (stated in the
header of `db/migrations/0001_init.sql`):

1. **Application layer, primary.** The API connects as `service_role`, which
   *bypasses RLS*. Every query is therefore responsible for its own explicit
   `where pharmacy_id = $1`. `assertPharmacyId()` throws on a missing or
   malformed id so the mistake is loud rather than silent.
2. **RLS, defence in depth.** `is_pharmacy_member(uuid)` security-definer
   function, with `tenant_read` / `tenant_write` / `tenant_update` policies
   applied in a loop over the tenant tables at
   `db/migrations/0001_init.sql:490`.

New website tables must join both layers. Enabling RLS without policies (the
`inbound_events` / `jobs` treatment) is the right choice for anything only
the service role touches.

## A6. Branding and profile data available today

Available: `name`, `slug`, `public_whatsapp_number` (digits, international, no
leading `+`), `phone`, `address_line`, `city`, `state`, `landmark`,
`opening_hours` (validated jsonb, no overnight spans), `delivers`,
`delivery_note`, `extra_info`.

**Not present anywhere: logo, brand colours, description, services list, hero
image, geo coordinates, maps link.** `client/src/AccountMenu.jsx:29` notes the
avatar is derived from initials precisely because an uploaded logo is a real
feature nobody had built. The builder needs all of these, so §B2 adds them.

`public_whatsapp_number` is the correct source for the WhatsApp CTA, and the
reasoning in `db/migrations/0038_public_whatsapp_number.sql` is directly
relevant: it is the number a pharmacy *publishes*, deliberately decoupled from
`whatsapp_accounts.display_phone_number`, which follows whatever socket
happens to be paired. A printed flyer and a published website are the same
kind of artefact. **Use `pharmacies.public_whatsapp_number`, and fall back to
nothing rather than to the live socket number.**

## A7. Deployment

Render, **one** web service (`rxnaija`, plan `starter`, region `frankfurt`,
branch `main`). Build `npm install && npm run build`; start `npm start`. The
API and the dashboard are the same process — deliberately, so there is no
second service to pay for or keep in step.

No persistent disk volume, stated explicitly in `render.yaml`. Baileys keeps
its auth state encrypted in Postgres so a redeploy can restore sessions.

**Helmet CSP** (`server/index.js:44`), and every directive below is
load-bearing for this work:

```
connect-src  'self' + supabase origin + its wss
script-src   'self'
style-src    'self' 'unsafe-inline' https://fonts.googleapis.com
img-src      'self' data: blob:
font-src     'self' data: https://fonts.gstatic.com
frame-ancestors 'none'
```

Three of these directly conflict with a website builder. See §C1 risk 2.

**No custom domain appears in `render.yaml`.** The production hostname is an
open question that has to be answered before the subdomain work (§B7).

## A8. Storage — there is none

`multer` appears three times (`catalogue.js`, `emailInbound.js`, `sync.js`)
and is **`memoryStorage()` in every case**. Uploaded spreadsheets are parsed
in memory and the extracted rows go to Postgres; the file itself is never
persisted. There is no Supabase Storage bucket, no S3, no disk.

A website builder needs durable binary storage for logos and hero images.
This is the single largest piece of genuinely new infrastructure in the plan.

---

# PART B — PROPOSED ARCHITECTURE

## B1. System shape

```
                         Render (one service, one process)
   ┌────────────────────────────────────────────────────────────────┐
   │                                                                │
   │  /api/website/*      requireAuth + requireRole                 │
   │        │             tenant-scoped, assertPharmacyId           │
   │        ↓                                                       │
   │  services/website/                                             │
   │     websiteService.js   draft, publish, revisions              │
   │     sanitize.js         allowlist HTML/CSS sanitiser           │
   │     bindRewriter.js     data-rx-bind text refresh              │
   │     assets.js           Supabase Storage                       │
   │        │                                                       │
   │        ↓                                                       │
   │  Postgres  pharmacy_websites · website_revisions               │
   │            pharmacy_assets  · pharmacy_profile (+8 cols)       │
   │                                                                │
   │  /p/:slug            PUBLIC, no auth, no session               │
   │        └─ single indexed read → published_html → cached        │
   │                                                                │
   │  /  (SPA)            dashboard, Website tab lazy-chunked       │
   └────────────────────────────────────────────────────────────────┘
                                  │
                    Supabase Storage  pharmacy-assets/<pharmacy_id>/…
```

Nothing new is deployed. No second service, no CDN, no edge function. That is
deliberate: the operational surface of this product is currently one process
and one database, and the first release of a website builder is not a good
reason to double it.

## B2. Database schema proposal

New migration `db/migrations/0049_pharmacy_websites.sql`. **Additive only** —
no existing column is altered or dropped, which is what makes rollback cheap
(§B9).

### `pharmacy_websites`

```sql
create table if not exists pharmacy_websites (
  -- PK, not a surrogate id with a unique constraint. Exactly one website per
  -- pharmacy in this release, the same one-to-one shape as pharmacy_profile.
  -- If multi-site is ever real it arrives as its own table, rather than as a
  -- nullable column nobody trusts.
  pharmacy_id       uuid primary key references pharmacies(id) on delete cascade,

  template_id       text not null,
  template_version  integer not null,

  -- The GrapesJS project JSON. The editable source of truth, and the only
  -- thing the editor reads back.
  draft_data        jsonb not null default '{}'::jsonb,

  -- Guided-step answers and theme, kept OUT of draft_data so that changing
  -- template does not discard what the owner typed.
  content           jsonb not null default '{}'::jsonb,
  theme             jsonb not null default '{}'::jsonb,

  -- What the public actually gets. Sanitised server-side, self-contained,
  -- no external JS. Null until the first publish.
  published_html    text,
  published_data    jsonb,
  published_at      timestamptz,

  status            text not null default 'draft'
                    check (status in ('draft', 'published', 'unpublished')),

  -- Separate from pharmacies.slug on purpose — see §B7.
  subdomain         text unique,
  custom_domain     text unique,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_pharmacy_websites_subdomain
  on pharmacy_websites(subdomain) where subdomain is not null;
create index if not exists idx_pharmacy_websites_published
  on pharmacy_websites(status) where status = 'published';
```

### `website_revisions`

```sql
-- Publish history. Exists so that "publish" is never destructive: the brief
-- asks for safety over automatic updates, and a rollback the owner can reach
-- is the cheapest form of that.
create table if not exists website_revisions (
  id                bigint generated always as identity primary key,
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  project_data      jsonb not null,
  html              text,
  template_id       text not null,
  template_version  integer not null,
  published_by      uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists idx_website_revisions_pharmacy
  on website_revisions(pharmacy_id, created_at desc);
```

Retention: keep the most recent 20 per pharmacy, pruned on write. A revision
is a few KB of JSON; 20 is generous and bounded.

### `pharmacy_assets`

Named `pharmacy_assets`, **not** `website_assets`. A logo is a fact about the
pharmacy, not about one of its pages, and it will be wanted on the QR sheet
and on receipts long before anyone builds a second website.

```sql
create table if not exists pharmacy_assets (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  kind         text not null check (kind in ('logo', 'hero', 'gallery', 'service')),
  -- Object path inside the bucket, ALWAYS prefixed with pharmacy_id so a
  -- storage policy can enforce the same boundary the API does.
  storage_path text not null unique,
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        integer not null,
  width        integer,
  height       integer,
  created_at   timestamptz not null default now()
);

create index if not exists idx_pharmacy_assets_pharmacy
  on pharmacy_assets(pharmacy_id, kind);
```

### `pharmacy_profile` additions

```sql
alter table pharmacy_profile
  add column if not exists description     text,
  add column if not exists services        jsonb not null default '[]'::jsonb,
  add column if not exists logo_asset_id   uuid references pharmacy_assets(id) on delete set null,
  add column if not exists brand_primary   text,
  add column if not exists brand_secondary text,
  add column if not exists maps_url        text,
  add column if not exists latitude        numeric(9,6),
  add column if not exists longitude       numeric(9,6);
```

> **A warning that belongs in the migration itself.** `pharmacy_profile` is
> read by the assistant, and `extra_info` is injected into its context
> verbatim. `description` and `services` are website copy, and they must
> **not** be added to the assistant's context as a side effect of this work.
> Making the assistant answer "what services do you offer" from these columns
> is a good feature and a separate, deliberate change with its own review.

### RLS

Same treatment as every other tenant table:

```sql
alter table pharmacy_websites  enable row level security;
alter table website_revisions  enable row level security;
alter table pharmacy_assets    enable row level security;

-- tenant_read / tenant_write / tenant_update via is_pharmacy_member(pharmacy_id),
-- following the loop at db/migrations/0001_init.sql:490.
```

## B3. API specification

All authenticated routes live in `server/routes/website.js`, mounted at
`/api/website`. Every handler calls `assertPharmacyId(req.pharmacyId)` before
building a query, and **no handler ever reads a pharmacy id from the body, the
query string, or an unverified header.**

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/website` | `requireAuth` | Current site or `{site:null}`. Never 404 for "not created yet" — that is a normal state, not an error. |
| GET | `/api/website/templates` | `requireAuth` | Manifest list. No project data — that is large and only needed on selection. |
| POST | `/api/website` | `requireAuth` + `requireRole('owner','pharmacist')` | `{template_id}`. Clones template project data into `draft_data`. 409 if a site already exists. |
| PUT | `/api/website/draft` | same | `{project_data}`. Debounced client-side; last write wins. |
| PATCH | `/api/website/content` | same | `{content, theme}` from the guided step. |
| GET | `/api/website/preview.html` | `requireAuth` | Renders the **draft**. Sends its own CSP with `frame-ancestors 'self'` — see §C1 risk 2. |
| POST | `/api/website/publish` | `requireAuth` + `requireRole('owner')` | `{html, css, project_data}`. Server sanitises, writes a revision, sets `published_html`. |
| POST | `/api/website/unpublish` | `requireAuth` + `requireRole('owner')` | Sets `status='unpublished'`. Keeps `published_html` so republish is instant. |
| POST | `/api/website/revisions/:id/restore` | `requireAuth` + `requireRole('owner')` | Restores into `draft_data`. Never publishes directly. |
| PUT | `/api/website/subdomain` | `requireAuth` + `requireRole('owner')` | Validated, reserved-word checked, unique. |
| POST | `/api/website/assets` | `requireAuth` + `requireRole('owner','pharmacist')` | multipart, multer memory, ≤ 2 MB, magic-byte checked. |
| DELETE | `/api/website/assets/:id` | same | Scoped read before delete; 404 (not 403) for another tenant's id. |

Public, unauthenticated, in `server/routes/publicSite.js`:

| Method | Path | Notes |
|---|---|---|
| GET | `/p/:slug` | Reads **only** `status='published'`. Never returns a draft. |
| GET | `/p/:slug/robots.txt` | Phase 4. |

**Publishing takes HTML from the client.** That is a deliberate trade, and the
reason it is safe is §B5's sanitiser, not trust in the browser. The
alternative — running GrapesJS in Node to render project JSON — requires
jsdom, adds a heavy dependency to a process that holds live WhatsApp sockets,
and buys nothing the sanitiser does not already have to provide.

## B4. Data-driven content — the recommended mechanism

The brief asks for this and lists five candidate approaches. The
recommendation is **bound spans in a published snapshot**, and here is the
reasoning against each alternative:

- *Server-side render per request* — puts a Postgres query in front of every
  public visitor, on a pooler capped at 15 connections shared with every
  pharmacy's WhatsApp socket. A moderately successful site degrades messaging.
  Rejected.
- *Client-side fetch of a JSON endpoint* — breaks SEO, and shows a flash of
  empty content on a slow mobile connection, which is the actual target
  device. Rejected.
- *Plain tokens (`{{phone}}`) left in the HTML* — a template that fails to
  substitute publishes literal braces to the public. Rejected.
- *Duplicating profile values into each template* — exactly what the brief
  forbids. Rejected.

**The mechanism.** A pharmacy-bound GrapesJS component emits a single element
with a binding attribute and a single text node:

```html
<span data-rx-bind="profile.phone">0801 234 5678</span>
<a data-rx-bind="profile.whatsapp_url" href="https://wa.me/2348012345678">Chat on WhatsApp</a>
```

At **publish**, the current value is baked in. The page is static, fast, and
crawlable — no JavaScript, no fetch, no flash.

At **profile change**, a `website_republish` job rewrites only the text inside
`data-rx-bind` elements (and the `href` of bound links) in the stored
`published_html`. GrapesJS never runs on the server. The rewriter is a narrow,
targeted transform over a shape we control.

**The design constraint this imposes, which must be written into the block
definitions:** a bound component renders exactly one element containing
exactly one text node, with no nested markup. That constraint is what lets the
rewriter be a small tested function instead of a DOM parser, and it is the
kind of rule that silently rots unless a test asserts it — so
`templateIntegrity.test.js` asserts it for every template in the registry.

Structural changes (new sections, moved blocks) still require the owner to
open the editor and publish again. That is the right boundary: content stays
live, layout stays deliberate.

## B5. Publishing and the public site

```
owner edits ──► PUT /draft ──► draft_data
                                  │
                             (Preview) ──► GET /preview.html   authenticated
                                  │
                             POST /publish
                                  │
                    ┌─────────────┴─────────────┐
                    │  sanitise(html, css)      │
                    │  write website_revisions  │
                    │  set published_html       │
                    │  status = 'published'     │
                    └─────────────┬─────────────┘
                                  ↓
                            GET /p/:slug   public, cached
```

**Serving.** One indexed read, then the stored string. Response headers:

```
Content-Type:  text/html; charset=utf-8
Cache-Control: public, max-age=60, s-maxage=300
ETag:          <hash of published_html>
```

Not `no-cache`. A pharmacy brochure page is public and read-heavy, and the
60-second window bounds how stale a republish can be while removing almost all
of the database load. An in-process LRU keyed on slug is a cheap later
addition if it is ever needed; it is not needed on day one and is not in this
plan.

**The published page gets its own CSP**, not the dashboard's:

```
default-src 'none'
img-src     'self' data: <supabase storage origin>
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com
font-src    'self' https://fonts.gstatic.com
script-src  'none'
frame-ancestors 'none'
```

`script-src 'none'` is the important one. **Published pharmacy pages contain
no JavaScript in this release** — everything they do (call, WhatsApp,
directions) is a link. That makes the whole class of stored-XSS bugs
unreachable rather than merely defended against, and costs nothing a brochure
site wanted.

**The sanitiser** (`server/services/website/sanitize.js`) runs on every
publish and is the load-bearing security control:

- allowlist of elements and attributes, not a denylist
- strips every `<script>`, every `on*` attribute, every `javascript:` and
  `data:` URL outside of images
- `href` restricted to `http:`, `https:`, `tel:`, `mailto:`, and `wa.me`
- CSS passed through a property allowlist; no `@import`, no `url()` to a
  non-allowlisted origin, no `expression()`

It gets its own test file, and a golden entry, because a weak sanitiser here
is a defaced pharmacy website that RxNaija served.

## B6. Component architecture (frontend)

The dashboard has no subdirectories today. The builder is the first feature
large enough to justify one, and forcing it flat would produce twenty
`Website*.jsx` files at the top level.

```
client/src/website/
  WebsitePanel.jsx        section root; decides picker vs guided vs editor
  TemplatePicker.jsx      the cards, preview, "Use this template"
  GuidedSetup.jsx         name, logo, description, phone, WhatsApp, hours…
  BuilderShell.jsx        RxNaija chrome: Back · Preview · Save · Publish
  Editor.jsx              LAZY. the only module that imports grapesjs
  PublishBar.jsx          status, public URL, publish/unpublish
  api.js                  thin fetch wrappers over /api/website
  blocks/
    index.js              block registry passed to the editor
    pharmacyBlocks.js     header, hero, hours, services, location, footer
    boundComponents.js    the data-rx-bind component types
  templates/
    index.js              THE REGISTRY — the only file that changes per template
    professional/{manifest.js, project.js, preview.webp}
    modern/…
    community/…
```

Wiring into the shell is three edits, all in `App.jsx`: a `SECTIONS` entry
(placed after Patients and before Inventory — it is periodic work, not daily,
but it is not configuration either), a `SUBTITLE` line, and a canvas branch.

**`Editor.jsx` is loaded with `React.lazy` + dynamic `import()`.** Nothing
else in `client/src/website/` may import `grapesjs`, and a build-size
assertion should keep it that way. See §C1 risk 1.

## B7. Domain strategy

**Phase one: `rxnaija.com/p/<slug>`.** It works on the existing service with
the existing TLS certificate, needs no DNS change, and the handler is
identical to the subdomain version.

**Phase two: `<subdomain>.rxnaija.com`.** A wildcard `*.rxnaija.com` CNAME to
the Render service, plus middleware that reads `req.hostname`, strips the base
domain, and resolves it against `pharmacy_websites.subdomain`.

Write the resolver as one function from the start:

```js
// Returns a slug or null. Path form today, host form tomorrow, and the route
// handler never learns which it was.
function resolveSiteKey(req) { … }
```

**`pharmacies.slug` must not be the subdomain.** It is auto-generated from the
pharmacy name, has no reserved-word check, gets a random suffix on collision,
and was explicitly documented as "a convenience, not an identifier". A
separate `subdomain` column, chosen by the owner, validated, and checked
against a reserved list (`www`, `api`, `app`, `admin`, `mail`, `staging`,
`dev`, `blog`, `help`, `support`, `status`, `cdn`, `assets`) is the correct
shape.

**Two open questions that block phase two, not phase one:**

1. `render.yaml` contains no custom domain. The production hostname is
   unconfirmed — possibly `rxnaija.onrender.com`.
2. Wildcard custom domains and the wildcard TLS certificate need to be
   confirmed against the current Render plan (`starter`) before the phase is
   scheduled. This is a verification task, not an assumption to build on.

## B8. Security model

The isolation story is the existing one, extended — not a new one.

```
request
   ↓  requireAuth      Supabase token verified server-side
   ↓  getMemberships   real rows from pharmacy_members
   ↓  selectTenant     pure, exhaustively tested
   ↓  req.pharmacyId   never from body, query, or unverified header
   ↓  requireRole      owner-only for publish, subdomain, delete
   ↓  assertPharmacyId throws before any query is built
   ↓  where pharmacy_id = ${req.pharmacyId}
   ↓  RLS policies     defence in depth via is_pharmacy_member()
```

Specific rules for this feature:

- **The public route is the one place with no session, so it gets the
  tightest contract.** It resolves a slug or subdomain to exactly one row,
  filters on `status = 'published'`, and selects only `published_html`. It
  never accepts a pharmacy id in any form and never reads `draft_data`.
- **Another tenant's asset id returns 404, not 403.** Consistent with
  `selectTenant`'s reasoning: confirming an id exists is a disclosure.
- **Asset object paths are prefixed with `pharmacy_id`** so the storage bucket
  can enforce the same boundary the API does, and a leaked URL is traceable to
  a tenant.
- **Uploads never trust the client's MIME type.** Magic bytes checked
  server-side; `image/jpeg`, `image/png`, `image/webp` only; 2 MB cap.
- **Publishing is `requireRole('owner')`.** Putting text on the public
  internet under the pharmacy's name is an owner-level act, not a staff one.

## B9. Migration and rollback

Rollback is cheap by construction:

- The migration is **purely additive** — three new tables, eight new nullable
  columns. Reverting the code leaves unused tables and costs nothing.
- **A feature flag, `WEBSITE_BUILDER_ENABLED`, default off.** The tab and the
  routes ship dark and are switched on per environment. This is how the
  feature reaches production before it is finished without any risk to the
  dashboard.
- No existing column changes type or meaning, so no backfill and no window
  where old and new code disagree about a row.

**Template versioning.** A website stores `template_id` + `template_version`
and a **clone** of the template's project data. Updating a template in the
repository has no effect on any existing site — ever. Migration to a newer
version is offered in the UI, is opt-in, and writes a revision first. This is
the "prefer safety over automatic updates" the brief asks for, and it is
achieved by cloning rather than by referencing.

## B10. Template architecture — adding template 4 through 10

The registry is the only file that changes.

```js
// client/src/website/templates/index.js
import professional from './professional/manifest.js';
import modern from './modern/manifest.js';
import community from './community/manifest.js';

export const TEMPLATES = [professional, modern, community];
```

Every manifest satisfies one shape, asserted by `templateIntegrity.test.js`
for all templates at once:

```js
{
  id: 'professional',        // stable forever; stored in the database
  version: 1,                // bump on any change to project data
  name: 'Professional',
  description: 'Clean and clinical. For pharmacies that lead with trust.',
  preview: professionalPreview,
  blocks: ['header', 'hero', 'whatsapp-cta', 'services', 'hours', 'location', 'footer'],
  project: () => import('./project.js'),   // lazy — project data is large
}
```

Adding a template is: one folder, one manifest, one line in `index.js`. No
part of the builder, the API, or the schema is touched. The architecture is
built for ten and three are implemented, exactly as the brief asks.

---

# PART C — EXECUTION

## C1. Risks and technical unknowns

**1. Bundle size — the highest-probability regression.**
The dashboard ships as one 606 KB chunk today. GrapesJS plus its React binding
is roughly 1 MB minified. Loaded eagerly, every user who never opens Website —
which is most of them, most days — pays for it on first paint, on a mobile
connection. *Mitigation:* `React.lazy` around `Editor.jsx`, no top-level
`grapesjs` import anywhere else, and an assertion in the build step that the
main chunk has not grown by more than ~20 KB.

**2. CSP — three concrete conflicts, all of which fail silently.**
- `frame-ancestors 'none'` blocks the preview iframe **including same-origin**.
  The preview response must send its own `frame-ancestors 'self'`.
- `img-src 'self' data: blob:` blocks every pharmacy-uploaded image once those
  live in Supabase Storage. The storage origin must be added.
- The published page needs a different policy from the dashboard entirely.

A CSP failure shows an empty box and a console warning — the same class of
quiet failure that left the dashboard rendering in fallback system fonts until
2026-09-02.

**3. The SPA fallback will swallow `/p/*`.**
`/^\/(?!api\/|webhooks\/|pdf\/).*/` answers every unmatched GET with
`index.html`. Without adding `p\/` to that exclusion, a published pharmacy site
returns the dashboard shell with a 200. This is the same trap the
`/download/:file` route was written to avoid, and the fix is the same.

**4. Wildcard DNS and TLS on Render are unverified,** and the production custom
domain is not in `render.yaml` at all. Blocks the subdomain phase only, which
is why path-based URLs ship first.

**5. Public traffic shares the 15-connection pooler with WhatsApp.**
Every visitor to a pharmacy website competes with every pharmacy's live
messaging for the same finite pool. *Mitigation:* one indexed read per page,
`max-age=60`, and treat any per-request rendering proposal as a regression.

**6. Sanitiser correctness is a public-facing security control.**
Its own test file, an allowlist rather than a denylist, and `script-src 'none'`
on the published page so a miss is not exploitable.

**7. `pharmacies.slug` is not safe as a public subdomain.** Covered in §B7;
listed here because reusing it is the obvious shortcut and it is wrong.

**8. Assistant coupling.** `description` and `services` land on
`pharmacy_profile`, which the assistant reads. They must not enter its context
without a separate, reviewed change.

**9. There is no client-side test runner.** The builder is mostly client code,
and `client/package.json` has lint but no tests. Either accept that the client
is covered by lint and manual verification, or add Vitest — which is scope
creep this plan does not assume. Flagged for a decision.

**10. Incidental finding, outside this scope.** `render.yaml` sets
`healthCheckPath: /api/health`, but `server/index.js:96` argues at length that
the platform health check must **not** be that endpoint — `/api/live` exists
precisely so a transient Postgres blip does not restart the process and drop
every pharmacy's WhatsApp session. The blueprint and the code contradict each
other. Not part of this work; worth a separate fix.

## C2. Testing strategy

Following AGENTS.md: new behaviour ships with tests, the regression suite runs
and is compared against `test-baseline.json`, and no test is ever weakened to
get to green.

**Unit — no database, runs everywhere:**
- `websiteSlug.test.js` — subdomain validation, reserved words, collisions
- `sanitize.test.js` — script tags, `on*` attributes, `javascript:` hrefs, CSS
  `url()`, `@import`, nested and malformed input
- `bindRewriter.test.js` — the `data-rx-bind` transform, including the
  single-text-node constraint and refusal on nested markup
- `templateIntegrity.test.js` — every registered template has a unique id, a
  version, a preview, and only known block types

**Integration — requires `TEST_DATABASE_URL`:**
- `websiteService.test.js` — create from template, save draft, publish,
  unpublish, revision written, restore, retention pruning

**Isolation — requires `TEST_DATABASE_URL`, and is the gate:**
- `websiteIsolation.test.js`, modelled on `server/tests/isolation.test.js`.
  Two real pharmacies, two users. Asserts A cannot read, edit, publish, or
  unpublish B's site; cannot read or delete B's assets; cannot claim B's
  subdomain; and that `/p/<B's slug>` never returns B's *draft*.

**Golden — structural invariants, no database, never pruned:**

```
GOLDEN-0NN — A pharmacy's unpublished draft was reachable from the public web
Protection: the public site route reads only published_html, only where
            status='published', and takes no tenant id from the request.
```

Per AGENTS.md, prefer the invariant over the reproduction: assert the *shape*
that makes the leak possible cannot be introduced.

**Baseline.** `test-baseline.json` counts move as tests are added, and
AGENTS.md requires the file and the docs be updated in the same commit as the
behaviour. Expect `counts.total` and `counts.pass` to rise; `skipped` will
rise too for the database-gated suites, which is honest — a skipped isolation
suite proves nothing, and the baseline file already says so.

## C3. Implementation roadmap — PR-sized tasks

Every task below is one behaviour, sized to be reviewable in a single diff, in
dependency order.

### Phase 1 — Foundation

**T1.1 — Website schema**
*Objective:* the tables exist, with RLS, and nothing reads them yet.
*Files:* `db/migrations/0049_pharmacy_websites.sql`
*Depends on:* nothing.
*Acceptance:* `npm run migrate` applies cleanly and is re-runnable; RLS enabled
on all three tables with the `is_pharmacy_member` policies.
*Tests:* migration applies against a scratch database; `isolation.test.js`
still passes.

**T1.2 — Website service + API**
*Objective:* create, read, and save a draft, tenant-scoped.
*Files:* `server/services/website/websiteService.js`,
`server/routes/website.js`, mount in `server/index.js`.
*Depends on:* T1.1.
*Acceptance:* `GET /api/website` returns `{site:null}` for a fresh pharmacy;
`POST` then `PUT /draft` round-trips project JSON; every handler calls
`assertPharmacyId`.
*Tests:* `websiteService.test.js`, `websiteIsolation.test.js` (create, read and
write isolation).

**T1.3 — Website tab, behind the flag**
*Objective:* `Dashboard → Website` exists and renders an empty state.
*Files:* `client/src/App.jsx` (SECTIONS, SUBTITLE, canvas branch),
`client/src/Icons.jsx` (`IconWebsite`), `client/src/website/WebsitePanel.jsx`,
`client/src/website/api.js`, `server/config/env.js`
(`WEBSITE_BUILDER_ENABLED`).
*Depends on:* T1.2.
*Acceptance:* the tab appears only with the flag on; `?tab=website`
deep-links; main bundle unchanged in size.
*Tests:* lint; verification in the browser preview.

**T1.4 — GrapesJS mount, lazy**
*Objective:* the editor opens, loads `draft_data`, and saves it back.
*Files:* `client/src/website/Editor.jsx`, `BuilderShell.jsx`,
`client/package.json` (`grapesjs@0.23.6`, `@grapesjs/react@2.0.0`).
*Depends on:* T1.3.
*Acceptance:* editing then reloading the page shows the edit; **the main chunk
grows by less than 20 KB** and GrapesJS lands in its own lazy chunk.
*Tests:* lint; a build-output size check; manual save/reload.

### Phase 2 — Templates

**T2.1** Registry, manifest shape, and the *Professional* template.
`templates/index.js`, `templates/professional/*`, `templateIntegrity.test.js`.
*Acceptance:* creating a site from Professional produces an editable page.

**T2.2** Template picker and preview UI. `TemplatePicker.jsx`.
*Acceptance:* the cards render, three are selectable, the rest are marked
coming soon; "Use this template" clones project data into the draft.

**T2.3** *Modern* and *Community* templates.
*Acceptance:* adding them touches no file outside `templates/`, proving §B10.

### Phase 3 — Pharmacy blocks

**T3.1** Pharmacy block set — header, hero, WhatsApp CTA, about, services,
hours, location, contact, footer. `blocks/pharmacyBlocks.js`.
*Acceptance:* the block panel shows a PHARMACY category and nothing generic
that would let an owner break the layout.

**T3.2** Bound components + the rewriter. `blocks/boundComponents.js`,
`server/services/website/bindRewriter.js`.
*Acceptance:* a published page's phone number changes when the profile
changes, without the owner opening the editor.
*Tests:* `bindRewriter.test.js`, including refusal on nested markup.

### Phase 4 — Publishing

**T4.1** Sanitiser, publish, unpublish, revisions.
*Tests:* `sanitize.test.js` — the largest test file in this feature.

**T4.2** Public route `/p/:slug`, its own CSP, caching, and the SPA-fallback
exclusion.
*Acceptance:* a published site loads at `/p/<slug>`; an unpublished one 404s;
`/p/<slug>` does **not** return the dashboard shell.
*Tests:* `websiteIsolation.test.js` extended; the GOLDEN entry.

**T4.3** `website_republish` job on profile change, via the existing `jobs`
table and worker.

### Phase 5 — Branding and assets

**T5.1** Supabase Storage bucket, upload/delete API, magic-byte validation,
CSP `img-src` update.
**T5.2** Guided setup step writing `content` and `pharmacy_profile`.
**T5.3** Theme controls — logo, two brand colours, a constrained font choice.
Constrained on purpose: the brief asks for a professional minimum standard, so
the owner picks from a set, not from a colour wheel.

### Phase 6 — Subdomains

Blocked on the two verifications in §B7. Ships as `resolveSiteKey` gaining a
host branch, and nothing else changing.

### Phase 7 — Analytics hooks

Schema and event shape only, so §19 of the brief can be built later without
touching the website system.

## C4. Definition of done for the MVP

Phases 1 through 5 complete, and this path works end to end for two different
pharmacies with no interference between them:

```
sign in → Website → choose template → confirm pharmacy details →
customise → preview → save → publish → public URL →
customer taps "Chat on WhatsApp" → the pharmacy's own WhatsApp opens
```

With `websiteIsolation.test.js` green against a real database, and `npm test`
compared against `test-baseline.json`.

---

## Appendix — decisions taken, so they are not re-litigated

| Decision | Chosen | Rejected, and why |
|---|---|---|
| GrapesJS source | npm `grapesjs@0.23.6` | The GitHub fork — npm ships built `dist`; a git dependency would need a build step during Render's install. |
| Fork's role | Upstream mirror only | Modifying core forfeits upstream fixes for no demonstrated requirement. |
| React binding | `@grapesjs/react@2.0.0` | Hand-rolled `useEffect` mount — the official binding handles teardown, which is where hand-rolled versions leak. |
| Editor loading | `React.lazy` | Eager import — 1 MB on first paint for users who never open Website. |
| Publish artefact | Stored sanitised HTML | Per-request render — a query per visitor on a 15-connection pooler shared with WhatsApp. |
| Live data | `data-rx-bind` spans rewritten by a job | Tokens, client fetch, SSR — see §B4. |
| HTML rendering | Client exports, server sanitises | GrapesJS in Node via jsdom — heavy dependency in the process holding WhatsApp sockets. |
| Public URL | `/p/<slug>` first | Subdomains first — blocked on unverified wildcard DNS and TLS. |
| Subdomain source | New validated `subdomain` column | `pharmacies.slug` — auto-generated, no reserved-word check, documented as not an identifier. |
| Asset storage | Supabase Storage | Postgres `bytea` (bloat, pooler pressure); Render disk (no volume, pins the instance). |
| Site cardinality | One per pharmacy, `pharmacy_id` as PK | A surrogate id with a unique constraint — a join for a one-to-one is a join written wrong eventually. |
| Rollout | `WEBSITE_BUILDER_ENABLED`, default off | Big-bang release — the flag makes production exposure reversible in one env var. |
