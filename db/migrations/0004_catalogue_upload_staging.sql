-- 0004 — staging for the two-step catalogue import
--
-- Upload and confirm are separate steps on purpose: the owner sees the
-- proposed mapping and corrects it before anything is written to products.
-- That means the parsed rows must survive between the two requests.
--
-- Holding them in process memory would be simpler and wrong — a restart
-- between upload and confirm would lose the file with no explanation, and
-- the owner would have to find and re-upload it having already done the
-- work of reviewing the mapping.
--
-- So they are staged in the row. A pharmacy catalogue is a few thousand
-- lines; as jsonb that is single-digit megabytes, and it is CLEARED on
-- completion so the table does not accumulate copies of every file ever
-- imported.

alter table catalogue_uploads
  -- Cleaned rows from the ported cleanData pass, keyed by raw header.
  -- Nulled once the import finishes.
  add column if not exists staged_rows jsonb,
  -- The full analysis shown to the owner: proposals, tiers, the reason for
  -- each decision, unmapped columns. Kept after import as the record of what
  -- they actually agreed to.
  add column if not exists analysis    jsonb,
  -- Which sheet was read. Pharmacy workbooks routinely carry several, and
  -- "it imported the wrong tab" is otherwise invisible.
  add column if not exists sheet_name  text,
  -- What the owner changed from what we proposed. Worth keeping separately:
  -- a field corrected by hand every single time is a synonym we are missing.
  add column if not exists overrides   jsonb;

comment on column catalogue_uploads.staged_rows is
  'Parsed rows awaiting confirmation. Cleared on completion — this table must not become a copy of every file ever uploaded.';
comment on column catalogue_uploads.overrides is
  'Mapping changes the owner made. A field corrected by hand every time is a missing synonym, not a stubborn user.';

create index if not exists catalogue_uploads_pharmacy_idx
  on catalogue_uploads (pharmacy_id, created_at desc);
