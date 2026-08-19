-- 0028 — move "has this customer ever been greeted" from the conversation to
--        the customer, where it actually belongs
--
-- THE BUG THIS FIXES
-- conversations.greeted_at answered "has THIS conversation session sent its
-- opening menu". That was harmless back when one customer had exactly one
-- conversation forever. It stopped being harmless the moment 0021-0027 gave
-- conversations a real lifecycle: any gap past IDLE_HOURS now starts a NEW
-- conversation row with greeted_at = null, for a customer who has ordered
-- from this pharmacy a dozen times before.
--
-- The visible symptom: a returning customer says "Good morning" after a
-- day's silence and gets the full numbered menu dumped on them again, as
-- though the system had never seen them — because, by the column it was
-- checking, it hadn't. This is Segment 1's own rule (§6: "a customer can
-- have conversation 1, 2, 3, 4 while still being the same customer") applied
-- to a place that was still violating it.
--
-- THE FIX
-- onboarded_at lives on customers, stamped once, read forever, unaffected by
-- how many conversation sessions come and go underneath it.

alter table customers
  add column if not exists onboarded_at timestamptz;

comment on column customers.onboarded_at is
  'When this customer first got the welcome/menu — set ONCE, ever. Not conversation-scoped: see 0028. A returning customer must never look first-time because their old conversation aged out and a new one started.';

-- ---------------------------------------------------------------------------
-- backfill — nobody who has already talked to this pharmacy should get a
-- "welcome, first time here?" message tomorrow because of this migration
-- ---------------------------------------------------------------------------
--
-- Two sources, in order of confidence:
--   1. The earliest greeted_at across all of a customer's conversations —
--      this IS a record that a welcome/menu was actually sent, just filed
--      under the wrong entity.
--   2. For a customer with conversations but no greeted_at anywhere (menu
--      was off, or they arrived through history sync) — first_seen_at.
--      They have unmistakably already been in contact; treating them as
--      first-time would be the exact bug this migration exists to remove,
--      just triggered by a different gap in the old data.

update customers c
set onboarded_at = sub.earliest_greeting
from (
  select customer_id, min(greeted_at) as earliest_greeting
  from conversations
  where greeted_at is not null
  group by customer_id
) sub
where sub.customer_id = c.id
  and c.onboarded_at is null;

update customers c
set onboarded_at = c.first_seen_at
where c.onboarded_at is null
  and c.first_seen_at is not null
  and exists (select 1 from conversations cv where cv.customer_id = c.id);
