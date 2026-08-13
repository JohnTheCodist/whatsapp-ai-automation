/**
 * The pharmacist's consultation queue.
 *
 * Separate from the Inbox on purpose. The Inbox is every conversation, sorted
 * and paginated; this is only the people waiting on a pharmacist, with enough
 * of the situation on the card to triage without opening anything.
 *
 * WHAT IS SHOWN, AND WHY IT IS NOT A SUMMARY
 * The customer's own words, quoted. A model-written précis of a clinical
 * question reads more smoothly and can be wrong in ways nobody catches —
 * three months old becoming three years old. The person making the medical
 * decision gets the sentences the customer actually typed.
 */

import { useEffect, useState, useCallback } from 'react';

export default function Consultations({ onOpenConversation }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/conversations/waiting');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load the queue.');
      setData(j);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    // 20s. Someone waiting on a pharmacist is the one thing in this app worth
    // polling for, but the pooler has been exhausted once already by eager
    // refreshes, so this is the only screen that polls this often.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function resolve(conversationId) {
    setBusy(conversationId);
    try {
      await fetch(`/api/conversations/${conversationId}/resolve`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  const { counts, waiting } = data;

  if (waiting.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 p-8 text-center">
        <p className="text-sm font-medium text-slate-700">Nobody is waiting for a pharmacist</p>
        <p className="mt-1 text-sm text-slate-500">
          Clinical questions the assistant will not answer appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-slate-700">
          {counts.total} waiting
        </span>
        {counts.urgent > 0 && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
            {counts.urgent} urgent
          </span>
        )}
        {counts.technical > 0 && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {counts.technical} not clinical
          </span>
        )}
      </div>

      {waiting.map((w) => (
        <article
          key={w.handoffId}
          className={`rounded-lg border ${
            w.urgent ? 'border-red-300 bg-red-50' : w.technical ? 'border-slate-200 bg-slate-50' : 'border-amber-300 bg-white'
          }`}
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/5 px-4 py-3">
            <div>
              <span className={`text-sm font-semibold ${w.urgent ? 'text-red-800' : 'text-slate-800'}`}>
                {w.urgent && '⚠ '}{w.headline}
              </span>
              <span className="ml-2 text-sm text-slate-600">{w.customer}</span>
            </div>
            <span className="text-xs text-slate-500">waiting {w.waiting}</span>
          </header>

          <div className="space-y-3 px-4 py-3">
            {/* Verbatim, and labelled as such so nobody mistakes it for our
                interpretation of what they meant. */}
            {w.trigger && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">They said</p>
                <p className="mt-1 border-l-2 border-slate-300 pl-3 text-sm text-slate-800">“{w.trigger}”</p>
              </div>
            )}

            {/* Anything since the handoff has had no reply from anyone —
                the assistant is muted and no human has picked it up. */}
            {w.unansweredSince > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
                  {w.unansweredSince} message{w.unansweredSince > 1 ? 's' : ''} since, unanswered
                </p>
                <ul className="mt-1 space-y-1">
                  {w.since.map((s, i) => (
                    <li key={i} className="border-l-2 border-amber-300 pl-3 text-sm text-slate-700">“{s}”</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              {w.discussed && <span>Discussed: {w.discussed}</span>}
              {w.pendingSuggestion && <span>Suggested: {w.pendingSuggestion}</span>}
              <span>{w.messageCount} messages</span>
              {w.awaitingCustomerAnswer && (
                <span className="text-slate-600">We offered a pharmacist — no answer yet</span>
              )}
            </div>
          </div>

          <footer className="flex gap-2 border-t border-black/5 px-4 py-2">
            <button
              onClick={() => onOpenConversation?.(w.conversationId)}
              className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
            >
              Open and reply
            </button>
            <button
              onClick={() => resolve(w.conversationId)}
              disabled={busy === w.conversationId}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {busy === w.conversationId ? 'Closing…' : 'Mark handled'}
            </button>
          </footer>
        </article>
      ))}
    </div>
  );
}
