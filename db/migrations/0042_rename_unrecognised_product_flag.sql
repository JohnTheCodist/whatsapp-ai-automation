-- Rename the data_flags entry 'unrecognised_product' to 'no_generic_name'.
--
-- WHY THE OLD NAME HAD TO GO
-- It reads as "the reference data has never heard of this product". What it
-- actually marks is narrower and much more common: there is no generic name
-- worth DISPLAYING — and the usual reason is that the generic is already
-- contained in the product name, so repeating it would tell a pharmacist
-- nothing. "Omeprazole 20mg" is a drug NAFDAC knows perfectly well and still
-- carried the flag.
--
-- That gap is not cosmetic. duplicateReview was built on this flag believing
-- it meant "NAFDAC cannot confirm this name", and so offered a pharmacist
-- pairs to adjudicate under a heading promising the opposite — while the
-- safety argument it rested on (a look-alike pair cannot appear here because
-- both halves resolve) was never actually being tested. That module now asks
-- the registry directly and does not read this flag at all.
--
-- WHY THE STORED ROWS ARE REWRITTEN RATHER THAN LEFT
-- data_flags holds literal strings, so code and data have to agree. Leaving
-- old rows on the old string would mean every reader carrying both spellings
-- forever, which is the same trap one indirection further along.
--
-- Idempotent: the WHERE clause matches only rows still holding the old value,
-- so re-running changes nothing. coalesce guards the theoretical empty array
-- — jsonb_agg over no rows returns NULL, and data_flags is NOT NULL.
update products
set data_flags = (
  select coalesce(
    jsonb_agg(
      case when elem = '"unrecognised_product"'::jsonb
        then '"no_generic_name"'::jsonb
        else elem
      end
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(products.data_flags) as elem
)
where data_flags @> '["unrecognised_product"]'::jsonb;
