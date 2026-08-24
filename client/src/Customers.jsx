/**
 * Customer list — proof that identity resolution is producing one durable
 * record per real person, and a place staff can see status/opt-out state.
 *
 * Deliberately thin. No filters beyond search, no analytics — this is
 * "does the identity system work", not a CRM.
 */

import { useCallback, useEffect, useState } from 'react';
import CustomerProfile from './CustomerProfile.jsx';
import Loading from './Loading.jsx';

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

/**
 * The chronic register — conditions the pharmacy is tracking from purchase
 * history, and who is under each.
 *
 * A condition with no patients is not rendered at all. Four permanent
 * "Asthma — 0" cards would push the conditions that DO have patients off the
 * first screen, and a card that is always zero is one staff learn to ignore.
 * The server already omits them; this renders nothing if the whole register
 * is empty rather than an explanatory box about a feature that has not
 * produced anything yet.
 *
 * WHAT THE WORDING HAS TO CARRY
 * "Confirmed by purchase" is not a diagnosis, and the UI must never let that
 * distinction get lost — hence the basis line under the heading and the
 * per-patient evidence, both drawn from the engine rather than asserted here.
 */
function ChronicRegister({ onOpen }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/customers/conditions/registry', {
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch {
        /* the register is supplementary — the patient list below still works */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const conditions = data?.conditions || [];
  if (conditions.length === 0) return null;

  const shown = conditions.find((c) => c.code === open);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-700">Chronic conditions tracked</h3>
        <span className="text-xs text-slate-500">
          {data.trackedPatients} patient{data.trackedPatients === 1 ? '' : 's'} · from purchase history
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {conditions.map((c) => {
          const isOpen = c.code === open;
          return (
            <button
              key={c.code}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : c.code)}
              className={`rounded-lg border px-3 py-2 text-left transition ${
                isOpen
                  ? 'border-teal-400 bg-teal-50'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="block text-xs text-slate-500">{c.name}</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{c.patientCount}</span>
            </button>
          );
        })}
      </div>

      {shown && (
        <div className="mt-3 rounded-lg border border-slate-200">
          <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
            {shown.name} — confirmed by purchase history, not a diagnosis
          </p>
          <ul className="divide-y divide-slate-100">
            {shown.patients.map((p) => (
              <li key={p.customerId}>
                <button
                  type="button"
                  onClick={() => onOpen(p.customerId)}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="font-medium text-slate-800">{p.name}</span>
                  <span className="text-xs text-slate-500">{p.phone}</span>
                  {/* Recency is the actionable part: a confirmed condition with
                      no recent purchase is the patient worth calling. */}
                  {p.purchaseStatus === 'NO_RECENT_PURCHASE' && (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                      no recent purchase
                    </span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-slate-400">
                    {p.purchases} purchase{p.purchases === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function Customers({ onOpenConversation, onNavigate, initialQuery = '' }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState(initialQuery);
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

  // Re-runs when the header search sends a new term, so searching from the
  // top bar while already on this screen actually filters rather than
  // silently doing nothing.
  useEffect(() => {
    setQ(initialQuery);
    load(initialQuery);
  }, [load, initialQuery]);

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
  if (!data) return <p className="text-sm text-slate-500"><Loading /></p>;

  return (
    <div className="space-y-4">
      {/* Above the full list: a pharmacy scanning for "who is on blood
          pressure medicine" should not have to open records one by one to
          find out. Renders nothing at all when no condition has patients. */}
      <ChronicRegister onOpen={setSelectedId} />

      {/* The standalone "Diabetic Patients" card that used to sit here is
          gone — ChronicRegister above already shows a Diabetes card (and
          every other tracked condition) drawn from the real condition
          engine, clickable through to the patient list. This one was a
          second, cruder count of the same thing from a separate query
          (server/routes/customers.js), with no way to act on it — a
          duplicate, not a different fact. */}
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
