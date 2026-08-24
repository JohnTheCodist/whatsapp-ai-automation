/**
 * Overview — the screen a pharmacy owner opens first.
 *
 * ORDER IS THE DESIGN
 * Anything needing a human comes first, then whether the assistant is
 * actually working, then sales, then catalogue health. An owner should be
 * able to stop reading after the first row on a normal day.
 *
 * WHY FAILURES ARE SHOWN NEXT TO SUCCESSES
 * "Replied" sits beside "Handed off". A dashboard that reports only what
 * worked is how a pharmacy finds out three weeks late that half their
 * customers were escalated into an inbox nobody opened.
 */

import { useEffect, useState } from 'react';
import { IconCustomers, IconAi, IconHeart, IconTrendUp } from './Icons.jsx';

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/**
 * A headline figure, with the sentence that says what it actually means.
 *
 * Icon takes the component, not an emoji — this card used to render 🤖 for
 * "AI-assisted sales", which is exactly the "reads as generated, not
 * designed" tell design.md's Icon-chip section now bans outright.
 */
function Big({ Icon, label, value, hint }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        <span className="ui-icon-chip"><Icon width={13} height={13} /></span>{label}
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <span className="ui-icon-chip"><IconHeart width={13} height={13} /></span>Chronic register
        </h3>
        <span className="text-xs text-slate-500">confirmed by purchase history</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {conditions.map((c) => {
          const on = c.confirmed > 0;
          return (
            <div
              key={c.code}
              className={`rounded-lg border p-3 ${on ? 'border-teal-200 bg-teal-50' : 'border-slate-200 bg-slate-50'}`}
            >
              <p className={`text-xs font-medium ${on ? 'text-teal-800' : 'text-slate-500'}`}>{c.name}</p>
              <p className={`mt-0.5 text-2xl font-semibold tabular-nums ${on ? 'text-teal-900' : 'text-slate-400'}`}>
                {c.confirmed}
              </p>
              {c.pending > 0 ? (
                <p className="mt-0.5 text-[11px] text-amber-700">
                  +{c.pending} gathering evidence
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {on ? 'patient' + (c.confirmed === 1 ? '' : 's') : 'none yet'}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {!anyone && (
        <p className="mt-3 text-xs text-slate-500">
          Nobody has qualified yet. A patient is added the first time they buy a medicine
          for one of these — nothing to set up.
        </p>
      )}
    </section>
  );
}

/**
 * Average time to approve an order, against a five-minute target.
 *
 * The colour is the whole point of the card, so it is derived on the server
 * (`withinTarget`) rather than recomputed here — two places deciding what
 * "late" means is how a green badge ends up next to a red number.
 */
function Approval({ approval }) {
  if (!approval) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading…</div>;
  }

  // No order has ever been acted on. "0 minutes" would read as instant.
  if (approval.averageMinutes === null) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Average time to approve an order</p>
        <p className="mt-1 text-sm text-slate-500">No orders have been actioned yet.</p>
      </div>
    );
  }

  const ok = approval.withinTarget;
  const mins = approval.averageMinutes;
  const pretty = mins >= 60
    ? `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`
    : `${mins} min`;

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4 ${
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
        <span className="block text-slate-500">
          across {approval.sample} order{approval.sample === 1 ? '' : 's'}
        </span>
      </p>
    </div>
  );
}

/**
 * Revenue against new and returning customers, on one time base.
 *
 * Revenue is an area (it is a magnitude) and the two customer counts are
 * lines (they are tallies) — plotting all three the same way would invite
 * reading naira against people. Revenue keeps its own scale for the same
 * reason: on a shared axis, counts in single digits sit flat on the floor.
 */
function Growth({ trend, days }) {
  if (!trend?.length) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading…</div>;
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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <span className="ui-icon-chip"><IconTrendUp width={13} height={13} /></span>Revenue &amp; customer growth
        </h3>
        <span className="text-xs text-slate-500">last {days} days</span>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-3 h-28 w-full" role="img"
        aria-label={`Revenue ${naira(totalRev)}, ${totalNew} new and ${totalRet} returning customers over ${days} days`}>
        <path d={`${revPath} L${w},${h} L0,${h} Z`} className="fill-teal-500/15" />
        <path d={revPath} className="stroke-teal-600" fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={path((d) => d.newCustomers, maxCust)} className="stroke-slate-800" fill="none" strokeWidth="1.5"
          vectorEffect="non-scaling-stroke" />
        <path d={path((d) => d.returningCustomers, maxCust)} className="stroke-amber-500" fill="none" strokeWidth="1.5"
          strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Key className="bg-teal-600" label="Revenue" value={naira(totalRev)} />
        <Key className="bg-slate-800" label="New patients" value={totalNew} />
        <Key className="bg-amber-500" label="Returning" value={totalRet} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{trend[0]?.day}</span><span>{trend[trend.length - 1]?.day}</span>
      </div>
    </section>
  );
}

function Key({ className, label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-600">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label} <strong className="tabular-nums text-slate-800">{value}</strong>
    </span>
  );
}

/** What actually earned the money, beside the line that shows it going up. */
function TopProducts({ products, days }) {
  if (!products) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading…</div>;
  }
  const max = Math.max(1, ...products.map((p) => p.revenue));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-700">Top 5 products</h3>
        <span className="text-xs text-slate-500">last {days} days</span>
      </div>

      {products.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No confirmed orders in this window yet.</p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {products.map((p, i) => (
            <li key={p.name}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className="w-4 shrink-0 tabular-nums text-xs text-slate-400">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-slate-800" title={p.name}>{p.name}</span>
                <span className="shrink-0 tabular-nums font-medium text-slate-900">{naira(p.revenue)}</span>
              </div>
              {/* The bar is what makes the ranking readable at a glance — five
                  right-aligned numbers require comparing digits. */}
              <div className="ml-6 mt-1 h-1.5 overflow-hidden rounded bg-slate-100">
                <div className="h-full rounded bg-teal-500" style={{ width: `${(p.revenue / max) * 100}%` }} />
              </div>
              <p className="ml-6 mt-0.5 text-[10px] text-slate-400">{p.units} sold</p>
            </li>
          ))}
        </ol>
      )}
    </section>
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
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-slate-500">Loading…</p>;
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
    <div className="space-y-6">
      {/* ---- anything actually wrong, stated once, at the top ---- */}
      {limits.sendingPaused && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">Sending is paused — no customer is being answered</p>
          <p className="mt-1 text-sm text-red-700">{limits.pausedReason || 'Paused automatically.'}</p>
        </div>
      )}

      {/* ---- the three figures that describe the business ----
          Nothing operational here: no counts of today's messages, no
          catalogue health. Those moved to AI Performance, because an owner
          opening this screen is asking "how is the pharmacy doing", and
          answering that alongside "you have 3 unread" made both harder to
          read. Each card carries a plain-English line saying what it means,
          since "Chronic Patients Tracked" is not self-evident. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Big
          Icon={IconCustomers}
          label="Total patients"
          value={ins ? ins.headline.totalPatients.toLocaleString('en-NG') : '—'}
          hint="How large your customer base is"
        />
        <Big
          Icon={IconAi}
          label="AI-assisted sales"
          value={ins ? naira(ins.headline.aiAssistedSales) : '—'}
          hint="Revenue generated through AI conversations"
        />
        <Big
          Icon={IconHeart}
          label="Chronic patients tracked"
          value={ins ? ins.headline.chronicTracked.toLocaleString('en-NG') : '—'}
          hint="Patients RxNaija is following from purchase history"
        />
      </section>

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
      <section className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <Growth trend={ins?.trend} days={ins?.windowDays} />
        <TopProducts products={ins?.topProducts} days={ins?.windowDays} />
      </section>
    </div>
  );
}
