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
import AiPerformance from './AiPerformance.jsx';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';
import Consultations from './Consultations.jsx';
import Inbox from './Inbox.jsx';
import Orders from './Orders.jsx';
import Requests from './Requests.jsx';
import Customers from './Customers.jsx';
import Settings from './Settings.jsx';
import AccountMenu from './AccountMenu.jsx';
import { playOrderChime, playConsultationAlarm, unlockChime, isUnlocked } from './orderChime.js';
import {
  IconOverview, IconConsultations, IconInbox, IconOrders, IconRequests,
  IconCustomers, IconSetup, IconSearch, IconBellOn, IconBellOff, IconLink, IconAi,
  IconInventory, IconUpload, IconDeals,
} from './Icons.jsx';

const SECTIONS = [
  { id: 'overview', label: 'Overview', Icon: IconOverview, title: 'Overview' },
  // Directly after Overview, because it answers the follow-up question rather
  // than a new one: Overview says how the business is doing, this says how
  // much of that the assistant is responsible for. It used to be five
  // sections stacked underneath Overview, which pushed the alerts — the only
  // thing on that screen that is ever urgent — below the fold.
  { id: 'ai', label: 'AI', Icon: IconAi, title: 'AI performance' },
  // Ahead of Inbox deliberately. The Inbox is every conversation; this is
  // only people waiting on a pharmacist, and a clinical question left sitting
  // behind a general list is the one thing here that can actually harm
  // someone.
  { id: 'consultations', label: 'Consult', Icon: IconConsultations, title: 'Consultations' },
  // Inbox, Orders and Requests are ONE rail item and three segments, not
  // three rail items. They are the same job at three stages — someone asked,
  // it became an order, or we could not supply it — and as siblings in the
  // rail they read as unrelated places, so working a single customer meant
  // hopping the sidebar and losing your position each time.
  //
  // Their tab ids are deliberately UNCHANGED. Every onNavigate('orders') in
  // the app still lands exactly where it did; the grouping is presentation,
  // so nothing that already navigates here had to be touched.
  {
    id: 'deals',
    label: 'Manage Deals',
    Icon: IconDeals,
    title: 'Manage Deals',
    children: [
      { id: 'inbox', label: 'Inbox', Icon: IconInbox },
      { id: 'orders', label: 'Orders', Icon: IconOrders },
      { id: 'requests', label: 'Requests', Icon: IconRequests },
    ],
  },
  { id: 'customers', label: 'Patients', Icon: IconCustomers, title: 'Patients' },
  // Inventory is daily work, not configuration. Buried in Setup it sat beside
  // one-off things like the WhatsApp pairing and the assistant's name, so the
  // one screen a pharmacy touches every week lived behind the screens they
  // touch once. Two segments, because uploading a file and checking what the
  // assistant can actually sell are different jobs done at different times.
  {
    id: 'inventory',
    label: 'Inventory',
    Icon: IconInventory,
    title: 'Inventory',
    children: [
      { id: 'inventory', label: 'Products', Icon: IconInventory },
      { id: 'inventory-upload', label: 'Upload', Icon: IconUpload },
    ],
  },
];

/**
 * Setup is deliberately NOT in SECTIONS.
 *
 * It is configuration, not work — connection, catalogue mapping, assistant
 * identity, opening hours. Sitting in the same list as the queues gave it
 * equal weight with screens that carry live customer work, and it is opened
 * roughly once a month. It now lives with the connection status at the foot
 * of the rail, which is the other thing on this screen that is about the
 * installation rather than the day.
 */
const SETUP = { id: 'setup', label: 'Setup', Icon: IconSetup, title: 'Setup' };

const SUBTITLE = {
  overview: 'How the pharmacy is doing',
  ai: 'What the assistant is handling, and what it is passing to you',
  consultations: 'People waiting to speak to a pharmacist',
  inbox: 'Every conversation on this number',
  orders: 'Reservations awaiting confirmation',
  requests: 'Asked for, not in the catalogue',
  customers: 'One record per person, per pharmacy',
  inventory: 'What the assistant can see and sell',
  'inventory-upload': 'What the assistant can see and sell',
  setup: 'Connection, catalogue and assistant identity',
};

/** Flattened once, so a child tab can find its parent without a nested scan. */
const PARENT_OF = Object.fromEntries(
  SECTIONS.flatMap((s) => (s.children || []).map((c) => [c.id, s])),
);

/**
 * The rail item that should look active for a given tab — itself, or its
 * parent. SETUP is checked explicitly because it deliberately lives outside
 * SECTIONS now (see its own note); without this, opening Setup would fall
 * through to SECTIONS[0] and light "Overview" instead.
 */
function sectionFor(tab) {
  if (tab === SETUP.id) return SETUP;
  return PARENT_OF[tab] || SECTIONS.find((s) => s.id === tab) || SECTIONS[0];
}

export default function App({ onSignOut, pharmacy = null, email = '' }) {
  const [tab, setTab] = useState('overview');
  const [health, setHealth] = useState(null);
  // The name shown in the account chip. Handed down by AuthGate when there is
  // a session; fetched here only for the DEV_AUTH_BYPASS path, which renders
  // App directly and so has no pharmacy to pass. Seeded from the prop rather
  // than fetched-then-replaced, so the common case never flashes a
  // placeholder name.
  const [pharmacyName, setPharmacyName] = useState(pharmacy?.name || '');
  // Badge counts live in the shell so a staff member on the Orders tab still
  // sees that someone is waiting in Consultations. A count only visible from
  // inside the tab it describes is useless.
  const [badges, setBadges] = useState({ consultations: 0, orders: 0, requests: 0 });
  // Defaults ON, not off — a pharmacy team should not have to discover and
  // flip a switch before an actionable alert (a new order, a pharmacist
  // handoff) makes any sound. Read from localStorage so the choice survives
  // a reload rather than resetting to silent every time the tab reopens.
  // Genuinely per-device on purpose: a shop floor has several screens, and
  // one staff member muting theirs must not mute a colleague's.
  const [soundOn, setSoundOn] = useState(() => {
    const stored = localStorage.getItem('staffNotificationSound');
    return stored === null ? true : stored === 'true';
  });
  const [openConversationId, setOpenConversationId] = useState(null);
  const [consultationsWaiting, setConsultationsWaiting] = useState(0);
  const [alarmSilenced, setAlarmSilenced] = useState(false);
  // Header search. Submitting jumps to Patients with the term applied — a
  // search box that only decorates the header would be worse than none.
  const [search, setSearch] = useState('');
  const [patientQuery, setPatientQuery] = useState('');
  const prevPending = useRef(null);

  // Persists the on/off PREFERENCE, independent of whether the browser has
  // actually unlocked audio yet (see the toggle button's click handler).
  useEffect(() => {
    localStorage.setItem('staffNotificationSound', String(soundOn));
  }, [soundOn]);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  // Keeps the chip in step when the pharmacy is renamed in Settings, and
  // covers the bypass path that mounts App with no pharmacy prop at all.
  useEffect(() => {
    if (pharmacy?.name) { setPharmacyName(pharmacy.name); return undefined; }
    let cancelled = false;
    fetch('/api/pharmacies/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const p = j?.pharmacy || j;
        if (!cancelled && p?.name) setPharmacyName(p.name);
      })
      // No name is a chip that says "Your pharmacy" — not worth an error
      // state on a shell that is otherwise working.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pharmacy?.name]);

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
  const active = sectionFor(tab);
  // The segments of the group currently open, or none. Drives both the
  // sub-nav and the "is this rail item lit" test below.
  const segments = active.children || null;

  function submitSearch(e) {
    e.preventDefault();
    if (!search.trim()) return;
    setPatientQuery(search.trim());
    setTab('customers');
  }

  return (
    <div className="flex min-h-screen bg-[var(--ui-paper)]">
      {/* ---------------------------------------------------------------- rail */}
      <nav
        aria-label="Sections"
        className="sticky top-0 flex h-screen w-[214px] shrink-0 flex-col gap-1 border-r border-[var(--ui-line)] bg-[var(--ui-surface)] px-3 py-4"
      >
        <div className="mb-5 flex items-center gap-2.5 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--ui-accent)] text-white">
            {/* The product mark: a cross in a speech bubble — pharmacy, over chat. */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z"
                stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
              />
              <path d="M12 7.5v6M9 10.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-[var(--ui-ink)]">RxNaija</span>
        </div>

        <span className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-ink-faint)]">
          Workspace
        </span>

        {SECTIONS.map(({ id, label, Icon, children }) => {
          // A group is lit when any of its segments is open, so "Manage Deals"
          // stays highlighted while you move between Inbox, Orders and
          // Requests — the rail should say which room you are in, not go dark
          // because you changed desk.
          const isActive = children ? children.some((c) => c.id === tab) : tab === id;
          // A group carries the sum of its segments. Collapsing three items
          // must not also collapse the reason to look at them: if two orders
          // and a request are waiting, the rail still says 3.
          const count = children
            ? children.reduce((n, c) => n + (badges[c.id] || 0), 0)
            : (badges[id] || 0);
          // Consultations is the only red badge. Everything else is queued
          // work; that one is a person waiting, and the colour has to say so
          // from across the room.
          const urgent = id === 'consultations';
          return (
            <button
              key={id}
              type="button"
              // A group opens on its FIRST segment only when you are not
              // already inside it — clicking "Manage Deals" while reading an
              // order must not throw you back to the Inbox.
              onClick={() => setTab(children ? (isActive ? tab : children[0].id) : id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition
                ${isActive
                  ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]'
                  : 'text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]'}`}
            >
              {/* The active marker is a shape, not just a tint — a rail that
                  relies on colour alone loses its "you are here" for anyone
                  who cannot separate the two greys. */}
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[var(--ui-accent)]" />
              )}
              <span className="shrink-0"><Icon /></span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">{label}</span>
              {count > 0 && (
                <span
                  className={`ml-auto min-w-[19px] shrink-0 rounded-full px-1.5 text-center text-[10px] font-semibold leading-[18px] text-white
                    ${urgent ? 'bg-red-500' : 'bg-amber-500'}`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}

        <div className="mt-auto pt-3">
          {/* Sign out is no longer here — it lives in the account menu at the
              top right, next to the name of the account it signs you out of.
              It used to sit directly above this connection panel, which put a
              destructive once-a-day action in the corner staff scan most. */}
          <span className="block px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-ink-faint)]">
            Connection
          </span>
          {/* Live socket state, in the rail rather than buried in Setup: if
              WhatsApp drops, nothing else on any screen is true. */}
          <div
            title={connected ? 'Connected to WhatsApp' : `Not connected (${health?.status || 'checking'})`}
            className="flex items-center gap-2.5 rounded-[9px] border border-[var(--ui-line)] px-2.5 py-2"
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                connected ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]' : 'bg-red-50 text-red-600'
              }`}
            >
              <IconLink width={15} height={15} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ui-ink-soft)]">WhatsApp</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                connected ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]' : 'bg-red-50 text-red-700'
              }`}
            >
              {connected ? 'Live' : 'Down'}
            </span>
          </div>

          {/* Setup, directly beneath the connection it configures. Both are
              about the installation rather than today's work, which is why
              they sit together at the foot of the rail instead of competing
              with the queues above. */}
          <button
            type="button"
            onClick={() => setTab(SETUP.id)}
            aria-current={tab === SETUP.id ? 'page' : undefined}
            className={`relative mt-1 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition
              ${tab === SETUP.id
                ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]'
                : 'text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]'}`}
          >
            {tab === SETUP.id && (
              <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[var(--ui-accent)]" />
            )}
            <span className="shrink-0"><SETUP.Icon /></span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">{SETUP.label}</span>
          </button>
        </div>
      </nav>

      {/* -------------------------------------------------------------- column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---- top bar ---- */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-[var(--ui-line)] bg-[var(--ui-surface)] px-5">
          {/* The pharmacy's name used to be hardcoded here as "Sterling
              Pharmacy" — one tenant's name shown to every tenant. It now
              comes from the account chip on the right, which reads the real
              one, so this corner is free for the search that was previously
              squeezed between two blocks of text. */}

          <form onSubmit={submitSearch} className="w-full max-w-md">
            <label className="relative block">
              <span className="sr-only">Search patients by name or phone</span>
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                <IconSearch width={16} height={16} />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search patients by name or phone…"
                className="w-full rounded-[9px] border border-[var(--ui-line)] bg-[var(--ui-sunk)] py-1.5 pl-9 pr-3 text-sm
                           placeholder:text-[var(--ui-ink-faint)] focus:border-[var(--ui-accent)] focus:bg-[var(--ui-surface)]"
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
                // Branches on whether sound is ACTUALLY playing, not just on
                // the stored preference — the two can now disagree. A fresh
                // page load has soundOn=true from localStorage but the
                // browser's audio is still locked (no gesture yet), so that
                // first click must unlock it, not mute a preference that was
                // never actually active yet.
                if (soundOn && isUnlocked()) { setSoundOn(false); return; }
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

            {/* The "All systems go" pill stood here. It read the same
                `connected` flag the rail's Connection panel already shows —
                the same fact twice on one screen — so the corner now carries
                the thing that was missing instead: whose workspace this is. */}
            <AccountMenu
              pharmacyName={pharmacyName}
              email={email}
              onOpenSettings={() => setTab(SETUP.id)}
              onSignOut={onSignOut}
            />
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
        <main className="ui-canvas flex-1 px-5 py-6">
          <div className="mx-auto max-w-6xl">
            {/* Setup is the one screen that titles itself: its heading names
                the settings AREA you are in ("Customer contact"), which a
                fixed "Setup" above it would only repeat one level too high. */}
            {tab !== SETUP.id && (
              <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight text-[var(--ui-ink)]">{active.title}</h1>
                  {/* Inside a group the subtitle describes the SEGMENT, not the
                      group: the h1 already says where you are, so repeating it
                      underneath wastes the one line that could tell you what
                      this particular list contains. */}
                  <p className="mt-0.5 text-sm text-[var(--ui-ink-soft)]">{SUBTITLE[tab] || SUBTITLE[active.id]}</p>
                </div>
                {badges[tab] > 0 && (
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      tab === 'consultations' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {badges[tab]} waiting
                  </span>
                )}
              </div>
            )}

            {/* ---- segments ----
                The three stages of one job, as a track you move along rather
                than three places you navigate between. Counts sit ON the
                segments so you can see where the work is without opening
                each one — which is the whole reason this is not a dropdown. */}
            {segments && (
              <div
                role="tablist"
                aria-label="Manage Deals"
                onKeyDown={(e) => {
                  const i = segments.findIndex((s) => s.id === tab);
                  if (i < 0) return;
                  // Arrow keys walk the track, wrapping at both ends — the
                  // expected behaviour for a tablist, and the reason this is
                  // marked up as one rather than as three buttons.
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault(); setTab(segments[(i + 1) % segments.length].id);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault(); setTab(segments[(i - 1 + segments.length) % segments.length].id);
                  } else if (e.key === 'Home') {
                    e.preventDefault(); setTab(segments[0].id);
                  } else if (e.key === 'End') {
                    e.preventDefault(); setTab(segments[segments.length - 1].id);
                  }
                }}
                className="mb-5 inline-flex flex-wrap gap-1 rounded-[11px] border border-[var(--ui-line)] bg-[var(--ui-sunk)] p-1"
              >
                {segments.map(({ id: sid, label: slabel, Icon: SIcon }) => {
                  const on = tab === sid;
                  const n = badges[sid] || 0;
                  return (
                    <button
                      key={sid}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      // Only the active segment is in the tab order; the arrow
                      // keys reach the others. Three stops for one control is
                      // how a keyboard user ends up tabbing through chrome.
                      tabIndex={on ? 0 : -1}
                      onClick={() => setTab(sid)}
                      className={`flex items-center gap-2 rounded-[8px] px-3 py-1.5 text-[13px] font-medium transition
                        ${on
                          ? 'bg-white text-[var(--ui-ink)] shadow-[0_1px_2px_rgba(24,32,28,0.10)]'
                          : 'text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]'}`}
                    >
                      <SIcon width={16} height={16} />
                      {slabel}
                      {n > 0 && (
                        <span
                          className={`min-w-[18px] rounded-full px-1.5 text-center text-[10px] font-semibold leading-[17px]
                            ${on ? 'bg-amber-500 text-white' : 'bg-[var(--ui-line)] text-[var(--ui-ink-soft)]'}`}
                        >
                          {n > 99 ? '99+' : n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* onNavigate lets the Overview's cards be the way you get to the
                work, rather than a wall of numbers you then have to act on by
                hunting for the right section. */}
            {tab === 'overview' && <Overview onNavigate={setTab} />}
            {tab === 'ai' && <AiPerformance onNavigate={setTab} />}
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
            {/* Inventory — the same component either side, told which half to
                show. See UploadCatalogue's `view` prop for why it is one
                component and not two. */}
            {tab === 'inventory' && <UploadCatalogue view="products" />}
            {tab === 'inventory-upload' && <UploadCatalogue view="upload" />}

            {/* Owns its own heading and rail — see Settings.jsx. The six
                panels that used to be stacked here are unchanged; only which
                one is on screen at a time is new. */}
            {tab === 'setup' && (
              <Settings health={health} onBack={() => setTab('overview')} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
