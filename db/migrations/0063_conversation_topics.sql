-- =====================================================================
-- Messages: what a conversation was ABOUT.
-- =====================================================================
--
-- See MESSAGES_PLAN.md §5 and §11. This is the whole of phase 1's schema
-- change: one nullable column on a table that nine non-test modules read and
-- that receives every live patient's WhatsApp messages. Additive, and no
-- existing column changes meaning.
--
-- WHY A COLUMN AND NOT A TABLE
-- A topic is one label per conversation, chosen from a fixed list. A table
-- would let a conversation carry several topics, which answers "what was this
-- about" with a list instead of an answer — and the point of the label is that
-- a pharmacist scanning a patient's history can tell the medication thread
-- from the billing thread at a glance.
--
-- WHY NULLABLE, AND WHY NO DEFAULT
-- Every conversation that exists today arrived before topics did, and nobody
-- has said what any of them was about. `general` as a default would be this
-- system inventing an answer for thousands of real threads it never asked
-- about — the same mistake as an allergy card reading "None" when nobody was
-- asked (0058). NULL means "not labelled", the screen says so, and a
-- pharmacist labels it or does not.
--
-- WHY THE LIST INCLUDES `appointment` WHEN THERE IS NO APPOINTMENTS MODULE
-- The topic organises a conversation; it does not link to a record (that is
-- conversation_links, phase 2). Patients discuss appointments whether or not
-- this product models them, and a pharmacist who cannot label that thread
-- would label it `other`, which tells the next reader nothing. The label is
-- honest; what would not be honest is offering a "View appointment" button
-- behind it, and phase 2 does not.
--
-- NOT IN THIS MIGRATION, DELIBERATELY:
--   conversations.channel        internal threads — phase 3, with GOLDEN-007
--   conversation_links           clinical context — phase 2
--   conversation_read_marks      per-user unread — phase 2
-- Each is its own behaviour and gets its own migration, per AGENTS.md.

alter table conversations
  add column if not exists topic text
    check (topic is null or topic in (
      'general',
      'medication',
      'medication_review',
      'follow_up',
      'appointment',
      'test_result',
      'care_program',
      'condition',
      'billing',
      'other'
    )),
  -- Who labelled it and when. A topic is a staff judgement about a patient's
  -- conversation, so it carries its author for the same reason every clinical
  -- write in this product does.
  add column if not exists topic_set_at timestamptz,
  add column if not exists topic_set_by uuid references auth.users(id) on delete set null;

comment on column conversations.topic is
  'What this conversation was about, chosen by staff from a fixed list. NULL means nobody has said — never assume general.';

-- The patient Messages screen reads one patient's threads newest-first, and
-- filters them by topic. Both are covered by this.
create index if not exists idx_conversations_customer_recent
  on conversations (customer_id, last_message_at desc);
