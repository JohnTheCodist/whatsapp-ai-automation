-- Caches the LID WhatsApp uses to address the staff alert number, so a
-- staff reply is still recognised on a message that carries no phone number.
--
-- WHY THIS EXISTS
-- isStaffNumber() compares two phone numbers: notify_phone (typed into
-- settings) and the sender's wa_phone (derived from the inbound JID). That
-- comparison silently fails whenever WhatsApp addresses the reply by LID
-- without also supplying the phone-number alt JID on that particular
-- message — see senderIdentity.js. wa_phone then lands NULL, isStaffNumber
-- returns false unconditionally, and the reply falls through to the
-- customer-facing assistant instead of confirming or rejecting the order —
-- exactly the "replying doesn't confirm/reject" symptom this fixes.
--
-- Nullable and learned lazily, not resolved up front: there is no API in
-- this codebase to ask WhatsApp "what LID does this phone number have" ahead
-- of time. The first inbound message that DOES carry both — a phone number
-- matching notify_phone AND a LID — teaches this column the mapping, and
-- every later message recognised by LID alone (no phone) matches against
-- it from then on.
alter table pharmacies
  add column if not exists notify_lid text;

comment on column pharmacies.notify_lid is
  'The LID WhatsApp used the last time a message from notify_phone carried '
  'one, learned opportunistically by worker.js. Lets a staff reply be '
  'recognised even when that particular message carries no phone number.';
