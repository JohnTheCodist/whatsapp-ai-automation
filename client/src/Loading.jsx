/**
 * The "Loading…" replacement — three dots pulsing in sequence, the same
 * shape as a WhatsApp typing indicator.
 *
 * NOT A GENERIC SPINNER, ON PURPOSE
 * This product is a WhatsApp assistant. The one loading animation in it
 * echoing the channel it lives in is a small, deliberate callback rather
 * than the stock spinner every other dashboard reaches for — it should feel
 * like this product, not like a component library's default.
 *
 * currentColor, not a fixed colour. The ~14 call sites this replaces each
 * already set their own muted text tone on the wrapper — slate-400,
 * slate-500, --ui-ink-soft — and the dots need to read as "the same message,
 * animated" in whatever context they land, not a fixed colour dropped in
 * on top of fourteen different backgrounds.
 *
 * CSS keyframes only, per design.md's motion-cut stance — no animation
 * library. `prefers-reduced-motion` freezes the dots at a fixed, visible
 * opacity rather than removing them (see index.css): they are the loading
 * state's only content, not decoration sitting on top of it, so hiding
 * them entirely would leave the label with no indication anything is
 * happening at all.
 */
export default function Loading({ label = 'Loading', className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {label}
      <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
        <span className="ui-loading-dot" />
        <span className="ui-loading-dot" style={{ animationDelay: '0.16s' }} />
        <span className="ui-loading-dot" style={{ animationDelay: '0.32s' }} />
      </span>
    </span>
  );
}
