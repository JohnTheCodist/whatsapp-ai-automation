-- 0011 — product requests and pharmacist-suggested alternatives
--
-- THE GAP THIS CLOSES
-- A customer asks for something the catalogue does not have. The assistant
-- says "we don't stock that", the conversation ends, and nobody at the
-- pharmacy ever learns it happened. That is a lost sale AND a lost signal:
-- the same drug asked for eleven times in a week is a restocking decision
-- nobody is in a position to make.
--
-- WHY THE PHARMACIST PICKS THE ALTERNATIVE, NOT THE ASSISTANT
-- "Drug B works like drug A" is clinical judgement. It is exactly the class
-- of statement the safety filter exists to keep the model away from, and
-- letting the assistant generate substitutions would undo that at the point
-- where a customer is most likely to act on it.
--
-- So the assistant may only ASK. A human chooses, from real catalogue rows —
-- which also means the price and stock quoted back are verifiable through
-- the same tools as everything else, rather than typed into a text box.
--
-- The pharmacist's note is relayed VERBATIM and attributed to them. The
-- assistant does not paraphrase it, because paraphrasing a clinical
-- statement is authoring one.

create table if not exists product_requests (
  id              uuid primary key default gen_random_uuid(),
  pharmacy_id     uuid not null references pharmacies(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,

  -- What the customer actually asked for, in their words. Kept raw: it is
  -- both the question the pharmacist must answer and, in aggregate, the
  -- demand signal for what to stock next.
  requested_text  text not null,

  status          text not null default 'open'
                  check (status in ('open', 'suggested', 'declined', 'accepted', 'expired')),

  -- The alternative, as a real catalogue row rather than free text. This is
  -- what keeps the quoted price and stock verifiable by the same tools that
  -- verify everything else the assistant says.
  suggested_product_id uuid references products(id) on delete set null,
  -- The pharmacist's own words, e.g. "same active ingredient, works the same
  -- way". Relayed verbatim and attributed — never rewritten.
  pharmacist_note text,

  answered_by     uuid references auth.users(id) on delete set null,
  answered_at     timestamptz,
  -- Set when the customer accepts and an order is created from it, so the
  -- suggestion can be traced to whether it actually sold.
  order_id        uuid references orders(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A pharmacist's working queue: oldest unanswered first, because the person
-- who has been waiting longest should be dealt with first.
create index if not exists product_requests_open_idx
  on product_requests (pharmacy_id, created_at) where status = 'open';

create index if not exists product_requests_conversation_idx
  on product_requests (conversation_id, created_at desc);

comment on table product_requests is
  'Things a customer asked for that the catalogue could not supply. Also the demand signal for what to stock.';
comment on column product_requests.suggested_product_id is
  'A real catalogue row, never free text — so the price quoted back to the customer is verifiable.';
comment on column product_requests.pharmacist_note is
  'Relayed verbatim and attributed to the pharmacist. Paraphrasing a clinical statement is authoring one.';
