-- Catalogue sync: a program on the pharmacy's own computer that uploads their
-- stock file on a schedule, so the catalogue stops being a thing somebody has
-- to remember to re-upload.
--
-- WHAT THIS IS NOT
-- Not a new ingestion path. A synced file goes through exactly the same
-- stageUpload -> detect columns -> confirmAndImport stack a hand-uploaded one
-- does. The agent is a new way for a file to arrive at a door that already
-- exists, and everything below exists to authenticate that arrival and to
-- decide when it may import without asking a human.

-- ---------------------------------------------------------------- devices --
--
-- One row per installed agent. A pharmacy can legitimately have more than one
-- (a second branch, a replaced PC), so this is a table rather than columns on
-- pharmacies.
create table if not exists sync_devices (
  id                uuid primary key default gen_random_uuid(),
  pharmacy_id       uuid not null references pharmacies(id) on delete cascade,

  -- What the pharmacist calls this machine. Theirs to set, because "which
  -- computer is this?" is a question only they can answer, and a hostname
  -- like DESKTOP-V4L4I9C answers it for nobody.
  label             text,

  -- SHA-256 of the device token, never the token itself.
  --
  -- This is the same reasoning as any password column: the agent keeps the
  -- only copy, and a database dump must not hand someone the ability to push
  -- a price list into a live pharmacy. A leaked hash is useless; a leaked
  -- token is an open door.
  token_hash        text unique,

  -- Pairing. The code is short-lived and single-use — it is read off a screen
  -- and typed into another machine, which is a window measured in minutes,
  -- not the lifetime of the install.
  pairing_code      text,
  pairing_expires_at timestamptz,
  paired_at         timestamptz,

  status            text not null default 'pending'
                    check (status in ('pending', 'active', 'revoked')),

  -- What the agent found on that PC, and what the pharmacist said it was.
  --
  -- BOTH, deliberately. `pos_fingerprint` is machine-collected (installed
  -- program names, database services); `pos_confirmed` is the human's answer
  -- to "which of these is your stock software?". Storing the pair is what
  -- lets the NEXT pharmacy running the same software be recognised without
  -- being asked — the fingerprint catalogue is accumulated from real installs
  -- rather than guessed at in advance.
  --
  -- Program NAMES only. Never file contents, never anything out of the data
  -- files themselves. See the agent's disclosure step: collecting an
  -- inventory of someone's server undisclosed is malware behaviour, and the
  -- only thing separating this from that is that they were shown it and
  -- agreed to send it.
  pos_fingerprint   jsonb,
  pos_confirmed     text,

  -- Where their POS writes its export, on that machine. Stored so support can
  -- answer "why has this stopped working" without a screen-share.
  watch_path        text,

  last_seen_at      timestamptz,
  last_sync_at      timestamptz,
  last_sync_status  text,
  last_sync_detail  text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists sync_devices_pharmacy_idx
  on sync_devices (pharmacy_id);

-- Pairing codes are looked up by code alone, before any pharmacy is known —
-- the agent has nothing else to present. Partial because the many paired
-- devices with no live code must not collide on null.
create unique index if not exists sync_devices_pairing_code_key
  on sync_devices (pairing_code)
  where pairing_code is not null;

comment on column sync_devices.token_hash is
  'SHA-256 of the device token. The agent holds the only copy of the token itself — a '
  'database dump must not confer the ability to push a price list into a live pharmacy.';

comment on column sync_devices.pos_fingerprint is
  'Installed program and service NAMES the agent found, with the pharmacist''s consent. '
  'Never file contents. Paired with pos_confirmed to build the fingerprint catalogue that '
  'lets later installs of the same software be recognised without asking.';

-- ------------------------------------------------------------- the mapping --
--
-- The rule that makes an unattended import safe.
--
-- Nothing reaches products until a human has agreed what the columns mean —
-- that is the existing contract and this does not weaken it. It just stops
-- asking the same question every night: the mapping the owner confirmed is
-- saved here, and a later file whose columns still match imports against it
-- automatically. A file whose columns have CHANGED does not import at all.
-- It stops and asks, because a renamed column is exactly how a price ends up
-- read out of a stock-count field.
alter table pharmacies
  add column if not exists catalogue_sync_mapping jsonb;

-- The signature the mapping was agreed against: the sorted column headers of
-- the file the owner confirmed. Compared against each incoming file to decide
-- "same shape, import" versus "this changed, ask".
--
-- Stored separately from the mapping rather than derived from it because the
-- mapping only names the columns that were USED. A new column appearing in
-- the export is a change worth noticing even if nothing maps to it.
alter table pharmacies
  add column if not exists catalogue_sync_columns jsonb;

comment on column pharmacies.catalogue_sync_mapping is
  'field -> raw column header, as confirmed by the owner on the review screen. Reused by '
  'unattended syncs so the same question is not asked nightly.';

comment on column pharmacies.catalogue_sync_columns is
  'Sorted headers of the file that mapping was agreed against. An incoming file with a '
  'different set stops for review instead of importing.';

-- Which device a given upload arrived from, and whether a human saw it.
--
-- Without this, a synced import and a hand-made one are indistinguishable
-- afterwards — which matters the first time somebody asks why the price of
-- something changed at 3am.
alter table catalogue_uploads
  add column if not exists sync_device_id uuid references sync_devices(id) on delete set null;

alter table catalogue_uploads
  add column if not exists imported_unattended boolean not null default false;

comment on column catalogue_uploads.imported_unattended is
  'True when this upload imported against a saved mapping with no human review. The audit '
  'trail for "nobody clicked anything and the catalogue changed".';
