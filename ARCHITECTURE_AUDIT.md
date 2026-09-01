# RxNaija — Architecture Audit

**Read-only audit. No code was changed, no file was refactored, nothing was fixed.**

- **Audited:** 2026-08-29, at commit `75e2689` (branch `main`, working tree clean)
- **Repo:** `whatsapp-ai-automation` — multi-tenant WhatsApp AI assistant for Nigerian pharmacies
- **Method:** static reading of source, migrations, config and git history; `npx eslint .` run read-only; no tests executed (see §14.1 for why)

## Why this file, and not `ARCHITECTURE.md`

`ARCHITECTURE.md` already exists (66 KB, last written 2026-08-09). It is a **design document** — the phase plan, the decisions, the pushback on the original brief — not a map of what got built. It is also badly stale: it and `README.md` both still describe a scaffold, while the system they plan is deployed and serving live pharmacies.

Overwriting it would have destroyed a genuinely valuable record of *why* things were decided. This file is the complementary document: **what is actually here now.** See §14.3.

---

## Table of contents

1. [System at a glance](#1-system-at-a-glance)
2. [Entry points](#2-entry-points)
3. [API surface](#3-api-surface)
4. [Data model](#4-data-model)
5. [Authentication and authorization](#5-authentication-and-authorization)
6. [Background jobs and queues](#6-background-jobs-and-queues)
7. [External integrations](#7-external-integrations)
8. [Module map](#8-module-map)
9. [Shared utilities](#9-shared-utilities)
10. [Configuration and environment](#10-configuration-and-environment)
11. [Test suites](#11-test-suites)
12. [Critical dependency chains](#12-critical-dependency-chains)
13. [High-risk file register](#13-high-risk-file-register)
14. [Regression-risk observations](#14-regression-risk-observations)

---

## 1. System at a glance

A **modular monolith**: one Node process holds the HTTP API, the static dashboard, every live WhatsApp socket, and the job worker. That is deliberate and documented in `server/index.js` — at this scale every "service" would share one database and one deploy anyway.

### Size

| Area | Files | Lines |
|---|---:|---:|
| `server/` source (excl. tests) | 118 | 37,447 |
| `server/tests/` | 81 | 15,228 |
| `client/src/` | 37 | 10,934 |
| `db/migrations/` | 48 | 4,387 |
| `agent/` (POS connector) | 6 | 1,643 |
| `desktop/` (Electron shell) | 3 | 598 |

### Topology

```
                     Caddy (TLS, app.rxnaija.com)
                                |
                      reverse_proxy :4000
                                |
     +==========================================================+
     |          ONE Node process — systemd `rxnaija`            |
     |                                                          |
     |  Express API  --  static client/dist  --  /download/*    |
     |       |                                                  |
     |  sessionManager (live Baileys socket per pharmacy)       |
     |       |  events: message / message-arrived / ignored     |
     |       v                                                  |
     |  inboundIngest  ->  jobs table  ->  worker (poll 2s)     |
     |                                          |               |
     |                        clinicalFilter -> assistant/LLM   |
     |                                          |               |
     |                        orderService / clinicalWorkflow   |
     +==========================================================+
                                |
                  Supabase Postgres (pooler :6543)
                  Supabase Auth (JWT verification)
                  OpenAI-compatible LLM endpoint
```

### The five non-negotiables (from `README.md`, and honoured in the code)

1. The database is the source of truth — the assistant never states a price or stock level it did not get from a tenant-scoped tool call.
2. Tenant isolation lives in the query layer — `pharmacy_id` on every row, server-resolved, never client-supplied.
3. Safety routing is deterministic and runs **before** the model.
4. Every failure path ends at a human, never at a guess.
5. Providers sit behind adapters.

Layers 1–4 are visibly enforced in code (`db.js#assertPharmacyId`, `clinicalFilter.js`, `replyValidator.js`, `assistant.js`). Layer 5 is only partially built — see §7.1.

---

## 2. Entry points

### 2.1 Backend

| File | Role |
|---|---|
| `server/index.js` | **The** process entry. Builds Express, mounts 12 routers, serves `client/dist`, starts the session manager and worker, installs shutdown handlers. |
| `server/index.js#start()` | Boot ordering that matters: `assertRequiredEnv()` → `ping()` → `warmPool()` → `startKeepAlive()` → worker → session restore → `listen()`. |
| `server/config/env.js` | Env loading and boot-time validation. Deliberately does **not** throw on import, so a pure unit test three modules downstream can still load. |

### 2.2 Frontend (dashboard SPA)

| File | Role |
|---|---|
| `client/index.html` | Vite HTML entry. |
| `client/src/main.jsx` | React root. Calls `installAuthFetch()` **before** render so the first request already carries a bearer token. |
| `client/src/AuthGate.jsx` | Session gate — sign-in, password recovery, persistent-401 sign-out. Decides whether `App` renders at all. |
| `client/src/App.jsx` | The shell: navigation rail, tab state, badge polling. **Not react-router** — tab state is `useState` synced to `?tab=` via `history.replaceState`. `react-router-dom` is a declared dependency the shell does not use. |

### 2.3 Marketing / static pages

`client/public/home.html`, `about.html`, `company.html`, `download.html` — plain HTML served by the same Express static block. `extensions: ['html']` is set so `/company` resolves to `company.html` instead of falling through to the SPA and returning the dashboard shell with a 200.

### 2.4 POS connector agent (separate program, ships as an .exe)

| File | Role |
|---|---|
| `agent/index.js` | CLI entry — `pair`, `sync`, `watch`, `status`. |
| `agent/scripts/build.js` | esbuild bundle → Node SEA → postject → `rxnaija-sync.exe`. |

Zero runtime dependencies by design (fetch/FormData/Blob are built into Node 18+), except `mysql2` for direct POS database reads. A pharmacy PC must never have to run `npm install`.

### 2.5 Desktop shell

| File | Role |
|---|---|
| `desktop/main.js` | Electron main process. Loads `https://app.rxnaija.com`, splash until first paint, taskbar badge, navigation locked to own origin, `nodeIntegration` off + `contextIsolation` on. |

### 2.6 Operational entry points

| File | Role |
|---|---|
| `deploy/update.sh` | The deploy. Build → migrate → restart → verify. |
| `deploy/setup.sh` | First-time VPS provisioning. |
| `deploy/rxnaija.service` | systemd unit — `Restart=always`, secrets via `EnvironmentFile`, systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges`). |
| `deploy/Caddyfile` | TLS + reverse proxy + health check. |
| `scripts/migrate.js` | Forward-only migration runner. |
| `scripts/doctor.js` | Pre-flight config check. **Contains a now-wrong warning — see §14.5.** |

---

## 3. API surface

**71 router endpoints across 12 mounts, plus 4 top-level routes.** Auth is applied **per route**, never as a blanket `app.use('/api', requireAuth)`. The reasoning is in `index.js`: a blanket gate needs an ever-growing exempt list, and an exempt list is a place where a route quietly ends up unauthenticated.

### 3.1 Top-level (`server/index.js`)

| Method | Path | Auth | Note |
|---|---|---|---|
| GET | `/api/live` | **none** | Liveness only. No DB, no awaits. Kept separate from `/api/health` so a transient Postgres blip cannot fail a platform health check, restart the process, and drop every WhatsApp socket. |
| GET | `/api/health` | **none** | Readiness. Pings DB, 503 when down. |
| GET | `/api/summary` | `requireAuth` | Three counts in one query. Exists because the shell was polling two full endpoints every 10s to read two integers — which helped exhaust the Supabase pooler. |
| GET | `/download/:file` | **none, by design** | Allowlist of exactly two filenames. Registered **before** the SPA fallback, or a missing exe would download `index.html` renamed to `.exe`. |

### 3.2 Routers

| Mount | File | Endpoints | Auth |
|---|---|---:|---|
| `/api/overview` | `routes/overview.js` | 1 | `requireAuth` |
| `/api/insights` | `routes/insights.js` | 1 | `requireAuth` |
| `/api/pharmacies` | `routes/pharmacies.js` | 10 | `requireAuthOnly` (create) / `requireAuth` / `requireRole` |
| `/api/whatsapp` | `routes/whatsapp.js` | 7 | `requireAuth`, plus `authOrTicket` for SSE |
| `/api/catalogue` | `routes/catalogue.js` | 8 | `requireAuth` |
| `/api/sync` | `routes/sync.js` | 7 | `requireAuth` (3) / `requireDevice` (3) / none (1) |
| `/api/email` | `routes/emailInbound.js` | 1 | **shared secret** |
| `/api/conversations` | `routes/conversations.js` | 10 | `requireAuth` |
| `/api/requests` | `routes/requests.js` | 5 | `requireAuth` + `requireRole` on writes |
| `/api/customers` | `routes/customers.js` | 11 | `requireAuth` |
| `/api/customers` | `routes/conditions.js` | 7 | `requireAuth` — **same prefix, deliberately** |
| `/api/orders` | `routes/orders.js` | 3 | `requireAuth` |

`conditions.js` shares the `customers` prefix on purpose: a purchase-based condition profile is a fact *about a customer*, and giving it a second noun in the URL space would imply a second record that does not exist. Worth knowing before someone "tidies" it into `/api/conditions`.

### 3.3 The unauthenticated paths, and why each is defensible

| Path | Justification found in code |
|---|---|
| `/api/live`, `/api/health` | Load balancers cannot log in. Health reports readiness without leaking config values. |
| `/download/:file` | The machine that needs the connector is a till in a back office that will never be signed in. The binary holds no credentials and is inert until paired. Two-name allowlist, not path sanitising. |
| `POST /api/sync/pair` | Redeems a short pairing code the dashboard just issued. The code *is* the credential. |
| `POST /api/email/inbound` | Three locks: constant-time shared secret, unguessable address, sender allowlist. Each alone would be thin. |

**None of these are rate-limited.** See §14.2.

---

## 4. Data model

**46 tables across 48 forward-only migrations** (`0001`–`0047`; `0023` used twice — §14.6), plus `schema_migrations` created by the runner. No down-migrations, by policy: a bad migration is fixed by writing the next one, and an untested `down` is worse than none.

### 4.1 Isolation model — the most important thing in the schema

Two independent layers, and `0001_init.sql` is explicit that neither may be relied on alone:

1. **Application layer (primary).** The API connects with the Supabase **service_role** key, which **bypasses RLS**. Every query therefore carries its own `where pharmacy_id = $1`, resolved server-side from a verified session. `services/db.js#assertPharmacyId` exists to make forgetting it loud — it throws rather than letting `undefined` reach Postgres and quietly match nothing (or, worse, everything).
2. **Row-Level Security (defence in depth).** Policies via `is_pharmacy_member(p_id)`, a `security definer` function. Catches anything arriving through the anon key.

`inbound_events` and `jobs` have RLS **enabled with no client policies at all** — infrastructure tables, service_role only. An unroutable `inbound_event` has no `pharmacy_id` to filter on anyway.

### 4.2 Money

All amounts are **integer kobo** (1 naira = 100 kobo). No floats anywhere in the money path. Order totals are **snapshots** taken at confirmation — recomputing from current product prices would silently rewrite history when the next catalogue lands.

### 4.3 Table groups

| Group | Tables |
|---|---|
| **Tenancy** | `pharmacies`, `pharmacy_members`, `pharmacy_profile` |
| **Channel** | `whatsapp_accounts`, `whatsapp_auth_keys`, `whatsapp_consents`, `whatsapp_templates`, `inbound_events`, `outbound_allowlist`, `blocked_senders`, `opt_outs` |
| **Catalogue** | `products`, `catalogue_uploads`, `column_mapping`, `column_alias` |
| **Conversation** | `customers`, `conversations`, `messages`, `handoffs` |
| **CRM** | `customer_events`, `patient_notes`, `patient_tags`, `tags`, `communication_preference_history` |
| **Orders** | `orders`, `order_items`, `order_status_history`, `product_requests` |
| **Clinical** | `clinical_encounters`, `clinical_protocols`, `protocol_questions`, `protocol_executions`, `protocol_red_flags`, `protocol_recommendations`, `encounter_answers`, `encounter_facts`, `patient_profiles`, `patient_clinical_facts`, `patient_condition`, `patient_condition_evaluation`, `recommendation_evaluations`, `evidence_sources`, `evidence_references` |
| **Sync** | `sync_devices` |
| **Infrastructure** | `jobs`, `audit_logs` |

### 4.4 Constraints to know before touching anything

- `whatsapp_accounts.display_phone_number` is **globally unique** — it is the tenant routing key on inbound. `0046` adds one-account-per-pharmacy on top.
- `conversations` has a partial unique index `idx_conversations_one_open on (customer_id) where mode <> 'closed'` — one open conversation per customer, enforced by the database, not by application logic.
- `orders.customer_id` is `on delete restrict` (not cascade) — deleting a customer with orders fails loudly rather than destroying order history.
- `order_items.product_id` is `on delete set null` **with `name_snapshot`** — a catalogue re-upload archiving a product must not destroy what was agreed.
- `products` unique on `(pharmacy_id, natural_key)` — this is what makes re-upload an upsert rather than a duplicate. `natural_key` comes from the `productNormalizer` / `productIdentityResolver` stack.
- `products.stock_tracked` distinguishes "we counted zero" from "this file had no stock column". `orderLimits` branches on it.
- `messages.provider_message_id` partial unique index — the idempotency guarantee against duplicate socket/webhook delivery.
- `products` uses **pg_trgm GIN indexes** on `name` and `generic_name`. This is what actually answers "do you have augmentin" against messy catalogue text.

---

## 5. Authentication and authorization

### 5.1 The dashboard path

```
Browser ──(Supabase JS, direct)──> Supabase Auth ──> JWT
   │
   └──(Authorization: Bearer <jwt>)──> Express
                                         │
                     middleware/auth.js#requireAuth
                       ├─ verifyUser()      Supabase getUser(), 8s timeout
                       ├─ getMemberships()  pharmacy_members join pharmacies
                       └─ selectTenant()    PURE — picks the tenant
                                         │
                                    req.pharmacyId
```

**The one rule** (stated at the top of `middleware/auth.js`): `req.pharmacyId` is derived from a verified session and a real membership row. It is never read from a body, a query param, or an unverified header.

`X-Pharmacy-Id` **is** accepted — but only as a *selection among memberships the caller provably has*. A header naming a pharmacy the caller does not belong to is rejected outright.

### 5.2 `selectTenant()` — the single most security-critical function

Deliberately **pure**, so it can be tested exhaustively without a database, network or mock (`tests/selectTenant.test.js`). Every branch is a security decision:

| Input | Result | Why |
|---|---|---|
| No memberships | 403 `NO_MEMBERSHIP` | Cannot act on a tenant you have none of. |
| No header | first membership | v1 has no switcher. |
| Header matches one | that membership | — |
| Header matches none | **403, not 404** | Telling a caller whether a tenant id exists is itself a disclosure. |
| Header not a string | 403 | Node joins duplicate headers into `"a, b"`; sending it twice must not get a lucky match. |

UUID comparison is case-insensitive, because Postgres treats `uuid` that way — rejecting different case would be a bug, not a defence.

### 5.3 Guards

| Guard | Meaning |
|---|---|
| `requireAuthOnly` | Valid session, no membership needed. Used only for pharmacy creation. |
| `requireAuth` | Valid session **and** a real membership. The default. |
| `requireRole(...roles)` | Owner/pharmacist gates on billing, disconnect, catalogue writes, request replies. |
| `requireDevice` (`routes/sync.js`) | Device token. **Scoped narrowly on purpose** — a pharmacy server PC is shared, so a leaked token must mean "somebody pushed a price list", not "somebody read the customer table". Kept as its own middleware so the two cannot drift into accepting each other. |
| `authOrTicket` (`routes/whatsapp.js`) | Header if present, else a single-use 30-second ticket. |

### 5.4 The SSE ticket

`EventSource` cannot send an `Authorization` header. Rather than putting the session token in a query string — where it lands in access logs, proxy logs and browser history — the route issues a **single-use, 30-second, in-memory ticket** that grants exactly one thing: a read-only stream of that tenant's connection events. Redeeming deletes it, so a logged URL cannot be replayed.

### 5.5 `DEV_AUTH_BYPASS`

Disables authentication entirely. Gated **twice**: `env.devAuthBypass` is false unless `NODE_ENV` is non-production, and `assertRequiredEnv()` **refuses to boot** if the flag is set in production. It also logs on every single request. A warning would be read once and ignored; a dead process gets fixed.

### 5.6 Credential handling

- `SUPABASE_SERVICE_ROLE_KEY` — server only, never sent to the browser. The client uses the anon key via `VITE_SUPABASE_ANON_KEY`.
- Baileys session credentials are **envelope-encrypted** (`services/crypto.js`, AES-256-GCM, `[iv|authTag|ciphertext]` in one `bytea`). Possession of a Baileys auth state is full account takeover of the pharmacy's WhatsApp, so a database dump must yield ciphertext.
- `routes/whatsapp.js` explicitly enumerates response fields rather than spreading the row, so `creds_encrypted` cannot leak because someone added a column later.

---

## 6. Background jobs and queues

### 6.1 The queue

**Postgres-backed, not Redis/BullMQ.** `select ... for update skip locked` on the `jobs` table. The reasoning is recorded in both `0001_init.sql` and `worker.js`: at a few hundred messages a day, Redis adds a second stateful service to operate, back up and secure, to solve a scale problem that does not exist.

### 6.2 The worker — `server/services/worker.js` (1,864 lines)

In-process, started from `index.js` unless `WORKER_ENABLED=false`. Polls every 2s (`WORKER_POLL_INTERVAL_MS`).

**One job kind:** `process_inbound` → `HANDLERS = { process_inbound: processInbound }`.

Timing and safety constants:

| Constant | Value | Purpose |
|---|---|---|
| `STALE_LOCK_MINUTES` | 5 | Longer than any legitimate job, so a reclaim means a stuck worker, not a slow one. Reclaiming eagerly would double-send. |
| `JOB_TIMEOUT_MS` | 120,000 | The line past which "slow" is indistinguishable from "hung". A hung job costs every *later* message for that pharmacy. |
| `SWEEP_TIMEOUT_MS` | 60,000 | — |
| `SWEEP_INTERVAL_MS` | 60,000 | — |
| `REMINDER_SCHEDULE_MINUTES` | 15, 45, 75, 105 | Unhandled-consultation chasing. |
| `PHARMACIST_IDLE_TAKEBACK_MINUTES` | 10 | — |

### 6.3 The four sweeps

| Sweep | What it does |
|---|---|
| `sweepAbandonedJobs` | Reclaims jobs stuck in `running` past the stale lock. |
| `sweepIdleConversations` | Closes conversations idle past `IDLE_HOURS`. |
| `sweepUnhandledConsultations` | Chases a pharmacist who has not picked up a clinical handoff. |
| `sweepIdlePharmacistHandoffs` | Returns a conversation to the assistant when a pharmacist went quiet. |
| `sweepExpiredHolds` | Releases stock held by orders that never got confirmed. |

### 6.4 The inbound pipeline, end to end

```
Baileys socket
  └─ sessionManager emits 'message'
       └─ inboundIngest.ingest()          PERSIST FIRST, PROCESS SECOND
            ├─ ingestionPolicy            are we entitled to keep this?
            ├─ jidPolicy                  is this a chat we may join? (allowlist)
            ├─ senderIdentity             LID vs phone JID resolution
            ├─ conversationPolicy         same conversation, or a new one?
            └─ INSERT messages + INSERT jobs(process_inbound)
                 └─ worker.tick() claims it
                      ├─ burstPolicy      skip / defer / send
                      ├─ conductPolicy    may the assistant send at all?
                      ├─ warmupPolicy     new-number volume ramp
                      ├─ clinicalFilter   DETERMINISTIC, before the model
                      ├─ clinicalRouter   protocol engine, or ordinary path?
                      ├─ ai/assistant     LLM loop, ≤3 tool iterations
                      │    ├─ catalogueTools   the ONLY way facts enter a reply
                      │    └─ replyValidator   every number must trace to a tool
                      └─ outboundMessage  send + store row + timeline event
```

**Persist first, process second** is load-bearing: nothing retries on our behalf under Baileys, so a message dropped before it becomes a row is a customer ignored with no trace.

### 6.5 Process-model constraint

The worker and the WhatsApp sockets live in the **same process**. `for update skip locked` makes multiple workers safe at the queue level, but a second *production* instance would open a second Baileys socket per pharmacy, and WhatsApp permits one — the newcomer knocks the incumbent off with `connectionReplaced` (440). This is a **hard single-instance constraint** today. `ALLOW_LOCAL_WHATSAPP` guards the dev case only.

---

## 7. External integrations

| Integration | Where | Notes |
|---|---|---|
| **WhatsApp via Baileys** | `services/whatsapp/sessionManager.js` | Unofficial client, authenticates as the pharmacy's own linked device. `baileys@7.0.0-rc14` — a **release candidate**, pinned exactly. |
| **Supabase Postgres** | `services/db.js` | Transaction pooler `:6543` with `prepare: false`. |
| **Supabase Auth** | `middleware/auth.js` | `getUser(token)` with an 8s timeout; returns **503, not 401**, on timeout — "your session is invalid" would be a lie that sends people to a sign-in that also cannot work. |
| **LLM (OpenAI-compatible)** | `services/ai/llmClient.js` | `LLM_API_URL` defaults to OpenAI chat completions; `LLM_MODEL` defaults to `gpt-4o-mini`. Behind an adapter. |
| **LLM (column mapping)** | `services/ingestion/llmMapper.js` | Separate call path, hardcoded OpenAI URL as its default. |
| **Twilio** | `config/env.js`, `0047_twilio_obo.sql`, `whatsapp/templates.js` | **Scaffolded, not wired.** Config keys and DB columns exist; no adapter implementation. |
| **Inbound email parse** | `routes/emailInbound.js` | Provider-agnostic multipart POST (SendGrid / Mailgun / Postmark / Cloudflare Email Workers). Deliberately not an SMTP server of our own. |
| **POS MySQL** | `agent/src/database.js` | The agent reads the pharmacy's POS database directly on their machine. |
| **STT vendors** | `scripts/stt-compare.js`, `scripts/voice-check.js` | **Exploration harnesses only, not in the product.** Azure Speech, Deepgram, Intron Health, OpenAI Whisper. |

### 7.1 On non-negotiable #5 ("providers sit behind adapters")

`services/whatsapp/channelProvider.js` exists as the boundary, and `sessionManager` is the Baileys implementation. But `worker.js` requires `sessionManager` directly, and so do `routes/whatsapp.js` and `routes/orders.js`. The abstraction exists; it is not yet the only door. This matters if the Twilio path is ever finished.

---

## 8. Module map

For each: **what it does · depended on by · depends on · entry files · high-risk files.**

### 8.1 `services/whatsapp/` — channel layer (22 files)

**What it does.** Owns every live socket, decides which messages may be kept and answered, turns socket events into durable rows, and is the only place an outbound message is actually sent.

**Depended on by.** `worker.js`, `routes/whatsapp.js`, `routes/orders.js`, `routes/conversations.js`, `routes/requests.js`, `index.js`.

**Depends on.** `services/db.js`, `config/env.js`, `services/crypto.js`, `baileys`, `pino`.

**Entry files.** `sessionManager.js` (the socket owner), `inboundIngest.js` (socket → rows), `outboundMessage.js` (the single send+store door).

| File | Lines | Role |
|---|---:|---|
| `sessionManager.js` | 1,093 | Every live socket. Reconnect, pairing, LID handling, `onWhatsApp` check with 6h cache. |
| `inboundIngest.js` | 333 | Persist first, process second. |
| `authStore.js` | — | Encrypted, tenant-scoped, **lazy** Baileys auth state in Postgres. |
| `conversationState.js` | — | The workflow state machine (transition matrix). |
| `conversationService.js` | — | The **only** place `workflow_state` is written. |
| `senderIdentity.js` | — | LID vs phone JID. WhatsApp is migrating to opaque LIDs that are *not* phone numbers. |
| `jidPolicy.js` | — | Allowlist, not exclusion list, of chats the assistant may join. |
| `ingestionPolicy.js` | — | Baileys is a linked device and sees *every* chat on the phone. This decides what we are entitled to keep. |
| `conductPolicy.js` | — | May the assistant send this reply? |
| `communicationPolicy.js` | — | May we send *this kind* of message to *this customer*, right now? |
| `conversationPolicy.js` | — | Same conversation, or a new one? |
| `disconnectPolicy.js` | — | **Pure.** What to do when a socket closes. |
| `burstPolicy.js` | — | **Pure.** skip / defer / send — answers a burst once and spaces replies. |
| `warmupPolicy.js` | — | New-number volume ramp. Counts business-initiated only. |
| `handoffService.js` | — | Consolidates three questions in five minutes into one pharmacist alert. |
| `messageFormat.js` | — | Final outbound polish, as a function not a prompt instruction. |
| `templates.js` | — | Five UTILITY templates (Twilio path). |
| `tradeCode.js` | — | Wholesale account enrolment via a printed code. |
| `channelProvider.js` | — | The provider boundary (see §7.1). |

**High risk to modify.**
- `sessionManager.js` — the whole product is offline if this is wrong, and failures are silent. Baileys is unofficial and its behaviour changes between RCs.
- `inboundIngest.js` — a bug here drops customers with no trace.
- `outboundMessage.js` — the only place a send becomes a row *and* a timeline event, together. Splitting those produces a message the CRM never saw.
- `senderIdentity.js` — LID handling; get it wrong and replies go to the wrong person.
- `authStore.js` — corrupting auth state forces every pharmacy to re-pair.

### 8.2 `services/ai/` — assistant layer (11 files)

**What it does.** The orchestration loop: message in, reply or handoff out.

**Depended on by.** `worker.js`, `routes/pharmacies.js`.

**Depends on.** `services/safety/clinicalFilter`, `services/db.js`, the LLM endpoint.

**Entry file.** `assistant.js#respond()`.

**The order in `assistant.js` is explicitly non-negotiable:**

1. Safety filter — deterministic, **before** the model sees anything
2. Tool-calling loop — bounded at `MAX_TOOL_ITERATIONS = 3`
3. Reply validation — every number must trace to a tool result
4. Send, or hand off

Step 1 cannot move after step 2: "a model asked to evaluate the text that would compromise it is being asked a circular question."

| File | Lines | Role |
|---|---:|---|
| `catalogueTools.js` | 1,027 | **The only way facts enter a reply.** 9 tools: `find_products`, `get_pharmacy_info`, `contact_pharmacy`, `browse_category`, `ask_pharmacist`, `get_order_history`, `save_customer_name`, `create_order`, `change_order_item`. |
| `assistant.js` | 499 | The loop. `MAX_VALIDATION_RETRIES = 2` — a rejected draft is handed back with the specific violation rather than escalated immediately. |
| `replyValidator.js` | — | Every number in a reply must trace to a tool result **from this turn**. |
| `menu.js` | — | Greeting and menu for new numbers. |
| `therapeuticNeed.js` / `needVocabulary.js` | — | Everyday words → NAFDAC therapeutic subgroups / catalogue category words. |
| `saleUnit.js` | — | What a product is actually *sold* as, derived from the catalogue's `form` column. |
| `assistantTone.js` | — | Three selectable voices; the exact sentence each puts in the system prompt. |
| `llmClient.js` | — | Provider adapter. Throws `LlmUnavailable`. |
| `greetingName.js`, `welcomeNoteGenerator.js` | — | — |

**High risk to modify.**
- `catalogueTools.js` — 1,027 lines, and it is the *entire* factual surface of the product. **No dedicated test file** (see §11.3).
- `assistant.js` — reordering steps 1–4 breaks a safety guarantee, silently and only under adversarial input.
- `replyValidator.js` — the last line of defence against a hallucinated price reaching a customer.

### 8.3 `services/safety/` — the deterministic gate (4 files)

**What it does.** Decides, **without a model**, whether the assistant may answer at all.

**Depended on by.** `worker.js`, `services/ai/assistant.js`, `routes/conversations.js`.

**Depends on.** Nothing. `clinicalFilter.js` is pure.

**Entry file.** `clinicalFilter.js#screenMessage()`.

| File | Role |
|---|---|
| `clinicalFilter.js` | Pure, deterministic. 12 escalation categories. **Fails closed** — empty, non-string, over-long, or unreadable input escalates. Strips zero-width characters so an invisible character cannot break a word boundary. |
| `escalationPolicy.js` | When a failure is worth a pharmacist, and when it is just a bad turn. |
| `escalationMessage.js` | What the customer is told. |
| `consultationBriefing.js` | What a pharmacist needs before opening the conversation. |

**High risk to modify.** `clinicalFilter.js` is the single highest-consequence file in the repo. Loosening it risks a customer getting clinical advice from a model; tightening it makes the product useless (a filter that escalates everything is an expensive way to forward messages). It has the largest test corpus in the suite, split into MUST ESCALATE and MUST ANSWER halves — **both halves are the specification.**

The corpus carries an honest recorded caveat: it was written from knowledge of how people phrase things, **not** from this pharmacy's real logs, and must be re-run against real logs before launch.

### 8.4 `services/clinical/` — protocol engine (22 files)

**What it does.** Structured clinical encounters: versioned protocols, collected facts with provenance, red-flag evaluation, and a deterministic recommendation gate.

**Depended on by.** `worker.js`, `routes/conversations.js`, `routes/conditions.js`, `routes/orders.js`.

**Depends on.** `services/db.js`, `services/customers/`, `config/conditionMappings.js`, the NAFDAC dataset.

**Entry files.** `clinicalWorkflow.js` (the single doorway from the conversation layer), `clinicalRouter.js` (protocol engine or ordinary path?), `clinicalEncounterService.js` (all encounter writes).

| File | Lines | Role |
|---|---:|---|
| `safetyGate.js` | 550 | **Pure.** The deterministic recommendation gate. No database, no clock, no model. |
| `clinicalWorkflow.js` | 537 | The single doorway. |
| `protocolExecutionService.js` | 489 | Runs a versioned protocol deterministically, entirely from application code. |
| `clinicalProtocolService.js` | 457 | Protocol/red-flag metadata: labels, versions, on/off switches. |
| `conditionEngine.js` | 423 | **Pure.** Purchase-based condition inference. |
| `conditionProfileService.js` | 419 | Reads purchases, runs the engine, stores the result so it can be explained later. |
| `recommendationService.js` | 336 | Authoring rules + running the gate. |
| `clinicalFactService.js` | 313 | Observations with provenance. **Nothing is ever silently overwritten.** |
| `answerNormaliser.js` | 294 | Structures what a patient typed **without throwing the original words away.** |
| `protocols/*.js` | 1,966 | 5 versioned protocols: fever v1/v2, cough v1, sore throat v1, Nigeria malaria v1. |
| `evidenceService.js` | — | Approved sources and the exact passages recommendations cite. |
| `redFlagEvaluator.js`, `clinicalBriefing.js`, `clinicalDifferentialService.js`, `clinicalAudit.js`, `patientProfileService.js`, `clinicalProductResolver.js`, `nafdacDatasetVersion.js`, `pharmacistHandoffService.js` | — | — |

**High risk to modify.** `safetyGate.js` and the `protocols/` files — these encode clinical judgement, are versioned for a reason, and a change silently alters advice given to real patients. `clinicalFactService.js` — the no-silent-overwrite guarantee is what makes the audit trail trustworthy.

### 8.5 `services/orders/` — commerce (6 files)

**What it does.** Turns a conversation into an order, sizes it against real stock, and moves stock only when a human acts.

**Depended on by.** `worker.js`, `routes/orders.js`, `routes/requests.js`, `services/ai/catalogueTools.js`.

**Depends on.** `services/db.js`, `services/customers/customerEvents`.

**Entry file.** `orderService.js`.

**Two rules, both load-bearing:**

1. **The model supplies product ids and quantities. It does NOT supply prices.** Every price is read from `products` server-side at creation time. The assistant has been observed saying "Done, I've set aside 3 packs" when nothing existed; if it could also state the price, a hallucinated number would become a real order and an argument at the counter.
2. **`pending` holds nothing.** Stock is decremented atomically the first time a *human* moves an order out of `pending`. Two customers can both have a pending order for the last pack; whichever is confirmed first wins, and the other fails at confirm time with a clear reason rather than silently at order time.

| File | Lines | Role |
|---|---:|---|
| `orderService.js` | 1,028 | `createOrder`, `amendPendingOrder`, `updateStatus`, `commitStock`, `releaseStock`, `expireStaleHolds`, `listOrders`. `MAX_LINES = 20`, `DUPLICATE_CONFIRM_MINUTES = 10`. |
| `orderLimits.js` | 141 | **Pure.** `maxOrderableQuantity` returns the *full shelf*; `checkLine` returns ok / reduce / review. `UNTRACKED_CAP = 20`, `REVIEW_ABOVE_KOBO` default ₦500,000, **skipped for wholesale**. |
| `staffCommands.js` | — | Staff replying by WhatsApp. |
| `staffAlert.js` | — | Paging staff. |
| `requestService.js` | — | Product requests when something is not stocked. |
| `orderMessages.js` | — | Customer-facing order copy. |

**High risk to modify.** `orderService.js` — 1,028 lines touching money, stock and customer promises. Its stock-commit path uses a conditional UPDATE for race safety; a refactor that loses that condition oversells silently. `orderLimits.js` is small and pure but its behaviour has been reversed twice by product decisions, and its test file documents the exact real conversation each rule exists for — **read `tests/orderLimits.test.js` before changing anything here.**

### 8.6 `services/ingestion/` + `services/catalogue/` — the catalogue pipeline (21 files, ~9,000 lines)

**What it does.** Takes an arbitrary pharmacy spreadsheet and turns it into `products` rows, with mapping memory so the second upload needs less human input than the first.

**Depended on by.** `routes/catalogue.js`, `services/sync/ingestCatalogue.js`, `routes/emailInbound.js`.

**Depends on.** `services/db.js`, `xlsx`, the NAFDAC dataset CSV, the LLM (for `llmMapper`).

**Entry files.** `catalogue/catalogueImport.js` (the two-step import), `catalogue/catalogueMapping.js` (adapter over the ported stack).

Ported from a previous project — see `PORTING.md`. Pipeline order:

```
file → schemaDetector → columnMapper (+ columnAlias / column_mapping memory)
     → llmMapper (fallback)  → sheetJoiner → dataCleaner → productParser
     → productNormalizer → productIdentityResolver → drugClassifier
     → nafdacLookup → dataQuality → validator → productBuilder → products
```

| File | Lines |
|---|---:|
| `schemaDetector.js` | 1,544 |
| `llmMapper.js` | 891 |
| `nafdacLookup.js` | 864 |
| `dataQuality.js` | 860 |
| `dictionary.js` | 824 |
| `productNormalizer.js` | 800 |
| `dataCleaner.js` | 763 |
| `productIdentityResolver.js` | 518 |
| `datasetClassifier.js` | 508 |
| `catalogueImport.js` | 416 |

**High risk to modify.** `productIdentityResolver.js` + `productNormalizer.js` — they produce `natural_key`, which is the upsert identity. Change how it is derived and the next upload creates duplicate products for every row instead of updating them. That is a data-corruption failure, not a cosmetic one, and it is not obvious in a diff.

### 8.7 `services/customers/` — CRM (8 files)

**What it does.** Customer identity, the activity timeline, notes and tags, and the reachability picture.

**Depended on by.** `routes/customers.js`, `routes/conversations.js`, `worker.js`, `orderService.js`, the clinical stack.

**Depends on.** `services/db.js`.

**Entry files.** `customerIdentity.js`, `customerEvents.js`, `customerProfile.js`.

| File | Role |
|---|---|
| `patientEventTypes.js` | **Fan-in 20 — the most-required non-infrastructure module in the repo.** The event vocabulary, one file, one source of truth. |
| `customerEvents.js` | The **single write path** onto a customer's timeline. |
| `customerIdentity.js` | Who is this, and have we met them before? |
| `customerName.js` | Cleaning and splitting names — and proving the customer actually *said* the name being stored. |
| `customerProfile.js` | Customer 360. |
| `customerTimeline.js` | Read side — one indexed query, cursor-paginated. |
| `customerActivity.js` | Read-time only. Never writes `customers.status`. |
| `customerCrm.js` | Staff notes and tags. |

**High risk to modify.** `patientEventTypes.js` — 20 modules depend on this vocabulary; adding or renaming an event type has repo-wide reach. `customerEvents.js` — being the single write path is the whole guarantee; a second write path elsewhere silently breaks timeline completeness.

### 8.8 `services/sync/` — unattended catalogue delivery (2 files)

**What it does.** Accepts a catalogue from a machine rather than a person, and decides whether it may import without a human looking.

**Depended on by.** `routes/sync.js`, `routes/emailInbound.js`.

**Entry files.** `syncDevices.js` (pairing, auth, the auto-import rule), `ingestCatalogue.js` (shared by both unattended paths).

**High risk to modify.** `syncDevices.js` — it holds the rule that decides whether a file imports *without human review*. A price list pushed straight into a live catalogue changes what real customers are quoted. This is one of the few places in the app where a wrong answer costs money directly.

### 8.9 `client/src/` — dashboard (37 files)

**What it does.** The pharmacy-facing SPA. React 18 + Vite 5 + Tailwind v4, against `design.md` as a locked design system.

**Entry files.** `main.jsx` → `AuthGate.jsx` → `App.jsx`.

| File | Lines | Role |
|---|---:|---|
| `UploadCatalogue.jsx` | 815 | The mapping-confirmation UI — the most complex screen. |
| `App.jsx` | 677 | Shell, rail, tab state, badge polling. |
| `AiPerformance.jsx` | 558 | — |
| `CatalogueSync.jsx` | 551 | Connector + email-inbox management. |
| `Consultations.jsx` | 440 | Clinical queue. |
| `Overview.jsx` | 420 | — |
| `Inbox.jsx` | 404 | Staff conversation view. |
| `ConnectWhatsApp.jsx` | 390 | Pairing flow, consumes the SSE stream. |
| `auth.js` | 112 | `installAuthFetch()` — patches `window.fetch` to attach the bearer token. |

**High risk to modify.** `auth.js` — every request in the app depends on the fetch patch; a change here fails as "everything 401s". `AuthGate.jsx` — a wrong branch locks users out of their own dashboard, and the recovery path runs through the same service. `App.jsx` polling intervals — the dashboard's poll load already exhausted the Supabase pooler once (§14.7).

### 8.10 `agent/` — POS connector

**What it does.** Runs on the one pharmacy PC that holds the POS data; finds today's export (newest matching file, since POS software names exports however it likes) or reads MySQL directly, and uploads.

**Depends on.** Nothing at runtime except `mysql2`. Talks only to `POST /api/sync/*`.

**Entry file.** `agent/index.js`.

**High risk to modify.** `agent/src/config.js` — stores the device token in ProgramData (not the user profile) because this is expected to run as a service under a system account. `agent/index.js` has the highest churn in recent history (7 changes in 40 commits) and ships as a signed-nothing .exe that cannot be hot-fixed remotely.

### 8.11 `desktop/` — Electron shell

**What it does.** Wraps `app.rxnaija.com` so it does not feel like a browser in a box: hidden window until loaded (splash in front of the gap), local error page instead of Chrome's dinosaur, external links opened in the real browser, taskbar badge.

**High risk to modify.** `desktop/main.js` — it loads **remote code**, so the browser protections have to be put back deliberately: `nodeIntegration` off, `contextIsolation` on, navigation locked to `APP_ORIGIN`. Loosening any of those turns a redirect into arbitrary code in a window that looks like the application.

---

## 9. Shared utilities

| File | Fan-in | What it is |
|---|---:|---|
| `services/db.js` | **82** | The pool + `assertPharmacyId` + `readWithRetry` + `warmPool` + `startKeepAlive`. Everything touches it. |
| `services/customers/patientEventTypes.js` | 20 | Event vocabulary. |
| `services/pharmacies.js` | 15 | Tenant service — create, profile, assistant settings, opening hours, trade code. |
| `services/customers/customerEvents.js` | 15 | Timeline write path. |
| `middleware/auth.js` | 13 | Auth + tenant resolution. |
| `config/env.js` | 9 | Config. |
| `services/crypto.js` | — | AES-256-GCM envelope encryption. |
| `middleware/errorHandler.js` | — | `requestId`, `notFound`, `errorHandler`. |
| `config/conditionMappings.js` | 4 | Condition → product mappings. |

### 9.1 `services/db.js` is more interesting than it looks

It carries the measured tuning behind several production incidents, recorded in comments:

- `max`: 15 in production, 5 under the test runner (keyed off `TEST_DATABASE_URL`, because the runner forks a process per file, each with its own pool).
- `idle_timeout`: **300s in production, 20s under test — the goal inverts.** Production wants sockets held open; the runner wants them released fast. With 300s applied to tests, ten `customerProfile` tests failed together *in setup* from connection starvation while passing 10/10 alone.
- `prepare: false`: **required** on the transaction pooler. A prepared statement is session state; in transaction mode the next statement may land on a backend that has never seen it. Omitting this fails as "prepared statement does not exist" **only under concurrency**.
- `connect_timeout`: 30s, because the pooler is slow to accept (~4.8s measured) and Baileys generates Curve25519 pre-keys synchronously during pairing, blocking the event loop.
- TCP keepalive 15s, not the postgres.js default of 60s: the pooler drops connections without a FIN, so a dead socket looks open and every request handed one **hangs** instead of failing. That is worse than slow — a hang gives the caller nothing to retry on.

---

## 10. Configuration and environment

### 10.1 Required at boot (`assertRequiredEnv()` throws otherwise)

`DATABASE_URL` · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `SESSION_ENCRYPTION_KEY`

> Changing `SESSION_ENCRYPTION_KEY` **orphans every connected session** — every pharmacy has to re-pair.

### 10.2 Server

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | — |
| `PORT` | `4000` | — |
| `CORS_ORIGIN` | `true` (reflect) | — |
| `DEV_AUTH_BYPASS` | off | **Refuses to boot** in production. |
| `ALLOW_LOCAL_WHATSAPP` | off | Permission for a non-production process to open a real socket. Default off so the safe thing needs no thought. |
| `DEFAULT_COUNTRY_CODE` | `234` | Dialing code. |
| `DEFAULT_COUNTRY` | `NG` | ISO alpha-2 — **not** the same value; libphonenumber needs the country, and passing `234` fails by returning null for every local number rather than raising. |
| `DOWNLOAD_DIR` | `./downloads` | Outside `client/dist` so it survives `git reset --hard` on deploy. |
| `CHANNEL_PROVIDER` | `baileys` | — |
| `BAILEYS_PROXY_URL` | — | Datacenter IPs are a reported ban signal. **Two** agents are built from this; setting only the socket agent still leaks the host IP on every image. |
| `BAILEYS_MIN/MAX_REPLY_DELAY_MS` | 1000 / 3000 | A safety control, not a UX nicety. |
| `BAILEYS_SEND_TIMEOUT_MS` | 30000 | Baileys' `sendMessage` has no timeout; on a half-open socket it waits forever and silently stops every reply for that pharmacy. |
| `LLM_API_KEY` / `LLM_API_URL` / `LLM_MODEL` / `LLM_TIMEOUT_MS` | — / OpenAI / `gpt-4o-mini` / 20000 | — |
| `ORDER_REVIEW_ABOVE_KOBO` | 50000000 (₦500k) | Retail only; wholesale bypasses. |
| `WORKER_ENABLED` | `true` | Set false on any extra instance. |
| `WORKER_POLL_INTERVAL_MS` / `_CONCURRENCY` / `_JOB_TIMEOUT_MS` / `_SWEEP_TIMEOUT_MS` | 2000 / 2 / 120000 / 60000 | — |
| `PG_POOL_MAX` / `PG_IDLE_TIMEOUT` / `PG_CONNECT_TIMEOUT` / `PG_KEEPALIVE_MS` / `PG_WARM_CONNECTIONS` / `PG_MAX_LIFETIME` / `PG_STATEMENT_TIMEOUT_MS` | see §9.1 | — |
| `EMAIL_INBOUND_SECRET` / `EMAIL_INBOUND_DOMAIN` | — | Email ingestion. **Not yet set in production.** |
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_WEBHOOK_URL` | — | Unused while `CHANNEL_PROVIDER=baileys`. |
| `NAFDAC_DATASET_VERSION` | content hash | — |
| `TEST_DATABASE_URL` | — | **See §14.1.** |

### 10.3 Client (build-time, `VITE_` prefix — these ship to the browser)

`VITE_SUPABASE_URL` · `VITE_SUPABASE_ANON_KEY`

### 10.4 Agent / desktop

`RXNAIJA_API` · `RXNAIJA_SYNC_HOME` · `RXNAIJA_DEBUG` · `RXNAIJA_URL`

### 10.5 Not in the product (exploration harnesses only)

`AZURE_SPEECH_KEY` · `AZURE_SPEECH_REGION` · `AZURE_STT_LANGUAGE` · `AZURE_TTS_VOICES` · `DEEPGRAM_API_KEY` · `DEEPGRAM_MODEL` · `INTRON_API_KEY` · `INTRON_STT_URL` · `INTRON_LANGUAGE` · `OPENAI_API_KEY` · `OPENAI_STT_MODEL`

### 10.6 Secret hygiene

`.gitignore` covers `.env`, `.env.*` (except `.env.example`), `server/.env`, `env.production*`, `*.env.production`, `*.log`, `logs/`, `/downloads/`, `server/*.pdf`, `/desktop/dist/`. **Verified: no `.env` file is tracked by git, and no secrets, logs, PDFs or build artifacts appear in `git ls-files`.**

---

## 11. Test suites

**81 test files, 15,228 lines**, via `node --test`. `npm test` runs `eslint . && node --test "server/tests/*.test.js"` — **lint first, deliberately**: a `ReferenceError` in a branch no test walks is invisible to the suite but fatal in production, which is exactly how a deleted variable (`shelfHasMore`) survived into `orderService.js`.

### 11.1 Lint

`eslint.config.js` (root, flat config, CommonJS). Ignores `client/ agent/ desktop/ downloads/ db/` — the client has its own config.

- `no-undef: 'error'` is the load-bearing rule.
- `no-useless-escape: 'off'` (116 false positives).
- `no-irregular-whitespace` with `skipComments`/`skipRegExps` true but `skipStrings`/`skipTemplates` **false** — the exemption is narrowed to where deliberate zero-width characters actually live (the anti-evasion regex in `clinicalFilter.js`), because an *accidental* invisible character hides in string literals, and has bitten this codebase before.

**Current state, verified by running it: 0 errors, 44 warnings** (all `no-unused-vars` in tests and helpers).

### 11.2 Two classes of test

| Class | Behaviour |
|---|---|
| **Pure / unit** | Run anywhere. `selectTenant`, `orderLimits`, `clinicalFilter`, `burstPolicy`, `disconnectPolicy`, `safetyGate`, `conditionEngine`, `messageFormat`, `jidPolicy`, `senderIdentity`… |
| **Database-backed** | ~20 files. **Skip** rather than fail when `TEST_DATABASE_URL` is unset — so a green run that skipped the isolation gate must not be mistaken for a passing isolation gate. |

`isolation.test.js` is the tenant-isolation gate: two real pharmacies, two users, asserting nothing scoped to one ever returns the other's rows. It proves the *actual queries*, where the unit tests prove the guard.

### 11.3 Modules with no dedicated same-name test file

Some are covered indirectly (`worker.js` via `isStaffNumber`, `outboundBypass`, `isLiveMessage`, `pharmacistIdleTakeback`; `sessionManager.js` via `sessionManagerEvents`, `quotedMessageId`, `needsNewSocket`, `onWhatsAppCheck`; `catalogueTools.js` via `orderHistoryTool`, `crmBoundary`, `pharmacyContactPhone`). Others have no coverage at all:

**Largest uncovered surface:** the entire `services/ingestion/` stack — `schemaDetector` (1,544), `llmMapper` (891), `dataQuality` (860), `dictionary` (824), `productNormalizer` (800), `dataCleaner` (763), `productIdentityResolver` (518), `datasetClassifier` (508), `productParser`, `sheetJoiner`, `validator`, `columnMapper`, `columnAlias`, `drugClassifier`. **That is roughly 9,000 lines of ported code with no direct tests**, and it is the code that decides what `natural_key` a product gets (§8.6).

Also uncovered: `assistant.js`, `catalogueTools.js`, `clinicalWorkflow.js`, `clinicalFactService.js`, `recommendationService.js`, `protocolExecutionService.js`, `evidenceService.js`, `syncDevices.js`, `ingestCatalogue.js`, `outboundMessage.js`, `inboundIngest.js`, `pharmacies.js`, `llmClient.js`, `requestService.js`, `staffAlert.js`, `tradeCode.js`.

### 11.4 No CI

There is no `.github/` directory and no CI configuration anywhere in the repo. Lint and tests run only when someone remembers.

---

## 12. Critical dependency chains

Chains where a change at one end reaches much further than it looks.

### 12.1 `services/db.js` → everything (fan-in 82)

Pool settings, `assertPharmacyId`, `readWithRetry`. A change to pool sizing or timeouts is a change to production stability under load, and the failure mode is a *hang*, not an error. Every number in this file was set by an incident.

### 12.2 `patientEventTypes.js` → 20 modules

The event vocabulary. Renaming a constant is a repo-wide change; adding one without a matching timeline renderer produces events nobody can see.

### 12.3 `sessionManager` → `inboundIngest` → `jobs` → `worker` → `assistant` → `outboundMessage`

The message path. Every link is a place a customer can be silently dropped. Only `outboundMessage` writes both the row and the timeline event, so a send introduced anywhere else is invisible to the CRM.

### 12.4 `clinicalFilter` → `assistant` → `replyValidator`

The safety chain. Ordering is the guarantee, not the presence of the parts.

### 12.5 `productNormalizer` + `productIdentityResolver` → `natural_key` → `products` unique constraint

The upsert identity. Change it and the next catalogue upload duplicates every product instead of updating it. **No direct test coverage.**

### 12.6 `orderLimits.checkLine` → `orderService.createOrder` **and** `orderService.changeOrderItem`

Called from two places. `checkLine`'s `wholesale` flag defaults to `false` **deliberately** — a caller that forgot to pass it silently exempting every retail customer from the value ceiling is a failure that looks like nothing at all. There is a test asserting exactly that (`the exemption is opt-in, not the default`).

### 12.7 `conversationService` → `conversations.workflow_state`

The single write path for workflow state, enforcing the `conversationState.js` transition matrix. A direct `update conversations set workflow_state = ...` anywhere else bypasses the state machine.

### 12.8 `SESSION_ENCRYPTION_KEY` → `crypto.js` → `authStore` → every live session

Rotating the key orphans every pharmacy's WhatsApp connection. There is no re-encryption path.

---

## 13. High-risk file register

Ranked by blast radius × likelihood of a subtle change.

| Rank | File | Lines | Why |
|---:|---|---:|---|
| 1 | `services/whatsapp/sessionManager.js` | 1,093 | Whole product offline if wrong; failures are silent; built on an unofficial RC library. |
| 2 | `services/worker.js` | 1,864 | `processInbound` alone is **~960 lines in one function** (508–1469). Every inbound message goes through it. |
| 3 | `services/safety/clinicalFilter.js` | 316 | Highest consequence per line in the repo. Both directions of error are serious. |
| 4 | `services/orders/orderService.js` | 1,028 | Money, stock, and promises to customers. Race-safe conditional UPDATE is easy to lose in a refactor. |
| 5 | `services/ai/catalogueTools.js` | 1,027 | The entire factual surface of the assistant. No dedicated test file. |
| 6 | `services/db.js` | 354 | Fan-in 82; every constant is an incident postmortem; failures manifest as hangs. |
| 7 | `middleware/auth.js` | 300+ | Tenant isolation. A wrong branch is a cross-tenant data leak. |
| 8 | `services/ingestion/productIdentityResolver.js` + `productNormalizer.js` | 1,318 | Produce the upsert identity. Untested. Failure is silent data duplication. |
| 9 | `services/clinical/safetyGate.js` | 550 | Deterministic gate on clinical recommendations. |
| 10 | `services/ai/assistant.js` | 499 | Step ordering is a safety guarantee. |
| 11 | `services/whatsapp/inboundIngest.js` | 333 | Persist-first is what makes a dropped message traceable. |
| 12 | `db/migrations/0001_init.sql` | — | The schema of record. RLS policies and the isolation model. |
| 13 | `client/src/auth.js` | 112 | Fetch patch; breaking it 401s the entire dashboard. |
| 14 | `desktop/main.js` | — | Loads remote code; the security settings are the only thing between a redirect and arbitrary code. |
| 15 | `services/sync/syncDevices.js` | — | Decides whether a price list imports **without a human looking**. |

---

## 14. Regression-risk observations

Findings only — **nothing here was changed.** Each notes whether it is a live hazard, a known-and-accepted trade-off, or documentation drift.

### 14.1 `TEST_DATABASE_URL` is identical to `DATABASE_URL` — the test suite writes to production

**Verified** by comparing the two values in `server/.env` (values not printed). They are byte-identical.

~20 test files write and delete rows. `isolation.test.js` creates two pharmacies, two users and their data, then cleans up. Its own header says: *"Never point `TEST_DATABASE_URL` at production. This suite writes and deletes rows."*

`.env.example` records this as a **deliberate, dated decision** — *"ONE PROJECT FOR NOW (decided 2026-08-08): set this to the same value as `DATABASE_URL` above. Split it out before the first real pharmacy is onboarded"* — with a matching note in `ARCHITECTURE.md`.

That condition has now been met: the system is deployed and serving live pharmacies. **This is why I did not run the test suite during this audit.** The suite only deletes rows it created and sweeps leftovers by an `isotest` tag, so the design is careful — but a failed run mid-cleanup, or a future test that is less careful, writes to the live database.

**Status: live hazard, and the stated precondition for fixing it has passed.**

### 14.2 `express-rate-limit` is installed and never used

`express-rate-limit@^8.6.2` is a production dependency in `package.json`. **Grep across `server/`, `client/src/`, `agent/`, `desktop/` and `scripts/` finds zero imports.**

No endpoint is rate-limited, including the four unauthenticated ones (§3.3) and the auth-verifying routes that make a Supabase network call per request. `POST /api/email/inbound` and `POST /api/sync/pair` are internet-reachable and unauthenticated at the transport level.

**Status: a security control that was intended, paid for in dependency surface, and never wired up.**

### 14.3 `README.md` and `ARCHITECTURE.md` describe a system that no longer exists

- `README.md`: *"**Status: scaffold.** The foundation, schema, and ported ingestion stack exist. **No product behaviour is implemented.**"*
- `server/index.js` header: *"SCAFFOLD STATE: routes are mounted as they are built. Only `/api/health` and the webhook stub exist today."* — while 12 routers and 71 endpoints are mounted directly below it.
- `ARCHITECTURE.md` §10 still frames Phases 3–5 as future work; they shipped.

Every *other* comment in this codebase is unusually accurate and well-maintained. That is exactly what makes these three dangerous: a reader who has learned to trust the comments will trust these too.

**Status: documentation drift, high confusion cost.**

### 14.4 Three deployment stories coexist

| Artifact | Describes |
|---|---|
| `deploy/` (Caddyfile, systemd unit, setup.sh, update.sh) | **The real one** — Truehost VPS, Ubuntu, systemd + Caddy. |
| `render.yaml` | A Render blueprint, with region reasoning for a Supabase pooler in Paris. |
| `Dockerfile` | A two-stage container build, "works anywhere". |

`render.yaml` and `Dockerfile` are not obviously marked as superseded. The `Dockerfile` header explicitly says it exists to keep the platform choice reversible, which is a legitimate reason to retain it — but nothing tells a reader which one is live.

**Status: documentation drift, moderate.**

### 14.5 `scripts/doctor.js` warns against the port the app deliberately requires

`checkPoolerMode()` warns when `DATABASE_URL` contains `:6543`:

> *"Port 6543 is the TRANSACTION pooler. It does not support prepared statements or some DDL, and migrations can fail oddly. Use the SESSION pooler or the direct connection (usually port 5432)."*

Production **is** on `:6543`, deliberately. `db.js` documents the move at length: session mode's hard 15-backend cap caused `EMAXCONNSESSION`, `ECONNRESET` and `ENOTFOUND` (which looks exactly like a DNS failure and is not one). `prepare: false` is set in both `db.js` and `migrate.js` to make transaction mode safe.

`.env.example` still carries the old advice too.

So `npm run doctor` now emits a warning telling the operator to undo a fix — and reverting it would resurrect the connection-exhaustion incidents.

**Status: stale tooling that actively misleads.**

### 14.6 Duplicate migration number `0023`

`0023_conversation_sessions.sql` and `0023_customer_lifecycle.sql`.

`migrate.js` sorts by filename, so ordering is **deterministic** (`conversation_sessions` before `customer_lifecycle`) and `schema_migrations` keys on the full filename — nothing is broken today. But the numbering contract is what tells a developer the sequence; a third `0023_*.sql` inserted alphabetically before an already-applied one would be applied *after* it with no warning.

**Status: latent, not currently broken.**

### 14.7 Dashboard polling load

Eight `setInterval` timers across the SPA:

| Screen | Interval |
|---|---|
| `App.jsx` badge poll | 30s |
| `App.jsx` consultation alarm | 15s |
| `ConnectWhatsApp.jsx` | 15s |
| `Consultations.jsx` | 20s |
| `Overview.jsx` | 20s (+120s insights) |
| `Requests.jsx` | 20s |
| `AiPerformance.jsx` | 30s |

`/api/summary` exists precisely because earlier polling exhausted the Supabase pooler, which surfaced as `ENOTFOUND`/`ECONNRESET` everywhere and looked like a network fault. The current intervals are more conservative, but **every one of these requests costs a Supabase `getUser()` round trip** (§5.1) on top of its queries, and several screens poll simultaneously when open. This scales with concurrent dashboard users, not with pharmacies.

**Status: known-and-managed, worth watching as tenant count grows.**

### 14.8 Single-instance constraint is undocumented outside code comments

Running a second production instance would open a second Baileys socket per pharmacy and knock the first offline (`connectionReplaced`, 440). `WORKER_ENABLED=false` handles the *queue* half of this; nothing handles the socket half. `deploy/update.sh` restarts in place, so this is not currently hit — but it is a hard scaling ceiling that only appears as a comment in `config/env.js`.

**Status: architectural constraint, correctly implemented, under-documented.**

### 14.9 `baileys@7.0.0-rc14` is a release candidate

Pinned exactly, which is right. But the core of the product runs on a pre-release of an unofficial, reverse-engineered client whose behaviour has changed between RCs during this project's lifetime (the LID migration, quoted-message extraction). Several unexplained production outages during development had no confirmed root cause.

**Status: accepted product risk, correctly hedged by pinning.**

### 14.10 Smaller items

- **`New folder/`** at repo root — empty, untracked. Cruft.
- **`backend.log`** (75 KB) and **`logs/`** at root — gitignored, so not in history, but present in the working tree.
- **`react-router-dom`** is a client dependency; `App.jsx` implements navigation with `useState` + `history.replaceState` instead. Either unused, or used somewhere narrow enough not to justify it.
- **`server/scratch/state-of-the-product.html`** is committed under `server/`.
- **`agent/dist/`** contains `rxnaija-sync.exe` and build intermediates. `/downloads/` is gitignored but `agent/dist/` does not appear to be.
- **44 eslint warnings**, all `no-unused-vars` in tests and helpers. Zero errors.
- **Neither `RxNaija-Setup.exe` nor `rxnaija-sync.exe` is present in `downloads/`** — `/download/:file` returns its 503 "not been uploaded to this server yet" message for anything the `download.html` page links to. The route handles this deliberately and says so plainly rather than 404ing into the SPA.

---

## Appendix — where to start reading

If you are new to this codebase, in this order:

1. `README.md` §Non-negotiables — but ignore its "Status: scaffold" line (§14.3).
2. `db/migrations/0001_init.sql` — the isolation model and money rules, extensively commented.
3. `middleware/auth.js` — `selectTenant()` and the one rule.
4. `services/db.js` — why every constant is what it is.
5. `services/worker.js` lines 1–140 — the inbound pipeline's intent.
6. `services/ai/assistant.js` lines 1–30 — the four steps and why the order is fixed.
7. `services/safety/clinicalFilter.js` + `tests/clinicalFilter.test.js` — the corpus **is** the specification.
8. `services/orders/orderLimits.js` + `tests/orderLimits.test.js` — every rule names the real conversation that produced it.

The comments in this repo are unusually good and carry measured numbers, dates and incident history. Read them before changing the code they sit above — with the three exceptions in §14.3.
