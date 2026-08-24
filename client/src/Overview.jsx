/* Hallmark · genre: modern-minimal · macrostructure: Workbench
 * design-system: design.md · designed-as-app · tone: premium-utilitarian
 * pre-emit critique: P5 H4 E4 S4 R5 V4
 */

/**
 * Overview — the screen a pharmacy owner opens first, told in the same
 * ranked-narrative voice AI Performance already uses: fewer, larger THINGS
 * rather than a wall of same-size cards, sharing Panel/PanelHead/Bar/
 * Headline/Trend from DashboardKit.jsx rather than a second hand-copied set.
 *
 * WHY THIS SCREEN DOES NOT GET A TAB STRIP
 * AI Performance splits into Performance / Opportunity / Operations because
 * those are three separate QUESTIONS a pharmacist asks at different times.
 * Overview is one question — "how is the pharmacy doing" — asked once, and
 * four sections is short enough to read top to bottom without a scroll a
 * strip would only pretend to save. Forcing the same tab mechanic onto
 * content that does not split is structure for its own sake, not craft.
 *
 * ORDER IS THE DESIGN
 * The snapshot first (who we serve, what it is worth, who we are tracking
 * clinically), then the chronic register that headline number is the front
 * of, then the one operational number an owner can act on today (order
 * approval speed), then growth and what is driving it. An owner should be
 * able to stop reading after the first panel on a normal day.
 *
 * THE "NEEDS YOU" BAR AND THE WHATSAPP-DISCONNECTED BANNER ARE NOT HERE
 * They moved into the header's NotificationBell — see that file. Neither
 * fact is specific to this one screen, and a fact that important should not
 * require opening one particular tab to see it.
 *
 * BARS ARE INK, NOT THE BRAND COLOUR
 * The Top 5 products ranking bar was teal — decoration wearing the costume
 * of data, the same mistake AI Performance's funnel made and fixed. Length
 * already carries the number; colour there was borrowing a meaning (health,
 * identity) that a sales ranking does not have. Now the shared ink Bar.
 * Chronic register and the approval-time card keep real colour on purpose:
 * a tracked condition genuinely IS this system's "health" domain, and
 * on-time/late is a genuine status signal — design.md's semantic-colour
 * rule protects exactly those two cases, not a ranking bar.
 */

import { useEffect, useState } from 'react';
import { IconCustomers, IconHeart, IconTrendUp } from './Icons.jsx';
import { naira, Bar, Panel, PanelHead } from './DashboardKit.jsx';
import Loading from './Loading.jsx';

/**
 * The chronic register, per condition.
 *
 * WHY ZEROES ARE SHOWN RATHER THAN HIDDEN
 * A condition with nobody in it is dropped by most dashboards, which makes
 * "we do not follow asthma" and "we follow asthma and nobody qualifies yet"
 * look identical. They are opposite facts, and only one of them means the
 * pharmacy should go looking. So every tracked condition appears, and an
 * empty one says so in words.
 *
 * PENDING IS SHOWN, NEVER ADDED IN
 * "Tracked" has to keep meaning confirmed by a real purchase. A patient one
 * purchase short is worth knowing about — they are the next refill list —
 * but folding them into the headline count is how a register fills with
 * maybes and stops being trusted.
 */
function Chronic({ conditions }) {
  if (!conditions?.length) return null;

  const anyone = conditions.some((c) => c.confirmed > 0 || c.pending > 0);

  return (
    <Panel className="p-5">
      <PanelHead
        Icon={IconHeart}
        aside={<span className="text-xs text-[var(--ui-ink-faint)]">Confirmed by purchase history</span>}
      >
        Chronic register
      </PanelHead>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {conditions.map((c) => {
          const on = c.confirmed > 0;
          return (
            <div
              key={c.code}
              className={`rounded-[10px] border p-3 ${on ? 'border-teal-200 bg-teal-50' : 'border-[var(--ui-line)] bg-[var(--ui-sunk)]'}`}
            >
              <p className={`text-xs font-medium ${on ? 'text-teal-800' : 'text-[var(--ui-ink-faint)]'}`}>{c.name}</p>
              <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${on ? 'text-teal-900' : 'text-[var(--ui-ink-faint)]'}`}>
                {c.confirmed}
              </p>
              {c.pending > 0 ? (
                <p className="mt-0.5 text-[11px] text-amber-700">
                  +{c.pending} gathering evidence
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] text-[var(--ui-ink-faint)]">
                  {on ? 'patient' + (c.confirmed === 1 ? '' : 's') : 'none yet'}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!anyone && (
        <p className="mt-3 text-xs text-[var(--ui-ink-soft)]">
          Nobody has qualified yet. A patient is added the first time they buy a medicine
          for one of these — nothing to set up.
        </p>
      )}
    </Panel>
  );
}

/**
 * Average time to approve an order, against a five-minute target.
 *
 * The colour is the whole point of the card, so it is derived on the server
 * (`withinTarget`) rather than recomputed here — two places deciding what
 * "late" means is how a green badge ends up next to a red number. Kept as
 * real semantic colour, not the shared ink Bar's territory: on-time/late is
 * a genuine status signal, the exact case design.md's semantic-colour rule
 * exists for.
 */
function Approval({ approval }) {
  if (!approval) {
    return <Panel className="p-4 text-sm text-[var(--ui-ink-soft)]"><Loading /></Panel>;
  }

  // No order has ever been acted on. "0 minutes" would read as instant.
  if (approval.averageMinutes === null) {
    return (
      <Panel className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--ui-ink-faint)]">
          Average time to approve an order
        </p>
        <p className="mt-1 text-sm text-[var(--ui-ink-soft)]">No orders have been actioned yet.</p>
      </Panel>
    );
  }

  const ok = approval.withinTarget;
  const mins = approval.averageMinutes;
  const pretty = mins >= 60
    ? `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`
    : `${mins} min`;

  return (
    <section className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[12px] border p-4 ${
      ok ? 'border-teal-300 bg-teal-50' : 'border-red-300 bg-red-50'}`}>
      <span className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-teal-600' : 'bg-red-600'}`} />
      <div className="min-w-0">
        <p className={`text-xs font-medium uppercase tracking-wide ${ok ? 'text-teal-800' : 'text-red-800'}`}>
          Average time to approve an order
        </p>
        <p className={`text-2xl font-semibold tabular-nums ${ok ? 'text-teal-900' : 'text-red-900'}`}>{pretty}</p>
      </div>
      <p className={`ml-auto text-xs ${ok ? 'text-teal-800' : 'text-red-800'}`}>
        {ok
          ? `Under the ${approval.targetMinutes}-minute target`
          : `Over the ${approval.targetMinutes}-minute target — customers are waiting`}
        <span className="block text-[var(--ui-ink-faint)]">
          across {approval.sample} order{approval.sample === 1 ? '' : 's'}
        </span>
      </p>
    </section>
  );
}

/**
 * Revenue against new and returning customers, on one time base.
 *
 * Revenue is an area (it is a magnitude) and the two customer counts are
 * lines (they are tallies) — plotting all three the same way would invite
 * reading naira against people. This is a genuine multi-series chart, not a
 * length-encoded single measure, so it keeps real colour per series — the
 * shared ink Bar is for the OTHER kind of chart, where one number per row is
 * all there is to show.
 */
function Growth({ trend, days }) {
  if (!trend?.length) {
    return <Panel className="p-4 text-sm text-[var(--ui-ink-soft)]"><Loading /></Panel>;
  }

  const w = 320;
  const h = 96;
  const step = w / Math.max(1, trend.length - 1);
  const maxRev = Math.max(1, ...trend.map((d) => d.revenue));
  const maxCust = Math.max(1, ...trend.map((d) => Math.max(d.newCustomers, d.returningCustomers)));

  const path = (get, max) => trend
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (get(d) / max) * h).toFixed(1)}`)
    .join(' ');

  const revPath = path((d) => d.revenue, maxRev);
  const totalRev = trend.reduce((s, d) => s + d.revenue, 0);
  const totalNew = trend.reduce((s, d) => s + d.newCustomers, 0);
  const totalRet = trend.reduce((s, d) => s + d.returningCustomers, 0);

  return (
    <Panel className="p-4">
      <PanelHead
        Icon={IconTrendUp}
        aside={<span className="text-xs text-[var(--ui-ink-faint)]">Last {days} days</span>}
      >
        Revenue &amp; customer growth
      </PanelHead>

      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-3 h-28 w-full" role="img"
        aria-label={`Revenue ${naira(totalRev)}, ${totalNew} new and ${totalRet} returning customers over ${days} days`}>
        <path d={`${revPath} L${w},${h} L0,${h} Z`} className="fill-teal-500/15" />
        <path d={revPath} className="stroke-teal-600" fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={path((d) => d.newCustomers, maxCust)} fill="none" strokeWidth="1.5"
          style={{ stroke: 'var(--ui-ink)' }} vectorEffect="non-scaling-stroke" />
        <path d={path((d) => d.returningCustomers, maxCust)} className="stroke-amber-500" fill="none" strokeWidth="1.5"
          strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Key className="bg-teal-600" label="Revenue" value={naira(totalRev)} />
        <Key style={{ background: 'var(--ui-ink)' }} label="New patients" value={totalNew} />
        <Key className="bg-amber-500" label="Returning" value={totalRet} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[var(--ui-ink-faint)]">
        <span>{trend[0]?.day}</span><span>{trend[trend.length - 1]?.day}</span>
      </div>
    </Panel>
  );
}

function Key({ className = '', style, label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[var(--ui-ink-soft)]">
      <span className={`h-2 w-2 rounded-full ${className}`} style={style} />
      {label} <strong className="tabular-nums text-[var(--ui-ink)]">{value}</strong>
    </span>
  );
}

/** What actually earned the money, beside the line that shows it going up. */
function TopProducts({ products, days }) {
  if (!products) {
    return <Panel className="p-4 text-sm text-[var(--ui-ink-soft)]"><Loading /></Panel>;
  }
  const max = Math.max(1, ...products.map((p) => p.revenue));

  return (
    <Panel className="p-4">
      <PanelHead aside={<span className="text-xs text-[var(--ui-ink-faint)]">Last {days} days</span>}>
        Top 5 products
      </PanelHead>

      {products.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ui-ink-soft)]">No confirmed orders in this window yet.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {products.map((p, i) => (
            <li key={p.name}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className="w-4 shrink-0 tabular-nums text-xs text-[var(--ui-ink-faint)]">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--ui-ink)]" title={p.name}>{p.name}</span>
                <span className="shrink-0 tabular-nums font-medium text-[var(--ui-ink)]">{naira(p.revenue)}</span>
              </div>
              {/* The bar is what makes the ranking readable at a glance — five
                  right-aligned numbers require comparing digits. Ink, not
                  brand colour — see this file's header. */}
              <div className="ml-6 mt-1.5 flex items-center gap-2">
                <Bar value={p.revenue} max={max} height="h-1.5" />
              </div>
              <p className="ml-6 mt-1 text-[10px] text-[var(--ui-ink-faint)]">{p.units} sold</p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export default function Overview() {
  const [data, setData] = useState(null);
  const [ins, setIns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch('/api/overview');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not load the overview.');
        if (!cancelled) { setData(j); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };

    // Fetched separately, and its failure is deliberately NOT fatal. These are
    // trend figures over 30 days: if they are slow or unavailable the operational
    // half of this screen — what needs a human right now — must still render.
    // One combined request would mean a slow aggregate query blanking the alerts.
    const loadInsights = async () => {
      try {
        const r = await fetch('/api/insights');
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setIns(j);
      } catch {
        /* leaves the headline cards showing a dash rather than an error */
      }
    };

    load();
    loadInsights();
    const t = setInterval(load, 20000);
    // Slower: these move over days, so polling them every 20s spends database
    // time to redraw the same numbers.
    const ti = setInterval(loadInsights, 120000);
    return () => { cancelled = true; clearInterval(t); clearInterval(ti); };
  }, []);

  if (error) {
    return <p className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-[var(--ui-ink-soft)]"><Loading /></p>;
  }

  // today / sales / catalogue / daily are deliberately NOT read here any more
  // — they belong to AiPerformance now. Left in the response because that
  // screen fetches the same endpoint; destructuring them here would only
  // suggest this screen still shows them.
  // connection and waiting are read by App.jsx's header bell now (see
  // NotificationBell.jsx) — every screen needs to know about a disconnect or
  // a pharmacist handoff, not only whoever happens to have Overview open.
  // limits is the one piece still owned here: "sending is paused" is severe
  // enough, and specific enough to what this screen is already reporting, to
  // stay a standing banner rather than something a badge count can carry.
  const { limits } = data;

  return (
    <div className="space-y-5">
      {/* ---- anything actually wrong, stated once, at the top ---- */}
      {limits.sendingPaused && (
        <div className="rounded-[12px] border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">Sending is paused — no customer is being answered</p>
          <p className="mt-1 text-sm text-red-700">{limits.pausedReason || 'Paused automatically.'}</p>
        </div>
      )}

      {/* ---- the snapshot ----
          Nothing operational here: no counts of today's messages, no
          catalogue health. Those live on AI Performance, because an owner
          opening THIS screen is asking "how is the pharmacy doing", and
          answering that alongside "you have 3 unread" made both harder to
          read. Ruled columns, not gapped cards — a hairline between three
          related figures is the register a printed statement uses, and it
          reads as one fact told three ways rather than three unrelated
          boxes that happen to sit next to each other. */}
      <Panel className="p-6">
        <PanelHead
          Icon={IconCustomers}
          aside={<span className="text-xs text-[var(--ui-ink-faint)]">Since this pharmacy went live</span>}
        >
          At a glance
        </PanelHead>

        {!ins ? (
          <p className="mt-4 text-sm text-[var(--ui-ink-faint)]">—</p>
        ) : (
          <div className="mt-5 grid grid-cols-1 divide-y divide-[var(--ui-line)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="min-w-0 px-0 sm:px-5 sm:first:pl-0 sm:last:pr-0">
              <p
                className="text-[1.75rem] font-semibold tabular-nums tracking-tight text-[var(--ui-ink)] sm:text-[2.125rem]"
                style={{ overflowWrap: 'anywhere' }}
              >
                {naira(ins.headline.aiAssistedSales)}
              </p>
              <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">AI-assisted sales</p>
            </div>
            <div className="min-w-0 px-0 py-3 sm:px-5 sm:py-0">
              <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ui-ink)]">
                {ins.headline.totalPatients.toLocaleString('en-NG')}
              </p>
              <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">Total patients</p>
            </div>
            <div className="min-w-0 px-0 pt-3 sm:px-5 sm:pt-0">
              <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ui-ink)]">
                {ins.headline.chronicTracked.toLocaleString('en-NG')}
              </p>
              <p className="mt-1 text-xs text-[var(--ui-ink-soft)]">Chronic patients tracked</p>
            </div>
          </div>
        )}
        <p className="mt-5 border-t border-[var(--ui-line)] pt-4 text-xs text-[var(--ui-ink-faint)]">
          Revenue generated through AI conversations, how large the customer base is, and how many patients
          RxNaija is following from purchase history.
        </p>
      </Panel>

      {/* ---- the chronic register ----
          Under the headline total, because it is that total broken open:
          "3 tracked" is a fact, "2 hypertensive, 1 diabetic" is something a
          pharmacy can act on — a refill list, a reminder, a stock decision. */}
      <Chronic conditions={ins?.conditions} />

      {/* ---- how fast staff act ----
          Immediately under the headline figures, because it is the one number
          on this screen the owner can do something about today. */}
      <Approval approval={ins?.approval} />

      {/* ---- growth, and what is driving it ----
          The chart and the top-five sit side by side on purpose: "revenue is
          up" and "this is what sold" are the same question asked twice, and
          separating them means scrolling between the answer and its cause. */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Growth trend={ins?.trend} days={ins?.windowDays} />
        <TopProducts products={ins?.topProducts} days={ins?.windowDays} />
      </section>
    </div>
  );
}
