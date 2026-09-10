/**
 * The explanation, folded into an icon.
 *
 * WHY THIS EXISTS. Every panel on this tab carried a sentence or two of
 * explanation under its heading — what the panel does, where the data goes,
 * why a figure is a floor rather than an exact number. All of it true, all of
 * it worth saying once, and none of it worth re-reading on the fifth visit.
 * Stacked up it was most of the words on the screen.
 *
 * So the sentence stays, and the reader chooses when to see it. An owner
 * meeting the panel for the first time can ask; one who already knows sees a
 * heading and gets on with it.
 *
 * NOT A HOVER TOOLTIP. `title=""` and hover popovers do not exist on a phone,
 * which is where a pharmacy owner actually opens this. Click to open, click
 * anywhere to close, Escape to dismiss — the same gesture on both.
 *
 * ACCESSIBLE BY CONSTRUCTION rather than by attribute soup: a real <button>
 * with aria-expanded, and the panel is a sibling with an id the button owns.
 * A screen reader gets "more information, collapsed" and the text on demand,
 * which is exactly what a sighted reader gets.
 */

import { useEffect, useId, useRef, useState } from 'react';

export default function InfoTip({ children, label = 'More information' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef(null);

  // Dismiss on Escape or on a click anywhere outside. Bound only while open,
  // so a page full of these costs nothing until one is used.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    const onDown = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <span ref={wrap} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold transition ${
          open
            ? 'border-teal-600 bg-teal-600 text-white'
            : 'border-slate-300 text-slate-400 hover:border-slate-400 hover:text-slate-600'
        }`}
      >
        i
      </button>

      {open && (
        <span
          id={id}
          role="note"
          // Anchored to the icon and clamped to a readable measure. Pulled
          // left rather than centred so it cannot hang off the right edge of
          // a panel on a narrow screen.
          className="absolute left-0 top-7 z-20 w-64 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-600 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
