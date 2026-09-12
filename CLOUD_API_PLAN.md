# WhatsApp Cloud API — an alternative channel beside Baileys

**Status:** SUPERSEDED (2026-09-11). Not built, and not the direction.
The owner narrowed the scope to a minimal Meta App Review harness
(`server/services/whatsapp/metaCloudReview.js`, Settings → WhatsApp → Meta
App Review Test), with production WhatsApp to go through **Twilio** later.
The `channel.js` seam from Phase A below was written and then reverted
unshipped. Kept only as a record of the audit in §1, which is still accurate.
**Goal:** a working Meta Cloud API path, good enough to record the two App
Review videos (`whatsapp_business_messaging`, `whatsapp_business_management`),
with Baileys switched off but fully intact and one env var away from coming
back.

---

## 1. What already exists (audit)

The Cloud API was the original design, and more of it survived the move to
Baileys than the code's current behaviour suggests. That keeps this plan small.

| Already there | Where | What it gives us |
|---|---|---|
| A provider switch | `server/config/env.js:137` — `CHANNEL_PROVIDER`, default `baileys` | The on/off switch. No new flag needed. |
| An adapter contract | `server/services/whatsapp/channelProvider.js` | `verifyWebhook / parseInbound / parseStatus / sendText`, `SendError{retryable}`, `DELIVERY_STATUS`. **Nothing registers an adapter today.** |
| `meta_cloud` as a provider value | `db/migrations/0002_baileys_sessions.sql:28` | `check (provider in ('baileys','twilio','meta_cloud'))` |
| Cloud API account columns | `db/migrations/0001_init.sql:85` | `whatsapp_accounts.waba_id`, `phone_number_id`, `display_phone_number` (unique), `status`, `credentials_ref` |
| Meta business id | `db/migrations/0047_twilio_obo.sql` | `whatsapp_accounts.meta_business_id` |
| One account per pharmacy per provider | `0046` unique index `(pharmacy_id, provider)` | A pharmacy can hold a `baileys` row **and** a `meta_cloud` row at once. Switching back and forth loses nothing. |
| Template table | `0047` `whatsapp_templates` (`provider` includes `meta_cloud`, statuses include `paused/disabled`) | Management video's template screen writes here. |
| Canonical template wording | `server/services/whatsapp/templates.js` | What we submit to Meta. |
| A provider-neutral ingest | `server/services/whatsapp/inboundIngest.js:39` `ingest(msg)` | Takes a normalised payload. A webhook can produce the same shape. |
| JSON parsed for `/api` only | `server/index.js:100` | The webhook router can read the **raw body** it needs for signature checks. |
| SPA fallback already excludes `/webhooks/` | `server/index.js:432` | A webhook route won't be swallowed by the dashboard. |

**The one real coupling:** every outbound message goes straight to Baileys.
`sessionManager.sendText(accountId, jid, text, opts)` is called from **~20
sites**: `worker.js` ×8, `outboundMessage.js` ×4, `staffAlert.js` ×2,
`routes/orders.js`, `routes/whatsapp.js`. `startTyping` is called from
`worker.js` ×2. That is the seam this plan cuts.

---

## 2. Design

### 2.1 Deactivating Baileys — without deleting anything

- `CHANNEL_PROVIDER=meta_cloud` in `.env.production`.
- `server/index.js:596`: `sessionManager.start()` runs **only** when the
  provider is `baileys`. No sockets open, no session restore, no QR/pairing.
- The Baileys pairing endpoints (`/api/whatsapp/connect`, pairing code) answer
  `409 "WhatsApp is connected through Meta on this server"` in cloud mode,
  rather than half-starting a socket.
- **Nothing is removed.** `sessionManager.js`, `authStore.js`, encrypted
  sessions in Postgres and `baileys` rows in `whatsapp_accounts` all stay put.
  **Rollback = set `CHANNEL_PROVIDER=baileys` and restart.** Pharmacies
  reconnect from their stored sessions, the same as after any deploy.

### 2.2 One outbound seam: `channel.js`

New `server/services/whatsapp/channel.js` exports the three functions the app
actually uses, **with the exact same signatures** as today:

```js
sendText(accountId, jid, text, opts)   // → provider's sendText
startTyping(accountId, jid)            // → returns a stop() function
getStatus(pharmacyId)                  // → connection state for the dashboard
```

It dispatches on `env.channel.provider`. The ~20 call sites change one import
line each and nothing else. Mechanical, reviewable, and it makes the next
provider a one-file change, which is what `channelProvider.js` promised.

*Rejected: making the Cloud adapter impersonate `sessionManager` (swapping the
export at boot).* Fewer lines, but every reader of `worker.js` would believe
they were looking at Baileys. A seam you can see beats a clever one.

`formatForWhatsApp()` moves from inside `sessionManager.sendText` into
`channel.sendText`, so both providers format identically. Its own header says
it must sit at the one place every message passes through; after this change,
that place is `channel.js`.

### 2.3 The Cloud adapter

New `server/services/whatsapp/providers/metaCloud.js`, registered through the
existing `registerProvider()`:

| Contract method | Cloud API behaviour |
|---|---|
| `verifyWebhook(req)` | HMAC-SHA256 of the **raw body** with `META_APP_SECRET`, timing-safe compare against `X-Hub-Signature-256`. Reject otherwise. |
| `parseInbound(req)` | `entry[].changes[].value.messages[]` → normalised message. Returns `null` for status-only payloads. |
| `parseStatus(req)` | `value.statuses[]` → `sent / delivered / read / failed` mapped onto `DELIVERY_STATUS`. |
| `sendText({ from, to, body })` | `POST https://graph.facebook.com/{v}/{phone_number_id}/messages` with `messaging_product: 'whatsapp'`, `type: 'text'`. |
| `sendTemplate(...)` *(new, cloud-only)* | Same endpoint, `type: 'template'`, for sends outside the 24-hour window. |

**Error mapping**, so the existing job runner retries only what it should:
HTTP 429/5xx → `retryable: true`. Meta's "outside the 24-hour window" error,
and invalid or unregistered recipients → `retryable: false`, with a message a
pharmacist can act on.

**Typing:** `startTyping` returns a no-op in cloud mode. The Baileys
human-latency delay (`BAILEYS_MIN/MAX_REPLY_DELAY_MS`) does not apply, because
it exists to avoid a ban signal that doesn't exist on the official API.

**`verifyNumber`:** Cloud has no `onWhatsApp` lookup. It returns `null`
("could not check"). `sessionManager.sendText` already treats `null` as
*send anyway* on purpose (`sessionManager.js:~690`), so behaviour stays safe.

### 2.4 Inbound: the webhook

New `server/routes/webhooksMeta.js`, mounted at `/webhooks/meta`, with a raw
body parser:

- `GET` — Meta's verification handshake: echo `hub.challenge` only when
  `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`.
- `POST` — verify the signature, then **answer 200 immediately** and process
  after. Meta retries slow or failed deliveries, and a slow answer earns a
  duplicate.
- **Tenant resolution:** `value.metadata.phone_number_id` → `whatsapp_accounts`
  row with `provider = 'meta_cloud'` → `pharmacy_id`, `account_id`. No row
  means drop and log. Never guess a tenant.
- **Normalise into `ingest()`'s existing shape:**
  `providerMessageId = message.id`, `phoneNumber = wa_id`,
  `replyJid = \`${wa_id}@s.whatsapp.net\``, `displayName = contacts[0].profile.name`.
  The jid form is deliberate. `wa_jid` is the customer identity key
  (migration 0016) and NOT NULL, so Cloud customers get the **same key shape
  Baileys produced**. A customer seen under both providers stays one person.
- **One change to `inboundIngest.js`:** the `inbound_events` insert hardcodes
  `'baileys'` as the provider. It takes it from `msg.provider` instead (default
  `'baileys'`, so the Baileys path is unchanged). The existing unique
  constraint on `(provider, provider_message_id)` then dedupes Meta's retries
  with no new code.
- **Statuses** update the outbound message's delivery state through the
  existing `DELIVERY_STATUS` vocabulary.

**The scope gate still runs, and mostly passes through.** On Baileys it
exists to keep the owner's *private* chats out of the database. A Cloud number
is business-only, so there are no private chats. `ingest_mode`, the allowlist
and the block list keep working unchanged.

### 2.5 Management: connecting a number, and templates

**Recommended onboarding: Embedded Signup (Tech Provider).** Each pharmacy
connects its own number. The management video needs this flow anyway, and it
is the real product, not a demo.

1. **Dashboard, Setup → WhatsApp** (cloud mode): a *Connect with Meta* button
   loads Meta's JS SDK and calls `FB.login` with
   `config_id = META_EMBEDDED_SIGNUP_CONFIG_ID`. The owner walks through Meta's
   own popup: pick or create the business, the WABA and the number.
2. The popup returns an **auth code** plus a `sessionInfo` message carrying
   `waba_id` and `phone_number_id`. The client POSTs these to
   `POST /api/whatsapp/cloud/onboard`.
3. The server, in order:
   exchange the code (proves the grant is real) →
   `POST /{waba_id}/subscribed_apps` (webhooks start flowing) →
   `POST /{phone_number_id}/register` with a PIN (the number goes live) →
   `GET /{phone_number_id}` (display number, verified name, quality rating) →
   upsert the `whatsapp_accounts` row (`provider = 'meta_cloud'`,
   `status = 'connected'`).
4. **Templates screen**, new, under Setup → WhatsApp:
   `GET /{waba_id}/message_templates` lists the templates, and
   *Submit RxNaija templates* POSTs the canonical set from `templates.js`.
   Status syncs into `whatsapp_templates`; paused and disabled are shown, not
   hidden.

**Tokens: one system-user token from env for now, not per-pharmacy tokens.**
Once a pharmacy's WABA is shared with RxNaija's business through Embedded
Signup, the Tech Provider's system-user token can act on it. So nothing
secret gets written to the database at all, and `credentials_ref` stays what
its column comment demands: a pointer, never a credential.

*Rejected for now: storing each pharmacy's exchanged business token,
encrypted with `SESSION_ENCRYPTION_KEY` in a new table.* It's more
isolation per tenant, but it adds a table, a rotation story and a new leak
surface, all before a single customer exists on this path. Revisit when
there are real Cloud tenants.

### 2.6 New environment variables (all server-only)

```
CHANNEL_PROVIDER=meta_cloud
META_APP_ID=
META_APP_SECRET=                  # webhook signatures + code exchange
META_SYSTEM_USER_TOKEN=           # Graph API calls
META_WEBHOOK_VERIFY_TOKEN=        # any long random string, also typed into Meta's dashboard
META_EMBEDDED_SIGNUP_CONFIG_ID=   # from Meta → Facebook Login for Business → Configurations
META_GRAPH_VERSION=v21.0          # pinned; Meta retires versions on a schedule
```

`isChannelConfigured()` (`env.js:186`) gains a `meta_cloud` branch requiring
the app secret, the system-user token and the verify token. The boot log's
`channel:` line then reports the truth.

### 2.7 Dashboard CSP

Embedded Signup needs `https://connect.facebook.net` in `script-src` and
`https://www.facebook.com` in `frame-src` **on the dashboard only**. Published
pharmacy sites keep `script-src 'none'`. The two CSPs are separate today
(`publicSite.js` is its own), and they stay separate.

---

## 3. What cloud mode does NOT do (said up front)

- **Sends outside the 24-hour window need an approved template.** Order-ready
  alerts the next morning, hold-expiry messages and staff alerts to
  `notify_phone` will **fail** until templates are approved. The failure is
  loud (non-retryable, visible in the dashboard), never silent. Wiring each
  proactive send to its template is a follow-up phase. It isn't needed for
  the videos.
- **No typing indicator** in this phase.
- **Media** (images and documents in and out) is not in this phase. Inbound
  media is stored as `hasMedia: true` with no download, same as today's
  fallback.
- **Meta's test number** only messages up to 5 verified recipients. That's
  fine for recording, and it doesn't limit a real connected number.

---

## 4. Phases

Each phase ends green on `scripts/check-baseline.js`, and each is its own
commit.

| # | Phase | Behaviour change | Unlocks |
|---|---|---|---|
| **A** | `channel.js` seam; call sites repointed; `formatForWhatsApp` moved | **None**, since Baileys stays the provider. Proven by the existing suite passing untouched. | Everything below |
| **B** | Cloud adapter + `/webhooks/meta` + provider-aware ingest + `CHANNEL_PROVIDER` gating the Baileys boot | Only when `CHANNEL_PROVIDER=meta_cloud` | **Messaging video**, recorded with Meta's test number |
| **C** | Embedded Signup + onboard endpoint + templates screen + dashboard CSP | Cloud mode only | **Management video** |
| **D** | Recording checklist in the repo (`docs/app-review-videos.md`): exact scripts, test data, what's on screen | — | Submission |

**Tests.** Signature verification (valid, tampered, missing header). The
`GET` handshake (right token, wrong token). Webhook normalisation from
recorded sample payloads, including a status-only payload returning `null`.
Tenant resolution (known id, unknown id → dropped). Error mapping (429 →
retryable; window error → not). Ingest dedupe across a Meta retry. And one
test that fails if Baileys boots when the provider is `meta_cloud`. Graph
calls are stubbed. No test touches Meta.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Signature check silently fails because the body was parsed first | Raw-body parser on `/webhooks/meta` only, plus a test that feeds the exact bytes. |
| A wrong tenant on inbound | Resolved from `phone_number_id` against our own table, and never from anything in the message body. No row means no ingest. |
| Switching providers strands customers | Same `wa_jid` key shape under both providers, and a pharmacy may hold both account rows (unique on `(pharmacy_id, provider)`). |
| Graph API version retirement | Pinned in env, one place to bump. |
| Proactive sends failing in cloud mode | Loud non-retryable `SendError`, surfaced in the dashboard. §3 names it. |
| `META_APP_SECRET` / system-user token leaking | Server-only env, never `VITE_*`, never logged, never written to the DB. |

---

## 6. Decisions needed before Phase A

1. **Onboarding: Embedded Signup per pharmacy (recommended)**, or one
   RxNaija-owned number for now? The management video essentially requires
   Embedded Signup, so the other option means a second, weaker video later.
2. **System-user token from env (recommended)**, or per-pharmacy encrypted
   tokens now?
3. **Is Meta business verification done**, and does the app have the WhatsApp
   product added? Phase B can run on the test number without verification.
   Phase C's Embedded Signup needs a Facebook Login for Business
   configuration, which needs the app set up as a Tech Provider.
