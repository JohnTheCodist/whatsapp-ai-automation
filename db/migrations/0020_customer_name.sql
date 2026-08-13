-- 0020 — the customer's own name, kept apart from the name WhatsApp shows
--
-- THREE DIFFERENT THINGS, AND ONLY ONE OF THEM IS A NAME THE PHARMACY CAN USE
--
--   display_name   what WhatsApp reports (pushName). Already stored, and
--                  already correct — this migration only documents it. It is
--                  whatever the customer set on their own phone: "John",
--                  "John's iPhone", "Dr John", a shop name, an emoji. Useful
--                  for recognising someone in the inbox, never usable as the
--                  name on a reservation.
--
--   full_name      what the customer actually told this pharmacy when asked.
--                  The only one staff should put on a package.
--
--   identity       neither of the above. Identity is
--                  (pharmacy_id, identity_key) from 0019 and does not move
--                  when a name changes — see the name_source note below.
--
-- WHY first_name AND last_name ARE BOTH NULLABLE
-- "John" is a complete answer. Splitting it into first='John', last=''
-- invents a fact, and splitting "Ngozi Chukwuemeka Okonkwo" into two fields
-- has to guess which parts are which. So full_name is the authoritative
-- value, the split is best-effort convenience, and last_name stays NULL
-- rather than being fabricated when the customer gave one word.
--
-- WHY name_source EXISTS
-- 'customer_provided' is the only value that means the customer said it.
-- The column exists so that a later feature which imports names from a
-- pharmacy's own records ('staff_entered', 'imported') cannot silently
-- become indistinguishable from something the customer confirmed — which
-- matters the moment a name is printed on a package or read out on a call.

alter table customers
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists full_name text,
  -- True only when the customer themselves gave it, in their own message.
  add column if not exists name_verified boolean not null default false,
  add column if not exists name_source text
    check (name_source is null or name_source in ('customer_provided', 'staff_entered', 'imported')),
  add column if not exists name_updated_at timestamptz;

comment on column customers.display_name is
  'The WhatsApp pushName — whatever the customer set on their own phone. Recognisable in the inbox, NOT the customer''s name. Never use on a reservation; use full_name.';
comment on column customers.full_name is
  'What the customer told this pharmacy when asked at their first order. Authoritative; first_name/last_name are a best-effort split of it.';
comment on column customers.last_name is
  'NULL when the customer gave only one name. Never fabricated from a single word.';
comment on column customers.name_source is
  'customer_provided is the only value meaning the customer said it themselves. Kept distinct so an imported or staff-typed name can never be mistaken for a confirmed one.';

-- Finding customers a pharmacy still needs a name for, without scanning.
create index if not exists customers_missing_name_idx
  on customers (pharmacy_id) where full_name is null;
