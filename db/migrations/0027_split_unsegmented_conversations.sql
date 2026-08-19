-- 0027 — retroactively split threads the index bug prevented from segmenting
--
-- WHY THIS EXISTS
-- Between 0023 and 0025, idx_conversations_one_open was keyed on `mode`,
-- which nothing wrote any more, so it read as "one conversation per customer,
-- forever". The worker closed threads and resolveConversation asked for new
-- ones; the INSERT failed every time. The result is history that looks like a
-- single endless conversation: one patient held 160 messages, 5 orders and 16
-- handoffs across five days in one row.
--
-- THE RULE IS THE LIVE RULE, DELIBERATELY
-- Sessions are cut at gaps of >= 24 hours, matching conversationPolicy's
-- IDLE_HOURS exactly. The point of this migration is to reproduce what the
-- system WOULD have produced had the bug never existed — not to produce the
-- prettiest segmentation.
--
-- The data offers a real temptation to do otherwise: the largest thread has
-- overnight gaps of 16.5h, 9.5h, 9.2h and 8.0h that read like session
-- boundaries to a human, and an 8h threshold would yield 5 sessions instead
-- of 2. Splitting there would invent a history the policy would never have
-- generated, and leave old conversations segmented on a finer rule than every
-- new one. If 24h is the wrong boundary, the fix is to change IDLE_HOURS for
-- everyone — live and historical together — not to special-case the past.
--
-- WHAT MOVES WITH A MESSAGE
-- Orders and handoffs follow the session their timestamp falls in. An order
-- placed on the 13th must not stay attached to a conversation that ended on
-- the 11th, or "which conversation produced this order" keeps the wrong
-- answer it has had all along.
--
-- WHAT IS PRESERVED
-- Message ids, message timestamps, order ids, handoff ids, and the ORIGINAL
-- conversation id — which stays with the EARLIEST session, because that is
-- the conversation it genuinely was. Its CONVERSATION_STARTED event is dated
-- to that first session, and reassigning the id to a later one would make
-- that event describe a conversation that had not begun yet.
--
-- Idempotent: a second run finds no >= 24h gaps to cut, because the first run
-- already removed them.

do $$
declare
  conv        record;
  starts      timestamptz[];
  seg_start   timestamptz;
  seg_end     timestamptz;
  new_id      uuid;
  i           int;
  orig_state  text;
  orig_status text;
  orig_ctx    jsonb;
begin
  -- Only threads that still contain a >= 24h gap.
  for conv in
    select c.id, c.customer_id, c.pharmacy_id, c.workflow_state, c.status, c.context
    from conversations c
    where exists (
      select 1 from (
        select created_at, lag(created_at) over (order by created_at, id) as prev
        from messages where conversation_id = c.id
      ) g
      where g.prev is not null and g.created_at - g.prev >= interval '24 hours'
    )
  loop
    orig_state  := conv.workflow_state;
    orig_status := conv.status;
    orig_ctx    := conv.context;

    -- The start of each session after the first: every message whose
    -- predecessor is >= 24h older begins a new one.
    select array_agg(created_at order by created_at)
    into starts
    from (
      select created_at, lag(created_at) over (order by created_at, id) as prev
      from messages where conversation_id = conv.id
    ) g
    where g.prev is not null and g.created_at - g.prev >= interval '24 hours';

    if starts is null then
      continue;
    end if;

    -- CLOSE THE ORIGINAL FIRST. Ordering, not tidiness.
    --
    -- idx_conversations_one_open permits a single open conversation per
    -- customer, and it is checked per statement, not at commit. Creating the
    -- new live session while this row was still open put two open rows on one
    -- customer for the duration of one INSERT — enough to violate it. The
    -- first version of this migration did exactly that and failed here.
    --
    -- Its final timestamps are set after the moves below, once we know which
    -- messages it kept.
    update conversations
    set status = 'closed',
        workflow_state = 'resolved',
        closed_at = starts[1],
        closed_reason = 'idle_expired',
        context = '{}'::jsonb
    where id = conv.id;

    for i in 1 .. array_length(starts, 1) loop
      seg_start := starts[i];
      -- Open-ended for the final session, so late rows are never stranded.
      seg_end := case when i < array_length(starts, 1) then starts[i + 1] else null end;

      insert into conversations
        (pharmacy_id, customer_id, mode, status, workflow_state,
         created_at, last_message_at, window_expires_at, context)
      values
        (conv.pharmacy_id, conv.customer_id, 'bot',
         -- Every session except the last is finished by definition: a >= 24h
         -- gap followed it. Only the final one may still be live, and it
         -- inherits the original row's real state below.
         case when seg_end is null then orig_status else 'closed' end,
         case when seg_end is null then orig_state  else 'resolved' end,
         seg_start, seg_start, seg_start + interval '24 hours',
         -- Context is conversational memory ("the product we were just
         -- discussing"). It belongs only to the live session; giving it to a
         -- closed one would preserve a dangling reference to a finished chat.
         case when seg_end is null then orig_ctx else '{}'::jsonb end)
      returning id into new_id;

      update messages set conversation_id = new_id
      where conversation_id = conv.id
        and created_at >= seg_start
        and (seg_end is null or created_at < seg_end);

      -- Orders and handoffs follow their own timestamps into the session that
      -- actually contained them.
      update orders set conversation_id = new_id
      where conversation_id = conv.id
        and created_at >= seg_start
        and (seg_end is null or created_at < seg_end);

      update handoffs set conversation_id = new_id
      where conversation_id = conv.id
        and requested_at >= seg_start
        and (seg_end is null or requested_at < seg_end);

      update conversations
      set last_message_at = coalesce(
            (select max(created_at) from messages where conversation_id = new_id),
            seg_start),
          closed_at = case when seg_end is null then null else seg_end end,
          closed_reason = case when seg_end is null then null else 'idle_expired' end
      where id = new_id;
    end loop;

    -- The original row kept session 1. Its last_message_at can only be
    -- computed now, after the later sessions took their messages away.
    update conversations
    set last_message_at = coalesce(
          (select max(created_at) from messages where conversation_id = conv.id),
          created_at)
    where id = conv.id;
  end loop;
end $$;
