-- 0016 — WhatsApp JID is the customer identity key, not phone number
--
-- 0003 already diagnosed this and stopped halfway. Its own comment says
-- wa_jid is "authoritative for routing" and wa_phone is "true to its name
-- only by accident" — but the uniqueness constraint stayed on wa_phone
-- anyway, because at the time nothing yet depended on changing it.
--
-- THE ACTUAL FAILURE MODE
-- sessionManager resolves phoneNumber as `sender.phone || sender.lid` per
-- MESSAGE, not per customer. Two messages from the same real person can
-- resolve differently — a real number when WhatsApp's alt-JID happens to be
-- present on that event, an opaque LID string when it is not. Keyed on
-- wa_phone, those look like two different customers: a fresh insert instead
-- of a matched upsert, silently, with no error anywhere.
--
-- wa_jid (msg.key.remoteJid) does not have this problem. It is what
-- WhatsApp addressed the message TO US as, on every single event, and this
-- system already replies to it directly rather than reconstructing it. It
-- is the one identifier the channel itself guarantees is stable per sender.
--
-- wa_phone keeps its own index — still what a pharmacist actually
-- recognises — it just stops being what identity is decided by.
--
-- Verified before writing this: zero existing rows have wa_jid null (every
-- row so far was created through the path that always sets it), so this
-- ships as a straight NOT NULL rather than needing a backfill strategy.

alter table customers alter column wa_jid set not null;

alter table customers drop constraint customers_pharmacy_id_wa_phone_key;
alter table customers add constraint customers_pharmacy_id_wa_jid_key unique (pharmacy_id, wa_jid);

create index if not exists customers_wa_phone_idx on customers (pharmacy_id, wa_phone);

comment on column customers.wa_jid is
  'The JID to send replies to, AND the customer identity key (unique per pharmacy). The only value WhatsApp guarantees resolves the same way on every message from the same sender — see 0016.';
comment on column customers.wa_phone is
  'Human-recognisable phone number, best-effort. NOT the identity key — WhatsApp does not guarantee this resolves consistently per message (see senderIdentity.js); only wa_jid does.';
