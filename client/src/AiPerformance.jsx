/**
 * AI Performance — is the assistant earning its place, and is it keeping up?
 *
 * WHY THIS IS ITS OWN SCREEN
 * All of this used to sit on Overview, under the alerts. That made the first
 * screen a pharmacy owner opens five sections long, of which four answered a
 * question nobody had asked yet — so the one section that mattered on a bad
 * day was below the fold. Overview now answers "how is the business doing";
 * this answers "how is the assistant doing", which is a different question
 * asked at a different time.
 *
 * ORDER IS THE DESIGN, same as Overview: what the assistant did, then what it
 * could not do, then the traffic behind both, then whether it is allowed to
 * keep replying at all.
 *
 * FAILURES SIT NEXT TO SUCCESSES throughout. "Pharmacist interventions" is
 * reported as prominently as "assisted orders" — a screen that shows only
 * what worked is how a pharmacy discovers three weeks late that half its
 * customers were escalated into an inbox nobody opened.
 */

import { useEffect, useState } from 'react';

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

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
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.12" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'border-slate-200 bg-white',
    warn: 'border-amber-300 bg-amber-50',
    bad: 'border-red-300 bg-red-50',
    good: 'border-teal-300 bg-teal-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
    </div>
  );
}

export default function AiPerformance({ onNavigate }) {
  const [ov, setOv] = useState(null);
  const [ins, setIns] = useState(null);
  const [error, setError] = useState(null);

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
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!ov) return <p className="text-sm text-slate-500">Loading…</p>;

  const { today, sales, catalogue, limits, daily } = ov;
  const ai = ins?.ai;
  const dash = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-NG'));

  return (
    <div className="space-y-6">

      {/* ---- the assistant's record ----
          All-time, not last-24h: this is the "is it worth it" question, and a
          single quiet day should not make the answer look bad. */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">🤖 AI performance</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Card label="AI conversations" value={dash(ai?.conversations)} sub="Threads the assistant handled" />
          <Card label="Product requests" value={dash(ai?.productRequests)} sub="Asked about something specific" />
          <Card label="AI-assisted orders" value={dash(ai?.assistedOrders)} sub="Orders that came from a chat" />
          <Card
            label="Conversion rate"
            value={ai?.conversionRate === null || ai?.conversionRate === undefined ? '—' : `${ai.conversionRate}%`}
            sub="Of conversations that asked for a product"
            tone={ai?.conversionRate != null && ai.conversionRate >= 30 ? 'good' : 'default'}
          />
          {/* Not framed as a failure. Escalation is the safety design working
              — but it is also a queue a person has to actually work. */}
          <Card
            label="Pharmacist interventions"
            value={dash(ai?.interventions)}
            sub="Handed to a human"
          />
        </div>
      </section>

      {/* ---- today ---- */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Last 24 hours</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card
            label="Messages received"
            value={today.messagesIn}
            sub={`${today.conversations} conversation${today.conversations === 1 ? '' : 's'}`}
          />
          <Card label="Answered by assistant" value={today.replied} />
          <Card
            label="Handed to staff"
            value={today.handedOff}
            sub={today.handedOff > today.replied ? 'More escalated than answered' : null}
            tone={today.handedOff > today.replied && today.handedOff > 0 ? 'warn' : 'default'}
          />
          <Card label="New customers" value={today.newCustomers} />
        </div>
      </section>

      {/* ---- traffic ---- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-slate-700">Messages, last 14 days</h3>
          <span className="text-xs text-slate-500">
            in <span className="text-teal-600">▬</span> · out <span className="text-slate-400">▬</span>
          </span>
        </div>
        <div className="mt-2 text-teal-600"><Spark points={daily.map((d) => d.inbound)} /></div>
        <div className="text-slate-400"><Spark points={daily.map((d) => d.outbound)} /></div>
        <div className="mt-1 flex justify-between text-[10px] text-slate-400">
          <span>{daily[0]?.day}</span><span>{daily[daily.length - 1]?.day}</span>
        </div>
      </section>

      {/* ---- selling ---- */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Last 7 days</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="Orders placed" value={sales.orders7d} />
          <Card label="Confirmed value" value={naira(sales.confirmedValue7d)} sub="Confirmed, ready or completed" />
          <Card label="Rejected" value={sales.rejected7d} />
          {/* Each expiry is stock that sat off the shelf and a customer who was
              told nothing came of it. Not a neutral statistic. */}
          <Card
            label="Expired unconfirmed"
            value={sales.expired7d}
            sub={sales.expired7d > 0 ? 'Held stock nobody confirmed in time' : null}
            tone={sales.expired7d > 0 ? 'warn' : 'default'}
          />
        </div>
      </section>

      {/* ---- what the assistant is able to sell at all ---- */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Catalogue</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card label="Products" value={catalogue.active} />
          {/* A product with no price cannot be quoted, so it is invisible to
              customers however well it is stocked. */}
          <Card
            label="Missing a price"
            value={catalogue.noPrice}
            sub={catalogue.noPrice > 0 ? 'The assistant cannot quote these' : 'All priced'}
            tone={catalogue.noPrice > 0 ? 'warn' : 'good'}
          />
          <Card label="Out of stock" value={catalogue.outOfStock} />
        </div>
      </section>

      {/* ---- is it allowed to keep replying ---- */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-slate-600">
            Replies sent today: <strong className="tabular-nums">{limits.sent24h}</strong> of {limits.cap}
            {limits.capSource === 'warmup' && (
              <span className="ml-1 text-xs text-slate-500">(warm-up day {limits.warmupDay})</span>
            )}
          </span>
          <span className="text-xs text-slate-500">
            Replying to: {limits.replyMode === 'all' ? 'everyone'
              : limits.replyMode === 'allowlist' ? 'allowlist only' : 'nobody'}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
          <div
            className={`h-full ${limits.sent24h / limits.cap > 0.8 ? 'bg-amber-500' : 'bg-teal-500'}`}
            style={{ width: `${Math.min(100, (limits.sent24h / Math.max(1, limits.cap)) * 100)}%` }}
          />
        </div>
        {limits.sendingPaused && (
          <p className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800">
            Sending is paused — {limits.pausedReason || 'paused automatically.'}{' '}
            <button onClick={() => onNavigate?.('setup')} className="underline">Setup</button>
          </p>
        )}
      </section>
    </div>
  );
}
