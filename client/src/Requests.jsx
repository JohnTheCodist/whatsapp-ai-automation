/**
 * Pharmacist queue — things a customer asked for that the catalogue could not
 * supply.
 *
 * WHY THE ALTERNATIVE IS A PICKER, NOT A TEXT BOX
 * A typed product name would have been quicker to build and would have let a
 * pharmacist quote a price the system cannot verify — reintroducing invented
 * numbers through the one door the whole assistant design closes. Picking a
 * real catalogue row means the price the customer is quoted comes from the
 * same place as every other price.
 *
 * The note IS free text, because that is the clinical judgement only a person
 * can supply, and it is sent to the customer in their words and attributed to
 * them.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';

export default function Requests({ onCount }) {
  const [requests, setRequests] = useState([]);
  const [demand, setDemand] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);

  const load = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/requests').then((r) => r.json()),
        fetch('/api/requests/demand').then((r) => r.json()),
      ]);
      setRequests(r1.requests || []);
      setDemand(r2.demand || []);
      onCount?.((r1.requests || []).length);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <p className="text-sm text-slate-500"><Loading /></p>;

  return (
    <div className="space-y-6">
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section>
        <h3 className="mb-1 text-sm font-medium text-slate-700">Customers waiting on you</h3>
        <p className="mb-3 text-xs text-slate-500">
          They asked for something not in your catalogue. The assistant will not suggest a
          substitute — that is your call.
        </p>

        {requests.length === 0 ? (
          <p className="rounded-lg border border-slate-200 p-4 text-sm text-slate-500">
            Nothing waiting.
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-slate-900">
                    “{r.requested_text}”
                  </p>
                  <span className="text-xs text-slate-500">
                    {r.display_name || r.wa_phone} · {timeAgo(r.created_at)}
                  </span>
                </div>
                {r.asked_30d > 1 && (
                  // Turns one customer's question into a stocking decision.
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    Asked {r.asked_30d} times in the last 30 days — worth stocking?
                  </p>
                )}
                <div className="mt-3">
                  {active === r.id ? (
                    <AnswerForm request={r} onDone={() => { setActive(null); load(); }} onCancel={() => setActive(null)} />
                  ) : (
                    <button
                      onClick={() => setActive(r.id)}
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                    >
                      Answer this
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {demand.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-medium text-slate-700">What customers keep asking for</h3>
          <p className="mb-3 text-xs text-slate-500">Last 30 days, most asked first.</p>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Asked</th>
                  <th className="px-3 py-2">Sold an alternative</th>
                  <th className="px-3 py-2">Turned away</th>
                </tr>
              </thead>
              <tbody>
                {demand.map((d) => (
                  <tr key={d.product} className="border-t border-slate-100">
                    <td className="px-3 py-2">{d.product}</td>
                    <td className="px-3 py-2 font-medium">{d.times_asked}</td>
                    <td className="px-3 py-2 text-teal-700">{d.sold_alternative}</td>
                    <td className="px-3 py-2 text-slate-500">{d.declined}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function AnswerForm({ request, onDone, onCancel }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/requests/catalogue-search?q=${encodeURIComponent(query)}`);
        const j = await r.json();
        setResults(j.products || []);
      } catch { /* the form still works without search */ }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function submit(kind) {
    setBusy(true);
    setErr(null);
    try {
      const url = `/api/requests/${request.id}/${kind}`;
      const body = kind === 'suggest' ? { productId: picked?.id, note } : { note };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not send.');
      // Say plainly when the decision saved but the message did not go out,
      // rather than showing a success that only half happened.
      if (j.delivery && !j.delivery.sent) {
        setErr(`Saved, but the customer could not be messaged (${j.delivery.reason}). Please call them.`);
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-slate-300 bg-white p-3">
      {err && <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</p>}

      <label className="block text-xs font-medium text-slate-700">Suggest an alternative from your catalogue</label>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
        placeholder="Search your products…"
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
      />

      {results.length > 0 && !picked && (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-slate-200">
          {results.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => { setPicked(p); setQuery(p.name); }}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-slate-50"
              >
                <span>
                  {p.name}
                  {p.strength ? <span className="text-slate-500"> {p.strength}</span> : null}
                </span>
                <span className="text-slate-600">₦{p.price.toLocaleString('en-NG')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {picked && (
        <p className="mt-2 rounded bg-teal-50 px-2 py-1 text-xs text-teal-800">
          Suggesting <strong>{picked.name}</strong> at ₦{picked.price.toLocaleString('en-NG')}
        </p>
      )}

      <label className="mt-3 block text-xs font-medium text-slate-700">
        Your note to the customer (optional)
      </label>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 300))}
        placeholder="e.g. same active ingredient, works the same way"
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
      />
      <p className="mt-1 text-xs text-slate-500">
        Sent to the customer in your words, as your recommendation. The assistant will not add to it.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => submit('suggest')}
          disabled={busy || !picked}
          className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Send suggestion
        </button>
        <button
          onClick={() => submit('decline')}
          disabled={busy}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
        >
          We can't supply this
        </button>
        <button onClick={onCancel} disabled={busy} className="px-2 py-1.5 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}
