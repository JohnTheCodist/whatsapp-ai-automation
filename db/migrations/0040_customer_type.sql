-- Retail or trade, decided by WHICH QR CODE the customer arrived through.
--
-- HOW THIS GETS SET, AND WHY THAT MATTERS MORE THAN THE COLUMN
-- Three earlier designs for this failed on the same point: somebody had to
-- decide. Tagging customers by hand does not happen in a busy pharmacy;
-- letting customers declare themselves means everyone claims the trade price;
-- and inferring it from purchase volume is guesswork with money attached —
-- a family collecting three months of a chronic medicine looks exactly like a
-- small bulk order.
--
-- The QR code decides instead. A wa.me link can carry a prefilled message, so
-- the pharmacy prints two:
--
--   retail     wa.me/<number>
--   wholesale  wa.me/<number>?text=<pharmacy's trade code>
--
-- The retail code goes on the counter and the flyers; the trade code goes on
-- invoices and delivery notes, handed to buyers the pharmacy already deals
-- with. Arriving through it sets this column once, automatically. Nobody
-- tags anyone, and the pharmacy keeps control of who ever sees the code.
--
-- SAME SIM, SAME INBOX. Both codes point at one number, so this costs no
-- extra line, no second pairing and no second socket.
--
-- WHAT IT IS FOR
--   1. Pricing — the catalogue tool returns the tier this customer is
--      entitled to and only that one, so the model never holds both prices
--      and cannot quote the wrong one.
--   2. The condition register — trade accounts are excluded outright. A
--      vendor buying metformin monthly produces textbook diabetes evidence,
--      and a clinical list filling up with businesses is a clinical list
--      nobody trusts. A business is not a patient with weak evidence; it is
--      not a patient at all.
--
-- Default 'retail' — every existing customer messaged the pharmacy like one,
-- and a null would force every reader to handle a third state that means
-- nothing.
alter table customers
  add column if not exists customer_type text not null default 'retail';

alter table customers
  drop constraint if exists customers_customer_type_valid;

alter table customers
  add constraint customers_customer_type_valid
  check (customer_type in ('retail', 'wholesale'));

-- The trade code itself. Per pharmacy, because it is printed on that
-- pharmacy's own paperwork, and null until they generate one — a pharmacy
-- that does no wholesale should not have a code that could be guessed into.
alter table pharmacies
  add column if not exists wholesale_code text;

-- Unique so an inbound message can be resolved to exactly one pharmacy, and
-- partial so the many pharmacies with no code do not collide on null.
create unique index if not exists pharmacies_wholesale_code_key
  on pharmacies (wholesale_code)
  where wholesale_code is not null;

-- Wholesale is the rare case, so index only those rows: both the register
-- and the pricing path filter on it per pharmacy on every read.
create index if not exists customers_wholesale_idx
  on customers (pharmacy_id)
  where customer_type = 'wholesale';

comment on column customers.customer_type is
  'retail | wholesale. Set automatically when a customer arrives via the pharmacy''s trade '
  'QR code (wa.me link with a prefilled wholesale_code). Never inferred from purchase '
  'behaviour, never self-declared. Wholesale accounts are excluded from the condition engine.';

comment on column pharmacies.wholesale_code is
  'Prefilled token in this pharmacy''s trade QR link. Null when the pharmacy does no '
  'wholesale. Printed on invoices and delivery notes, not on public-facing material.';
