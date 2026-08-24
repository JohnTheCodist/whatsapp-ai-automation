-- A second price on the same product, not a second product list.
--
-- WHAT WAS ACTUALLY BROKEN
-- 0040 gave customers a customer_type and the trade QR code that sets it, and
-- its own comment promised "the catalogue tool returns the tier this customer
-- is entitled to". Nothing implemented the other half: products had exactly
-- one price_kobo, so a wholesale account was identified correctly and then
-- quoted the retail price anyway. The tagging worked; the pricing it existed
-- for did not.
--
-- WHY A COLUMN AND NOT A SECOND CATALOGUE
-- A pharmacy's trade list is the same medicines at different prices — the same
-- paracetamol, the same NAFDAC number, the same shelf. Modelling it as a
-- separate product set would double every row, split stock across two records
-- that describe one physical box, and make "is this the same product?" a
-- question the identity resolver would have to answer across catalogues rather
-- than within one. Price tiering on a shared product is what stock systems
-- do because the product is genuinely shared.
--
-- Nullable, and that is a real state: "no trade price set for this item". It
-- is NOT zero and it is NOT the retail price. A wholesale customer asking
-- about a product with no trade price is told it is not on the trade list —
-- never shown the retail figure, which would be a different price than the one
-- their account is entitled to and looks like a pricing error to a buyer who
-- sees both on one order.
alter table products
  add column if not exists wholesale_price_kobo bigint
    check (wholesale_price_kobo is null or wholesale_price_kobo >= 0);

comment on column products.wholesale_price_kobo is
  'Trade price for customers whose customer_type is ''wholesale''. Null means this product '
  'is not on the trade list — the assistant says so rather than falling back to price_kobo, '
  'so a trade account is never quoted a retail figure. Set by a catalogue upload whose '
  'price_tier is ''wholesale''.';

-- Which price column an upload writes to.
--
-- The whole ingestion stack — column detection, cleaning, NAFDAC matching,
-- identity resolution — is identical for both tiers, because a trade price
-- list is the same shape of file. Only the destination differs, so this is one
-- column on the upload rather than a parallel pipeline.
--
-- Default 'retail': every upload before this migration was a retail catalogue,
-- and a null would make every reader handle a third state that means nothing.
alter table catalogue_uploads
  add column if not exists price_tier text not null default 'retail';

alter table catalogue_uploads
  drop constraint if exists catalogue_uploads_price_tier_valid;

alter table catalogue_uploads
  add constraint catalogue_uploads_price_tier_valid
  check (price_tier in ('retail', 'wholesale'));

comment on column catalogue_uploads.price_tier is
  'retail | wholesale. Decides which price column confirmAndImport writes: price_kobo or '
  'wholesale_price_kobo. A wholesale upload is a PRICE LIST — it never overwrites retail '
  'price or stock, because both tiers describe one physical inventory.';

-- Trade-priced products are the minority, and both the dashboard's wholesale
-- view and the assistant's pricing path filter on "has a trade price" per
-- pharmacy on every read.
create index if not exists products_wholesale_priced_idx
  on products (pharmacy_id)
  where wholesale_price_kobo is not null;
