/**
 * The account chip in the top-right: who this workspace belongs to, and the
 * two things you do with that — open Settings, or leave.
 *
 * WHY THE PHARMACY NAME AND NOT THE SIGNED-IN PERSON
 * A pharmacy runs this on a shared counter screen. The question staff
 * actually need answered at a glance is "which pharmacy's data am I looking
 * at", not "whose login is this" — the second matters exactly once, when
 * signing out. So the name is the pharmacy's and the email sits inside the
 * menu, where the person who needs it is already looking.
 *
 * WHY SIGN OUT MOVED HERE FROM THE RAIL
 * It sat directly above the connection panel, which put a destructive,
 * once-a-day action permanently in the same corner as a status readout
 * people scan constantly. Behind a deliberate click it is still one gesture
 * away, and it can no longer be hit while reaching for something else.
 *
 * Rendered nowhere when there is no session (DEV_AUTH_BYPASS): a Sign out
 * that signs nothing out is worse than its absence, so the menu keeps only
 * the entries that do something.
 *
 * WHY THE SWITCHER LIVES HERE
 * One login may own up to five pharmacies (MAX_PHARMACIES_PER_USER), and
 * until 2026-09-06 there was no way to move between them. Creating a second
 * pharmacy pinned it as active in localStorage, and with nothing in the UI
 * to change that, the first pharmacy — the one with the connected WhatsApp
 * number, the customers and the orders — became unreachable. A one-way door,
 * escapable only by clearing site data from a browser console.
 *
 * It belongs in this menu and not the rail because "which pharmacy am I
 * looking at" is the question this chip already exists to answer. Somewhere
 * else it would be a second answer to the same question, in a different
 * corner.
 *
 * Hidden below two memberships. A control offering one choice is furniture.
 */

import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconSetup, IconSignOut, IconCheckCircle } from './Icons.jsx';
import { setActivePharmacyId } from './auth.js';

/**
 * "Sterling Pharmacy" -> "SP". One pharmacy, one stable mark.
 *
 * Derived rather than stored: an uploaded logo is a real feature with real
 * work behind it (upload, crop, hosting, a fallback for the pharmacies that
 * never add one), and initials cover the job this chip is doing today.
 */
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export default function AccountMenu({
  pharmacyName,
  email,
  memberships = [],
  activePharmacyId = null,
  onOpenSettings,
  onSignOut,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

  // Close on a click anywhere else, and on Escape. Both are registered only
  // while the menu is actually open — a document-level listener that lives
  // for the lifetime of the app runs on every click in the dashboard to
  // decide it has nothing to do.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Focus goes back to the button, not to the top of the page — closing
      // a menu should leave a keyboard user where they opened it.
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const name = pharmacyName || 'Your pharmacy';

  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition';

  // Two or more, or it is not a choice.
  const canSwitch = Array.isArray(memberships) && memberships.length > 1;

  /**
   * Change tenant by storing the id and RELOADING THE WHOLE APP.
   *
   * A soft switch — set the id, let React refetch — is the obvious
   * implementation and the wrong one. Every panel in this dashboard holds
   * its own independently fetched state: orders, the inbox, the catalogue,
   * customers, the consultation queue. Swapping the tenant underneath them
   * would leave each one showing the previous pharmacy's data until its own
   * poll happened to come round, under a header already displaying the new
   * pharmacy's name. That is not a loading state, it is one pharmacy's
   * customers labelled as another's — in a product whose central promise is
   * that those are never mixed.
   *
   * A reload discards all of it at once. It costs a second, and it makes the
   * mixed state unreachable rather than merely brief.
   */
  const switchTo = (id) => {
    if (!id || id === activePharmacyId) { setOpen(false); return; }
    setActivePharmacyId(id);
    window.location.reload();
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-[9px] py-1 pl-1 pr-1.5 transition
          focus:outline-2 focus:outline-offset-1 focus:outline-teal-500
          ${open ? 'bg-[var(--ui-sunk)]' : 'hover:bg-[var(--ui-sunk)]'}`}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                     bg-[var(--ui-accent)] text-[11px] font-semibold text-white"
        >
          {initialsOf(name)}
        </span>
        {/* The name is the chip's whole point, but it is also the part that
            can be long. It truncates rather than pushing the chevron off the
            bar, and drops out entirely on a narrow screen where the avatar
            alone still identifies the workspace. */}
        <span className="hidden max-w-[9rem] truncate text-[13px] font-medium text-[var(--ui-ink)] sm:block">
          {name}
        </span>
        <IconChevronDown
          width={15}
          height={15}
          className={`shrink-0 text-[var(--ui-ink-faint)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-20 mt-1.5 w-60 overflow-hidden rounded-[11px]
                     border border-[var(--ui-line)] bg-[var(--ui-surface)] py-1
                     shadow-[0_8px_24px_rgba(24,32,28,0.12)]"
        >
          <div className="border-b border-[var(--ui-line)] px-3 pb-2.5 pt-2">
            <p className="truncate text-[13px] font-semibold text-[var(--ui-ink)]">{name}</p>
            {email && (
              <p className="truncate text-[11px] text-[var(--ui-ink-faint)]">{email}</p>
            )}
          </div>

          {canSwitch && (
            <div className="border-b border-[var(--ui-line)] py-1">
              <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ui-ink-faint)]">
                Switch pharmacy
              </p>
              {/* Scrolls rather than growing: five memberships is the cap, but
                  a menu that can push its own Sign out below the fold is a
                  menu that can hide the way out. */}
              <div className="max-h-52 overflow-y-auto">
                {memberships.map((m) => {
                  const isActive = m.pharmacy_id === activePharmacyId;
                  return (
                    <button
                      key={m.pharmacy_id}
                      type="button"
                      role="menuitem"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => switchTo(m.pharmacy_id)}
                      className={`${item} ${isActive
                        ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]'
                        : 'text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]'}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                                    text-[10px] font-semibold ${isActive
                          ? 'bg-[var(--ui-accent)] text-white'
                          : 'bg-[var(--ui-sunk)] text-[var(--ui-ink-faint)]'}`}
                      >
                        {initialsOf(m.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{m.name || 'Unnamed pharmacy'}</span>
                        {/* The role is the useful second line, not the id: it
                            tells you what you will be able to do once you are
                            in there. */}
                        <span className="block text-[11px] capitalize text-[var(--ui-ink-faint)]">
                          {m.role}
                          {m.status && m.status !== 'active' ? ` · ${m.status}` : ''}
                        </span>
                      </span>
                      {isActive && (
                        <IconCheckCircle width={15} height={15} className="shrink-0" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSettings?.(); }}
            className={`${item} text-[var(--ui-ink-soft)] hover:bg-[var(--ui-sunk)] hover:text-[var(--ui-ink)]`}
          >
            <IconSetup width={16} height={16} />
            Settings
          </button>

          {/* Only with a real session behind it — see this file's header. */}
          {onSignOut && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onSignOut(); }}
              className={`${item} text-[var(--ui-ink-soft)] hover:bg-red-50 hover:text-red-700`}
            >
              <IconSignOut width={16} height={16} />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
