/**
 * Settings, as a place rather than a scroll.
 *
 * WHY THIS REPLACED A STACK OF CARDS
 * Setup used to render every panel one under the other: assistant identity,
 * QR code, contact number, opening hours, pairing, API status. Six cards deep
 * meant the thing you came for was almost never on screen, and there was no
 * way to link to, or come back to, one of them — "where do I change the
 * opening hours" had the same answer as every other question, which is
 * "scroll".
 *
 * TWO LEVELS, BECAUSE THE CONTENT HAS TWO
 * A left rail chooses the AREA; tabs across the top choose the PANEL inside
 * it. That is the shape of every settings screen people already know, and it
 * means each panel gets a stable address instead of a position in a stack.
 *
 * NOTHING INSIDE THE PANELS CHANGED
 * Every section below is the same component it always was, rendered whole,
 * with its own card, heading and Save button. This file only decides which
 * one is on screen. That boundary is deliberate: rearranging navigation
 * should not be able to break a form that was working, so no panel was
 * split, merged, or given a second save path.
 */

import { useMemo, useState } from 'react';
import AssistantSettings from './AssistantSettings.jsx';
import CustomerContactSettings from './CustomerContactSettings.jsx';
import CustomerQrCode from './CustomerQrCode.jsx';
import PharmacyHoursSettings from './PharmacyHoursSettings.jsx';
import ConnectWhatsApp from './ConnectWhatsApp.jsx';
import { IconSearch } from './Icons.jsx';

/**
 * The map of the whole screen, as data.
 *
 * Grouped the way a pharmacist would look for something rather than the way
 * the code is organised: everything about how the pharmacy presents itself
 * in one group, everything about the line it runs on in the other. The
 * `render` functions are what keep each panel untouched — this file names
 * them, it does not reimplement them.
 */
const GROUPS = [
  {
    label: 'Your pharmacy',
    items: [
      {
        id: 'general',
        label: 'General',
        title: 'General',
        blurb: 'How the pharmacy and its assistant present themselves.',
        tabs: [
          { id: 'assistant', label: 'Assistant', render: () => <AssistantSettings /> },
          { id: 'hours', label: 'Hours & location', render: () => <PharmacyHoursSettings /> },
        ],
      },
      {
        id: 'contact',
        label: 'Customer contact',
        title: 'Customer contact',
        blurb: 'The number customers message, and the code that takes them there.',
        tabs: [
          { id: 'number', label: 'Public number', render: () => <CustomerContactSettings /> },
          { id: 'qr', label: 'QR code', render: () => <CustomerQrCode /> },
        ],
      },
    ],
  },
  {
    label: 'Connection',
    items: [
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        title: 'WhatsApp',
        blurb: 'The live socket everything else depends on.',
        tabs: [
          { id: 'pairing', label: 'Pairing', render: () => <ConnectWhatsApp /> },
          {
            id: 'api',
            label: 'API status',
            render: ({ health }) => (
              <section className="rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">API status</h2>
                <pre className="mt-2 overflow-x-auto text-xs text-slate-600">
                  {health ? JSON.stringify(health, null, 2) : 'Checking…'}
                </pre>
              </section>
            ),
          },
        ],
      },
    ],
  },
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items);

export default function Settings({ health = null, onBack }) {
  const [itemId, setItemId] = useState(ALL_ITEMS[0].id);
  // Keyed BY ITEM, not a single value: moving to another area and back should
  // return you to the panel you were on, the way a real settings screen does.
  // One shared value would silently reset every area to its first tab.
  const [tabByItem, setTabByItem] = useState({});
  const [query, setQuery] = useState('');

  const item = ALL_ITEMS.find((i) => i.id === itemId) || ALL_ITEMS[0];
  const tabId = tabByItem[item.id] || item.tabs[0].id;
  const tab = item.tabs.find((t) => t.id === tabId) || item.tabs[0];

  /**
   * Search matches a PANEL's name as well as its area's, because "QR code"
   * and "hours" are what someone actually types — neither is the name of a
   * left-rail entry, and a search that only looked at those would come back
   * empty for the two most specific things on this screen.
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS
      .map((g) => ({
        ...g,
        items: g.items.filter((i) => (
          i.label.toLowerCase().includes(q)
          || g.label.toLowerCase().includes(q)
          || i.tabs.some((t) => t.label.toLowerCase().includes(q))
        )),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <div className="flex min-h-[32rem] gap-6">
      {/* ------------------------------------------------------------ rail */}
      <aside
        aria-label="Settings sections"
        className="hidden w-56 shrink-0 flex-col gap-4 md:flex"
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 self-start rounded-[7px] px-1 py-0.5 text-[13px]
                       text-[var(--ui-ink-soft)] transition hover:text-[var(--ui-ink)]
                       focus:outline-2 focus:outline-offset-1 focus:outline-teal-500"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
            Back
          </button>
        )}

        <label className="relative block">
          <span className="sr-only">Search settings</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
            <IconSearch width={15} height={15} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            className="w-full rounded-full border border-[var(--ui-line)] bg-[var(--ui-surface)] py-1.5 pl-9 pr-3 text-[13px]
                       placeholder:text-[var(--ui-ink-faint)] focus:border-[var(--ui-accent)]"
          />
        </label>

        <nav className="flex flex-col gap-4">
          {filtered.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1 text-[13px] font-semibold text-[var(--ui-ink)]">
                {group.label}
              </p>
              {group.items.map((entry) => {
                const on = entry.id === item.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setItemId(entry.id)}
                    aria-current={on ? 'page' : undefined}
                    className={`relative flex w-full items-center rounded-[7px] px-2.5 py-1.5 text-left text-[13px] transition
                      ${on
                        ? 'bg-[var(--ui-accent-wash)] font-medium text-[var(--ui-accent-ink)]'
                        : 'text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]'}`}
                  >
                    {/* A shape, not only a tint — the rail must still say
                        "you are here" without relying on two close greys. */}
                    {on && (
                      <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-[var(--ui-accent)]" />
                    )}
                    {entry.label}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 text-[12px] text-[var(--ui-ink-faint)]">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </nav>
      </aside>

      {/* --------------------------------------------------------- content */}
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--ui-ink)]">{item.title}</h1>
        <p className="mt-0.5 text-sm text-[var(--ui-ink-soft)]">{item.blurb}</p>

        {/* On a narrow screen the rail is hidden, so the areas fold into this
            same strip ahead of the panel tabs — otherwise a phone can reach
            exactly one area of the settings and no other. */}
        <div className="mt-4 flex flex-wrap gap-1 md:hidden">
          {ALL_ITEMS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setItemId(entry.id)}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition
                ${entry.id === item.id
                  ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]'
                  : 'bg-[var(--ui-sunk)] text-[var(--ui-ink-soft)]'}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div
          role="tablist"
          aria-label={`${item.title} sections`}
          onKeyDown={(e) => {
            const i = item.tabs.findIndex((t) => t.id === tab.id);
            if (i < 0) return;
            const go = (n) => {
              e.preventDefault();
              setTabByItem((m) => ({ ...m, [item.id]: item.tabs[n].id }));
            };
            if (e.key === 'ArrowRight') go((i + 1) % item.tabs.length);
            else if (e.key === 'ArrowLeft') go((i - 1 + item.tabs.length) % item.tabs.length);
            else if (e.key === 'Home') go(0);
            else if (e.key === 'End') go(item.tabs.length - 1);
          }}
          className="mt-4 flex flex-wrap items-end gap-1 border-b border-[var(--ui-line)]"
        >
          {item.tabs.map((t) => {
            const on = t.id === tab.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                // Only the selected tab is a tab stop; arrows reach the rest.
                tabIndex={on ? 0 : -1}
                onClick={() => setTabByItem((m) => ({ ...m, [item.id]: t.id }))}
                className={`-mb-px rounded-t-[8px] border border-b-0 px-4 py-2 text-[13px] font-medium transition
                  ${on
                    ? 'border-[var(--ui-line)] bg-[var(--ui-surface)] text-[var(--ui-ink)]'
                    : 'border-transparent text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]'}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* The panel, rendered exactly as it was before this screen existed. */}
        <div className="pt-5">{tab.render({ health })}</div>
      </div>
    </div>
  );
}
