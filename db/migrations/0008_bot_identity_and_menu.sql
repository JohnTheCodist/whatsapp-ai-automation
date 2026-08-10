-- 0008 — bot identity and the greeting menu
--
-- A customer messaging a pharmacy should be met by something that knows who
-- it is and who they are, not a bare answer from an anonymous number.
--
-- WHY A NUMBERED MENU AND NOT TAPPABLE BUTTONS
-- WhatsApp restricted interactive list and button messages to the official
-- Cloud API. Baileys v7 can RECEIVE a list reply but its send union contains
-- no listMessage, buttons, interactiveMessage or templateButtons — verified
-- against the installed types, not assumed. A numbered menu is what actually
-- renders on every client, so that is what this stores.
--
-- When the Cloud API adapter lands this becomes a presentation change: the
-- menu items below are already structured, so rendering them as a real
-- tappable list is a different formatter over the same data.

alter table pharmacies
  -- What the assistant calls itself. A pharmacy that has not chosen one
  -- should get its own name rather than a vendor's — customers are talking
  -- to their pharmacy, not to us.
  add column if not exists bot_name     text,
  add column if not exists menu_enabled boolean not null default true,
  -- Sent once at the start of a conversation, and again on request. Nullable
  -- so a pharmacy can write its own without a schema change.
  add column if not exists welcome_note text;

comment on column pharmacies.bot_name is
  'Assistant''s name in customer-facing text. Falls back to the pharmacy name — never to a vendor name.';

-- ---------------------------------------------------------------------------
-- conversations: has this person been greeted?
-- ---------------------------------------------------------------------------
--
-- Not derived from "is this the first message", because that is wrong after
-- history sync, after a re-pair, and for anyone who messaged before the
-- pharmacy went live. An explicit timestamp is the only version that cannot
-- greet a regular customer as though they were new.

alter table conversations
  add column if not exists greeted_at timestamptz,
  -- Which menu option they last chose, so a follow-up like "the second one"
  -- has something to resolve against.
  add column if not exists last_menu_choice text;

comment on column conversations.greeted_at is
  'When the welcome menu was last sent. NULL means never — a returning customer must not be greeted as new.';
