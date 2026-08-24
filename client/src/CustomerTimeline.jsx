/**
 * A customer's activity, chronological and grouped by day.
 *
 * Reads GET /api/customers/:id/timeline directly rather than the slice
 * embedded in the profile response — this component owns its own paging
 * ("load older activity") independently of the rest of the profile, per the
 * segment's pagination requirement. The profile's embedded first page is
 * only ever what loads before this component takes over.
 *
 * EVERY LINE TRACES TO A REAL EVENT
 * No summarising, no invented captions. A message row shows the customer's
 * own words from event.metadata.preview — the same text the server stored,
 * never regenerated here.
 */

import { useCallback, useEffect, useState } from 'react';
import { IconInbox, IconOrders, IconPerson, IconBellOff, IconStar, IconReply } from './Icons.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'orders', label: 'Orders' },
  { id: 'messages', label: 'Messages' },
  { id: 'pharmacist', label: 'Pharmacist' },
  { id: 'system', label: 'System' },
];

// Icon + label per event type. Never rely on colour alone (section 10) —
// each category also gets a distinct glyph, not just a tint.
//
// `icon` is a component, not an emoji — this map used to hold 💬 / 🛒 / 👤 /
// 🔕 (design.md's Icon-chip section bans that as an icon source outright).
// Every entry draws from Icons.jsx now, including the two that were already
// plain Unicode (★, ↩) before the switch — a timeline where some rows are
// hand-drawn icons and others are whatever glyph the OS font ships is its
// own, quieter version of the same inconsistency.
const EVENT_META = {
  PATIENT_CREATED:        { icon: IconStar,  label: 'Became a customer',              tone: 'slate' },
  CONVERSATION_STARTED:   { icon: IconInbox, label: 'Started a conversation',         tone: 'slate' },
  CONVERSATION_RESOLVED:  { icon: IconInbox, label: 'Conversation resolved',          tone: 'slate' },
  MESSAGE_RECEIVED:       { icon: IconInbox, label: 'Customer asked',                 tone: 'blue' },
  MESSAGE_SENT:           { icon: IconReply, label: 'Customer notified',              tone: 'slate' },
  ORDER_CREATED:          { icon: IconOrders, label: 'Order sent to pharmacy',        tone: 'amber' },
  ORDER_STOCK_HELD:       { icon: IconOrders, label: 'Stock held',                    tone: 'amber' },
  ORDER_SENT_TO_PHARMACY: { icon: IconOrders, label: 'Sent to pharmacy',              tone: 'amber' },
  ORDER_CONFIRMED:        { icon: IconOrders, label: 'Order confirmed',               tone: 'teal' },
  ORDER_REJECTED:         { icon: IconOrders, label: 'Order rejected',                tone: 'red' },
  ORDER_READY:            { icon: IconOrders, label: 'Ready for collection',          tone: 'teal' },
  ORDER_COMPLETED:        { icon: IconOrders, label: 'Order completed',               tone: 'slate' },
  ORDER_CANCELLED:        { icon: IconOrders, label: 'Order cancelled',               tone: 'slate' },
  ORDER_HOLD_EXPIRED:     { icon: IconOrders, label: 'Reservation expired, unconfirmed', tone: 'red' },
  PHARMACIST_HANDOFF:     { icon: IconPerson, label: 'Passed to a pharmacist',        tone: 'amber' },
  PHARMACIST_RESPONDED:   { icon: IconPerson, label: 'Pharmacist responded',          tone: 'teal' },
  COMMUNICATION_OPTED_OUT:{ icon: IconBellOff, label: 'Opted out of WhatsApp messages', tone: 'red' },
};

/** The fallback for an event type nothing has written a renderer for yet. */
function DotIcon(p) {
  return (
    <svg viewBox="0 0 24 24" width={p.width} height={p.height} aria-hidden="true">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

const TONE_DOT = {
  slate: 'bg-slate-300', blue: 'bg-blue-400', amber: 'bg-amber-400',
  teal: 'bg-teal-500', red: 'bg-red-400',
};

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}
function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
}
function naira(kobo) { return `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG')}`; }

/** Group already-sorted (newest first) events into day sections, in order. */
function groupByDay(events) {
  const groups = [];
  let current = null;
  for (const e of events) {
    const label = dayLabel(e.occurredAt);
    if (!current || current.label !== label) {
      current = { label, events: [] };
      groups.push(current);
    }
    current.events.push(e);
  }
  return groups;
}

/**
 * A readable label for an event type nothing has written a renderer for yet.
 *
 * MEDICATION_STARTED -> "Medication started". The event registry is
 * deliberately extensible, so a future module can start recording a new type
 * before this file knows about it — and on that day the timeline should show
 * the event rather than a raw constant or, worse, nothing.
 *
 * Derived from the name rather than guessed at: no prose is invented, the
 * words are the ones the event type already contains.
 */
function humanizeEventType(type) {
  const words = String(type).toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return 'Activity';
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '');
}

/** Warn once per unknown type, so a missing renderer is noticed but not spammed. */
const warnedTypes = new Set();

function EventLine({ event, onOpenConversation }) {
  let meta = EVENT_META[event.eventType];
  if (!meta) {
    // Visible to developers, invisible to the pharmacist — the event still
    // renders. A crash or a blank row here would make adding an event type a
    // breaking change for the dashboard, which is the opposite of the point.
    if (!warnedTypes.has(event.eventType)) {
      warnedTypes.add(event.eventType);
      console.warn(
        `[timeline] no renderer for event type "${event.eventType}" — showing a derived label. `
        + 'Add it to EVENT_META in CustomerTimeline.jsx to give it an icon and wording.'
      );
    }
    meta = { icon: DotIcon, label: humanizeEventType(event.eventType), tone: 'slate' };
  }
  const m = event.metadata || {};

  let detail = null;
  if (event.eventType === 'MESSAGE_RECEIVED' || event.eventType === 'MESSAGE_SENT') {
    detail = m.preview ? <span className="text-slate-500">"{m.preview}"</span> : null;
  } else if (event.eventType.startsWith('ORDER_')) {
    const bits = [m.reference, m.totalKobo != null ? naira(m.totalKobo) : null].filter(Boolean);
    if (bits.length) detail = <span className="text-slate-500">{bits.join(' · ')}</span>;
  } else if (event.eventType === 'PHARMACIST_HANDOFF' && m.category) {
    detail = <span className="text-slate-500">{m.category.replace(/_/g, ' ')}</span>;
  }

  const canOpen = (event.eventType === 'MESSAGE_RECEIVED' || event.eventType === 'MESSAGE_SENT') && m.conversationId;

  return (
    <li className="relative pb-4 pl-5">
      <span className={`absolute left-0 top-1.5 h-2 w-2 rounded-full ${TONE_DOT[meta.tone]}`} />
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-slate-400">{timeLabel(event.occurredAt)}</p>
      </div>
      <p className="mt-0.5 flex items-start gap-1.5 text-sm text-slate-800">
        <meta.icon width={13} height={13} className="mt-0.5 shrink-0 text-slate-400" />
        <span>
          {meta.label}
          {detail && <> — {detail}</>}
        </span>
      </p>
      {canOpen && (
        <button
          onClick={() => onOpenConversation?.(m.conversationId)}
          className="mt-0.5 text-xs text-teal-700 hover:underline"
        >
          Open conversation
        </button>
      )}
    </li>
  );
}

export default function CustomerTimeline({ customerId, onOpenConversation }) {
  const [filter, setFilter] = useState('all');
  const [events, setEvents] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (currentFilter) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/customers/${customerId}/timeline?event_type=${currentFilter}&limit=25`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load activity.');
      setEvents(j.events);
      setCursor(j.nextCursor);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { load(filter); }, [filter, load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/customers/${customerId}/timeline?event_type=${filter}&limit=25&cursor=${encodeURIComponent(cursor)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load more activity.');
      setEvents((prev) => [...prev, ...j.events]);
      setCursor(j.nextCursor);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const groups = groupByDay(events);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Activity</h3>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded px-2 py-1 text-xs ${
                filter === f.id ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="mt-4 text-sm text-slate-400">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-400">Nothing here yet.</p>
      ) : (
        <div className="mt-4 space-y-5">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.label}</p>
              <ol className="border-l border-slate-200 pl-0">
                {g.events.map((e) => (
                  <EventLine key={e.id} event={e} onOpenConversation={onOpenConversation} />
                ))}
              </ol>
            </div>
          ))}
          {cursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full rounded border border-slate-200 py-2 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load older activity'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
