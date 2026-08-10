/**
 * Staff inbox.
 *
 * The other half of the safety design. The clinical filter escalates by
 * muting the assistant and writing a handoff — which, until this screen
 * existed, meant a customer asking about a drug interaction got silence.
 *
 * DESIGN NOTE
 * This is scanned, not read. Anything waiting on a person sorts to the top
 * and carries a red stripe; everything else is quiet. A staff member glancing
 * at this between customers should be able to tell in under a second whether
 * anyone needs them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// 5s was chosen without thinking and helped exhaust the database pooler.
// The list refreshes on every action anyway, so this only covers messages
// arriving while nobody is clicking.
const POLL_MS = 15000;
// The open thread is what someone is actually watching, so it stays quicker.
const THREAD_POLL_MS = 8000;

const MODE_STYLE = {
  bot: 'bg-slate-100 text-slate-600',
  human: 'bg-amber-100 text-amber-800',
  closed: 'bg-slate-100 text-slate-400',
};

const AUTHOR_STYLE = {
  customer: 'bg-white border border-slate-200 text-slate-800',
  assistant: 'bg-teal-600 text-white',
  staff: 'bg-blue-600 text-white',
  system: 'bg-slate-200 text-slate-700 italic',
};

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function Inbox() {
  const [list, setList] = useState(null);
  const [counts, setCounts] = useState({ open_handoffs: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch('/api/conversations');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load conversations.');
      setList(j.conversations);
      setCounts(j.counts);
      // Clearing on success matters more than it looks. This polls every few
      // seconds against a remote database, and a single dropped connection
      // would otherwise pin "Something went wrong" to the screen for the rest
      // of the day while everything behind it worked perfectly.
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const loadThread = useCallback(async (id) => {
    if (!id) return;
    try {
      const r = await fetch(`/api/conversations/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load the conversation.');
      setThread(j);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, POLL_MS);
    return () => clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    loadThread(selectedId);
    if (!selectedId) return undefined;
    const t = setInterval(() => loadThread(selectedId), THREAD_POLL_MS);
    return () => clearInterval(t);
  }, [selectedId, loadThread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages?.length]);

  async function act(path, body) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/conversations/${selectedId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'That did not work.');
      await Promise.all([loadThread(selectedId), loadList()]);
      return j;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(e) {
    e.preventDefault();
    const text = reply.trim();
    if (!text) return;
    const result = await act('reply', { text });
    if (result) setReply('');
  }

  const isHuman = thread?.conversation?.mode === 'human';
  const openHandoff = thread?.handoffs?.find((h) => !h.resolved_at);

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex items-baseline justify-between gap-4 border-b border-slate-200 px-5 py-4">
        <h2 className="font-medium">Inbox</h2>
        {counts.open_handoffs > 0 ? (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            {counts.open_handoffs} waiting for a person
          </span>
        ) : (
          <span className="text-xs text-slate-400">Nothing needs a person</span>
        )}
      </header>

      {error && (
        <p className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="grid md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        {/* ---- list ---- */}
        <ul className="max-h-[32rem] overflow-y-auto border-b border-slate-200 md:border-b-0 md:border-r">
          {list === null && <li className="px-5 py-4 text-sm text-slate-500">Loading…</li>}
          {list?.length === 0 && (
            <li className="px-5 py-4 text-sm text-slate-500">No conversations yet.</li>
          )}
          {list?.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={`flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left transition
                  ${c.handoff_id ? 'border-l-red-500 bg-red-50/40' : 'border-l-transparent'}
                  ${selectedId === c.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {c.display_name || c.wa_phone}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{timeAgo(c.last_message_at)}</span>
                </div>
                <p className="truncate text-xs text-slate-500">
                  {c.last_direction === 'outbound' && <span className="text-slate-400">You: </span>}
                  {c.last_body || '(no text)'}
                </p>
                {c.handoff_id && (
                  <span className="mt-0.5 w-fit rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
                    {c.handoff_reason} · waiting {timeAgo(c.handoff_at)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        {/* ---- thread ---- */}
        <div className="flex min-h-[24rem] flex-col">
          {!selectedId && (
            <p className="m-auto text-sm text-slate-400">Pick a conversation.</p>
          )}

          {selectedId && thread && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {thread.conversation.display_name || thread.conversation.wa_phone}
                  </p>
                  <p className="text-xs text-slate-500">{thread.conversation.wa_phone}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${MODE_STYLE[thread.conversation.mode]}`}>
                    {thread.conversation.mode === 'bot' ? 'assistant replying' : thread.conversation.mode}
                  </span>
                  {!isHuman ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act('takeover')}
                      className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Take over
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => act('release')}
                      className="rounded border border-slate-300 px-3 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Hand back to assistant
                    </button>
                  )}
                </div>
              </div>

              {openHandoff && (
                <div className="flex items-start justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2">
                  <p className="text-xs text-red-800">
                    <strong className="font-semibold">Escalated ({openHandoff.reason}).</strong>{' '}
                    {openHandoff.detail}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act('resolve')}
                    className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs text-red-800 disabled:opacity-50"
                  >
                    Mark handled
                  </button>
                </div>
              )}

              {thread.orders?.length > 0 && (
                <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                  <p className="text-xs text-slate-600">
                    Orders:{' '}
                    {thread.orders.map((o) => (
                      <span key={o.id} className="mr-2 font-mono">
                        {o.reference} <span className="text-slate-400">({o.status})</span>
                      </span>
                    ))}
                  </p>
                </div>
              )}

              <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 px-4 py-4">
                {thread.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.direction === 'inbound' ? 'justify-start' : 'justify-end'}`}
                  >
                    <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${AUTHOR_STYLE[m.author] || AUTHOR_STYLE.system}`}>
                      {m.body || <span className="opacity-60">(no text — media or unsupported)</span>}
                      <div className="mt-1 flex items-center gap-2 text-[11px] opacity-70">
                        {/* Who said it is not cosmetic: a complaint about
                            what "the pharmacy" said needs to distinguish a
                            person from the assistant. */}
                        <span>{m.author}</span>
                        <span>{new Date(m.created_at).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>

              <form onSubmit={sendReply} className="border-t border-slate-200 p-3">
                {!isHuman && (
                  <p className="mb-2 text-xs text-amber-700">
                    The assistant is still replying here. Take over first so it does not talk over you.
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder={isHuman ? 'Type a reply…' : 'Take over to reply'}
                    disabled={!isHuman || busy}
                    className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
                  />
                  <button
                    type="submit"
                    disabled={!isHuman || busy || !reply.trim()}
                    className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
