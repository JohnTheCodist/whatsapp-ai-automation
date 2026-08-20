-- The number a pharmacy PUBLISHES — the one on the printed QR code.
--
-- WHY THIS IS NOT whatsapp_accounts.display_phone_number
-- That column describes the socket: whatever number happens to be paired
-- right now. It is correct for "who are we connected as", and wrong for
-- "what did we print on two hundred flyers".
--
-- The QR was being generated from the live connection, which quietly tied a
-- physical, printed artefact to a runtime value. Re-pairing the same SIM is
-- harmless — a wa.me link encodes a phone number, not a session — but the
-- coupling meant the code on the counter was only ever as stable as the
-- socket, and nothing would have said so if it drifted.
--
-- Stored on the pharmacy instead: set once, deliberately, and unchanged by
-- disconnects, restores, or re-pairing. The UI compares it against the
-- currently connected number and warns when the two diverge, which is the
-- one case where a printed QR really has gone stale — and the one case the
-- old arrangement could not detect, because it had nothing to compare.
--
-- Nullable: a pharmacy that has not published a code yet has no answer here,
-- and defaulting it to the paired number would recreate exactly the silent
-- coupling this column exists to break.
alter table pharmacies
  add column if not exists public_whatsapp_number text;

comment on column pharmacies.public_whatsapp_number is
  'The number printed on this pharmacy''s customer QR code. Set deliberately by staff; '
  'independent of whatsapp_accounts.display_phone_number, which follows the live socket. '
  'Digits only, international format, no leading +.';
