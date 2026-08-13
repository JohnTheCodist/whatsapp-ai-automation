-- 0019 — identity is the phone number, not the LID
--
-- 0016 made (pharmacy_id, wa_jid) the unique key for a customer. That was
-- right about the problem it solved — wa_phone could hold a LID string, and
-- a column called "phone" containing an opaque identifier is worse than
-- useless to a pharmacist — and wrong about which column should carry
-- identity. The live data shows why:
--
--     phone 2349013993683   lid 198350347493478   jid 198350347493478@lid
--     phone 2347084848418   lid 157187984875693   jid 157187984875693@lid
--
-- EVERY customer on this account is addressed by LID. A LID is an identifier
-- WhatsApp assigns to a contact relationship; it is not a property of the
-- person, and WhatsApp can change it or switch a sender between LID and
-- phone-JID addressing. Keyed on wa_jid, that same human comes back as a
-- SECOND customer with no history — which is precisely the "a returning
-- customer must never create a second record" requirement failing silently.
--
-- The phone number is the stable thing about a person. So identity_key is
-- the normalised phone when there is one, and falls back to the LID only for
-- a sender WhatsApp gave us no number for.
--
-- WHY ONE COLUMN INSTEAD OF TWO PARTIAL UNIQUE INDEXES
-- The alternative — unique(pharmacy_id, wa_phone) where phone is not null,
-- plus unique(pharmacy_id, wa_jid) where phone is null — is two rules that
-- can disagree about the same row as data arrives. One column means one
-- constraint and one answer to "who is this".
--
-- Non-phone keys are PREFIXED ('lid:...'), so a bare value is always a real
-- validated phone number and the two can never be confused. That also makes
-- "which senders did WhatsApp give us no number for" a query rather than an
-- archaeology exercise.
--
-- SAFE FOR EXISTING ROWS: verified before writing this that no two customers
-- share a wa_phone within a pharmacy, so nothing collapses or collides when
-- the constraint moves.

alter table customers
  add column if not exists identity_key text;

-- Backfill. Every existing wa_phone was verified to be plain international
-- digits already (checked against the live table), so no parsing is needed
-- here — the application normalises on write from now on.
update customers
set identity_key = coalesce(
  nullif(wa_phone, ''),
  case when wa_lid is not null then 'lid:' || wa_lid end,
  case when wa_jid is not null then 'jid:' || wa_jid end
)
where identity_key is null;

alter table customers
  alter column identity_key set not null;

create unique index if not exists customers_identity_key_idx
  on customers (pharmacy_id, identity_key);

-- Retire the key this replaces. Keeping it would defeat the entire point:
-- the same person returning under a new LID would still be rejected as a
-- conflict on wa_jid rather than merging into their existing record.
--
-- Dropped as a CONSTRAINT, not as an index. `create unique index` and a
-- `unique` constraint both show up in pg_indexes, but when the index backs a
-- constraint Postgres refuses to drop it directly ("...requires it") — the
-- constraint owns it and takes the index with it. Getting this the wrong way
-- round fails loudly, which is the good case; the bad case is assuming the
-- index drop worked and leaving the old key silently in force.
alter table customers
  drop constraint if exists customers_pharmacy_id_wa_jid_key;

comment on column customers.identity_key is
  'The stable per-pharmacy identity. A bare value is a validated international phone number; anything else is prefixed (lid:/jid:) for a sender WhatsApp gave us no number for. Never the display name, which is a profile attribute and changes freely.';
