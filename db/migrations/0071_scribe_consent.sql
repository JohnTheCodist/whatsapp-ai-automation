-- ---------------------------------------------------------------------------
-- 0071 — consent to record a consultation (SCRIBE_PLAN.md §7)
-- ---------------------------------------------------------------------------
--
-- The scribe listens to a consultation so a pharmacist can talk to the patient
-- instead of typing about them. Recording a patient's voice in a pharmacy is
-- processing health data about an identified person, and under the Nigeria
-- Data Protection Act 2023 that needs a lawful basis and the patient needs to
-- know.
--
-- WHY THIS IS A COLUMN AND NOT A TICKBOX IN THE BROWSER
--
-- A consent that lives only in the UI is a consent nobody can produce later.
-- The question "was this patient asked?" has to be answerable from the record
-- months afterwards, by somebody who was not there, without taking the
-- software's word for it. So it is stored, with WHO confirmed it and WHEN.
--
-- WHAT IS NOT STORED, AND CANNOT BE
--
-- No audio. Anywhere. There is no column here that could hold a recording and
-- none is added — which is how "we do not keep it" stays true without anybody
-- maintaining the promise. The recording is held in memory, sent to the
-- transcription provider, and dropped.
--
-- The TRANSCRIPT is not stored either. It is shown beside the draft while the
-- pharmacist reviews, and then it is gone. What survives is what the
-- pharmacist accepted into the note, in their own words, as if typed — which
-- is the same thing that would have survived if they had typed it.
--
-- WHY IT HANGS OFF THE CONSULTATION
--
-- Consent is given for THIS conversation, not forever. A patient who agreed to
-- be recorded in September has not agreed to be recorded in December, and a
-- consent stored on the patient would quietly say they had.

alter table pharmacist_consultations
  add column if not exists scribe_consent_at timestamptz,
  add column if not exists scribe_consent_by uuid references auth.users(id) on delete set null;

-- Both or neither. A timestamp with nobody attached cannot be produced as
-- evidence that anybody asked, and a name with no time cannot say when.
alter table pharmacist_consultations
  drop constraint if exists pharmacist_consultations_scribe_consent;

alter table pharmacist_consultations
  add constraint pharmacist_consultations_scribe_consent check (
    (scribe_consent_at is null and scribe_consent_by is null)
    or (scribe_consent_at is not null)
  );

comment on column pharmacist_consultations.scribe_consent_at is
  'When the pharmacist confirmed the patient was told this consultation would be transcribed (SCRIBE_PLAN.md §7). NULL means never asked, and the scribe refuses to record.';
comment on column pharmacist_consultations.scribe_consent_by is
  'Which member of staff confirmed it. Null only where the user could not be identified; the timestamp still stands.';
