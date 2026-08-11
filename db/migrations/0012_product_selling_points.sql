-- 0012 — the pharmacy's own words about its own products
--
-- THE PROBLEM
-- Asked "what's your best antimalarial", a good counter assistant presents a
-- few options with a line about each. The catalogue cannot support that: the
-- Coartem row has a null strength, form, pack size AND generic name. There is
-- nothing to describe.
--
-- The tempting fix is to let the model write the descriptions from its own
-- knowledge of the drug. That is precisely the failure mode the entire
-- assistant design exists to prevent — an unverifiable claim about a
-- medicine, generated confidently, delivered to someone about to take it.
--
-- So the copy comes from the pharmacy. `description` is their words about
-- their stock, relayed as-is. `is_featured` is their commercial pick, which
-- is a judgement they are entitled to make and the assistant is not.
--
-- This is the same shape as the pharmacist-alternatives flow: a human makes
-- the claim, the assistant carries it.

alter table products
  -- One line the pharmacy writes, e.g. "Full 3-day course, one of the most
  -- widely used ACTs in Nigeria". Relayed verbatim, never rewritten —
  -- paraphrasing a statement about a medicine is authoring one.
  add column if not exists description text,
  -- The pharmacy's own pick within its category. Commercial judgement, not
  -- clinical: "this is what we recommend to customers" is a shop's call.
  add column if not exists is_featured boolean not null default false;

comment on column products.description is
  'The pharmacy''s own words about this product. Relayed verbatim to customers — the assistant must never write or rewrite one.';
comment on column products.is_featured is
  'The pharmacy''s pick within its category. Commercial judgement, which is theirs to make; efficacy judgement is not the assistant''s.';

create index if not exists products_category_active_idx
  on products (pharmacy_id, category) where status = 'active';
