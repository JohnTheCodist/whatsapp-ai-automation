/**
 * The bell beside the sound toggle — a place for "does anything need me"
 * that costs zero space when the answer is no.
 *
 * WHAT MOVED HERE, AND WHY THIS SET
 * Overview used to open on two things stated inline, permanently: a
 * collapsed-but-still-present "needs you" bar, and a standing "WhatsApp is
 * not connected" banner when disconnected. Both were reported as clutter —
 * fair, since neither is specific to the Overview screen, and a fact this
 * important should not require opening one particular tab to see.
 *
 * This reads from state App.jsx already polls independently of which tab is
 * open — `badges.consultations` / `badges.orders` (the same /api/summary
 * poll the rail's own counts use) and `connected` (the same /api/health poll
 * the rail's Connection panel uses). Nothing new is fetched, so the badge on
 * this bell is live on every screen, not only when Overview happens to be
 * mounted.
 *
 * WHAT DID NOT MOVE, ON PURPOSE
 * Overview's dropped banner also fed off a third figure — customers whose
 * last message has had no reply from anyone. That count comes from a query
 * overview.js's own comments call "the slowest thing on this page", already
 * needing a DISTINCT ON rewrite to be affordable on a 20s poll scoped to one
 * screen. Pulling it into a poll that runs app-wide on every screen would be
 * a real, silent cost nobody asked for. So this bell surfaces what is cheap
 * everywhere and links out to Overview for the fuller picture rather than
 * quietly dropping that number or quietly making every screen slower.
 *
 * The red "someone is waiting on a pharmacist" bar in App.jsx is deliberately
 * untouched — that one is already global, already unmissable, and downgrading
 * it into a collapsed badge would undo the exact reasoning that put it there.
 */

import { useEffect, useRef, useState } from 'react';
import { IconBellOn, IconOverview } from './Icons.jsx';

export default function NotificationBell({ consultations = 0, orders = 0, connected, onNavigate }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

  const items = [
    !connected && {
      key: 'connection',
      tone: 'amber',
      title: 'WhatsApp is not connected',
      detail: 'Customers messaging you are not reaching the assistant.',
      actionLabel: 'Go to Setup',
      go: 'setup',
    },
    consultations > 0 && {
      key: 'consultations',
      tone: 'amber',
      title: `${consultations} need${consultations === 1 ? 's' : ''} a pharmacist`,
      detail: 'Someone asked a question the assistant would not answer.',
      actionLabel: 'Open',
      go: 'consultations',
    },
    orders > 0 && {
      key: 'orders',
      tone: 'amber',
      title: `${orders} order${orders === 1 ? '' : 's'} to confirm`,
      detail: 'Stock is held until you confirm, or the hold expires.',
      actionLabel: 'Open',
      go: 'orders',
    },
  ].filter(Boolean);

  // Disconnection counts once toward the badge, same as one waiting thing —
  // it IS one fact that needs attention, not a per-category count of its own.
  const count = (connected ? 0 : 1) + consultations + orders;
  const quiet = count === 0;

  // Same close-on-outside-click / Escape-returns-focus pattern as
  // AccountMenu, so the two dropdowns in this header behave identically.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const go = (tab) => {
    setOpen(false);
    onNavigate?.(tab);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={quiet ? 'Nothing needs you right now' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`}
        className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition
          focus:outline-2 focus:outline-offset-1 focus:outline-teal-500
          ${open ? 'bg-[var(--ui-sunk)] text-[var(--ui-ink)]' : 'text-[var(--ui-ink-faint)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink-soft)]'}`}
      >
        <IconBellOn width={17} height={17} />
        {!quiet && (
          <span
            className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full
                       bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 top-full z-20 mt-1.5 w-72 overflow-hidden rounded-[11px]
                     border border-[var(--ui-line)] bg-[var(--ui-surface)] py-1
                     shadow-[0_8px_24px_rgba(24,32,28,0.12)]"
        >
          {quiet ? (
            <p className="px-3 py-3 text-[13px] text-[var(--ui-ink-faint)]">
              Nothing needs you right now.
            </p>
          ) : (
            <>
              <ul>
                {items.map((item) => (
                  <li key={item.key} className="border-b border-[var(--ui-line)] last:border-0">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => go(item.go)}
                      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition hover:bg-[var(--ui-sunk)]"
                    >
                      <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-[var(--ui-ink)]">{item.title}</span>
                        <span className="block text-[11px] text-[var(--ui-ink-faint)]">{item.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {/* The one figure this bell does not carry — see this file's
                  header for why — so the fuller breakdown is one click away
                  rather than silently missing. */}
              <button
                type="button"
                onClick={() => go('overview')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]
                           text-[var(--ui-ink-soft)] transition hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]"
              >
                <IconOverview width={13} height={13} />
                Open Overview for the full picture
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
