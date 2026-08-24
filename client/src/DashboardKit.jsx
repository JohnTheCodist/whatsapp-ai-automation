/* Hallmark · component-scope · design-system: design.md · designed-as-app
 * The shared card voice every ranked-narrative screen in this app draws
 * from — first built for AI Performance, pulled out here once Overview
 * needed the identical voice rather than a second, hand-copied one.
 */

/**
 * Shared building blocks for the "ranked story, not a wall of cards" screens
 * — currently AI Performance and Overview.
 *
 * WHY THIS FILE EXISTS
 * AiPerformance.jsx built Panel, PanelHead, Bar, Trend and Headline first.
 * Overview needed the exact same voice, and design.md is explicit that a
 * system-managed project's pages MUST share one card voice, not each grow
 * their own — "consistency is the goal, not variety" for pages inside one
 * app. Copying the five components into Overview.jsx would have meant two
 * places to fix the next time a border radius or a trend rule changed, and
 * the two copies drifting apart is exactly how an app stops looking like
 * one product. Pulled out once both screens needed it, not before.
 *
 * BARS ARE INK, NEVER THE BRAND COLOUR
 * See Bar below — this is the rule that started the whole extraction: a
 * length-encoded measure coloured teal or amber was decoration wearing the
 * costume of data, in both files, for the same reason.
 */

export const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;
export const pct = (n) => `${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 1 })}%`;

/** A single-series sparkline — inbound/outbound traffic, a revenue line. */
export function Spark({ points, className = '' }) {
  if (!points?.length) return null;
  const max = Math.max(1, ...points);
  const w = 100;
  const h = 28;
  const step = w / Math.max(1, points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-8 w-full ${className}`}>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.10" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A week-over-week (or period-over-period) change, or nothing.
 *
 * null renders no arrow at all rather than a manufactured "0%" or an "∞%" —
 * see insights.js's pctChange for why previous=0 and current=previous=0
 * cannot mean anything to a reader.
 *
 * `invert`: for a metric where LESS is the good direction — interventions,
 * rejections — colour and arrow must not agree with each other the way they
 * do for revenue. The arrow always faces the real direction the number
 * moved; only which colour counts as "good" changes.
 */
export function Trend({ value, invert = false }) {
  if (value === null || value === undefined) return null;
  const up = value > 0;
  const flat = value === 0;
  const good = invert ? !up : up;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums
        ${flat ? 'text-[var(--ui-ink-faint)]' : good ? 'text-teal-700' : 'text-red-600'}`}
    >
      {!flat && (up ? '↑' : '↓')}{pct(Math.abs(value))}
    </span>
  );
}

/**
 * One figure in a headline row — big number, label, trend underneath.
 *
 * `lead` sizes the primary figure above the ones beside it, so three equally
 * loud numbers do not flatten the one the section actually leads with.
 */
export function Headline({ value, label, trend, lead = false }) {
  return (
    <div className="min-w-0 px-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
      <p
        className={`font-semibold tabular-nums tracking-tight text-[var(--ui-ink)]
          ${lead ? 'text-[1.75rem] sm:text-[2.125rem]' : 'text-2xl'}`}
        style={{ overflowWrap: 'anywhere' }}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">{label}</p>
      <div className="mt-1.5 h-4">
        {trend === null || trend === undefined
          ? <span className="text-xs text-[var(--ui-ink-faint)]">—</span>
          : <Trend value={trend} />}
      </div>
    </div>
  );
}

/**
 * A horizontal measure. Ink, near-square, on a faint track — never the
 * brand colour and never a semantic one. Semantic colour means something
 * specific in this system (design.md: red = someone waiting on a human,
 * amber = queued work, emerald = healthy/connected); a bar's LENGTH is what
 * carries its number, and colouring it borrows a meaning that isn't the
 * one intended, which is how a reader ends up mis-reading a ranking bar as
 * a status signal. One component for every bar in the app so two screens
 * cannot each pick their own colour for the same kind of shape.
 */
export function Bar({ value, max, height = 'h-2.5' }) {
  return (
    <div
      className={`${height} min-w-0 flex-1 overflow-hidden`}
      style={{ background: 'var(--ui-bar-track)', borderRadius: 'var(--ui-radius-bar)' }}
    >
      <div
        className="h-full"
        style={{
          width: `${Math.max(1.5, (value / max) * 100)}%`,
          background: 'var(--ui-bar)',
          borderRadius: 'var(--ui-radius-bar)',
        }}
      />
    </div>
  );
}

/**
 * Shared section shell — one card voice, per design.md.
 *
 * min-w-0 because Panel is almost always used as a direct grid/flex item
 * (Overview's Growth panel sits in a `grid lg:grid-cols-[1.6fr_1fr]`), and a
 * grid/flex item's default min-width is its own content's min-content size,
 * not 0. An SVG chart inside — sized only via `w-full`, no explicit width
 * attribute — has an intrinsic width derived from its viewBox, and a
 * replaced element's intrinsic size counts toward min-content the same as
 * unbreakable text does. Without min-w-0 here, that chart alone forced the
 * whole column, and the page under it, wider than a 375px viewport — found
 * live, not hypothetical: this is what actually broke.
 */
export function Panel({ children, className = '' }) {
  return (
    <section className={`min-w-0 rounded-[12px] border border-[var(--ui-line)] bg-[var(--ui-surface)] ${className}`}>
      {children}
    </section>
  );
}

/**
 * Section heading with the system's icon chip.
 *
 * `min-w-0` on the h3 AND on the text span, not just the outer row: a flex
 * item's default min-width is its own unwrapped content width, and that
 * applies at every nesting level independently — the icon+text h3 is
 * itself a flex row nested inside the icon-chip+aside row, so without
 * min-w-0 at BOTH levels a long heading like "Revenue & customer growth"
 * refused to wrap and forced the whole card wider than its column on a
 * narrow screen, which is what actually happened here (found live, at
 * 375px, not a hypothetical). shrink-0 on the icon chip is the other half:
 * it must stay its own size while the text around it is what gives way.
 */
export function PanelHead({ Icon, children, aside }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-[var(--ui-ink)]">
        {Icon && <span className="ui-icon-chip shrink-0"><Icon width={13} height={13} /></span>}
        <span className="min-w-0">{children}</span>
      </h3>
      {aside}
    </div>
  );
}
