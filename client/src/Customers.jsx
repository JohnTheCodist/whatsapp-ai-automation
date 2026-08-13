/**
 * Customer list — proof that identity resolution is producing one durable
 * record per real person, and a place staff can see status/opt-out state.
 *
 * Deliberately thin. No filters beyond search, no analytics — this is
 * "does the identity system work", not a CRM.
 */

import { useCallback, useEffect, useState } from 'react';
import CustomerProfile from './CustomerProfile.jsx';

const TIER_LABEL = { active: 'Active', quiet: 'Quiet', dormant: 'Dormant', unknown: '—' };
const TIER_TONE = {
  active: 'bg-teal-50 text-teal-700',
  quiet: 'bg-amber-50 text-amber-700',
  dormant: 'bg-slate-100 text-slate-500',
  unknown: 'bg-slate-100 text-slate-400',
};

function relTime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Customers({ onOpenConversation, onNavigate }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async (query) => {
    try {
      const r = await fetch(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load customers.');
      setData(j);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(''); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => load(q), 300);
    return () => clearTimeout(t);
  }, [q, load]);

  if (selectedId) {
    return (
      <CustomerProfile
        customerId={selectedId}
        onBack={() => setSelectedId(null)}
        onOpenConversation={onOpenConversation}
        onNavigate={onNavigate}
      />
    );
  }

  if (error) {
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span className="font-medium text-slate-800">{data.counts.total} customers</span>
          {data.counts.opted_out > 0 && <span>{data.counts.opted_out} opted out</span>}
          {data.counts.blocked > 0 && <span>{data.counts.blocked} blocked</span>}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or phone…"
          className="w-56 rounded border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">WhatsApp</th>
              <th className="px-3 py-2">Activity</th>
              <th className="px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.customers.map((c) => (
              // A clickable <tr> is invisible to the keyboard and to screen
              // readers unless it is given a role, a tab stop and a key
              // handler — without these the only way to open a customer is a
              // mouse, which is not a choice anyone made deliberately.
              <tr
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    // Space scrolls the page by default; opening a row is
                    // what the key means here.
                    e.preventDefault();
                    setSelectedId(c.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`Open ${c.display_name || c.wa_phone}`}
                className="cursor-pointer hover:bg-slate-50 focus:bg-slate-100 focus:outline-2 focus:outline-offset-[-2px] focus:outline-teal-600"
              >
                <td className="px-3 py-2 font-medium text-slate-800">{c.display_name || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{c.wa_phone}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${c.status === 'blocked' ? 'bg-red-50 text-red-700' : 'text-slate-500'}`}>
                    {c.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${c.communication_status === 'opted_out' ? 'bg-red-50 text-red-700' : 'text-slate-500'}`}>
                    {c.communication_status === 'opted_out' ? 'Opted out' : 'Subscribed'}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${TIER_TONE[c.activity.tier]}`}>
                    {TIER_LABEL[c.activity.tier]}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-500">{relTime(c.last_seen_at)}</td>
              </tr>
            ))}
            {data.customers.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No customers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
