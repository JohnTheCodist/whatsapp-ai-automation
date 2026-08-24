/**
 * Order queue.
 *
 * DESIGN NOTE
 * Pending orders are the only ones that need a decision, so they lead and
 * everything else is history. The actions available on a row come from the
 * server's own transition table — a completed order shows no buttons because
 * there is nothing legitimate to do to it, not because the UI is hiding them.
 *
 * Every status change messages the customer. The result of that send is shown
 * rather than assumed: if WhatsApp was down, staff need to know to call
 * instead of believing the customer was told.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';

// Orders arrive minutes apart, not seconds. Polling faster than that
// spends database connections to display nothing new.
const POLL_MS = 20000;

const STATUS_STYLE = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-blue-100 text-blue-800',
  ready: 'bg-teal-100 text-teal-800',
  completed: 'bg-slate-100 text-slate-500',
  cancelled: 'bg-slate-100 text-slate-500',
  rejected: 'bg-red-100 text-red-700',
};

/**
 * Mirrors ALLOWED_TRANSITIONS in orderService.js.
 *
 * Pending has ONE decision button, not two. Confirm and Mark ready used to
 * be separate clicks — each its own trip to the shelf and its own message to
 * the customer, even though in practice a pharmacist checks stock and marks
 * an order ready in the same motion. This goes straight to `ready`, which is
 * also where stock actually commits now (orderService.commitStock) and the
 * customer gets exactly one message instead of two.
 *
 * `confirmed` stays reachable in its own right — the API still allows it —
 * so any order that already ended up there (an older order, a direct API
 * call) still shows the right next actions rather than a dead end.
 */
const ACTIONS = {
  pending: [
    { to: 'ready', label: 'Confirm & mark ready', style: 'bg-slate-900 text-white' },
    { to: 'rejected', label: 'Reject', style: 'border border-red-300 text-red-700' },
  ],
  confirmed: [
    { to: 'ready', label: 'Mark ready', style: 'bg-slate-900 text-white' },
    { to: 'cancelled', label: 'Cancel', style: 'border border-slate-300' },
  ],
  ready: [
    { to: 'completed', label: 'Collected', style: 'bg-slate-900 text-white' },
    { to: 'cancelled', label: 'Cancel', style: 'border border-slate-300' },
  ],
};

const money = (n) => (n === null || n === undefined ? '—' : `₦${Number(n).toLocaleString('en-NG')}`);

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [counts, setCounts] = useState({ pending: 0, total: 0 });
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    try {
      // BOUNDED, and this is the whole point. Without a timeout a request the
      // server never answers leaves BOTH branches below unrun: `orders` stays
      // null, so the screen renders "Loading…" indefinitely and tells the
      // pharmacist something is on the way when nothing is. That is worse
      // than an error — an error can be retried, a spinner cannot.
      //
      // Observed against a degraded database pooler: the API held the request
      // open past two minutes with no response and no failure.
      //
      // 20s is above any healthy response (this endpoint answers in ~1s even
      // on a slow day) and below the point where a person decides the app is
      // broken.
      const r = await fetch('/api/orders', { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load orders.');
      setOrders(j.orders);
      setCounts(j.counts);
      // See Inbox.jsx: a transient connection drop must not leave a stale
      // error banner sitting over a screen that is working.
      setError(null);
    } catch (e) {
      // A timeout arrives as a bare "signal timed out" / AbortError, which
      // says nothing useful to someone standing at a counter.
      setError(
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'The server did not respond. Orders may be out of date — retrying automatically.'
          : e.message,
      );
      // Deliberately NOT clearing `orders`. If a previous poll succeeded, the
      // list on screen is still the best information available; blanking it
      // on one slow request would take working data away from staff.
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function changeStatus(order, to) {
    setBusyId(order.id);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/orders/${order.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: to }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'That change was not allowed.');

      // Never claim the customer was told when the send failed. Staff act on
      // this: "confirmed but not delivered" means pick up the phone.
      setNotice(
        j.customerNotified
          ? `${order.reference} is now ${to}. The customer has been messaged.`
          : `${order.reference} is now ${to}, but the customer could NOT be messaged${j.notifyError ? ` (${j.notifyError})` : ''}. Call them.`
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  // The split that makes this screen safe to work from.
  //
  // A flat list mixed cancelled, rejected and completed orders in among ones
  // still needing a decision, all at the same weight — so the rows a
  // pharmacist must act on were buried among rows they must NOT act on, and
  // the two looked alike. Terminal states are history; only pending,
  // confirmed and ready are work.
  const LIVE = ['pending', 'confirmed', 'ready'];
  const live = (orders || []).filter((o) => LIVE.includes(o.status));
  const done = (orders || []).filter((o) => !LIVE.includes(o.status));
  // Pending first — those are decisions. Then the order the counter works in.
  const rank = { pending: 0, confirmed: 1, ready: 2 };
  live.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 px-5 py-4">
        <h2 className="font-medium">Orders</h2>
        <div className="flex items-baseline gap-3">
          {counts.pending > 0 && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              {counts.pending} awaiting your decision
            </span>
          )}
          {/* Says what is on screen, not what exists. "25 total" next to a
              list showing three was the header disagreeing with the body. */}
          <span className="text-xs text-slate-400">
            {live.length} open · {counts.total} all time
          </span>
        </div>
      </header>

      {error && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="border-b border-slate-200 bg-slate-50 px-5 py-2 text-sm text-slate-700">{notice}</p>}

      {/* Only while genuinely still waiting. Once a load has failed, the error
          banner above is the honest state — leaving "Loading…" underneath it
          would have the screen claim it is still working on something it has
          already given up on. */}
      {orders === null && !error && <p className="px-5 py-6 text-sm text-slate-500"><Loading /></p>}
      {orders === null && error && (
        <div className="px-5 py-6">
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Try again
          </button>
        </div>
      )}
      {orders?.length === 0 && (
        <p className="px-5 py-6 text-sm text-slate-500">
          No orders yet. They appear here when a customer confirms one over WhatsApp.
        </p>
      )}

      {/* ---- work first ----
          Everything that still needs somebody: pending decisions, then orders
          already promised to a customer and not yet handed over. */}
      {live.length > 0 && (
        <ul className="divide-y divide-slate-200">
          {live.map((o) => (
            <Row key={o.id} o={o} busyId={busyId} onAct={changeStatus} />
          ))}
        </ul>
      )}

      {/* Everything live is done and there is history behind it. Worth saying
          explicitly — an empty region with a "Show closed" link underneath
          reads like a screen that failed to load. */}
      {orders && orders.length > 0 && live.length === 0 && (
        <p className="px-5 py-6 text-sm text-slate-500">
          Nothing waiting. Every order has been completed, cancelled or rejected.
        </p>
      )}

      {/* ---- history, closed by default ----
          A finished order cannot be acted on, so on screen it is only a
          distraction sitting between two that can. It stays one click away
          rather than gone. */}
      {done.length > 0 && (
        <div className="border-t border-slate-200">
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm text-slate-600 hover:bg-slate-50"
          >
            <span className={`text-xs transition-transform ${showDone ? 'rotate-90' : ''}`}>▸</span>
            {showDone ? 'Hide' : 'Show'} closed orders
            <span className="text-xs text-slate-400">({done.length})</span>
          </button>

          {showDone && (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {done.map((o) => (
                <Row key={o.id} o={o} busyId={busyId} onAct={changeStatus} muted />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One order.
 *
 * `muted` is not only styling. A closed order renders WITHOUT its action row
 * — there is nothing legitimate left to do to it — so the buttons cannot be
 * mis-clicked on a row that merely looks similar to a live one. The server
 * enforces the same rule through ALLOWED_TRANSITIONS; this stops the click
 * ever being offered.
 */
function Row({ o, busyId, onAct, muted = false }) {
  const actions = muted ? null : ACTIONS[o.status];

  return (
    <li className={`px-5 py-4 ${muted ? 'bg-white' : o.status === 'pending' ? 'bg-amber-50/40' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <span className={`font-mono text-sm ${muted ? 'text-slate-400' : 'font-medium'}`}>{o.reference}</span>
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[o.status] || ''}`}>{o.status}</span>
          <span className="text-xs text-slate-500">
            {o.display_name || o.wa_phone} · {o.fulfilment}
          </span>
        </div>
        <span className={`text-sm tabular-nums ${muted ? 'text-slate-400' : 'font-medium'}`}>
          {money(o.total_naira)}
        </span>
      </div>

      {/* A closed order's line items are the least useful detail on the
          screen; the reference and the total are what someone is scanning for
          when they look one up. */}
      {!muted && (
        <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
          {o.items.map((i, idx) => (
            <li key={idx} className="flex justify-between gap-4">
              <span>{i.quantity} × {i.name_snapshot}</span>
              <span className="tabular-nums text-slate-500">{money(i.line_total_naira)}</span>
            </li>
          ))}
        </ul>
      )}

      {!muted && o.note && <p className="mt-1 text-xs italic text-slate-500">“{o.note}”</p>}

      {actions && (
        <div className="mt-3 flex gap-2">
          {actions.map((a) => (
            <button
              key={a.to}
              type="button"
              disabled={busyId === o.id}
              onClick={() => onAct(o, a.to)}
              className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-40 ${a.style}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
