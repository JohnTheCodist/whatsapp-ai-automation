-- 0013 — record WHY a conversation escalated, as a field
--
-- `handoffs.reason` is a coarse enum: clinical, low_confidence, error. It
-- groups a question about a child's medicine with a question about mixing two
-- drugs, which are the same to the schema and completely different to the
-- pharmacist about to answer them.
--
-- The specific category was already known — the filter produces it — but it
-- was being glued into the free-text detail as "paediatric: Asks about
-- medicine for a child". Reading it back meant splitting a string on a colon,
-- which works until a reason contains one.
--
-- So it gets a column. This is what lets the consultation queue say "asking
-- about medicine for a child" instead of "clinical", and lets a pharmacy see
-- which kinds of question it actually gets.

alter table handoffs
  add column if not exists category text;

comment on column handoffs.category is
  'The specific filter category (paediatric, dosage, overdose...). handoffs.reason is the coarse group; this is what the pharmacist needs to see.';

-- Backfill from the detail text, which has always been "category: reason".
-- Only touches rows matching that exact shape, so anything written by hand or
-- by an older path is left alone rather than being given a wrong category.
update handoffs
set category = split_part(detail, ':', 1)
where category is null
  and detail is not null
  and detail ~ '^[a-z_]+:';

create index if not exists handoffs_open_category_idx
  on handoffs (pharmacy_id, requested_at) where resolved_at is null;
