# RxNaija Website Builder — Locked Decisions

**This document is the contract the implementation must follow.**
Approved 2026-09-05. Supersedes the version pin and publishing mechanism in
`WEBSITE_BUILDER_PLAN.md`; that document's audit, security model, domain
strategy and risk register still stand.

Every item below is marked **DECIDED**, **DEFERRED** or **REJECTED**. A change
to a DECIDED item is an amendment to this file, argued in the commit that
makes it — not a quiet drift during implementation.

---

## The locked architecture

```
                 PHARMACY PROFILE
                       │
                       ▼
                  WEBSITE DATA
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
      TEMPLATE SYSTEM         THEME SYSTEM
            │                     │
            └──────────┬──────────┘
                       ▼
                REGISTERED BLOCKS
                       │
              ┌────────┴────────┐
              ▼                 ▼
       GUIDED BUILDER      GRAPESJS EDITOR
              │                 │
              └────────┬────────┘
                       ▼
                SERVER RENDERER
                       │
                       ▼
                PUBLISHED HTML
                       │
                       ▼
             PUBLIC PHARMACY SITE
                       │
                       ▼
                   WHATSAPP
                       │
                       ▼
                  RXNAIJA AI
                       │
                       ▼
             PRIVATE INVENTORY
```

**The governing rule, and the reason the diagram flows one way:**

> GrapesJS is an implementation detail of the advanced editor. No other part
> of the application may depend directly on a GrapesJS API. It is one of two
> user interfaces onto `site_data`; it is never the source of truth, never the
> renderer, and never a dependency of the server.

Enforced concretely: `grapesjs` may be imported by exactly one module,
`client/src/website/Editor.jsx`. Nothing in `server/` may import it, and a
test asserts both.

---

## 1. GrapesJS version and integration

| | |
|---|---|
| **DECIDED** | `grapesjs@0.23.6`, mounted by hand in a `useEffect`, torn down with `editor.destroy()`. |
| **DECIDED** | Do **not** install `@grapesjs/react`. |
| **DECIDED** | Loaded with `React.lazy` + dynamic `import()`. Only `Editor.jsx` may import it. |
| **DECIDED** | Do not modify GrapesJS core. Do not depend on the GitHub fork; it stays an upstream mirror. |
| **DEFERRED** | Adopting `@grapesjs/react` if it republishes with a `^0.23` peer and React back in peers only. Re-check at install time; adopting later is a contained change to one file. |
| **REJECTED** | `grapesjs@0.22.16` + `@grapesjs/react@2.0.0` — installs, but drags a second React into `node_modules`. |
| **REJECTED** | `--legacy-peer-deps` or an `overrides` entry to force the binding onto 0.23.6. |

**Evidence.** Measured by installing and building, 2026-09-05:

| Combination | Installs | React copies | Main chunk | Editor chunk (lazy) |
|---|---|---|---|---|
| 0.23.6 + binding | **No — ERESOLVE** | — | — | — |
| 0.22.16 + binding | Yes | **2** (18.3.1 + 19.2.8) | 143.94 kB | 1,124.80 kB / 304 kB gz |
| **0.23.6, hand-mounted** | Yes | **1** | **143.93 kB** | 1,148.27 kB / 303.5 kB gz |

The binding's peer range `^0.22.5` means `>=0.22.5 <0.23.0` and excludes the
current core. It also declares React 19 as a `dependency`, not only a peer.
The main chunk is byte-identical whether GrapesJS is present or not, so the
lazy-load mitigation is proven rather than assumed.

## 2. Publishing architecture

| | |
|---|---|
| **DECIDED** | The server renders published HTML from structured data. The browser never supplies HTML. |
| **DECIDED** | `published_html` is a **derived cache**, regenerable from `published_data` + the current profile at any time. |
| **DECIDED** | Published pages carry `script-src 'none'` and contain no JavaScript. |
| **REJECTED** | Client exports HTML → server sanitises. `sanitize.js` is **cancelled**; there is no untrusted HTML to sanitise. |
| **REJECTED** | Static-site generation to files — needs durable disk, which `render.yaml` deliberately has none of. |

Owner-typed text is escaped by one `escapeHtml()` function. That is the entire
residual surface, in place of an element/attribute/CSS allowlist.

## 3. Data-binding strategy

| | |
|---|---|
| **DECIDED** | Pharmacy facts are resolved **at render time** from `pharmacies` + `pharmacy_profile`. |
| **DECIDED** | Each block declares the profile fields it reads. The renderer is the only code that reads the profile. |
| **DECIDED** | A profile change enqueues a `website_render` job on the existing `jobs` table, running the same code path as publish. |
| **REJECTED** | `data-rx-bind` spans rewritten in stored HTML. `bindRewriter.js` is **cancelled** — its failure mode was silent. |
| **REJECTED** | `{{token}}` substitution, client-side fetch, and duplicating profile values into templates. |

One authoritative source per fact: identity and WhatsApp number in
`pharmacies`; contact, hours, services, description and brand in
`pharmacy_profile`; page structure and copy in `pharmacy_websites.site_data`;
published HTML derived and owning no truth of its own.

## 4. Template architecture

| | |
|---|---|
| **DECIDED** | A template is **seed `site_data` plus a manifest** — not HTML, not CSS. |
| **DECIDED** | Adding template 4–10 is one folder and one registry line. No change to the builder, renderer, API or schema. |
| **DECIDED** | A site stores `template_id` + `template_version` and a **clone** of the seed. Template updates never touch an existing site. |
| **DECIDED** | MVP ships exactly three: **Professional, Modern, Premium**. |
| **DEFERRED** | Templates 4–10. Opt-in migration between template versions. |

## 5. Website creation UX

| | |
|---|---|
| **DECIDED** | The guided flow is the product; the editor is optional. An owner can publish without ever opening GrapesJS. |
| **DECIDED** | Both the guided flow and the editor write the same `site_data`. The renderer does not know which produced it. |
| **DECIDED** | No blank canvas is ever shown. Selecting a template seeds a complete page. |
| **DECIDED** | The editor's block panel is restricted to registered pharmacy blocks. No generic div-dragging. |
| **DECIDED** | A constrained theme panel replaces the GrapesJS Style Manager. |
| **REJECTED** | Free-form CSS editing, and any flow that opens on an empty editor. |

## 6. Database schema

**DECIDED**, one additive migration `0049_pharmacy_websites.sql`:
`pharmacy_websites` (PK `pharmacy_id`, `site_data`, `content`, `theme`,
`published_data`, `published_html`, `status`, `subdomain`, `custom_domain`),
`website_revisions` (stores `site_data`, **not** HTML — HTML is regenerable),
`pharmacy_assets` (paths always prefixed with `pharmacy_id`), and eight
nullable columns on `pharmacy_profile`.

RLS enabled on all three with the `is_pharmacy_member` policies, following
`db/migrations/0001_init.sql:490`.

**DECIDED — a constraint that must appear in the migration itself:**
`description` and `services` land on a table the assistant reads. They must
not enter the assistant's context as a side effect of this work. That is a
separate change with its own clinical review.

**REJECTED:** storing rendered HTML in revisions; a surrogate id with a unique
constraint in place of `pharmacy_id` as PK.

## 7. API surface

**DECIDED.** As specified in `WEBSITE_BUILDER_PLAN.md` §B3 with three changes:

- `PUT /api/website/site` replaces `PUT /api/website/draft`; body is `{site_data}`.
- **`POST /api/website/publish` takes an empty body.** It no longer accepts
  `{html, css}`. This closes the only path by which a browser could put markup
  on the public internet.
- `GET /api/website/blocks` is added — the server ships the block contract to
  the client. See decision 10.

Every authenticated handler calls `assertPharmacyId(req.pharmacyId)` and never
reads a tenant id from the request. `GET /p/:slug` is public and reads only
`published_html` where `status='published'`.

### Amendment, 2026-09-06 (Phase 4)

`PUT /api/website/subdomain` is implemented as **`PUT /api/website/address`**.
The column it writes is still `subdomain`; only the route and the product
language changed.

**Why.** The value resolves as a path today — `/p/<address>` — and will *also*
resolve as a subdomain once wildcard DNS and TLS are confirmed. Calling the
endpoint `/subdomain` while no subdomains exist describes an implementation
that is not there yet, and "web address" stays accurate in both worlds.
Nothing else about the decision changes: it is still a separate validated,
owner-chosen column, still never `pharmacies.slug`, and still owner-only.

## 8. Security model

**DECIDED.** The existing chain, unchanged and untouched:
`requireAuth → getMemberships → selectTenant → req.pharmacyId → requireRole →
assertPharmacyId → where pharmacy_id = $1 → RLS`.

What decision 2 changes: no untrusted HTML enters the system; renderers are an
allowlist by construction, so an unknown block type renders nothing; published
pages carry `script-src 'none'`.

Unchanged: another tenant's asset id returns **404, not 403**; asset paths are
prefixed with `pharmacy_id`; uploads are magic-byte checked, ≤ 2 MB, three MIME
types; publishing is `requireRole('owner')`.

## 9. MVP scope

**DECIDED — in.** Website tab behind `WEBSITE_BUILDER_ENABLED`; three
templates; guided creation flow; nine pharmacy blocks; logo, hero and brand
colours; preview; publish and unpublish; revision history; public URL at
`/p/<slug>`; WhatsApp CTA from `pharmacies.public_whatsapp_number`; the
constrained editor as an optional layer.

**DEFERRED.** Custom domains; subdomains; AI-generated copy; analytics beyond
schema hooks; multi-page sites; multiple sites per pharmacy; inventory-aware
blocks.

**REJECTED for MVP.** Any public exposure of inventory. The website's
relationship to stock is a WhatsApp CTA and nothing else. Adding an
inventory-aware block later is one new renderer function — no schema change,
no architecture change.

**Done when** a real pharmacy goes sign-in → template → information → publish →
public URL → customer taps WhatsApp → the pharmacy's own WhatsApp opens, in
about ten minutes, with tenant isolation green against a real database.

## 10. Block contract location — resolved during Phase 1 planning

The server is CommonJS, the client is ESM, and there is no code-sharing path
between them today: `client/package.json` declares `"whatsapp-ai-automation":
"file:.."` but nothing imports it, and no client module imports anything
outside `client/`.

| | |
|---|---|
| **DECIDED** | The block contract, the renderers and the templates live **server-side**, in `server/services/website/`. |
| **DECIDED** | The client obtains block metadata and template manifests **over the API** (`GET /api/website/blocks`, `GET /api/website/templates`). Template preview images are static files in `client/public/`. |
| **DECIDED** | The GrapesJS editor builds its component types from the API-delivered contract, so it cannot drift from the renderer. |
| **REJECTED** | A duplicated contract in `client/src/website/`, and a shared module imported across the CommonJS/ESM boundary. |

This is what makes "an unknown block renders nothing" true by construction:
there is exactly one list of block types, on the side that renders.

## 11. Testing

**DECIDED — Vitest is added** for the client. Lint plus manual verification is
not accepted as the permanent client strategy.

**A consequence worth stating plainly:** all five invariants named in the
approval are **server-side** under this architecture, because the renderer is
server-side. They belong in the existing `node --test` suite, not in Vitest:

| Invariant | Home |
|---|---|
| Block contract — valid renders, invalid rejected, unknown rejected | `server/tests/blockContract.test.js` |
| Template integrity — required blocks exist, renderer succeeds, no invalid properties | `server/tests/templateIntegrity.test.js` |
| Rendering — name, phone, WhatsApp link, address, hours, theme all correct | `server/tests/websiteRenderer.test.js` |
| Tenant isolation — A cannot read or write B's website | `server/tests/websiteIsolation.test.js` |
| **Publishing invariant — a draft change leaves the public site unchanged until publish** | `server/tests/websiteService.test.js` |

Vitest's first real tests arrive with the guided flow in Phase 3, which is
where the first client logic lands. It is configured in Phase 1 so the
decision is locked and the harness is ready.

**DECIDED.** No test may be weakened to reach green (AGENTS.md rule 2).
`test-baseline.json` is updated in the same commit as the behaviour.

---

## Execution order — locked

```
1  Foundation        database · API · tenancy · website record · feature flag
2  Website contract   block schema · properties · theme schema · template
                      schema · server renderers · validation
3  Guided generator   template → information → branding → preview
4  Publishing         renderer → published_html → /p/<slug> · revisions
5  Advanced editor    lazy GrapesJS as a UI over site_data
6  Assets & polish    logo · images · colours · typography
7  Expansion          subdomains · analytics
```

Working product without the advanced editor by end of Phase 4. GrapesJS
arrives at Phase 5 as a UI over an architecture that already works.

---

## Open risks carried into implementation

1. **CSP, three conflicts, all silent.** `frame-ancestors 'none'` blocks the
   preview iframe *including same-origin*; `img-src` blocks Supabase Storage;
   published pages need their own policy.
2. **The SPA fallback answers `/p/*` with the dashboard shell at HTTP 200**
   unless `p\/` joins the exclusion regex in `server/index.js`.
3. **Public traffic shares the 15-connection pooler with every live WhatsApp
   socket.** One indexed read per page, `max-age=60`.
4. **Renderer coverage is the new correctness boundary.** With no sanitiser,
   renderers are the only thing between stored data and the public page.
5. **Subdomains blocked on two unverified facts** — no custom domain in
   `render.yaml`, wildcard TLS on `starter` unconfirmed.
