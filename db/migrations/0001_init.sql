-- WhatsApp AI Automation — multi-tenant Postgres schema
--
-- ISOLATION MODEL
-- Every tenant-owned row carries pharmacy_id. Two independent layers
-- enforce it, and you must not rely on either one alone:
--
--   1. Application layer (primary). The API connects with the service_role
--      key, which BYPASSES RLS. Every query is therefore responsible for
--      its own explicit `where pharmacy_id = $1`, resolved server-side from
--      a verified session — never from a client-supplied body or header.
--      services/db.js#assertPharmacyId exists to make forgetting it loud.
--
--   2. Row-Level Security (defense-in-depth). Catches anything that ever
--      reaches Postgres through the anon key (PostgREST, a future direct
--      client read) and limits blast radius if layer 1 is bypassed.
--
-- MONEY
-- All amounts are integer kobo (1 naira = 100 kobo). No floats anywhere in
-- the money path — 0.1 + 0.2 problems in a price quoted to a customer over
-- WhatsApp are not acceptable, and Postgres numeric round-trips through
-- JS get coerced to float by most drivers anyway.

create extension if not exists "pgcrypto";

-- =====================================================================
-- IDENTITY & TENANCY
-- =====================================================================

-- The tenant. One row per pharmacy business.
create table pharmacies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  -- Gates whether the assistant answers at all. 'onboarding' pharmacies
  -- have a tenant + maybe a catalogue but must not receive live traffic.
  status       text not null default 'onboarding'
               check (status in ('onboarding', 'active', 'suspended', 'closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table pharmacy_members (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'pharmacist', 'staff')),
  created_at   timestamptz not null default now(),
  unique (pharmacy_id, user_id)
);

create index idx_pharmacy_members_user on pharmacy_members(user_id);

-- Everything the assistant needs to answer "where are you / are you open /
-- do you deliver" without inventing anything. Separate from `pharmacies`
-- because this is assistant-facing content that changes often, while the
-- tenant row is identity that almost never changes.
create table pharmacy_profile (
  pharmacy_id     uuid primary key references pharmacies(id) on delete cascade,
  address_line    text,
  city            text,
  state           text,
  landmark        text,
  phone           text,
  -- [{day:'mon', open:'08:00', close:'20:00', closed:false}, ...]
  opening_hours   jsonb not null default '[]'::jsonb,
  delivers        boolean not null default false,
  delivery_note   text,
  -- Free-text the owner controls, injected verbatim into the assistant's
  -- context. NOT a prompt the owner writes — see AI architecture; owners
  -- supply facts, Sterling owns the instructions.
  extra_info      text,
  updated_at      timestamptz not null default now()
);

-- =====================================================================
-- WHATSAPP CHANNEL
-- =====================================================================

-- One connected WhatsApp sender per pharmacy (MVP: exactly one).
--
-- No access tokens or API secrets are stored here. `credentials_ref` is a
-- pointer into the secret store (env-scoped key or vault path). Putting a
-- long-lived Meta token in an application table means one SQL injection or
-- one careless backup dump hands over every tenant's WhatsApp account.
create table whatsapp_accounts (
  id                    uuid primary key default gen_random_uuid(),
  pharmacy_id           uuid not null references pharmacies(id) on delete cascade,
  provider              text not null default 'twilio' check (provider in ('twilio', 'meta_cloud')),
  -- The E.164 number customers message. This is the tenant routing key on
  -- every inbound webhook, so it must be globally unique across tenants.
  display_phone_number  text not null unique,
  -- Provider-side identifiers. Nullable because which ones exist depends on
  -- the provider and how far through Embedded Signup the pharmacy got.
  waba_id               text,
  phone_number_id       text,
  provider_sid          text,
  credentials_ref       text,
  status                text not null default 'pending'
                        check (status in ('pending', 'connecting', 'connected', 'failed', 'disconnected')),
  status_detail         text,
  connected_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_whatsapp_accounts_pharmacy on whatsapp_accounts(pharmacy_id);
create index idx_whatsapp_accounts_number on whatsapp_accounts(display_phone_number);

-- Raw inbound webhook log. Exists for exactly three reasons, all of which
-- are load-bearing in production:
--   1. IDEMPOTENCY. provider_message_id is unique — a duplicate webhook
--      delivery (which providers WILL send) is a no-op insert conflict,
--      not a second AI reply to the customer.
--   2. REPLAY. If the processor has a bug, the raw payload is still here.
--   3. FORENSICS. "The assistant said what?" is answerable.
--
-- Deliberately NOT tenant-scoped by a FK constraint: a webhook can arrive
-- for a number we cannot resolve to a pharmacy, and we must still record
-- it rather than drop it silently. pharmacy_id is filled in when routing
-- succeeds, and stays null on unroutable events.
create table inbound_events (
  id                    bigint generated always as identity primary key,
  provider              text not null,
  provider_message_id   text not null,
  pharmacy_id           uuid references pharmacies(id) on delete set null,
  to_number             text,
  from_number           text,
  payload               jsonb not null,
  status                text not null default 'received'
                        check (status in ('received', 'processing', 'processed', 'failed', 'unroutable')),
  attempts              integer not null default 0,
  last_error            text,
  received_at           timestamptz not null default now(),
  processed_at          timestamptz,
  unique (provider, provider_message_id)
);

create index idx_inbound_events_status on inbound_events(status, received_at);
create index idx_inbound_events_pharmacy on inbound_events(pharmacy_id, received_at desc);

-- =====================================================================
-- PRODUCT CATALOGUE
-- =====================================================================

-- One row per uploaded spreadsheet. Keeps the ingestion pipeline auditable:
-- what was uploaded, what mapping was applied, what was rejected and why.
create table catalogue_uploads (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  uploaded_by       uuid references auth.users(id) on delete set null,
  filename          text not null,
  -- Detects a re-upload of a file we have already processed.
  content_hash      text,
  status            text not null default 'uploaded'
                    check (status in ('uploaded', 'mapping', 'awaiting_confirmation', 'importing', 'completed', 'failed')),
  -- Output of the ported column-mapping stack: rawHeader -> canonical field.
  detected_mapping  jsonb,
  rows_total        integer not null default 0,
  rows_imported     integer not null default 0,
  rows_rejected     integer not null default 0,
  -- [{row, column, value, reason}] — shown back to the owner, never guessed at.
  issues            jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index idx_catalogue_uploads_pharmacy on catalogue_uploads(pharmacy_id, created_at desc);

-- The catalogue. THE source of truth for what the assistant may say about
-- price and availability.
--
-- MVP holds price and stock on the product row rather than in separate
-- price/inventory tables. Reason: with one upload per pharmacy per week
-- there is no price history to model and no multi-location stock to
-- reconcile, and a join we don't need is a join that can be written wrong.
-- Splitting them out later is an additive migration, not a rewrite.
create table products (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  upload_id         uuid references catalogue_uploads(id) on delete set null,

  name              text not null,
  -- Stable identity for upsert across re-uploads, from the ported
  -- productNormalizer/productIdentityResolver stack. Two spellings of the
  -- same drug in two files must not become two products.
  natural_key       text not null,
  generic_name      text,
  brand_name        text,
  category          text,
  form              text,          -- tablet, syrup, capsule, injection...
  strength          text,          -- '500mg'
  pack_size         text,          -- 'x10', '100ml'
  sku               text,
  barcode           text,

  -- NULL price is a real, expected state: plenty of uploaded rows have no
  -- usable price. It is NOT zero, and the assistant must never quote it.
  price_kobo        bigint check (price_kobo is null or price_kobo >= 0),
  stock_qty         integer check (stock_qty is null or stock_qty >= 0),
  -- Distinguishes "we counted zero" from "this file had no stock column".
  stock_tracked     boolean not null default false,
  expiry_date       date,

  status            text not null default 'active'
                    check (status in ('active', 'hidden', 'archived')),
  -- Set when ingestion could not verify something the assistant would need.
  -- Sellable == active AND price_kobo is not null.
  data_flags        jsonb not null default '[]'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (pharmacy_id, natural_key)
);

create index idx_products_pharmacy on products(pharmacy_id) where status = 'active';
-- Trigram search over name + generic + brand is what actually answers
-- "do you have augmentin" against messy real-world catalogue text.
create extension if not exists pg_trgm;
create index idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index idx_products_generic_trgm on products using gin (generic_name gin_trgm_ops);

-- =====================================================================
-- CUSTOMERS & CONVERSATIONS
-- =====================================================================

-- The pharmacy's customer, identified by WhatsApp number. Scoped per
-- pharmacy on purpose: the same human messaging two Sterling pharmacies is
-- two unrelated customer records. Sharing them across tenants would be a
-- tenant-isolation breach wearing a "feature" costume.
create table customers (
  id            uuid primary key default gen_random_uuid(),
  pharmacy_id   uuid not null references pharmacies(id) on delete cascade,
  wa_phone      text not null,
  display_name  text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  blocked       boolean not null default false,
  unique (pharmacy_id, wa_phone)
);

create table conversations (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  customer_id       uuid not null references customers(id) on delete cascade,
  -- Who is driving. 'bot' = assistant replies. 'human' = assistant is
  -- MUTED and staff reply. 'closed' = archived. The assistant checks this
  -- before every send; a handoff that the AI can talk over is not a handoff.
  mode              text not null default 'bot'
                    check (mode in ('bot', 'human', 'closed')),
  -- Conversational memory for anaphora ("I want two"). Small and bounded:
  -- last product discussed, pending quantity, in-flight order draft.
  -- Kept as a column, not a table, because it is state, not history.
  context           jsonb not null default '{}'::jsonb,
  last_message_at   timestamptz not null default now(),
  -- Providers restrict free-form replies outside a window after the
  -- customer's last inbound message. Cached here so the send path can
  -- check it without recomputing from the message log every time.
  window_expires_at timestamptz,
  created_at        timestamptz not null default now()
);

create index idx_conversations_pharmacy on conversations(pharmacy_id, last_message_at desc);
create index idx_conversations_customer on conversations(customer_id);
create unique index idx_conversations_one_open
  on conversations(customer_id) where mode <> 'closed';

create table messages (
  id                   bigint generated always as identity primary key,
  pharmacy_id          uuid not null references pharmacies(id) on delete cascade,
  conversation_id      uuid not null references conversations(id) on delete cascade,
  direction            text not null check (direction in ('inbound', 'outbound')),
  -- Who produced an outbound message. Needed to measure how much the
  -- assistant actually deflects, and to exclude staff text from any future
  -- evaluation set.
  author               text not null check (author in ('customer', 'assistant', 'staff', 'system')),
  body                 text,
  media_url            text,
  provider_message_id  text,
  -- Provider delivery lifecycle for outbound. 'sent' is not 'delivered',
  -- and neither is 'read' — the dashboard must not claim otherwise.
  delivery_status      text check (delivery_status in ('queued', 'sent', 'delivered', 'read', 'failed', 'undelivered')),
  delivery_error       text,
  -- What the intent classifier decided, kept for tuning.
  intent               text,
  created_at           timestamptz not null default now()
);

create index idx_messages_conversation on messages(conversation_id, created_at);
create index idx_messages_pharmacy_time on messages(pharmacy_id, created_at desc);
create unique index idx_messages_provider_id
  on messages(provider_message_id) where provider_message_id is not null;

-- Every time the assistant stepped back for a human. This is a safety
-- record, not a UI convenience: it is the audit trail proving a clinical
-- question reached a pharmacist.
create table handoffs (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  reason           text not null
                   check (reason in ('clinical', 'low_confidence', 'customer_request', 'order_review', 'unsupported', 'error')),
  detail           text,
  triggered_by     text not null default 'assistant' check (triggered_by in ('assistant', 'staff', 'customer')),
  requested_at     timestamptz not null default now(),
  accepted_by      uuid references auth.users(id) on delete set null,
  accepted_at      timestamptz,
  resolved_at      timestamptz
);

create index idx_handoffs_open on handoffs(pharmacy_id, requested_at desc) where resolved_at is null;

-- =====================================================================
-- ORDERS
-- =====================================================================

-- No payment fields. Payment is explicitly out of MVP scope: it drags in
-- PCI/PSP integration, refunds, and reconciliation, none of which are
-- needed to prove the core thesis (WhatsApp enquiry -> confirmed order).
create table orders (
  id               uuid primary key default gen_random_uuid(),
  pharmacy_id      uuid not null references pharmacies(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete restrict,
  conversation_id  uuid references conversations(id) on delete set null,
  -- Short human-readable reference the customer and counter staff can say
  -- out loud. Unique per pharmacy, not globally.
  reference        text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'confirmed', 'processing', 'ready', 'completed', 'cancelled', 'rejected')),
  status_detail    text,
  -- Snapshot at confirmation time. Recomputing a total from current product
  -- prices would silently rewrite history when the next catalogue lands.
  total_kobo       bigint not null default 0,
  fulfilment       text check (fulfilment in ('pickup', 'delivery')),
  delivery_address text,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (pharmacy_id, reference)
);

create index idx_orders_pharmacy_status on orders(pharmacy_id, status, created_at desc);

create table order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  -- Nullable: a product can be archived by a later catalogue upload, and
  -- that must not destroy order history.
  product_id      uuid references products(id) on delete set null,
  -- Snapshots. The order says what was actually agreed, forever.
  name_snapshot   text not null,
  unit_price_kobo bigint not null check (unit_price_kobo >= 0),
  quantity        integer not null check (quantity > 0),
  line_total_kobo bigint not null check (line_total_kobo >= 0)
);

create index idx_order_items_order on order_items(order_id);

create table order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  from_status text,
  to_status   text not null,
  changed_by  uuid references auth.users(id) on delete set null,
  actor_type  text not null default 'staff' check (actor_type in ('staff', 'assistant', 'system', 'customer')),
  note        text,
  changed_at  timestamptz not null default now()
);

create index idx_order_status_history_order on order_status_history(order_id, changed_at);

-- =====================================================================
-- INGESTION MEMORY (ported from RxNaija Analytics)
-- =====================================================================

-- Whole-header-set mapping memory. Hits when a file's headers match exactly.
create table column_mapping (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  fingerprint  text not null,
  mapping      jsonb not null,
  saved_at     timestamptz not null default now(),
  unique (pharmacy_id, fingerprint)
);

-- Per-column mapping memory. Survives a file gaining or renaming a column,
-- which the whole-set fingerprint above does not.
create table column_alias (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,
  normalized_header text not null,
  category          text not null,
  times_confirmed   integer not null default 0,
  times_overridden  integer not null default 0,
  source            text not null default 'user',
  last_seen         timestamptz not null default now(),
  unique (pharmacy_id, normalized_header)
);

-- =====================================================================
-- BACKGROUND WORK
-- =====================================================================

-- Postgres-backed job queue, deliberately NOT Redis/BullMQ for MVP.
-- Reason: at 1-5 pharmacies the entire throughput is a few hundred
-- messages a day. Redis would add a second stateful service to operate,
-- back up, and secure, to solve a scale problem that does not exist yet.
-- `select ... for update skip locked` gives correct concurrent workers on
-- the database we already run. Swap it when queue depth actually demands it.
create table jobs (
  id            bigint generated always as identity primary key,
  pharmacy_id   uuid references pharmacies(id) on delete cascade,
  kind          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  run_after     timestamptz not null default now(),
  last_error    text,
  locked_at     timestamptz,
  locked_by     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_jobs_claim on jobs(status, run_after) where status = 'queued';

-- =====================================================================
-- AUDIT
-- =====================================================================

create table audit_logs (
  id           bigint generated always as identity primary key,
  pharmacy_id  uuid references pharmacies(id) on delete set null,
  actor_id     uuid references auth.users(id) on delete set null,
  actor_type   text not null default 'user' check (actor_type in ('user', 'assistant', 'system', 'provider')),
  action       text not null,
  entity       text,
  entity_id    text,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index idx_audit_logs_pharmacy on audit_logs(pharmacy_id, created_at desc);

-- =====================================================================
-- ROW-LEVEL SECURITY (defense-in-depth — see header)
-- =====================================================================

create or replace function is_pharmacy_member(p_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from pharmacy_members
    where pharmacy_id = p_id and user_id = auth.uid()
  );
$$;

alter table pharmacies           enable row level security;
alter table pharmacy_members     enable row level security;
alter table pharmacy_profile     enable row level security;
alter table whatsapp_accounts    enable row level security;
alter table inbound_events       enable row level security;
alter table catalogue_uploads    enable row level security;
alter table products             enable row level security;
alter table customers            enable row level security;
alter table conversations        enable row level security;
alter table messages             enable row level security;
alter table handoffs             enable row level security;
alter table orders               enable row level security;
alter table order_items          enable row level security;
alter table order_status_history enable row level security;
alter table column_mapping       enable row level security;
alter table column_alias         enable row level security;
alter table jobs                 enable row level security;
alter table audit_logs           enable row level security;

create policy tenant_read   on pharmacies for select using (is_pharmacy_member(id));
create policy tenant_create on pharmacies for insert with check (auth.uid() is not null);
create policy tenant_update on pharmacies for update using (is_pharmacy_member(id)) with check (is_pharmacy_member(id));

create policy tenant_read on pharmacy_members for select using (is_pharmacy_member(pharmacy_id));

do $$
declare t text;
begin
  foreach t in array array[
    'pharmacy_profile', 'whatsapp_accounts', 'catalogue_uploads', 'products',
    'customers', 'conversations', 'messages', 'handoffs',
    'orders', 'order_items', 'order_status_history',
    'column_mapping', 'column_alias', 'audit_logs'
  ] loop
    execute format(
      'create policy tenant_read on %I for select using (is_pharmacy_member(pharmacy_id))', t);
    execute format(
      'create policy tenant_write on %I for insert with check (is_pharmacy_member(pharmacy_id))', t);
    execute format(
      'create policy tenant_update on %I for update using (is_pharmacy_member(pharmacy_id)) with check (is_pharmacy_member(pharmacy_id))', t);
  end loop;
end $$;

-- inbound_events and jobs get RLS enabled with NO client policies at all.
-- They are infrastructure tables touched only by the service_role
-- connection; a browser session has no business reading either, and an
-- unroutable inbound_event has no pharmacy_id to filter on anyway.
