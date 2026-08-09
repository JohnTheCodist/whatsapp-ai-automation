-- 0005 — conduct controls
--
-- The reported reasons WhatsApp actions a number are behavioural: messaging
-- strangers, bulk sending, low reply ratio, mechanical timing, ignoring
-- people who asked you to stop. Every one of those is something this system
-- can be made STRUCTURALLY INCAPABLE of, rather than merely instructed not
-- to do.
--
-- That is the whole strategy. Not hiding what the system is — making it
-- genuinely be a low-volume assistant that only ever answers people who
-- wrote first, so there is nothing to detect.
--
-- The limits live in the database rather than in code so a pharmacy that
-- turns out to be busier can be raised deliberately, one tenant at a time,
-- rather than by loosening a constant for everyone.

-- ---------------------------------------------------------------------------
-- opt-outs — permanent, and per pharmacy
-- ---------------------------------------------------------------------------
--
-- Continuing to message someone who said stop is the single clearest signal
-- of a system worth banning, and the one users report. It is also simply
-- wrong. This is a separate table rather than a flag on customers because it
-- must survive the customer row being rebuilt by a re-import or a cascade.

create table if not exists opt_outs (
  id           uuid primary key default gen_random_uuid(),
  pharmacy_id  uuid not null references pharmacies(id) on delete cascade,
  -- Stored normalised, so a local and an international spelling of the same
  -- number cannot silently become two records and let one through.
  wa_phone     text not null,
  -- What they actually typed. Evidence, and useful for tuning the matcher.
  source_text  text,
  opted_out_at timestamptz not null default now(),
  -- Deliberately nullable and unused for now: re-subscribing should be an
  -- explicit act by a person, never something the assistant infers from a
  -- later friendly message.
  opted_in_at  timestamptz,
  unique (pharmacy_id, wa_phone)
);

create index if not exists opt_outs_lookup_idx on opt_outs (pharmacy_id, wa_phone);

-- ---------------------------------------------------------------------------
-- per-pharmacy conduct limits
-- ---------------------------------------------------------------------------

alter table pharmacies
  -- A hard ceiling on assistant replies per rolling 24 hours. Reaching it is
  -- not an error, it is a signal something unusual is happening — and the
  -- correct response to "unusual" on an unofficial channel is to stop and let
  -- a human look, not to keep going faster.
  add column if not exists daily_reply_cap      integer not null default 200,
  -- Per-conversation ceiling per hour. A human going back and forth rarely
  -- exceeds this; a loop does so immediately.
  add column if not exists hourly_conversation_cap integer not null default 15,
  -- Local hours outside which the assistant stays silent. A shop that answers
  -- instantly at 03:00 is not a shop. Stored as integers rather than a time
  -- so the comparison is trivial and timezone-independent within one country.
  add column if not exists quiet_hours_start    integer not null default 22 check (quiet_hours_start between 0 and 23),
  add column if not exists quiet_hours_end      integer not null default 6  check (quiet_hours_end between 0 and 23),
  add column if not exists quiet_hours_enabled  boolean not null default true,
  -- Trips when something looks wrong. While set, the assistant sends nothing
  -- and every conversation goes to staff. Cleared by a person, deliberately.
  add column if not exists sending_paused       boolean not null default false,
  add column if not exists paused_reason        text,
  add column if not exists paused_at            timestamptz;

comment on column pharmacies.daily_reply_cap is
  'Hard ceiling on assistant replies per 24h. Hitting it pauses sending rather than throttling — unusual volume on an unofficial channel deserves a human, not a queue.';
comment on column pharmacies.sending_paused is
  'Circuit breaker. Set automatically on a conduct breach, cleared only by a person.';

-- ---------------------------------------------------------------------------
-- an index the conduct checks depend on
-- ---------------------------------------------------------------------------
--
-- Counting recent outbound messages runs on EVERY reply. Without this it is a
-- sequential scan over the whole message history, and the check meant to
-- protect the pharmacy becomes the reason replies are slow.

create index if not exists messages_outbound_recent_idx
  on messages (pharmacy_id, direction, created_at desc);

create index if not exists messages_conversation_recent_idx
  on messages (conversation_id, created_at desc);
