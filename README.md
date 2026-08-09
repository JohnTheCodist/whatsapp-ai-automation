# WhatsApp AI Automation

WhatsApp AI customer-service and sales automation for independent pharmacies. Multi-tenant SaaS.

A pharmacy connects its WhatsApp number, uploads its catalogue, and an assistant starts answering customer enquiries about price, availability, location and hours — from that pharmacy's real data — and hands off to a human the moment a question becomes clinical.

**Status: scaffold.** The foundation, schema, and ported ingestion stack exist. No product behaviour is implemented. Read [ARCHITECTURE.md](ARCHITECTURE.md) before writing code — it contains the design decisions, the open questions, and the parts of the brief that were pushed back on.

## Non-negotiables

These are structural, not stylistic. Changing one is an architecture decision, not a refactor.

1. **The database is the source of truth.** The assistant never states a price, stock level, or product it did not receive from a tenant-scoped tool call.
2. **Tenant isolation lives in the query layer.** `pharmacy_id` on every row, server-resolved from a verified session, never client-supplied. `assertPharmacyId()` at the top of every tenant query path.
3. **Safety routing is deterministic and runs before the model.** Clinical questions reach a human without the LLM generating anything. A model cannot be trusted to judge the input that would compromise its judgement.
4. **Every failure path ends at a human, never at a guess.**
5. **Providers sit behind adapters.** Nothing above `channelProvider.js` knows Twilio exists.

## Layout

```
db/migrations/          Forward-only SQL. 0001_init.sql is the schema of record.
scripts/migrate.js      Migration runner.
server/
  config/env.js         Env loading. Fails fast at boot.
  middleware/           Auth + tenant resolution, error handling.
  services/
    db.js               Postgres pool + assertPharmacyId tenant guard.
    ingestion/          Catalogue pipeline, ported. See PORTING.md.
    whatsapp/           Channel provider boundary.
    ai/                 Assistant orchestration. (empty — Phase 4)
  data/                 Bundled reference datasets.
client/                 React + Vite dashboard.
```

## Running it

```bash
npm install
```

```bash
cp server/.env.example server/.env
```

Fill in `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`, then:

```bash
npm run migrate
```

```bash
npm start
```

The client runs separately and proxies `/api` to port 4000:

```bash
npm --prefix client install && npm --prefix client run dev
```

Check it came up:

```bash
curl http://localhost:4000/api/health
```

## Tests

Unit tests need no database and cover the two things that must never be wrong — the tenant guard and tenant selection:

```bash
npm test
```

The **tenant isolation suite skips** without a database, and a skip is not a pass. Before trusting the isolation gate, point it at a Postgres instance with `db/migrations` applied:

```bash
TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname npm test
```

Never point `TEST_DATABASE_URL` at production — the suite writes and deletes rows.

## API — Phase 1

| Method | Route | Auth |
|---|---|---|
| `GET` | `/api/health` | none |
| `POST` | `/api/pharmacies` | session only (no tenant yet — this creates it) |
| `GET` | `/api/pharmacies/me` | session + membership |
| `PATCH` | `/api/pharmacies/me` | owner |
| `GET` | `/api/pharmacies/me/profile` | session + membership |
| `PATCH` | `/api/pharmacies/me/profile` | owner, pharmacist |
| `GET` | `/api/pharmacies/me/members` | session + membership |

Routes say `me`, never `:id`. There is no tenant id in any path, so there is none to be tempted into trusting.

## Ported code

`server/services/ingestion/` comes from the RxNaija Analytics codebase, where it ingested sales exports. This product ingests catalogues — a different problem. [PORTING.md](PORTING.md) lists which files are drop-in, which need adaptation, and which were deliberately left behind.

Nothing in that directory is wired to a route yet.

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. Server-side only. Never ship it to the browser.
- Row-level security is enabled on every tenant table as a **second** layer. The API connects with service role and bypasses it — explicit `where pharmacy_id = ...` filtering is the primary defence, and it is your job.
- Webhook signature verification needs the **raw** request body. `express.json` is mounted on `/api` only, deliberately.
- Provider credentials are referenced by `whatsapp_accounts.credentials_ref`, not stored in the table.
