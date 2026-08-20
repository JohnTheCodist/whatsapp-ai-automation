-- How the assistant SOUNDS. Not what it is willing to say.
--
-- THE DISTINCTION THIS COLUMN MUST NOT BLUR
-- Tone changes register: how warm the greeting is, whether honorifics are
-- used, how much small talk survives. It must never change the clinical
-- boundary. A "confident" or "expert" tone that made the assistant more
-- willing to answer a dosing question would be a safety regression wearing a
-- personality setting's clothes, which is exactly why the allowed values
-- below describe MANNER only — none of them is a licence to advise.
--
-- The prompt builder injects a fixed sentence per value (see
-- server/services/ai/assistantTone.js). The column stores a key, never free
-- text: an owner-authored tone string would be an instruction written by a
-- user and handed to the model, which is the injection surface this codebase
-- is careful to keep closed everywhere else.
--
-- Default 'warm' rather than null: every existing pharmacy already has an
-- implicit tone — whatever the prompt does today — and warm is the closest
-- description of it. A null would make the prompt builder branch on
-- "unset", which is a third state nobody needs.
alter table pharmacies
  add column if not exists assistant_tone text not null default 'warm';

alter table pharmacies
  drop constraint if exists pharmacies_assistant_tone_valid;

alter table pharmacies
  add constraint pharmacies_assistant_tone_valid
  check (assistant_tone in ('warm', 'professional', 'reassuring'));

comment on column pharmacies.assistant_tone is
  'How the assistant speaks: warm | professional | reassuring. Affects register only — '
  'never what it is permitted to answer. Maps to a fixed prompt line in assistantTone.js; '
  'never stores owner-written text.';
