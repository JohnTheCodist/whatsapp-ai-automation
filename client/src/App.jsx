/**
 * App shell.
 *
 * Two areas, not one list. Setup is done once; Inbox and Orders are what
 * someone behind a counter opens every day — so they are tabs rather than
 * steps, and the tab carrying work to do says how much.
 */

import { useEffect, useRef, useState } from 'react';
import Overview from './Overview.jsx';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';
import Consultations from './Consultations.jsx';
import Inbox from './Inbox.jsx';
import Orders from './Orders.jsx';
import Requests from './Requests.jsx';
import AssistantSettings from './AssistantSettings.jsx';
import { playOrderChime, playConsultationAlarm, unlockChime, isUnlocked } from './orderChime.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  // Ahead of Inbox deliberately. The Inbox is every conversation; this is
  // only people waiting on a pharmacist, and a clinical question left sitting
  // behind a general list is the one thing here that can actually harm
  // someone.
  { id: 'consultations', label: 'Consultations' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'orders', label: 'Orders' },
  { id: 'requests', label: 'Requests' },
  { id: 'setup', label: 'Setup' },
];

export default function App() {
  const [tab, setTab] = useState('overview');
  const [health, setHealth] = useState(null);
  // Badge counts live in the shell so a staff member on the Orders tab still
  // sees that someone is waiting in the Inbox. A count only visible from
  // inside the tab it describes is useless.
  const [badges, setBadges] = useState({ consultations: 0, orders: 0, requests: 0 });
  const [soundOn, setSoundOn] = useState(false);
  // Set when a pharmacist opens a consultation, so the Inbox lands on that
  // conversation instead of making them find it again in a list.
  const [openConversationId, setOpenConversationId] = useState(null);
  const [consultationsWaiting, setConsultationsWaiting] = useState(0);
  // Silences the repeating alarm without pretending the queue is empty. The
  // badge and the card stay; only the sound stops. Reset whenever the queue
  // empties, so the next escalation is audible again without anyone having to
  // remember to un-mute.
  const [alarmSilenced, setAlarmSilenced] = useState(false);
  // The previous pending count, so the chime fires on an INCREASE rather than
  // on every poll. Without this it would ring every 30 seconds for as long as
  // an order sat unconfirmed, which is how an alert gets muted forever.
  const prevPending = useRef(null);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        // /api/summary, not the two full endpoints. This previously re-fetched
        // every conversation and every order — with their joins and payloads —
        // every ten seconds, to read two integers. Combined with the tabs
        // polling the same endpoints, it exhausted Supabase's 15-client
        // pooler, which then surfaced as DNS and connection-reset errors that
        // looked like a broken network.
        const s = await fetch('/api/summary').then((r) => r.json());
        if (!cancelled) {
          const pending = s?.pending_orders || 0;
          setBadges((b) => ({
            ...b,
            // open_handoffs counts people waiting on a pharmacist, so it
            // belongs on Consultations. It sat on Inbox until that tab
            // existed, where it read as "unread messages" and understated
            // what it actually was.
            consultations: s?.open_handoffs || 0,
            orders: pending,
            requests: s?.open_requests ?? b.requests,
          }));

          // Ring only when the count GOES UP. The first poll seeds the
          // baseline without ringing, so opening the dashboard to five
          // waiting orders does not sound an alarm about old news.
          if (prevPending.current !== null && pending > prevPending.current) {
            playOrderChime();
          }
          prevPending.current = pending;

          // A waiting consultation keeps sounding, unlike an order, which
          // rings once. Someone with a symptom waiting is not a notification
          // you acknowledge by noticing it — it repeats until a pharmacist
          // has actually dealt with them, or until it is silenced on purpose.
          setConsultationsWaiting(s?.open_handoffs || 0);
        }
      } catch { /* the tabs still work without badges */ }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // The repeating alarm. Every 15s while anyone is waiting on a pharmacist —
  // often enough to be impossible to ignore, not so often it becomes noise.
  useEffect(() => {
    if (consultationsWaiting === 0) {
      // Queue cleared: re-arm. Otherwise a silence earlier today would mute
      // tonight's escalation too, and nobody would know it had.
      if (alarmSilenced) setAlarmSilenced(false);
      return undefined;
    }
    if (alarmSilenced || !soundOn || !isUnlocked()) return undefined;

    playConsultationAlarm();
    const t = setInterval(playConsultationAlarm, 15000);
    return () => clearInterval(t);
  }, [consultationsWaiting, alarmSilenced, soundOn]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp AI Automation</h1>
          <p className="mt-1 text-sm text-slate-600">
            WhatsApp customer service and sales for independent pharmacies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Browsers refuse to play audio until the user clicks something, so
              this cannot be a passive setting — it has to be a real click, and
              it has to say plainly whether sound is actually working. A
              pharmacist trusting an alert that is silently blocked is worse
              off than one who knows there is none. */}
          <button
            type="button"
            onClick={async () => {
              if (soundOn) { setSoundOn(false); return; }
              const ok = await unlockChime();
              setSoundOn(ok);
              if (ok) playOrderChime({ repeats: 1 });
            }}
            className={`rounded border px-2 py-0.5 text-xs transition ${
              soundOn && isUnlocked()
                ? 'border-teal-300 bg-teal-50 text-teal-800'
                : 'border-slate-300 text-slate-500 hover:bg-slate-50'
            }`}
            title={soundOn ? 'New-order sound is on. Click to mute.' : 'Click to turn on a sound for new orders.'}
          >
            {soundOn && isUnlocked() ? '🔔 Sound on' : '🔕 Sound off'}
          </button>
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              health?.status === 'ok' ? 'bg-teal-100 text-teal-800' : 'bg-red-100 text-red-700'
            }`}
          >
            {health ? health.status : 'checking…'}
          </span>
        </div>
      </header>

      {/* Impossible to miss, and it names the action rather than just the
          number — "1 waiting" invites acknowledgement, "go and reply" does
          not. Sits above the tabs so it is visible from every screen. */}
      {consultationsWaiting > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800">
            {consultationsWaiting === 1
              ? 'Someone is waiting to speak to a pharmacist'
              : `${consultationsWaiting} people are waiting to speak to a pharmacist`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTab('consultations')}
              className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
            >
              Open consultations
            </button>
            {soundOn && isUnlocked() && (
              <button
                type="button"
                onClick={() => setAlarmSilenced((s) => !s)}
                className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-800 hover:bg-red-100"
              >
                {alarmSilenced ? 'Sound silenced' : 'Silence sound'}
              </button>
            )}
          </div>
        </div>
      )}

      <nav className="mt-8 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition
              ${tab === t.id
                ? 'border-slate-900 font-medium text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
            {badges[t.id] > 0 && (
              <span className={`rounded-full px-1.5 text-[11px] font-medium ${
                t.id === 'consultations' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
              }`}>
                {badges[t.id]}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {/* onNavigate lets the Overview's cards be the way you get to the
            work, rather than a wall of numbers you then have to act on by
            hunting for the right tab. */}
        {tab === 'overview' && <Overview onNavigate={setTab} />}
        {tab === 'consultations' && (
          <Consultations
            onOpenConversation={(id) => { setOpenConversationId(id); setTab('inbox'); }}
          />
        )}
        {tab === 'inbox' && <Inbox openConversationId={openConversationId} />}
        {tab === 'orders' && <Orders />}
        {tab === 'requests' && (
          <Requests onCount={(n) => setBadges((b) => (b.requests === n ? b : { ...b, requests: n }))} />
        )}
        {tab === 'setup' && (
          <div className="space-y-4">
            <AssistantSettings />
            <ConnectWhatsApp />
            <UploadCatalogue />
            <section className="rounded-lg border border-slate-200 p-5">
              <h2 className="font-medium">API status</h2>
              <pre className="mt-2 overflow-x-auto text-xs text-slate-600">
                {health ? JSON.stringify(health, null, 2) : 'Checking…'}
              </pre>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
