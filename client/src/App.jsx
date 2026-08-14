/**
 * App shell — CRM chrome.
 *
 * LAYOUT
 *   left rail   fixed, icon + label, badge per section
 *   top bar     identity, search, live status, sound
 *   canvas      the active section
 *
 * WHY A RAIL AND NOT TABS
 * Seven sections is where a horizontal tab strip stops working: the labels
 * either wrap or truncate, and the badge that says four people are waiting
 * ends up in whichever tab happened to fit. A rail holds a stable number of
 * fixed positions, so staff learn where Consultations is and hit it without
 * reading — which matters most for the one section where waiting has a cost.
 *
 * COLOUR IS DOMAIN, NOT DECORATION
 * The rail is deep slate with a teal active state, continuing the accent the
 * rest of the app already uses. Semantic colour is kept separate from it:
 * red means someone is waiting, amber means work is queued, and neither is
 * ever the accent — so an alert can never be mistaken for "the active tab".
 */

import { useEffect, useRef, useState } from 'react';
import Overview from './Overview.jsx';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';
import Consultations from './Consultations.jsx';
import Inbox from './Inbox.jsx';
import Orders from './Orders.jsx';
import Requests from './Requests.jsx';
import Customers from './Customers.jsx';
import AssistantSettings from './AssistantSettings.jsx';
import { playOrderChime, playConsultationAlarm, unlockChime, isUnlocked } from './orderChime.js';
import {
  IconOverview, IconConsultations, IconInbox, IconOrders, IconRequests,
  IconCustomers, IconSetup, IconSearch, IconBellOn, IconBellOff, IconLink,
} from './Icons.jsx';

const SECTIONS = [
  { id: 'overview', label: 'Overview', Icon: IconOverview, title: 'Overview' },
  // Ahead of Inbox deliberately. The Inbox is every conversation; this is
  // only people waiting on a pharmacist, and a clinical question left sitting
  // behind a general list is the one thing here that can actually harm
  // someone.
  { id: 'consultations', label: 'Consult', Icon: IconConsultations, title: 'Consultations' },
  { id: 'inbox', label: 'Inbox', Icon: IconInbox, title: 'Inbox' },
  { id: 'orders', label: 'Orders', Icon: IconOrders, title: 'Orders' },
  { id: 'requests', label: 'Requests', Icon: IconRequests, title: 'Product requests' },
  { id: 'customers', label: 'Patients', Icon: IconCustomers, title: 'Patients' },
  { id: 'setup', label: 'Setup', Icon: IconSetup, title: 'Setup' },
];

const SUBTITLE = {
  overview: 'What needs you today',
  consultations: 'People waiting to speak to a pharmacist',
  inbox: 'Every conversation on this number',
  orders: 'Reservations awaiting confirmation',
  requests: 'Asked for, not in the catalogue',
  customers: 'One record per person, per pharmacy',
  setup: 'Connection, catalogue and assistant identity',
};

export default function App() {
  const [tab, setTab] = useState('overview');
  const [health, setHealth] = useState(null);
  // Badge counts live in the shell so a staff member on the Orders tab still
  // sees that someone is waiting in Consultations. A count only visible from
  // inside the tab it describes is useless.
  const [badges, setBadges] = useState({ consultations: 0, orders: 0, requests: 0 });
  const [soundOn, setSoundOn] = useState(false);
  const [openConversationId, setOpenConversationId] = useState(null);
  const [consultationsWaiting, setConsultationsWaiting] = useState(0);
  const [alarmSilenced, setAlarmSilenced] = useState(false);
  // Header search. Submitting jumps to Patients with the term applied — a
  // search box that only decorates the header would be worse than none.
  const [search, setSearch] = useState('');
  const [patientQuery, setPatientQuery] = useState('');
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
        // every ten seconds, to read two integers, and exhausted the pooler.
        const s = await fetch('/api/summary').then((r) => r.json());
        if (!cancelled) {
          const pending = s?.pending_orders || 0;
          setBadges((b) => ({
            ...b,
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
          setConsultationsWaiting(s?.open_handoffs || 0);
        }
      } catch { /* the sections still work without badges */ }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // The repeating alarm. Every 15s while anyone is waiting on a pharmacist —
  // often enough to be impossible to ignore, not so often it becomes noise.
  useEffect(() => {
    if (consultationsWaiting === 0) {
      if (alarmSilenced) setAlarmSilenced(false);
      return undefined;
    }
    if (alarmSilenced || !soundOn || !isUnlocked()) return undefined;
    playConsultationAlarm();
    const t = setInterval(playConsultationAlarm, 15000);
    return () => clearInterval(t);
  }, [consultationsWaiting, alarmSilenced, soundOn]);

  const connected = health?.status === 'ok';
  const active = SECTIONS.find((s) => s.id === tab) || SECTIONS[0];

  function submitSearch(e) {
    e.preventDefault();
    if (!search.trim()) return;
    setPatientQuery(search.trim());
    setTab('customers');
  }

  return (
    <div className="flex min-h-screen bg-slate-100">
      {/* ---------------------------------------------------------------- rail */}
      <nav
        aria-label="Sections"
        className="sticky top-0 flex h-screen w-[86px] shrink-0 flex-col items-center gap-1 bg-slate-900 py-4"
      >
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300">
          {/* The product mark: a cross in a speech bubble — pharmacy, over chat. */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"
              stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
            />
            <path d="M12 7.5v6M9 10.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </div>

        {SECTIONS.map(({ id, label, Icon }) => {
          const isActive = tab === id;
          const count = badges[id] || 0;
          // Consultations is the only red badge. Everything else is queued
          // work; that one is a person waiting, and the colour has to say so
          // from across the room.
          const urgent = id === 'consultations';
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex w-[70px] flex-col items-center gap-1 rounded-xl px-1 py-2.5 transition
                focus:outline-2 focus:outline-offset-2 focus:outline-teal-400
                ${isActive
                  ? 'bg-teal-500/15 text-teal-300'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
            >
              {/* The active marker is a shape, not just a tint — a rail that
                  relies on colour alone loses its "you are here" for anyone
                  who cannot separate the two greys. */}
              {isActive && (
                <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r bg-teal-400" />
              )}
              <span className="relative">
                <Icon />
                {count > 0 && (
                  <span
                    className={`absolute -right-2.5 -top-1.5 min-w-[17px] rounded-full px-1 text-[10px] font-semibold leading-[17px] text-white
                      ${urgent ? 'bg-red-500' : 'bg-amber-500'}`}
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </span>
              <span className="text-[10.5px] font-medium tracking-tight">{label}</span>
            </button>
          );
        })}

        <div className="mt-auto flex flex-col items-center gap-1.5 pt-3">
          {/* Live socket state, in the rail rather than buried in Setup: if
              WhatsApp drops, nothing else on any screen is true. */}
          <span
            title={connected ? 'Connected to WhatsApp' : `Not connected (${health?.status || 'checking'})`}
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              connected ? 'bg-teal-500/15 text-teal-300' : 'bg-red-500/20 text-red-300'
            }`}
          >
            <IconLink width={16} height={16} />
          </span>
          <span className={`text-[9.5px] font-medium ${connected ? 'text-teal-400' : 'text-red-300'}`}>
            {connected ? 'Live' : 'Down'}
          </span>
        </div>
      </nav>

      {/* -------------------------------------------------------------- column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---- top bar ---- */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-slate-200 bg-white px-5">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold tracking-tight text-slate-900">
              Sterling Pharmacy
            </p>
            <p className="truncate text-[11px] text-slate-500">WhatsApp assistant</p>
          </div>

          <form onSubmit={submitSearch} className="mx-auto hidden w-full max-w-md sm:block">
            <label className="relative block">
              <span className="sr-only">Search patients by name or phone</span>
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                <IconSearch width={16} height={16} />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search patients by name or phone…"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm
                           placeholder:text-slate-400 focus:border-teal-500 focus:bg-white
                           focus:outline-2 focus:outline-offset-0 focus:outline-teal-500/30"
              />
            </label>
          </form>

          <div className="ml-auto flex items-center gap-1.5">
            {/* Browsers refuse to play audio until the user clicks something,
                so this cannot be a passive setting — it has to be a real
                click, and it has to say plainly whether sound is actually
                working. A pharmacist trusting an alert that is silently
                blocked is worse off than one who knows there is none. */}
            <button
              type="button"
              onClick={async () => {
                if (soundOn) { setSoundOn(false); return; }
                const ok = await unlockChime();
                setSoundOn(ok);
                if (ok) playOrderChime({ repeats: 1 });
              }}
              title={soundOn && isUnlocked() ? 'Alert sound is on. Click to mute.' : 'Click to turn alert sounds on.'}
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition
                focus:outline-2 focus:outline-offset-1 focus:outline-teal-500
                ${soundOn && isUnlocked()
                  ? 'bg-teal-50 text-teal-700'
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`}
            >
              {soundOn && isUnlocked() ? <IconBellOn width={17} height={17} /> : <IconBellOff width={17} height={17} />}
            </button>
            <span
              className={`hidden items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium sm:flex ${
                connected ? 'bg-teal-50 text-teal-700' : 'bg-red-50 text-red-700'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-teal-500' : 'bg-red-500'}`} />
              {health ? (connected ? 'All systems go' : health.status) : 'Checking…'}
            </span>
          </div>
        </header>

        {/* ---- the one thing that outranks whatever screen you are on ---- */}
        {consultationsWaiting > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-5 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium text-red-800">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-600" />
              </span>
              {consultationsWaiting === 1
                ? 'Someone is waiting to speak to a pharmacist'
                : `${consultationsWaiting} people are waiting to speak to a pharmacist`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTab('consultations')}
                className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800
                           focus:outline-2 focus:outline-offset-1 focus:outline-red-900"
              >
                Open consultations
              </button>
              {soundOn && isUnlocked() && (
                <button
                  type="button"
                  onClick={() => setAlarmSilenced((s) => !s)}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-800 hover:bg-red-100
                             focus:outline-2 focus:outline-offset-1 focus:outline-red-700"
                >
                  {alarmSilenced ? 'Sound silenced' : 'Silence sound'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---- canvas ---- */}
        <main className="flex-1 px-5 py-6">
          <div className="mx-auto max-w-6xl">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-slate-900">{active.title}</h1>
                <p className="mt-0.5 text-sm text-slate-500">{SUBTITLE[active.id]}</p>
              </div>
              {badges[active.id] > 0 && (
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                    active.id === 'consultations' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {badges[active.id]} waiting
                </span>
              )}
            </div>

            {/* onNavigate lets the Overview's cards be the way you get to the
                work, rather than a wall of numbers you then have to act on by
                hunting for the right section. */}
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
            {tab === 'customers' && (
              <Customers
                initialQuery={patientQuery}
                onOpenConversation={(id) => { setOpenConversationId(id); setTab('inbox'); }}
                onNavigate={setTab}
              />
            )}
            {tab === 'setup' && (
              <div className="space-y-4">
                <AssistantSettings />
                <ConnectWhatsApp />
                <UploadCatalogue />
                <section className="rounded-lg border border-slate-200 bg-white p-5">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">API status</h2>
                  <pre className="mt-2 overflow-x-auto text-xs text-slate-600">
                    {health ? JSON.stringify(health, null, 2) : 'Checking…'}
                  </pre>
                </section>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
