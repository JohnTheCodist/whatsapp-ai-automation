-- 0002 — Baileys session storage
--
-- The channel decision (ARCHITECTURE.md §6.1, 2026-08-09) moved from Meta
-- Cloud API to Baileys. That is not a provider swap: Cloud API is stateless
-- HTTP, Baileys is a held socket per pharmacy whose credentials we now own
-- and must persist ourselves.
--
-- Two things drive this schema.
--
-- 1. Auth state splits into `creds` (one small blob, always loaded) and
--    `keys` (many entries, read by type+id). Keeping keys in their own table
--    with a (account, type, id) primary key is what lets the store do lazy
--    batched reads. Measured in §6.8: that is the difference between memory
--    scaling with SOCKET count (~1-2 MB each, bounded) and scaling with
--    CONTACT count (unbounded). It is the whole capacity argument.
--
-- 2. Everything here is a credential. A Baileys auth state is not a scoped
--    API token — possession is full account takeover of the pharmacy's
--    WhatsApp. It is stored encrypted (AES-256-GCM, server/services/crypto.js)
--    and the ciphertext never leaves the server.

-- ---------------------------------------------------------------------------
-- whatsapp_accounts — adapt from the Cloud API shape
-- ---------------------------------------------------------------------------

alter table whatsapp_accounts drop constraint if exists whatsapp_accounts_provider_check;
alter table whatsapp_accounts add constraint whatsapp_accounts_provider_check
  check (provider in ('baileys', 'twilio', 'meta_cloud'));

alter table whatsapp_accounts alter column provider set default 'baileys';

-- With Cloud API the number is known before the row exists. With Baileys it
-- is only learned AFTER the owner completes pairing, so it cannot be NOT NULL
-- at insert time. The unique index stays (Postgres permits many NULLs), which
-- still prevents two pharmacies claiming the same connected number.
alter table whatsapp_accounts alter column display_phone_number drop not null;

alter table whatsapp_accounts drop constraint if exists whatsapp_accounts_status_check;
alter table whatsapp_accounts add constraint whatsapp_accounts_status_check
  check (status in (
    'pending',       -- row exists, nothing attempted
    'pending_scan',  -- pairing code issued, waiting for the owner
    'connecting',    -- socket opening or restoring
    'connected',     -- verified by a self-test round trip, not by an API 200
    'disconnected',  -- transient; reconnect is expected
    'logged_out',    -- owner revoked, or credentials rejected. DO NOT retry.
    'banned',        -- terminal. Requires a human.
    'failed'
  ));

alter table whatsapp_accounts
  -- The `creds` half of the auth state. Encrypted. Never logged, never
  -- returned by an API, never included in an error payload.
  add column if not exists creds_encrypted    bytea,
  -- Short-lived onboarding artefacts. Pairing code beats QR here: the owner
  -- is holding the phone the code goes into, and photographing a screen is a
  -- worse experience than typing eight characters.
  add column if not exists pairing_code       text,
  add column if not exists pairing_expires_at timestamptz,
  add column if not exists last_connected_at  timestamptz,
  add column if not exists last_seen_at       timestamptz,
  -- Populated from DisconnectReason so a dead session can be diagnosed
  -- without reading logs.
  add column if not exists disconnect_reason  text,
  -- Unused in MVP (single process). Exists now so nothing is written that
  -- assumes the process serving a request is the process holding the socket.
  -- Adding it later would mean auditing every call site instead of one file.
  add column if not exists worker_id          text;

comment on column whatsapp_accounts.creds_encrypted is
  'AES-256-GCM. Full WhatsApp session credential — treat as more sensitive than any other column in this database.';
comment on column whatsapp_accounts.worker_id is
  'Reserved for multi-process session routing. Always NULL in MVP.';

-- ---------------------------------------------------------------------------
-- whatsapp_auth_keys — the lazy half of the auth state
-- ---------------------------------------------------------------------------

create table if not exists whatsapp_auth_keys (
  whatsapp_account_id uuid not null references whatsapp_accounts(id) on delete cascade,
  -- 'pre-key' | 'session' | 'sender-key' | 'app-state-sync-key' | ...
  -- Deliberately not an enum: Baileys owns this vocabulary and adds to it
  -- across versions. A CHECK here would turn a library upgrade into a
  -- migration, and fail at write time on a socket we cannot easily recover.
  key_type            text  not null,
  key_id              text  not null,
  value_encrypted     bytea not null,
  updated_at          timestamptz not null default now(),
  -- This primary key IS the performance design. `get(type, ids[])` becomes a
  -- single indexed lookup, so only the keys actually needed are ever read
  -- into memory.
  primary key (whatsapp_account_id, key_type, key_id)
);

comment on table whatsapp_auth_keys is
  'Signal protocol key material, encrypted per row. Read lazily by (type, id) — never load the whole set for a session.';

-- ---------------------------------------------------------------------------
-- whatsapp_consents — evidence, not a boolean
-- ---------------------------------------------------------------------------
--
-- Baileys is unofficial. A pharmacy's number can be permanently banned with
-- no appeal, and the banned asset is THEIR customer channel, not ours
-- (ARCHITECTURE.md §6.2). The pharmacy must acknowledge that before
-- connecting, and we must be able to show exactly what wording they saw.
-- A boolean column cannot do that; it records that someone clicked, not what
-- they agreed to.

create table if not exists whatsapp_consents (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references pharmacies(id) on delete cascade,
  user_id        uuid references auth.users(id) on delete set null,
  consent_type   text not null default 'unofficial_channel_ban_risk',
  -- Bump when the wording changes. Consent to v1 is not consent to v2.
  consent_version text not null,
  -- The exact text shown, stored verbatim. Storing a version alone is not
  -- enough: it makes the evidence depend on a git archaeology exercise.
  consent_text   text not null,
  accepted_at    timestamptz not null default now(),
  ip             inet,
  user_agent     text
);

create index if not exists whatsapp_consents_pharmacy_idx
  on whatsapp_consents (pharmacy_id, accepted_at desc);
