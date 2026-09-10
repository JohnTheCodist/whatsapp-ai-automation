/**
 * One collapsible line: a label, a summary of the current answer, and its
 * panel when open.
 *
 * SHARED BY BusinessInfo AND WebsiteContent, which is why it is its own file
 * now rather than a local helper. Those two panels were one component until
 * the Website tab was restructured, and copying this into both would have let
 * the halves of what still reads as one list drift apart in padding, in
 * wording and in what a row does when it has no panel.
 *
 * A row with no children is a LINK, not a disclosure: "Opening hours" opens
 * the real editor in Setup rather than a second one here. The arrow in the
 * action label is the only thing that says so, so callers pass "Edit →" and
 * this never appends one.
 */

export default function Row({
  label, summary, actionLabel, expanded, onToggle, children,
}) {
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-900">{label}</span>
          {summary && <span className="mt-0.5 block truncate text-xs text-slate-500">{summary}</span>}
        </span>
        <span className="shrink-0 text-sm font-medium text-teal-700">
          {expanded ? 'Close' : actionLabel}
        </span>
      </button>
      {expanded && <div className="pb-5">{children}</div>}
    </div>
  );
}
