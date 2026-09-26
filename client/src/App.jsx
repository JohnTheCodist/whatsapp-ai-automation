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
 * The rail is the ERPNext desk's light grey column with a white active pill
 * (design.md, "Why ERPNext"). Semantic colour is kept separate from it:
 * red means someone is waiting, amber means work is queued, and neither is
 * ever the accent — so an alert can never be mistaken for "the active tab".
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import Overview from './Overview.jsx';
import AiPerformance from './AiPerformance.jsx';
import UploadCatalogue from './UploadCatalogue.jsx';
import Consultations from './Consultations.jsx';
import Inbox from './Inbox.jsx';
import Orders from './Orders.jsx';
import Requests from './Requests.jsx';
import Customers, { ChronicRegister } from './Customers.jsx';
import Settings from './Settings.jsx';
import AccountMenu from './AccountMenu.jsx';
import NotificationBell from './NotificationBell.jsx';
import Favicon from './Favicon.jsx';
import { playOrderChime, playConsultationAlarm, unlockChime, isUnlocked } from './orderChime.js';
import {
  IconSetup, IconSearch, IconVolumeOn, IconVolumeOff, IconLink, IconBilling, IconAlertTriangle, IconHome,
} from './Icons.jsx';
import Launcher from './Launcher.jsx';
import CatalogueSync from './CatalogueSync.jsx';
import TradeQrCode from './TradeQrCode.jsx';
import { TemplatesPanel } from './MetaReviewTest.jsx';
import { RefillQueue } from './MedicationJourneys.jsx';
import {
  MODULES, MODULE_TABS, moduleOfTab, itemOfTab, sidebarFor, moduleHome,
} from './modules.js';
import Billing from './Billing.jsx';
/**
 * The whole Website section, in its own chunk.
 *
 * Not only the GrapesJS editor: the picker, the guided form, the publish bar
 * and the preview are all behind this too. A pharmacy opens Website a handful
 * of times a year, and the dashboard's initial download is what every member
 * of staff waits for on every shift — so none of it belongs in the main
 * bundle. Measured 2026-09-06: this moved the main chunk back under its
 * budget and the editor into a chunk nobody fetches until they ask for it.
 */
const WebsitePanel = lazy(() => import('./website/WebsitePanel.jsx'));
import { isWebsiteBuilderEnabled } from './website/api.js';

/*
 * WHERE EVERY SCREEN LIVES is decided in modules.js: five modules, each with
 * its own sidebar. This file keeps only what belongs to no module — Setup,
 * Billing and Home — and the words shown under each screen's title. See
 * MODULES_PLAN.md for the audit behind every placement.
 */

/**
 * Setup is configuration, not work — connection, assistant identity, opening
 * hours — so it belongs to no module. It sits with the connection status at
 * the foot of every workspace's sidebar, which is the other thing on screen
 * about the installation rather than the day.
 */
const SETUP = { id: 'setup', label: 'Setup', Icon: IconSetup, title: 'Setup' };

/** Beside Setup, for the same reason: about the installation, not today. */
const BILLING = { id: 'billing', label: 'Billing', Icon: IconBilling, title: 'Billing' };

/**
 * Home — the module launcher (Launcher.jsx), and where a pharmacy lands after
 * signing in. No sidebar is drawn on it: it is where modules are chosen from,
 * not a place inside one.
 */
const HOME = { id: 'home', label: 'Home', title: 'Home' };

const GLOBAL = { [SETUP.id]: SETUP, [BILLING.id]: BILLING, [HOME.id]: HOME };

const SUBTITLE = {
  overview: 'How the pharmacy is doing',
  inventory: 'What the assistant can see and sell',
  'inventory-upload': 'Add or replace your catalogue from a spreadsheet',
  'stock-sync': 'Keep the catalogue current from your stock software',
  orders: 'Reservations awaiting confirmation',
  requests: 'Asked for, not in the catalogue',
  wholesale: 'The QR code that signs businesses up for wholesale prices',
  consultations: 'People waiting to speak to a pharmacist',
  customers: "View all your customers' details",
  refills: 'Patients whose medicine is running out',
  conditions: 'Patients grouped by the conditions they buy for',
  inbox: 'Every conversation on this number',
  templates: 'Messages WhatsApp lets you send at any time',
  ai: 'What the assistant is handling, and what it is passing to you',
  website: 'Your pharmacy on the web, and the WhatsApp button on it',
  setup: 'Connection, catalogue and assistant identity',
  billing: 'Your plan, and what happens when it ends',
};

/**
 * Every id `tab` state may hold — the modules' screens plus the three global
 * ones. Derived, never hand-listed, so it cannot drift from the sidebars.
 *
 * Validates whatever comes out of the URL on load: a query string is
 * user-editable and outlives a code change, so a stale or hand-typed ?tab=
 * lands on Home rather than rendering a blank canvas.
 */
const VALID_TABS = new Set([...MODULE_TABS, ...Object.keys(GLOBAL)]);

/** Read the tab to open on load from the URL, or null if there isn't one. */
function readTabFromUrl() {
  const t = new URLSearchParams(window.location.search).get('tab');
  return t && VALID_TABS.has(t) ? t : null;
}

/** The title a screen carries: its sidebar label, or the global screen's name. */
/**
 * Where the page heading is NOT the sidebar's wording.
 *
 * The sidebar row has to be distinguishable from its neighbours inside the
 * Patients module — "All patients" beside "Refills due" and "Conditions" —
 * but the page it opens is the patient list itself, and "All patients" over
 * a list that is usually filtered contradicts what is on the screen. The
 * heading says where you are; the subtitle says what you can do here.
 */
const PAGE_TITLE = {
  customers: 'Patients',
};

function titleFor(tab) {
  return PAGE_TITLE[tab] || crumbFor(tab);
}

/** The breadcrumb always says what the sidebar says, so the trail a person
 *  clicked matches the trail they are reading. Patients is the case that
 *  proves it: the crumb is "Patients / All patients" while the heading over
 *  the list is "Patients". */
function crumbFor(tab) {
  return itemOfTab(tab)?.label || GLOBAL[tab]?.title || '';
}

/**
 * One sidebar row. Laid out once, at full width; the sidebar's hover state
 * (`.ui-rail` in index.css) decides how much of it shows.
 *
 * GEOMETRY. The icon is centred on x=28 — the middle of the 56px strip — so
 * it does not move by a pixel when the panel opens: 8px of sidebar padding,
 * 9px of row padding, a 22px icon.
 *
 * `.ui-rail-pill` is the one highlight, shared by hover and "you are here": a
 * 36px tile behind the icon while closed, a full-width pill once open.
 * Counts appear twice on purpose — a small badge on the icon's corner for
 * the strip, a pill at the end of the row for the panel — and cross-fade as
 * it opens. The corner copy is aria-hidden, so a screen reader hears the
 * label and the count once.
 *
 * `tone` is semantic, never decorative: red only for Consultations (a person
 * waiting), amber for queued work — see design.md.
 */
function RailButton({
  active, onClick, Icon, label, count = 0, tone = 'amber', dot = null, index = 0, className = '',
}) {
  const toneBg = tone === 'red' ? 'bg-red-500' : 'bg-amber-500';
  const dotBg = dot === 'red' ? 'bg-red-500' : 'bg-amber-500';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      style={{ '--i': index }}
      className={`ui-rail-row relative flex w-full items-center gap-2.5 py-[7px] pl-[9px] pr-2.5 text-left
        ${active ? 'text-[var(--ui-ink)]' : 'text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]'} ${className}`}
    >
      <span aria-hidden="true" className="ui-rail-pill" />
      <span className="relative shrink-0">
        <Icon />
        {count > 0 && (
          <span
            aria-hidden="true"
            className={`ui-rail-closed-only absolute -right-1.5 -top-1.5 min-w-[16px] rounded-full px-1 text-center text-[9px] font-semibold leading-[16px] text-white ring-2 ring-[var(--ui-sidebar)] ${toneBg}`}
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
        {dot && (
          <span aria-hidden="true" className={`ui-rail-closed-only absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${dotBg}`} />
        )}
      </span>
      <span className="ui-rail-fade relative min-w-0 flex-1 truncate text-[14px] font-medium">{label}</span>
      {count > 0 && (
        <span
          className={`ui-rail-fade relative ml-auto min-w-[19px] shrink-0 rounded-full px-1.5 text-center text-[10px] font-semibold leading-[18px] text-white ${toneBg}`}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
      {dot && (
        <span aria-hidden="true" className={`ui-rail-fade relative ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${dotBg}`} />
      )}
    </button>
  );
}

export default function App({ onSignOut, pharmacy = null, memberships = [], email = '' }) {
  const [tab, setTab] = useState(() => readTabFromUrl() || HOME.id);
  // The website builder ships behind a server-side flag, and while it is off
  // its routes are not mounted at all. There is no config endpoint to ask, so
  // the dashboard asks the feature itself: a 404 means absent, anything else
  // means present. Starts null so the rail renders without it rather than
  // flashing a tab that then disappears.
  const [websiteEnabled, setWebsiteEnabled] = useState(null);

  // Asked once, on mount. Nothing retries: if this request fails outright the
  // helper answers true, so a transient error shows the tab and lets the
  // panel report the real problem rather than silently removing a feature the
  // pharmacy has.
  useEffect(() => {
    let live = true;
    isWebsiteBuilderEnabled().then((on) => { if (live) setWebsiteEnabled(on); });
    return () => { live = false; };
  }, []);
  const [health, setHealth] = useState(null);
  // null until the first read — the banner and the rail dot stay hidden
  // rather than flashing a wrong state on load.
  const [billing, setBilling] = useState(null);
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
  // The same poll, kept as "not known yet" (null) until its first answer, for
  // the launcher's live lines — a card must not claim "No orders waiting"
  // before anybody has asked. The badges above can default to 0 because a
  // zero badge renders nothing.
  const [summary, setSummary] = useState(null);
  // Refills due and Conditions list patients; choosing one opens THE patient
  // profile under All patients. One profile, reached from three screens —
  // never a second copy of it on each.
  const [patientToOpen, setPatientToOpen] = useState(null);
  const clearPatientToOpen = useCallback(() => setPatientToOpen(null), []);
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
  const searchRef = useRef(null);

  // Ctrl+K (Cmd+K on a Mac) focuses the header search, as it does on the
  // ERPNext desk this layout follows. The hint is printed inside the field,
  // so the shortcut has to exist — a hint for a key that does nothing is
  // worse than no hint.
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Persists the on/off PREFERENCE, independent of whether the browser has
  // actually unlocked audio yet (see the toggle button's click handler).
  useEffect(() => {
    localStorage.setItem('staffNotificationSound', String(soundOn));
  }, [soundOn]);

  // Keeps the URL in step with the open tab, so a refresh — or a bookmark, or
  // sending a colleague a link — lands back on the same screen instead of
  // always Overview. replaceState, not pushState: every click swapping the
  // active section is a substitution of "where I am", not a new page to
  // visit, and pushing one history entry per tab click would make the
  // browser's back button cycle through the dashboard's own navigation
  // instead of leaving it — the read on load (readTabFromUrl, in useState's
  // initialiser above) is what makes a refresh land here at all.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') === tab) return;
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
  }, [tab]);

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
          setSummary({
            orders: pending,
            handoffs: s?.open_handoffs || 0,
            // ?? null: an older server without this count leaves the
            // Marketing card's line blank rather than claiming zero.
            openConversations: s?.open_conversations ?? null,
          });
        }
      } catch { /* the sections still work without badges */ }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  /**
   * Billing status for the rail dot and the banner.
   *
   * SEPARATE FROM THE BADGE POLL, AND MUCH SLOWER. A trial that has six days
   * left will still have six days left in ten minutes; polling it every 30
   * seconds alongside the badges would be the same mistake /api/summary
   * exists to undo. Ten minutes is far more often than the state can
   * meaningfully change, and a page load always refetches.
   *
   * /api/billing/status, not /api/billing: the full view is owner-only and
   * carries payment history. Everyone needs to know why the assistant
   * stopped; not everyone needs the receipts.
   */
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const b = await fetch('/api/billing/status').then((r) => (r.ok ? r.json() : null));
        if (!cancelled && b) setBilling(b);
      } catch { /* the dashboard works without the banner */ }
    };
    read();
    const t = setInterval(read, 600000);
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
  // Home is the desk's launcher: no sidebar, logo left, search centred.
  const isHome = tab === HOME.id;
  /**
   * Patients is the second screen with no sidebar, at the owner's request
   * (2026-09-20). The list is wide — nine columns — and inside a patient the
   * record grows its OWN navigation of twelve sections (PatientRecord.jsx),
   * which beside the module rail would be two vertical menus for one screen.
   */
  const isBare = isHome || tab === 'customers';
  // The module this screen belongs to, or null on Setup and Billing — where
  // the sidebar lists the modules instead, so there is always a way back in.
  const currentModule = moduleOfTab(tab);
  const pageTitle = titleFor(tab);
  const crumbTitle = crumbFor(tab);
  const openPatient = (id) => { setPatientToOpen(id); setTab('customers'); };

  function submitSearch(e) {
    e.preventDefault();
    if (!search.trim()) return;
    setPatientQuery(search.trim());
    setTab('customers');
  }

  return (
    <div className="flex min-h-screen bg-[var(--ui-paper)]">
      {/* ---------------------------------------------------------------- rail */}
      {!isBare && (<>
      {/* The strip's footprint. Always 56px in the page's flow, so the
          content beside it never moves; the panel inside opens OVER the
          page. Its right hairline is the strip's edge while the panel is
          closed. z-30 lifts the open panel above the sticky header. */}
      <div className="sticky top-0 z-30 h-screen w-14 shrink-0 border-r border-[var(--ui-line)] bg-[var(--ui-sidebar)]">
      <nav
        aria-label="Sections"
        className="ui-rail absolute inset-y-0 left-0 flex w-[214px] flex-col gap-1 overflow-y-auto overflow-x-hidden border-r border-[var(--ui-line)] bg-[var(--ui-surface)] px-2 py-4"
      >
        {/* The workspace row, in the shape of the desk's "Stock / ERPNext"
            header: the brand tile, then whose workspace this is and whose
            product it runs on. The tile sits on the strip's centre line; the
            names arrive with the panel. The R is the same mark the sign-in
            screen and the tab icon use. */}
        <div className="mb-4 flex min-w-0 items-center gap-2.5 pl-1">
          {/* The mark is also the way home, as the desk's logo is. */}
          <button
            type="button"
            onClick={() => setTab(HOME.id)}
            aria-label="RxNaija home"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ui-focus)] text-[15px] font-semibold leading-none text-white"
          >
            R
          </button>
          <span className="ui-rail-fade min-w-0 leading-tight" style={{ '--i': 0 }}>
            <span className="block truncate text-[14px] font-semibold text-[var(--ui-ink)]">
              {pharmacyName || 'Your pharmacy'}
            </span>
            <span className="block text-[12px] text-[var(--ui-ink-faint)]">RxNaija</span>
          </span>
        </div>

        {/* The group label names the module you are in — the desk's
            workspace header. On Setup and Billing, which belong to no
            module, it offers the modules instead. */}
        <span className="ui-rail-fade px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-ink-faint)]">
          {currentModule ? currentModule.label : 'Modules'}
        </span>

        {currentModule
          // CONTEXTUAL: only this module's screens. The five modules are one
          // click away on Home, via the logo above or the breadcrumb.
          ? sidebarFor(currentModule, { websiteEnabled }).map(({
            tab: itemTab, label, Icon, badge, tone,
          }, i) => (
            <RailButton
              key={itemTab}
              index={i + 1}
              active={tab === itemTab}
              onClick={() => setTab(itemTab)}
              Icon={Icon}
              label={label}
              count={badge ? (badges[badge] || 0) : 0}
              // Red only for a person waiting on a pharmacist; everything
              // else is queued work (design.md).
              tone={tone || 'amber'}
            />
          ))
          : MODULES.map((m, i) => (
            <RailButton
              key={m.id}
              index={i + 1}
              active={false}
              onClick={() => setTab(moduleHome(m.id, { websiteEnabled }))}
              Icon={m.Icon}
              label={m.label}
            />
          ))}

        <div className="mt-auto pt-3">
          {/* Sign out is no longer here — it lives in the account menu at the
              top right, next to the name of the account it signs you out of.
              It used to sit directly above this connection panel, which put a
              destructive once-a-day action in the corner staff scan most.

              The group label and the strip's hairline share one slot and hand
              over as the panel opens: the desk's icon strip separates its
              groups with rules, the open panel with words. */}
          <div className="relative">
            <span className="ui-rail-fade block px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ui-ink-faint)]">
              Connection
            </span>
            <hr aria-hidden="true" className="ui-rail-closed-only absolute left-[2px] top-1.5 w-9 border-slate-300" />
          </div>

          {/* Live socket state, in the rail rather than buried in Setup: if
              WhatsApp drops, nothing else on any screen is true. The chip sits
              on the strip's centre line with the state as a dot on its corner;
              the name and the Live/Down pill arrive with the panel. */}
          <div
            title={connected ? 'Connected to WhatsApp' : `Not connected (${health?.status || 'checking'})`}
            style={{ '--i': 7 }}
            className="relative flex items-center gap-2.5 py-1.5 pl-[6px] pr-2.5"
          >
            <span aria-hidden="true" className="ui-rail-fade pointer-events-none absolute inset-0 rounded-lg border border-[var(--ui-line)]" />
            <span
              className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                connected ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]' : 'bg-red-50 text-red-600'
              }`}
            >
              <IconLink width={15} height={15} />
              <span
                aria-hidden="true"
                className={`ui-rail-closed-only absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-[var(--ui-sidebar)] ${
                  connected ? 'bg-[var(--ui-accent)]' : 'bg-red-500'
                }`}
              />
            </span>
            <span className="ui-rail-fade relative min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ui-ink-soft)]">WhatsApp</span>
            <span
              className={`ui-rail-fade relative shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
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
          <RailButton
            index={8}
            active={tab === SETUP.id}
            onClick={() => setTab(SETUP.id)}
            Icon={SETUP.Icon}
            label={SETUP.label}
            className="mt-1"
          />

          {/* Billing, beneath Setup. The dot appears when the trial is
              running out or has run out — the one case where a monthly
              concern becomes this week's. */}
          <RailButton
            index={9}
            active={tab === BILLING.id}
            onClick={() => setTab(BILLING.id)}
            Icon={BILLING.Icon}
            label={BILLING.label}
            dot={billing?.needsPayment ? 'red' : billing?.warn ? 'amber' : null}
            className="mt-1"
          />
        </div>
      </nav>
      </div>
      </>)}

      {/* -------------------------------------------------------------- column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---- top bar ---- */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-[var(--ui-line)] bg-[var(--ui-surface)] px-5">
          {/* Where you are, in the desk's breadcrumb form: home, the section,
              and — inside a group — the segment. Each step before the last
              takes you there; the last is where you already are. The
              pharmacy's name is in the sidebar's workspace row and the
              account chip, so it is not repeated here. */}
          {isHome ? (
            <div className="flex flex-1 items-center">
              <span
                role="img"
                aria-label="RxNaija"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ui-focus)] text-[15px] font-semibold leading-none text-white"
              >
                R
              </span>
            </div>
          ) : (
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center gap-1.5 text-[15px] whitespace-nowrap">
              <li className="flex items-center">
                <button
                  type="button"
                  onClick={() => setTab(HOME.id)}
                  aria-label="Home"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]"
                >
                  <IconHome width={16} height={16} />
                </button>
              </li>
              <li aria-hidden="true" className="text-[var(--ui-ink-faint)]">/</li>
              {currentModule ? (
                <>
                  <li className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setTab(moduleHome(currentModule.id, { websiteEnabled }))}
                      className="truncate text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]"
                    >
                      {currentModule.label}
                    </button>
                  </li>
                  <li aria-hidden="true" className="text-[var(--ui-ink-faint)]">/</li>
                  <li className="min-w-0 truncate font-medium text-[var(--ui-ink)]" aria-current="page">
                    {crumbTitle}
                  </li>
                </>
              ) : (
                <li className="min-w-0 truncate font-medium text-[var(--ui-ink)]" aria-current="page">
                  {crumbTitle}
                </li>
              )}
            </ol>
          </nav>
          )}

          {/* The desk's "Search  Ctrl+K" pill. Submitting jumps to Patients
              with the term applied. Fill and focus come from the global
              field rule in index.css. */}
          <form onSubmit={submitSearch} className={isHome ? 'w-full max-w-md' : 'w-40 shrink-0 md:w-56 lg:w-72'}>
            <label className="relative block">
              <span className="sr-only">Search patients by name or phone</span>
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ui-ink-faint)]">
                <IconSearch width={15} height={15} />
              </span>
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search patients"
                className="w-full py-1.5 pl-8 pr-14 text-[13px]"
              />
              <span className="ui-kbd pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" aria-hidden="true">
                Ctrl+K
              </span>
            </label>
          </form>

          <div className={`flex items-center gap-1.5 ${isHome ? 'flex-1 justify-end' : ''}`}>
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
              {soundOn && isUnlocked() ? <IconVolumeOn width={17} height={17} /> : <IconVolumeOff width={17} height={17} />}
            </button>

            {/* The "needs you" bar and the "WhatsApp is not connected" banner
                used to sit inline on Overview, permanently, whether or not
                either had anything to say — reported as clutter, fairly:
                neither fact is specific to that one screen. Collapsed into
                this bell, fed by state App.jsx already polls regardless of
                which tab is open, so the badge is live everywhere, not only
                when Overview happens to be mounted. See NotificationBell.jsx
                for what deliberately did NOT move here and why. */}
            <NotificationBell
              consultations={badges.consultations}
              orders={badges.orders}
              connected={connected}
              onNavigate={setTab}
            />

            {/* The same arithmetic the bell does internally, so the tab icon
                and the badge can never disagree about whether anything is
                waiting. Renders nothing — it only paints the favicon. */}
            <Favicon count={(connected ? 0 : 1) + badges.consultations + badges.orders} />

            {/* The "All systems go" pill stood here. It read the same
                `connected` flag the rail's Connection panel already shows —
                the same fact twice on one screen — so the corner now carries
                the thing that was missing instead: whose workspace this is. */}
            <AccountMenu
              pharmacyName={pharmacyName}
              email={email}
              memberships={memberships}
              // The tenant the SERVER resolved, not what localStorage claims.
              // They disagree exactly when a stored id has gone stale, and in
              // that case the server is right and the stored value is what
              // needs correcting.
              activePharmacyId={pharmacy?.id || null}
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
            {/* ---- billing ----
                Above everything, on every screen, and only when it matters:
                the trial is nearly out, or the assistant has already stopped.
                A pharmacy discovering on day 7 that it needed a card has been
                ambushed, and the first thing they would otherwise notice is
                customers going unanswered.

                Hidden entirely on the Billing screen itself — repeating a
                warning immediately above the page that explains it reads as
                a system that is not paying attention. */}
            {billing && (billing.warn || billing.needsPayment) && tab !== BILLING.id && (
              <button
                type="button"
                onClick={() => setTab(BILLING.id)}
                className={`mb-5 flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition
                  ${billing.needsPayment
                    ? 'border-red-200 bg-red-50 hover:bg-red-100'
                    : 'border-amber-200 bg-amber-50 hover:bg-amber-100'}`}
              >
                <span className={`mt-0.5 shrink-0 ${billing.needsPayment ? 'text-red-600' : 'text-amber-600'}`}>
                  <IconAlertTriangle />
                </span>
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${billing.needsPayment ? 'text-red-900' : 'text-amber-900'}`}>
                    {billing.needsPayment
                      ? 'The assistant has stopped replying to customers'
                      : 'Your free trial is ending'}
                  </span>
                  {billing.message && (
                    <span className={`mt-0.5 block text-sm ${billing.needsPayment ? 'text-red-800' : 'text-amber-800'}`}>
                      {billing.message}
                    </span>
                  )}
                </span>
              </button>
            )}

            {/* Setup is the one screen that titles itself: its heading names
                the settings AREA you are in ("Customer contact"), which a
                fixed "Setup" above it would only repeat one level too high. */}
            {tab !== SETUP.id && !isHome && (
              <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight text-[var(--ui-ink)]">{pageTitle}</h1>
                  {/* Inside a group the subtitle describes the SEGMENT, not the
                      group: the h1 already says where you are, so repeating it
                      underneath wastes the one line that could tell you what
                      this particular list contains. */}
                  <p className="mt-0.5 text-sm text-[var(--ui-ink-soft)]">{SUBTITLE[tab]}</p>
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

            {/* Overview no longer takes onNavigate — its two clickable-alert
                sections (needs-you, WhatsApp disconnected) moved into the
                header's NotificationBell, which owns navigating from them
                now. AiPerformance's cards still link out on their own. */}
            {isHome && <Launcher onOpen={setTab} websiteEnabled={websiteEnabled} summary={summary} />}
            {tab === 'overview' && <Overview />}
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
                openPatientId={patientToOpen}
                onPatientOpened={clearPatientToOpen}
                onOpenConversation={(id) => { setOpenConversationId(id); setTab('inbox'); }}
                onNavigate={setTab}
              />
            )}
            {/* Inventory — the same component either side, told which half to
                show. See UploadCatalogue's `view` prop for why it is one
                component and not two. */}
            {tab === 'inventory' && <UploadCatalogue view="products" />}
            {tab === 'inventory-upload' && <UploadCatalogue view="upload" />}

            {/* Screens that already existed, nested elsewhere, given a place
                in their module's sidebar. The SAME components: the stock-sync
                panel and wholesale QR are still in Setup too, the templates
                panel in Setup -> WhatsApp, and the refill list and register
                open the one patient profile. Nothing here is a copy. */}
            {tab === 'stock-sync' && <CatalogueSync />}
            {tab === 'wholesale' && <TradeQrCode />}
            {tab === 'refills' && <RefillQueue standalone onOpen={openPatient} />}
            {tab === 'conditions' && <ChronicRegister standalone onOpen={openPatient} />}
            {tab === 'templates' && <TemplatesPanel />}

            {/* Owns its own heading and rail — see Settings.jsx. The six
                panels that used to be stacked here are unchanged; only which
                one is on screen at a time is new. */}
            {tab === 'setup' && (
              <Settings health={health} onBack={() => setTab('overview')} />
            )}

            {tab === 'website' && (
              <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
                <WebsitePanel onNavigate={setTab} />
              </Suspense>
            )}

            {tab === 'billing' && <Billing />}
          </div>
        </main>
      </div>
    </div>
  );
}
