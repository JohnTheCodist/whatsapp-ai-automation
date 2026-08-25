-- Catalogues that arrive by email, for pharmacies whose POS lives in the cloud.
--
-- WHY THIS IS THE SAME TABLE AS THE CONNECTED COMPUTERS
-- An email inbox and an installed agent are the same THING to everyone
-- downstream: a source that sends this pharmacy's catalogue on a schedule, can
-- succeed or fail, and can quietly stop — which is the failure the Stock sync
-- panel exists to shout about. Modelling them separately would mean a second
-- staleness rule, a second status vocabulary and a second panel, all of which
-- would drift. Here they differ by one column and share everything else,
-- including the "your catalogue stopped updating" warning that matters more
-- than either mechanism.
--
-- WHY EMAIL AT ALL
-- A cloud POS cannot be reached by a program on the shop's computer, and
-- writing an adapter per vendor means writing one before knowing which vendors
-- exist. But almost every POS can already email a scheduled report to a
-- person. Pointing that at us instead is ONE integration that works across
-- vendors — the cloud equivalent of watching a folder — with no password
-- asked for and nothing installed.

alter table sync_devices
  add column if not exists kind text not null default 'computer';

alter table sync_devices
  drop constraint if exists sync_devices_kind_valid;

alter table sync_devices
  add constraint sync_devices_kind_valid
  check (kind in ('computer', 'email'));

-- The unguessable part of the address this pharmacy's POS mails to, e.g. the
-- k7p2m4x8 in stock-k7p2m4x8@sync.rxnaija.com.
--
-- UNGUESSABLE IS THE POINT. Anyone who knows a pharmacy's address can send it
-- a spreadsheet, and this address is typed into a POS configuration screen
-- once and never read again — so it costs nothing to make it long, and a
-- guessable one (the pharmacy's name, an incrementing number) would let a
-- stranger rewrite a live catalogue's prices.
alter table sync_devices
  add column if not exists email_token text;

create unique index if not exists sync_devices_email_token_key
  on sync_devices (email_token)
  where email_token is not null;

-- The only address whose mail is accepted for this inbox.
--
-- The second lock, and the reason a leaked address is not a catastrophe: an
-- unguessable address stops a stranger finding it, and this stops one who
-- has. Null means "not yet learned" — the first message teaches it, and every
-- later one is checked against it. That first-message window is narrow and
-- deliberate: demanding the sending address up front means asking a pharmacist
-- what their POS sends mail AS, which is a question almost nobody can answer
-- before trying it once.
alter table sync_devices
  add column if not exists allowed_sender text;

-- token_hash is the agent's bearer credential. An email inbox has no token —
-- it authenticates by the address it was mailed at, plus the sender check —
-- so this can no longer be required.
alter table sync_devices
  alter column token_hash drop not null;

comment on column sync_devices.kind is
  'computer | email. A computer runs the agent and pushes with a bearer token; an email '
  'inbox receives a scheduled report from a cloud POS. Everything downstream — status, '
  'staleness, last_sync_at, the saved column mapping — is identical.';

comment on column sync_devices.email_token is
  'The unguessable part of this inbox''s address. Null for connected computers.';

comment on column sync_devices.allowed_sender is
  'The lower-cased address this inbox accepts mail from. Learned from the first message '
  'received, then enforced on every later one, so a leaked address alone cannot be used '
  'to push a price list into a live pharmacy.';

create index if not exists sync_devices_email_idx
  on sync_devices (pharmacy_id)
  where kind = 'email';
