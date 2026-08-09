-- 0003 — real sender identity, and the outbound allowlist
--
-- First live traffic arrived addressed by LID rather than phone number:
--
--   remoteJid      198350347493478@lid
--   remoteJidAlt   2349013993683@s.whatsapp.net
--
-- customers.wa_phone was therefore storing an opaque identifier. A
-- pharmacist looking at "198350347493478" cannot tell which customer that
-- is, match it to a walk-in, or phone them back — the column was true to its
-- name only by accident, and stopped being so the moment WhatsApp changed
-- addressing.
--
-- The two identifiers do different jobs and are now stored separately:
-- wa_phone is what a human recognises, wa_jid is what we actually reply to.

alter table customers
  -- The LID, when addressing is by LID. Not a phone number, never shown.
  add column if not exists wa_lid text,
  -- The addressable JID this customer last messaged from. We reply HERE
  -- rather than reconstructing a JID from the phone number, because this is
  -- the routing WhatsApp itself told us to use.
  add column if not exists wa_jid text;

comment on column customers.wa_phone is
  'Human-recognisable phone number in international digits. Falls back to the LID only when WhatsApp gave us no number at all.';
comment on column customers.wa_lid is
  'WhatsApp LID. Opaque; never display this to staff.';
comment on column customers.wa_jid is
  'The JID to send replies to. Authoritative for routing.';

create index if not exists customers_wa_lid_idx on customers (pharmacy_id, wa_lid);

-- ---------------------------------------------------------------------------
-- Outbound allowlist
-- ---------------------------------------------------------------------------
--
-- This number auto-replies to whoever messages it. During testing that must
-- be a very short list, and "we forgot to turn the filter on" must not be a
-- possible state.
--
-- Stored per pharmacy rather than in an env var so it is inspectable and
-- auditable, and so a second pharmacy cannot inherit the first one's list.

create table if not exists outbound_allowlist (
  id          uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  -- International digits, normalised on write. Matching a raw local format
  -- against a stored international one is how an allowlist fails silently.
  wa_phone    text not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (pharmacy_id, wa_phone)
);

-- The mode lives on the pharmacy so it is impossible to have an allowlist
-- configured and not enforced.
alter table pharmacies
  add column if not exists reply_mode text not null default 'allowlist'
    check (reply_mode in (
      'off',        -- record what would be sent, send nothing
      'allowlist',  -- reply only to outbound_allowlist. THE DEFAULT.
      'all'         -- reply to anyone. Deliberate act.
    ));

comment on column pharmacies.reply_mode is
  'Defaults to allowlist on purpose: a new pharmacy must not start replying to the public because someone forgot to configure it.';
