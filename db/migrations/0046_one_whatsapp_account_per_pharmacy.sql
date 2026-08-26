-- One WhatsApp account per pharmacy, enforced by the database.
--
-- WHAT WENT WRONG
-- getOrCreateAccount reads, finds nothing, then inserts:
--
--     select * from whatsapp_accounts where pharmacy_id = $1 ... limit 1
--     if (existing) return existing
--     insert into whatsapp_accounts ...
--
-- Two requests arriving together both see nothing and both insert. Nothing in
-- the schema said that was impossible, so it happened: a live pharmacy ended
-- up with two baileys accounts for one phone number, on linked-device slots
-- :24 and :26, both opening sockets.
--
-- WHY THAT IS SEVERE RATHER THAN UNTIDY
-- WhatsApp permits one socket per number. Two of them knock each other off
-- with connectionReplaced, repeatedly and forever — which is precisely the
-- outage this migration was written during. Every inbound message was also
-- processed twice, so a customer could be answered twice, and the reconnect
-- policy correctly refused to fight it and simply stopped. The pharmacy went
-- silent while every component reported itself healthy.
--
-- The trigger was two dashboards open at once: the desktop app and a browser
-- both poll /api/whatsapp/status on load, which is exactly the concurrency
-- the read-then-insert could not survive.

-- ---- de-duplicate before constraining -------------------------------------
--
-- Keeps the OLDEST row per (pharmacy, provider), because that is the one
-- getOrCreateAccount already selects (`order by created_at limit 1`). Keeping
-- any other would silently repoint the application at a different row than the
-- one it has been using.
--
-- Deleting the others cascades to whatsapp_auth_keys and nothing else — no
-- messages, conversations, orders or customers reference this table. The cost
-- is that the duplicate's session credentials are destroyed, which is the
-- intent: that session is the thing fighting the real one, and it must not be
-- able to reconnect.
delete from whatsapp_accounts a
using whatsapp_accounts b
where a.pharmacy_id = b.pharmacy_id
  and a.provider = b.provider
  and (
    a.created_at > b.created_at
    -- created_at can tie when both rows were inserted in the same instant,
    -- which is the exact race this is cleaning up. id breaks it so the
    -- delete is deterministic instead of leaving both or removing both.
    or (a.created_at = b.created_at and a.id > b.id)
  );

-- ---- make it impossible ---------------------------------------------------
--
-- The application fix (an upsert) still ships alongside this, but the
-- constraint is what actually guarantees it: an upsert is a promise made by
-- one function, and this is a promise made by the database to every caller
-- that will ever exist, including a future admin route or a manual insert.
create unique index if not exists whatsapp_accounts_one_per_pharmacy
  on whatsapp_accounts (pharmacy_id, provider);

comment on index whatsapp_accounts_one_per_pharmacy is
  'One provider account per pharmacy. WhatsApp allows a single socket per number, so a second '
  'baileys row means two sockets knocking each other off with connectionReplaced until the '
  'pharmacy goes silent. Added after that happened in production.';
