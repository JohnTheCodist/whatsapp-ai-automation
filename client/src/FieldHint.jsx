/**
 * The explanation for a field, tucked behind a small (i) beside its label.
 *
 * WHY THIS EXISTS
 * Settings had accumulated a full paragraph of prose under nearly every
 * input — what it is, why it matters, what happens if you get it wrong. Each
 * one was reasonable in isolation and worth keeping; stacked down a whole
 * screen they made every panel look like paperwork, and the one sentence
 * that actually mattered on a given day was buried in five that did not.
 * This does not delete any of that writing — it moves it behind a mark you
 * open on purpose, so the panel reads as a form again and the explanation is
 * still one click from wherever it was.
 *
 * WHAT DOES NOT BELONG BEHIND ONE
 * A live character counter ("42/60") or a state-dependent warning (the
 * printed-code-points-elsewhere notice, the "not saved yet" line) is not
 * background reading — it is the current condition of the field, and hiding
 * it behind a click would cost someone information they need to act right
 * now. Only the static "here is what this is for" prose moves in here. Each
 * call site was picked with that split in mind; see the panel it sits in.
 *
 * BEHAVIOUR
 * Opens on click, so it works the same on a touchscreen as with a mouse —
 * hover alone would leave a phone with no way to open it, and this dashboard
 * already folds down to one at 375px. Closes on Escape, on a click outside,
 * and when the panel around it decides something else took focus. Only one
 * hint is ever open per instance — there is no shared "close the others"
 * registry, deliberately: two explanations open at once on a form this
 * short is not the clutter this component exists to remove.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconInfo } from './Icons.jsx';

/**
 * @param {object} props
 * @param {string} [props.label]  read by a screen reader before the
 *   explanation — "More about Assistant name", not just "More info", so two
 *   hints on one screen are distinguishable without sight.
 * @param {React.ReactNode} props.children  the explanation itself
 */
export default function FieldHint({ label, children }) {
  const [open, setOpen] = useState(false);
  // Horizontal offset (px, relative to the icon) the panel is nudged by so it
  // stays fully on screen. A binary "hang left / hang right" choice was tried
  // first and was not enough: the panel is close to as wide as a phone
  // screen, so for an icon anywhere in roughly the left half, BOTH edges
  // overflow — hanging left overflows off the right, hanging right overflows
  // off the left. This clamps the panel's actual viewport position between a
  // margin on each side instead of picking a fixed edge to anchor to.
  //
  // The field this was found on: "Staff alert number" sits inside an indented
  // box, close enough to center that either anchor failed. A left-anchored
  // panel forced the WHOLE PAGE into horizontal scroll on a phone — this
  // dashboard promises no horizontal scroll, and one popover breaking that
  // would be as bad as the wall of text this component exists to remove.
  const [nudge, setNudge] = useState(0);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) { setNudge(0); return; }
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 12;
    // clientWidth, not innerWidth: innerWidth can include a scrollbar gutter
    // that is not part of the visible page, which would let this measure a
    // panel as "fits" while it still overlaps the scrollbar.
    const viewportWidth = document.documentElement.clientWidth;
    const rect = panel.getBoundingClientRect();
    const overflowRight = rect.right - (viewportWidth - margin);
    const overflowLeft = margin - rect.left;
    // At most one of these is positive for a panel narrower than the
    // available room (the ordinary case, and the only one tested against):
    // push left off the right edge, or push right off the left edge. Right
    // is checked first, so on the one pathological device narrow enough for
    // both to be positive at once, this clears the right edge and may still
    // leave the left edge slightly short — a one-line prose panel losing a
    // few pixels off one side is a paper cut, not a broken layout.
    if (overflowRight > 0) setNudge(-overflowRight);
    else if (overflowLeft > 0) setNudge(overflowLeft);
  }, [open]);

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

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={label ? `More about ${label}` : 'More information'}
        className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full transition
          focus:outline-2 focus:outline-offset-1 focus:outline-teal-500
          ${open ? 'text-[var(--ui-accent-ink,#0f766e)]' : 'text-slate-400 hover:text-slate-600'}`}
      >
        <IconInfo width={14} height={14} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="tooltip"
          style={{ left: nudge }}
          className="absolute top-full z-20 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-[9px] border
                     border-slate-200 bg-white p-2.5 text-xs leading-relaxed text-slate-600
                     shadow-[0_8px_20px_rgba(24,32,28,0.12)]"
        >
          {children}
        </div>
      )}
    </span>
  );
}
