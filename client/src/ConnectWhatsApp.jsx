/**
 * Connect WhatsApp — the pairing flow, Phase 2 task 2.4.
 *
 * Deliberately shows more than a finished product would: raw status, the
 * disconnect reason, and a live event log. This is the screen we debug the
 * session lifecycle from, and hiding the machinery now would mean adding it
 * back the first time a pairing misbehaves.
 *
 * NOTE ON AUTH: EventSource cannot send an Authorization header, so the SSE
 * endpoint works here because DEV_AUTH_BYPASS is on. Before this ships, that
 * stream needs a cookie session or a short-lived token in the query string.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import FieldHint from './FieldHint.jsx';

const STATUS_STYLES = {
  connected:    'bg-emerald-50 text-emerald-700 ring-emerald-200',
  pending_scan: 'bg-amber-50 text-amber-700 ring-amber-200',
  connecting:   'bg-sky-50 text-sky-700 ring-sky-200',
  disconnected: 'bg-slate-100 text-slate-600 ring-slate-200',
  logged_out:   'bg-rose-50 text-rose-700 ring-rose-200',
  banned:       'bg-rose-100 text-rose-800 ring-rose-300',
  failed:       'bg-rose-50 text-rose-700 ring-rose-200',
  pending:      'bg-slate-100 text-slate-600 ring-slate-200',
};

const STATUS_LABEL = {
  connected: 'Connected',
  pending_scan: 'Waiting for pairing code',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  logged_out: 'Logged out — re-pair needed',
  banned: 'Blocked by WhatsApp',
  failed: 'Failed',
  pending: 'Not connected',
};

async function api(path, options = {}) {
  const res = await fetch(`/api/whatsapp${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export default function ConnectWhatsApp() {
  const [status, setStatus] = useState(null);
  const [phone, setPhone] = useState('');
  const [pairing, setPairing] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [selfTest, setSelfTest] = useState(null);
  const [inbox, setInbox] = useState(null);
  const logRef = useRef(null);

  const log = useCallback((type, detail) => {
    setEvents((prev) => [
      { at: new Date().toLocaleTimeString(), type, detail },
      ...prev,
    ].slice(0, 60));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('/status'));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadInbox = useCallback(async () => {
    try {
      setInbox(await api('/messages?limit=25'));
    } catch { /* the status panel already reports connectivity problems */ }
  }, []);

  useEffect(() => { refresh(); loadInbox(); }, [refresh, loadInbox]);

  // Poll the durable rows rather than trusting the event stream. The SSE log
  // is ephemeral — it shows nothing that arrived before the page opened, and
  // that is exactly the question being asked here.
  useEffect(() => {
    // 5s here was the same mistake that exhausted Supabase's connection pool
    // via Inbox/Orders — see App.jsx and their POLL_MS comments. Same fix.
    const t = setInterval(loadInbox, 15000);
    return () => clearInterval(t);
  }, [loadInbox]);

  // Live connection events. The server filters to this tenant's account, so
  // everything arriving here is ours.
  useEffect(() => {
    let es = null;
    let cancelled = false;

    // A ticket, because EventSource cannot send an Authorization header.
    //
    // window.fetch is patched to attach the session token (auth.js), and
    // EventSource is not fetch — so this stream authenticated as nobody and
    // was refused, every time, in every deploy. The visible symptom was
    // "stream dropped — the browser will retry" sitting permanently on the
    // pairing screen while the live log stayed empty.
    //
    // The ticket is fetched (so it IS authenticated), single-use, and expires
    // in 30 seconds. It goes in the URL because that is the only channel
    // EventSource offers; the session token deliberately does not, since URLs
    // end up in access logs and browser history.
    (async () => {
      let url = '/api/whatsapp/events';
      try {
        const r = await fetch('/api/whatsapp/events/ticket', { method: 'POST' });
        if (r.ok) {
          const { ticket } = await r.json();
          if (ticket) url += `?ticket=${encodeURIComponent(ticket)}`;
        }
      } catch {
        // Fall through and open it anyway. Without a ticket the server
        // refuses and the browser retries — the same place we were before,
        // rather than a screen with no live log and no explanation.
      }
      if (cancelled) return;
      es = new EventSource(url);
      wire(es);
    })();

    function wire(es) {

    const on = (name, handler) => {
      es.addEventListener(name, (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch { /* keep-alive comment */ }
        handler(data);
      });
    };

    on('hello', (d) => setStatus(d));
    on('status', (d) => { log('status', `${d.status} — ${d.detail || ''}`); refresh(); });
    // 'socket-open', not 'open' — EventSource fires a native 'open' when the
    // stream itself connects, so listening for 'open' would log "WhatsApp
    // connected" on every page load.
    on('socket-open', (d) => { log('socket-open', `WhatsApp socket open as ${d.phoneNumber || 'unknown number'}`); refresh(); });
    on('pairing-code', (d) => log('pairing-code', d.code));
    on('reconnecting', (d) => log('reconnecting', `attempt ${d.attempt}, waiting ${Math.round(d.waitMs / 1000)}s`));
    on('session-dead', (d) => { log('session-dead', `${d.status} — ${d.detail}`); refresh(); });
    on('message', (d) => { log('message', `inbound from ${d.from}`); loadInbox(); });

      es.onerror = () => log('sse', 'stream dropped — the browser will retry');
    }

    return () => {
      cancelled = true;
      // Guarded: the ticket fetch is async, so unmounting before it resolves
      // leaves es null. Calling close() on that would throw inside a cleanup
      // function, where React cannot recover from it.
      if (es) es.close();
    };
    // loadInbox belongs here: the 'message' handler above calls it, and an
    // effect that closes over a function it does not declare will keep
    // calling the FIRST version of it forever. Safe to add — log, refresh and
    // loadInbox are all useCallback(..., []) with no dependencies of their
    // own, so the references never change and this stream is still opened
    // exactly once per mount rather than reconnecting on every render.
  }, [log, refresh, loadInbox]);

  async function connect() {
    setBusy('connect'); setError(null); setSelfTest(null);
    try {
      const res = await api('/connect', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber: phone }),
      });
      setPairing(res);
      log('pairing-code', res.pairingCode);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function runSelfTest() {
    setBusy('selftest'); setError(null);
    try {
      const res = await api('/selftest', { method: 'POST' });
      setSelfTest(`Sent to ${res.to}. Check that phone.`);
      log('selftest', `sent to ${res.to}`);
    } catch (err) {
      setError(err.message);
      setSelfTest(null);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect'); setError(null);
    try {
      await api('/disconnect', { method: 'POST' });
      setPairing(null); setSelfTest(null);
      log('disconnect', 'closed by dashboard');
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const s = status?.status || 'pending';
  const isConnected = s === 'connected';

  return (
    <section className="rounded-lg border border-slate-200 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Connect WhatsApp</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[s] || STATUS_STYLES.pending}`}>
          {STATUS_LABEL[s] || s}
        </span>
      </div>

      {status?.statusDetail && (
        <p className="mt-2 text-sm text-slate-600">{status.statusDetail}</p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-400">Number</dt>
          <dd className="tabular-nums">{status?.phoneNumber || '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Socket</dt>
          <dd>{status?.live ? 'live' : 'not live'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Credentials</dt>
          <dd>{status?.hasCredentials ? 'stored' : 'none'}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Last close</dt>
          <dd className="tabular-nums">{status?.disconnectReason || '—'}</dd>
        </div>
      </dl>

      {/* ---- pair ---- */}
      {!isConnected && (
        <div className="mt-6 border-t border-slate-100 pt-6">
          <label className="inline-flex items-center gap-1.5 text-sm font-medium" htmlFor="phone">
            WhatsApp number
            <FieldHint label="WhatsApp number">
              International format, digits only, including country code.
              Nigeria example: 2348012345678
            </FieldHint>
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="2348012345678"
              inputMode="numeric"
              className="w-56 rounded border border-slate-300 px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            <button
              onClick={connect}
              disabled={busy === 'connect' || phone.replace(/\D/g, '').length < 10}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {busy === 'connect' ? 'Requesting…' : 'Get pairing code'}
            </button>
          </div>
        </div>
      )}

      {pairing && !isConnected && (
        <div className="mt-5 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
            Enter this code on the phone
          </p>
          <p className="mt-2 font-mono text-3xl tracking-[0.2em] text-amber-900">
            {pairing.pairingCode}
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-amber-900">
            {pairing.instructions?.map((line, i) => <li key={i}>{line}</li>)}
          </ol>
          <p className="mt-3 text-xs text-amber-700">
            Codes expire after about three minutes. Request another if it lapses.
          </p>
        </div>
      )}

      {/* ---- connected actions ---- */}
      {isConnected && (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-6">
          <button
            onClick={runSelfTest}
            disabled={busy === 'selftest'}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy === 'selftest' ? 'Sending…' : 'Send self-test message'}
          </button>
          <button
            onClick={disconnect}
            disabled={busy === 'disconnect'}
            className="rounded border border-slate-300 px-4 py-2 text-sm disabled:opacity-40"
          >
            Disconnect
          </button>
          <p className="w-full text-xs text-slate-500">
            The socket being open is not proof a message can be delivered. The self-test is.
          </p>
        </div>
      )}

      {selfTest && (
        <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {selfTest}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      )}

      {/* ---- messages ---- */}
      <div className="mt-6 border-t border-slate-100 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Messages received
          </h3>
          {inbox?.counts && (
            <p className="font-mono text-xs text-slate-400 tabular-nums">
              {inbox.counts.messages} messages · {inbox.counts.customers} customers · {inbox.counts.queued_jobs} queued
            </p>
          )}
        </div>

        <div className="mt-2 max-h-64 overflow-y-auto rounded border border-slate-200">
          {(!inbox || inbox.messages.length === 0) && (
            <p className="p-3 text-sm text-slate-400">
              Nothing yet. Message {status?.phoneNumber || 'the connected number'} from another phone
              and it will appear here within a few seconds.
            </p>
          )}
          {inbox?.messages.map((m) => (
            <div key={m.id} className="flex gap-3 border-b border-slate-100 p-2 last:border-b-0">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                  m.direction === 'inbound'
                    ? 'bg-sky-50 text-sky-700'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {m.direction === 'inbound' ? 'in' : 'out'}
              </span>
              <span className="shrink-0 font-mono text-xs text-slate-500 tabular-nums">{m.from}</span>
              <span className="min-w-0 flex-1 break-words text-sm text-slate-800">
                {m.body || <em className="text-slate-400">(no text — media or unsupported type)</em>}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-400 tabular-nums">
                {new Date(m.at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ---- event log ---- */}
      <div className="mt-6 border-t border-slate-100 pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Live events
        </h3>
        <div ref={logRef} className="mt-2 max-h-56 overflow-y-auto rounded bg-slate-50 p-3 font-mono text-xs">
          {events.length === 0 && <p className="text-slate-400">Waiting for events…</p>}
          {events.map((e, i) => (
            <div key={i} className="flex gap-3 py-0.5">
              <span className="shrink-0 text-slate-400 tabular-nums">{e.at}</span>
              <span className="shrink-0 w-28 text-slate-500">{e.type}</span>
              <span className="text-slate-800 break-all">{e.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
