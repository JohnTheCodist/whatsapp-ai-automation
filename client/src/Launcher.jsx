/**
 * Home — the module launcher.
 *
 * FIVE TILES AND NOTHING ELSE ON THE PAGE. At rest each module is its icon
 * and its name, the way the ERPNext desk's home is — the owner asked for the
 * descriptions to be off the page. What a module is for, and its one live
 * figure, arrive in a card that opens beneath the icon on hover or keyboard
 * focus. The only thing a tile shows unasked is a dot on its icon when
 * something in that module needs a person: red for someone waiting on a
 * pharmacist, amber for queued work (design.md's semantic colours).
 *
 * Which module holds which screen, and where each tile opens, is decided in
 * modules.js — this file only draws it.
 *
 * THE LIVE LINE. Orders, consultations and open conversations come from the
 * summary App already polls, so they cost nothing here. Refills due and the
 * website's state are asked for once, when Home opens. A figure that is not
 * known yet shows nothing rather than a zero it has not earned.
 *
 * ACCESSIBILITY. Each tile is one button named by its module ("Stock"). The
 * card is a sibling of the button, not inside it, and is the button's
 * description via aria-describedby — so the name stays the module's name
 * while a screen reader still hears what it is for and how it stands. On a
 * touch screen, where there is no hover, the card never opens and the
 * description is still read.
 */

import { useEffect, useState } from 'react';
import { MODULES, moduleHome, tileStatus } from './modules.js';
import { getWebsite } from './website/api.js';

/** Semantic dot colours — red only for a person waiting (design.md). */
const DOT = {
  alert: 'bg-red-500',
  work: 'bg-amber-500',
  quiet: 'bg-[var(--ui-ink-faint)]',
};

/** "Good morning" by the pharmacy's clock, not the viewer's. */
function greeting(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(now));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos',
  }).format(now);
}

/**
 * One module: the tile, and the card that opens beneath it.
 * Exported so its markup can be checked without a DOM.
 *
 * `align` keeps the card on screen at the ends of the row: the first tile's
 * card opens to the right of its icon, the last one's to the left.
 */
export function ModuleCard({ module, status, onOpen, index = 0, align = 'center' }) {
  const { id, label, hint, Icon } = module;
  const cardId = `module-card-${id}`;
  const needsYou = status && (status.tone === 'alert' || status.tone === 'work');
  return (
    <div className="ui-module">
      <button
        type="button"
        onClick={onOpen}
        aria-describedby={cardId}
        style={{ '--i': index }}
        className="ui-app-tile flex w-full flex-col items-center gap-3 rounded-2xl px-2 pb-3 pt-2"
      >
        <span className="ui-app-icon" aria-hidden="true">
          <Icon width={28} height={28} strokeWidth={1.75} />
          {needsYou && (
            <span className={`ui-app-icon-dot ${DOT[status.tone]}`} />
          )}
        </span>
        <span className="text-[14px] font-semibold text-[var(--ui-ink)]">{label}</span>
      </button>

      <div id={cardId} role="tooltip" className="ui-module-pop" data-align={align}>
        <p className="text-[14px] font-semibold text-[var(--ui-ink)]">{label}</p>
        <p className="mt-1 text-[13px] leading-snug text-[var(--ui-ink-soft)]">{hint}</p>
        {status && (
          <p className="mt-3 flex items-center gap-1.5 border-t border-[var(--ui-line)] pt-2.5 text-[12px] font-medium text-[var(--ui-ink-soft)]">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status.tone] || DOT.quiet}`} />
            <span className={status.tone === 'alert' ? 'text-red-700' : ''}>{status.text}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {(tab: string) => void} props.onOpen
 * @param {boolean|null} props.websiteEnabled
 * @param {object|null} props.summary  { orders, handoffs, openConversations }
 *   from App's poll, or null before its first answer
 */
export default function Launcher({ onOpen, websiteEnabled, summary = null }) {
  const [refillsDue, setRefillsDue] = useState(null);
  const [websiteStatus, setWebsiteStatus] = useState(null);

  // Asked once per visit to Home. Failure leaves the line empty — the tile
  // still opens the module, which is the tile's actual job.
  useEffect(() => {
    let live = true;
    fetch('/api/refills', { signal: AbortSignal.timeout(20000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j?.counts) setRefillsDue((j.counts.due || 0) + (j.counts.overdue || 0));
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (websiteEnabled !== true) return undefined;
    let live = true;
    getWebsite()
      .then((res) => { if (live) setWebsiteStatus(res?.site ? res.site.status : 'none'); })
      .catch(() => {});
    return () => { live = false; };
  }, [websiteEnabled]);

  const figures = {
    orders: summary?.orders ?? null,
    handoffs: summary?.handoffs ?? null,
    openConversations: summary?.openConversations ?? null,
    refillsDue,
    websiteStatus,
    websiteEnabled,
  };

  const last = MODULES.length - 1;

  return (
    <section aria-labelledby="launcher-title" className="mx-auto w-full max-w-5xl pb-16 pt-8 sm:pt-12">
      <header className="ui-launcher-greeting mb-10 text-center sm:mb-14">
        <h1 id="launcher-title" className="text-[24px] font-semibold tracking-tight text-[var(--ui-ink)]">
          {greeting()}
        </h1>
        <p className="mt-1 text-[14px] text-[var(--ui-ink-faint)]">{today()}</p>
      </header>

      {/* A centred wrapping row, not a grid: five in a line on a laptop, and
          on narrower screens the short last row stays centred under the
          first instead of hanging off to the left. */}
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-8 sm:gap-x-8">
        {MODULES.map((module, i) => (
          <li key={module.id} className="w-[132px] sm:w-[152px]">
            <ModuleCard
              module={module}
              index={i}
              align={i === 0 ? 'start' : i === last ? 'end' : 'center'}
              status={tileStatus(module.id, figures)}
              onOpen={() => onOpen(moduleHome(module.id, { websiteEnabled }))}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
