/* Hallmark · genre: modern-minimal · macrostructure: Workbench
 * design-system: design.md · designed-as-app · tone: premium-utilitarian
 * pre-emit critique: P5 H5 E4 S5 R5 V4
 */

/**
 * AI Performance — not "here is all the data we collected", but "here is
 * what happened this week, why it matters, and what to do about it".
 *
 * WHY THIS REPLACED A WALL OF EQUAL-WEIGHT CARDS
 * The previous version gave a metric card to conversion rate, pharmacist
 * interventions, messages, orders, confirmed value, rejected, expired,
 * catalogue count, missing price and out of stock — ten-plus cards, all the
 * same size, all the same weight. That answers "what metrics can we show"
 * rather than "what does the pharmacist need to know, and what should they
 * do about it". The fix is not fewer numbers, it is fewer THINGS: the same
 * figures, organised into a story a pharmacist can act on without doing the
 * interpretation themselves.
 *
 * WHY THERE IS A TAB STRIP
 * Six ranked sections is the right amount of information and the wrong
 * amount of scroll. The strip splits them by the QUESTION each answers —
 * how did the week go, where is money leaking, is the machine running —
 * so the screen opens on one answer instead of all three. Same tablist
 * pattern as Settings.jsx (roving tabIndex, arrow keys wrap, active tab
 * raised onto a bottom rule), because a second tab idiom in one app is how
 * a product starts feeling assembled rather than designed.
 *
 * WHY THE BARS ARE INK AND NOT THE BRAND COLOUR
 * They were emerald, and emerald in this system means identity and health
 * (design.md) — never decoration, and a bar measuring lost revenue is not
 * health. The loss breakdown was amber for the same non-reason; amber here
 * means queued work, not "bigger than the one below it". Both now use
 * --ui-bar (ink), and LENGTH carries the number. Nothing is coloured to
 * look interesting.
 *
 * WHAT IS NOT HERE, ON PURPOSE
 * No invented "abandoned" bucket and no fabricated ₦ value for uncatalogued
 * product requests. Only two loss reasons are actually monetised in this
 * system — the pharmacist rejecting an order, and a hold expiring
 * unconfirmed — because both are real orders with a real total_kobo. A
 * customer asking for something never in the catalogue has no price
 * attached at all; showing a number there would be a plausible-looking
 * guess nobody measured, which is worse than showing none (see insights.js's
 * own file header). It gets a count instead, labelled unpriced.
 *
 * All figures are last-7-days-vs-previous-7 from /api/insights' `week` key,
 * except catalogue health and the reply-cap strip, which are point-in-time
 * facts from /api/overview and have no "this week" to compare against.
 */

import { useEffect, useRef, useState } from 'react';
import {
  IconAi, IconAlertTriangle, IconCheckCircle, IconInventory, IconRequests,
} from './Icons.jsx';

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;
const pct = (n) => `${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 1 })}%`;

/**
 * The three questions this screen answers, as a tab strip.
 *
 * Split by QUESTION, not by data source — "catalogue health" sits under
 * Opportunity rather than Operations because an unpriced product is a
 * blocked sale, which is the thing that tab is about.
 */
const VIEWS = [
  { id: 'performance', label: 'Performance' },
  { id: 'opportunity', label: 'Opportunity' },
  { id: 'operations', label: 'Operations' },
];

function Spark({ points, className = '' }) {
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
 * A week-over-week change, or nothing.
 *
 * null (previous period was zero, or nothing happened in either) renders no
 * arrow at all rather than a manufactured "0%" or an "∞%" — see insights.js's
 * pctChange for why those two cases cannot mean anything to a reader.
 *
 * `invert`: for a metric where LESS is the good direction — interventions,
 * rejections — colour and arrow must not agree with each other the way they
 * do for revenue. The arrow always faces the real direction the number
 * moved (↓ for a real decrease, never flipped to ↑ to match the colour);
 * only which colour counts as "good" changes.
 */
function Trend({ value, invert = false }) {
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
 * One figure in the performance headline.
 *
 * `lead` sizes the primary figure above the two beside it. All three were
 * the same size, which flattened the very hierarchy the section exists to
 * establish — money first, then the counts that explain it.
 */
function Headline({ value, label, trend, lead = false }) {
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
 * A horizontal measure. Ink, near-square, on a faint track.
 *
 * One component for both the funnel and the loss breakdown — they were two
 * near-identical implementations differing only in the colour each had
 * picked for itself, which is how two bars in one screen end up looking
 * like they came from two different products.
 */
function Bar({ value, max, height = 'h-2.5' }) {
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
 * The customer journey, as a track that narrows rather than four equal
 * boxes. Width is proportional to the FIRST step, so the narrowing itself —
 * not just the numbers printed on it — shows where the story is leaking.
 *
 * The final step used to be a darker green than the three above it, which
 * looked like it encoded something and did not. Its weight now comes from
 * type, which is honest: it is the outcome, so its label is the one set in
 * ink rather than grey.
 */
function Funnel({ steps }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="space-y-3">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={s.label} className="flex items-center gap-4">
            <span className={`w-28 shrink-0 text-xs sm:w-36 ${
              last ? 'font-medium text-[var(--ui-ink)]' : 'text-[var(--ui-ink-soft)]'
            }`}>
              {s.label}
            </span>
            <Bar value={s.value} max={max} height="h-2.5" />
            <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--ui-ink)]">
              {s.value.toLocaleString('en-NG')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One reason in the loss breakdown. */
function OpportunityRow({ label, count, value, max }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-36 shrink-0 text-xs text-[var(--ui-ink-soft)] sm:w-48">{label}</span>
      <Bar value={count} max={max} height="h-2" />
      <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-[var(--ui-ink)]">{count}</span>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-[var(--ui-ink-faint)]">{value ?? ''}</span>
    </div>
  );
}

/** Shared section shell — one card voice, per design.md. */
function Panel({ children, className = '' }) {
  return (
    <section className={`rounded-[12px] border border-[var(--ui-line)] bg-[var(--ui-surface)] ${className}`}>
      {children}
    </section>
  );
}

/** Section heading with the system's icon chip. */
function PanelHead({ Icon, children, aside }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2.5 text-sm font-medium text-[var(--ui-ink)]">
        {Icon && <span className="ui-icon-chip"><Icon width={13} height={13} /></span>}
        {children}
      </h3>
      {aside}
    </div>
  );
}

export default function AiPerformance({ onNavigate }) {
  const [ov, setOv] = useState(null);
  const [ins, setIns] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(VIEWS[0].id);
  const tabRefs = useRef({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [a, b] = await Promise.all([fetch('/api/overview'), fetch('/api/insights')]);
        const aj = await a.json();
        if (!a.ok) throw new Error(aj.error || 'Could not load performance.');
        const bj = b.ok ? await b.json() : null;
        if (!cancelled) { setOv(aj); setIns(bj); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) {
    return (
      <p className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
    );
  }
  if (!ov) return <p className="text-sm text-[var(--ui-ink-soft)]">Loading…</p>;

  const { catalogue, limits, daily } = ov;
  const wk = ins?.week;
  const lost = ins?.lostOrders;
  const unmet = ins?.unmetDemand;

  // Real, monetised lost order value. Deliberately excludes unmet demand —
  // see this file's header for why that has no price to add in.
  const lostOrderValue = lost ? Number(lost.rejected.value) + Number(lost.holdExpired.value) : null;

  // NOTHING HAPPENED and NOTHING WENT WRONG are different facts, and a
  // dashboard that renders them identically is the "0 everywhere" problem:
  // a quiet week gets an amber NEEDS ATTENTION card announcing "0 requests",
  // and an empty funnel of four zero-width bars, both of which read as
  // failure rather than as a pharmacy that has not started yet. Each section
  // below decides for itself which of the two it is looking at.
  const hadTraffic = Boolean(wk && wk.conversations > 0);
  const unresolved = unmet?.unresolved7d || 0;
  const lostCount = lost ? lost.rejected.count + lost.holdExpired.count : 0;
  const hasAttention = unresolved > 0 || lostCount > 0;

  const readyPct = catalogue.active > 0
    ? Math.max(0, Math.round(((catalogue.active - catalogue.noPrice - catalogue.outOfStock) / catalogue.active) * 100))
    : null;

  const oppMax = lost ? Math.max(1, unresolved, lost.rejected.count, lost.holdExpired.count) : 1;

  /** Roving tabIndex + arrow keys, matching Settings.jsx's strip. */
  const onTabKeyDown = (e) => {
    const i = VIEWS.findIndex((v) => v.id === view);
    if (i < 0) return;
    const go = (n) => {
      e.preventDefault();
      const next = VIEWS[n].id;
      setView(next);
      tabRefs.current[next]?.focus();
    };
    if (e.key === 'ArrowRight') go((i + 1) % VIEWS.length);
    else if (e.key === 'ArrowLeft') go((i - 1 + VIEWS.length) % VIEWS.length);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(VIEWS.length - 1);
  };

  return (
    <div>
      {/* ---- the strip: which question are we answering ---- */}
      <div
        role="tablist"
        aria-label="Performance views"
        onKeyDown={onTabKeyDown}
        className="mb-6 flex flex-wrap items-end gap-1 border-b border-[var(--ui-line)]"
      >
        {VIEWS.map((v) => {
          const on = v.id === view;
          return (
            <button
              key={v.id}
              ref={(el) => { tabRefs.current[v.id] = el; }}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => setView(v.id)}
              className={`-mb-px rounded-t-[8px] border border-b-0 px-4 py-2 text-[13px] font-medium transition-colors
                ${on
                  ? 'border-[var(--ui-line)] bg-[var(--ui-surface)] text-[var(--ui-ink)]'
                  : 'border-transparent text-[var(--ui-ink-soft)] hover:text-[var(--ui-ink)]'}`}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {/* ================= PERFORMANCE ================= */}
      {view === 'performance' && (
        <div className="space-y-5">

          {/* The outcome, with a direction. Given more air than anything
              below it — the one section that is allowed to breathe. */}
          <Panel className="p-6">
            <PanelHead
              Icon={IconAi}
              aside={<span className="text-xs text-[var(--ui-ink-faint)]">Last 7 days, vs the 7 before</span>}
            >
              Pharmacy performance
            </PanelHead>

            {!wk ? (
              <p className="mt-4 text-sm text-[var(--ui-ink-faint)]">—</p>
            ) : (
              /* Ruled columns rather than gapped ones. A hairline between
                 figures is the register a printed statement uses, and it
                 stops three numbers reading as three unrelated cards. */
              <div className="mt-5 grid grid-cols-1 divide-y divide-[var(--ui-line)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <Headline lead value={naira(wk.confirmedValue)} label="Confirmed order value" trend={wk.confirmedValueChangePct} />
                <Headline value={wk.orders.toLocaleString('en-NG')} label="Orders" trend={wk.ordersChangePct} />
                <Headline value={wk.conversations.toLocaleString('en-NG')} label="Conversations" trend={wk.conversationsChangePct} />
              </div>
            )}

            {/* The "is it worth it overall" question the week view cannot
                answer on its own. Hidden at zero: "₦0 since this pharmacy
                went live" reads as a verdict on the product when all it
                means is that nothing has happened yet. */}
            {ins?.headline?.aiAssistedSales > 0 && (
              <p className="mt-5 border-t border-[var(--ui-line)] pt-4 text-xs text-[var(--ui-ink-soft)]">
                {naira(ins.headline.aiAssistedSales)} in AI-assisted sales since this pharmacy went live.
              </p>
            )}
          </Panel>

          {/* Where the story leaks. */}
          {wk && (
            <Panel className="p-5">
              <PanelHead>This week’s customer journey</PanelHead>
              {hadTraffic ? (
                <>
                  <div className="mt-5">
                    <Funnel
                      steps={[
                        { label: 'Conversations', value: wk.conversations },
                        { label: 'Product requests', value: wk.productRequests },
                        { label: 'Orders', value: wk.orders },
                        { label: 'Completed', value: wk.completed },
                      ]}
                    />
                  </div>
                  {wk.conversionRate !== null && (
                    <p className="mt-4 border-t border-[var(--ui-line)] pt-3 text-xs text-[var(--ui-ink-soft)]">
                      Conversion: <strong className="tabular-nums text-[var(--ui-ink)]">{pct(wk.conversionRate)}</strong> of
                      conversations became an order.
                    </p>
                  )}
                </>
              ) : (
                /* Four zero-width bars say "your funnel is broken". One
                   sentence says the true thing — the week has not started. */
                <p className="mt-2 text-sm text-[var(--ui-ink-soft)]">
                  No customer conversations this week yet.
                  {limits.replyMode === 'allowlist' && ' The assistant is currently replying to allowlisted numbers only.'}
                  {limits.replyMode === 'off' && ' The assistant is currently set not to reply to anyone.'}
                </p>
              )}
            </Panel>
          )}

          {/* Failures beside successes, as two sentences apiece. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Amber ONLY when there is genuinely something to attend to.
                An amber card headed NEEDS ATTENTION reading "0 requests" is
                the loudest way a dashboard reports good news as bad. */}
            <div className={`rounded-[12px] border p-5 ${
              hasAttention ? 'border-amber-200 bg-amber-50' : 'border-[var(--ui-line)] bg-[var(--ui-surface)]'
            }`}>
              <h3 className={`flex items-center gap-2 text-sm font-medium ${
                hasAttention ? 'text-amber-900' : 'text-[var(--ui-ink-faint)]'
              }`}>
                <IconAlertTriangle width={15} height={15} />Needs attention
              </h3>
              {!hasAttention ? (
                <p className="mt-2.5 text-sm text-[var(--ui-ink-soft)]">
                  {hadTraffic
                    ? 'Nothing lost this week — every request was either filled or answered.'
                    : 'Nothing waiting.'}
                </p>
              ) : (
                <>
                  {unresolved > 0 && (
                    <p className="mt-2.5 text-sm leading-relaxed text-amber-900">
                      <strong className="tabular-nums">{unresolved}</strong> request
                      {unresolved === 1 ? '' : 's'} this week {unresolved === 1 ? 'was' : 'were'} for
                      products not in your catalogue.
                    </p>
                  )}
                  {lostOrderValue > 0 && (
                    <p className={`text-xs leading-relaxed text-amber-800 ${unresolved > 0 ? 'mt-1.5' : 'mt-2.5'}`}>
                      <strong className="tabular-nums">{naira(lostOrderValue)}</strong> in placed orders
                      did not go through — see Opportunity.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => onNavigate?.('requests')}
                    className="mt-3 text-xs font-medium text-amber-900 underline decoration-amber-300 underline-offset-4 hover:decoration-amber-600"
                  >
                    Review requests →
                  </button>
                </>
              )}
            </div>

            {/* Teal reads as a claim of success, so it is earned the same
                way amber is: only once there is traffic to have succeeded AT. */}
            <div className={`rounded-[12px] border p-5 ${
              hadTraffic ? 'border-teal-200 bg-teal-50' : 'border-[var(--ui-line)] bg-[var(--ui-surface)]'
            }`}>
              <h3 className={`flex items-center gap-2 text-sm font-medium ${
                hadTraffic ? 'text-teal-900' : 'text-[var(--ui-ink-faint)]'
              }`}>
                <IconCheckCircle width={15} height={15} />What’s working
              </h3>
              {hadTraffic ? (
                <>
                  <p className="mt-2.5 text-sm leading-relaxed text-teal-900">
                    {wk.aiHandledPct === null
                      ? 'Not enough conversations yet to measure.'
                      : <>AI handled <strong className="tabular-nums">{pct(wk.aiHandledPct)}</strong> of conversations without a person.</>}
                  </p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-teal-800">
                    <span>
                      <strong className="tabular-nums">{wk.interventions}</strong> staff intervention
                      {wk.interventions === 1 ? '' : 's'} this week
                    </span>
                    <Trend value={wk.interventionsChangePct} invert />
                  </p>
                </>
              ) : (
                /* "0 staff interventions" is not an achievement when nobody
                   wrote in. Say what is actually true instead. */
                <p className="mt-2.5 text-sm text-[var(--ui-ink-soft)]">Nothing to measure yet this week.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= OPPORTUNITY ================= */}
      {view === 'opportunity' && (
        <div className="space-y-5">

          {/* Real, monetised lost orders. Rendered only when something was
              actually lost — three zero-length bars under "Sales
              opportunity" is a section asking to be read and saying nothing. */}
          {lost && hasAttention ? (
            <Panel className="p-5">
              <PanelHead
                Icon={IconRequests}
                aside={lostOrderValue > 0 ? (
                  <span className="text-xs text-[var(--ui-ink-soft)]">
                    Missed this week{' '}
                    <strong className="tabular-nums text-[var(--ui-ink)]">{naira(lostOrderValue)}</strong>
                  </span>
                ) : null}
              >
                Sales opportunity
              </PanelHead>
              <p className="mt-1 text-xs text-[var(--ui-ink-faint)]">
                Orders and requests that did not become a sale.
              </p>

              <div className="mt-5 space-y-3">
                <OpportunityRow label="Not in catalogue" count={unresolved} value="unpriced" max={oppMax} />
                <OpportunityRow
                  label="Rejected by pharmacy" count={lost.rejected.count}
                  value={lost.rejected.count > 0 ? naira(lost.rejected.value) : null} max={oppMax}
                />
                <OpportunityRow
                  label="Hold expired, no response" count={lost.holdExpired.count}
                  value={lost.holdExpired.count > 0 ? naira(lost.holdExpired.value) : null} max={oppMax}
                />
              </div>

              <p className="mt-4 border-t border-[var(--ui-line)] pt-3 text-[11px] leading-relaxed text-[var(--ui-ink-faint)]">
                “Not in catalogue” carries no price — the product was never stocked, so there is nothing
                verified to value it at.
              </p>
              <button
                type="button"
                onClick={() => onNavigate?.('requests')}
                className="mt-3 text-xs font-medium text-[var(--ui-ink)] underline decoration-[var(--ui-line)] underline-offset-4 hover:decoration-[var(--ui-ink-faint)]"
              >
                View requests →
              </button>
            </Panel>
          ) : (
            <Panel className="p-5">
              <PanelHead Icon={IconRequests}>Sales opportunity</PanelHead>
              <p className="mt-2.5 text-sm text-[var(--ui-ink-soft)]">
                {hadTraffic
                  ? 'Nothing was lost this week — every request was either filled or answered.'
                  : 'Nothing lost yet — no customer activity this week.'}
              </p>
            </Panel>
          )}

          {/* One readiness figure, not three raw counts. */}
          <Panel className="p-5">
            <PanelHead
              Icon={IconInventory}
              aside={readyPct !== null ? (
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${
                  readyPct >= 90 ? 'bg-teal-100 text-teal-800'
                    : readyPct >= 70 ? 'bg-amber-100 text-amber-800'
                      : 'bg-red-100 text-red-800'
                }`}>
                  {readyPct}% ready
                </span>
              ) : null}
            >
              Catalogue health
            </PanelHead>

            {catalogue.active === 0 ? (
              /* "0 products · Nothing needs attention" is actively wrong: an
                 empty catalogue is the one state where EVERYTHING needs
                 attention, because the assistant has nothing it can sell. */
              <>
                <p className="mt-3 text-sm text-[var(--ui-ink)]">No catalogue uploaded yet.</p>
                <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">
                  The assistant cannot quote or sell anything until a product list is imported.
                </p>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm text-[var(--ui-ink)]">
                  <strong className="tabular-nums">{catalogue.active.toLocaleString('en-NG')}</strong> products
                  {readyPct !== null && (
                    <span className="text-[var(--ui-ink-soft)]"> — {readyPct}% ready for a customer to order right now.</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">
                  {catalogue.noPrice > 0 && <><strong className="tabular-nums text-[var(--ui-ink)]">{catalogue.noPrice}</strong> missing a price</>}
                  {catalogue.noPrice > 0 && catalogue.outOfStock > 0 && ' · '}
                  {catalogue.outOfStock > 0 && <><strong className="tabular-nums text-[var(--ui-ink)]">{catalogue.outOfStock}</strong> out of stock</>}
                  {catalogue.noPrice === 0 && catalogue.outOfStock === 0 && 'Nothing needs attention.'}
                </p>
              </>
            )}
            <button
              type="button"
              onClick={() => onNavigate?.(catalogue.active === 0 ? 'inventory-upload' : 'inventory')}
              className="mt-3 text-xs font-medium text-[var(--ui-ink)] underline decoration-[var(--ui-line)] underline-offset-4 hover:decoration-[var(--ui-ink-faint)]"
            >
              {catalogue.active === 0 ? 'Upload a catalogue →' : 'View catalogue →'}
            </button>
          </Panel>
        </div>
      )}

      {/* ================= OPERATIONS ================= */}
      {view === 'operations' && (
        <div className="space-y-5">

          {/* Traffic shape — a chart, not a card. */}
          <Panel className="p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-medium text-[var(--ui-ink)]">Messages, last 14 days</h3>
              <span className="text-[11px] text-[var(--ui-ink-faint)]">
                in <span className="text-teal-600">▬</span> · out <span className="text-[var(--ui-ink-faint)]">▬</span>
              </span>
            </div>
            <div className="mt-3 text-teal-600"><Spark points={daily.map((d) => d.inbound)} /></div>
            <div className="text-[var(--ui-ink-faint)]"><Spark points={daily.map((d) => d.outbound)} /></div>
            <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--ui-ink-faint)]">
              <span>{daily[0]?.day}</span><span>{daily[daily.length - 1]?.day}</span>
            </div>
          </Panel>

          {/* Is it allowed to keep replying — status, not a story. */}
          <Panel className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-[var(--ui-ink-soft)]">
                Replies sent today: <strong className="tabular-nums text-[var(--ui-ink)]">{limits.sent24h}</strong> of{' '}
                <span className="tabular-nums">{limits.cap}</span>
                {limits.capSource === 'warmup' && (
                  <span className="ml-1.5 text-xs text-[var(--ui-ink-faint)]">warm-up day {limits.warmupDay}</span>
                )}
              </span>
              <span className="text-xs text-[var(--ui-ink-faint)]">
                Replying to {limits.replyMode === 'all' ? 'everyone'
                  : limits.replyMode === 'allowlist' ? 'allowlisted numbers only' : 'nobody'}
              </span>
            </div>
            <div
              className="mt-3 h-1.5 overflow-hidden"
              style={{ background: 'var(--ui-bar-track)', borderRadius: 'var(--ui-radius-bar)' }}
            >
              <div
                className={limits.sent24h / limits.cap > 0.8 ? 'h-full bg-amber-500' : 'h-full'}
                style={{
                  width: `${Math.min(100, (limits.sent24h / Math.max(1, limits.cap)) * 100)}%`,
                  borderRadius: 'var(--ui-radius-bar)',
                  ...(limits.sent24h / limits.cap > 0.8 ? {} : { background: 'var(--ui-bar)' }),
                }}
              />
            </div>
            {limits.sendingPaused && (
              <p className="mt-3 rounded-[10px] border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                Sending is paused — {limits.pausedReason || 'paused automatically.'}{' '}
                <button
                  onClick={() => onNavigate?.('setup')}
                  className="font-medium underline decoration-red-300 underline-offset-4"
                >
                  Setup
                </button>
              </p>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
