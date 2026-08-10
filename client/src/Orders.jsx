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

/** Mirrors ALLOWED_TRANSITIONS in orderService.js. */
const ACTIONS = {
  pending: [
    { to: 'confirmed', label: 'Confirm', style: 'bg-slate-900 text-white' },
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

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/orders');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load orders.');
      setOrders(j.orders);
      setCounts(j.counts);
      // See Inbox.jsx: a transient connection drop must not leave a stale
      // error banner sitting over a screen that is working.
      setError(null);
    } catch (e) {
      setError(e.message);
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

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex items-baseline justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <h2 className="font-medium">Orders</h2>
        {counts.pending > 0 ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            {counts.pending} awaiting your decision
          </span>
        ) : (
          <span className="text-xs text-slate-400">{counts.total} total</span>
        )}
      </header>

      {error && <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="border-b border-slate-200 bg-slate-50 px-5 py-2 text-sm text-slate-700">{notice}</p>}

      {orders === null && <p className="px-5 py-6 text-sm text-slate-500">Loading…</p>}
      {orders?.length === 0 && (
        <p className="px-5 py-6 text-sm text-slate-500">
          No orders yet. They appear here when a customer confirms one over WhatsApp.
        </p>
      )}

      <ul className="divide-y divide-slate-200">
        {orders?.map((o) => (
          <li key={o.id} className={`px-5 py-4 ${o.status === 'pending' ? 'bg-amber-50/40' : ''}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-sm font-medium">{o.reference}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[o.status] || ''}`}>
                  {o.status}
                </span>
                <span className="text-xs text-slate-500">
                  {o.display_name || o.wa_phone} · {o.fulfilment}
                </span>
              </div>
              <span className="text-sm font-medium tabular-nums">{money(o.total_naira)}</span>
            </div>

            <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
              {o.items.map((i, idx) => (
                <li key={idx} className="flex justify-between gap-4">
                  <span>
                    {i.quantity} × {i.name_snapshot}
                  </span>
                  <span className="tabular-nums text-slate-500">{money(i.line_total_naira)}</span>
                </li>
              ))}
            </ul>

            {o.note && <p className="mt-1 text-xs italic text-slate-500">“{o.note}”</p>}

            {ACTIONS[o.status] && (
              <div className="mt-3 flex gap-2">
                {ACTIONS[o.status].map((a) => (
                  <button
                    key={a.to}
                    type="button"
                    disabled={busyId === o.id}
                    onClick={() => changeStatus(o, a.to)}
                    className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-40 ${a.style}`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
