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

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/** Inline sparkline. No chart library — it is 14 numbers. */
function Spark({ points, className = '' }) {
  if (!points?.length) return null;
  const max = Math.max(1, ...points);
  const w = 100;
  const h = 28;
  const step = w / Math.max(1, points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-8 w-full ${className}`}>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.12" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ label, value, sub, tone = 'default', children }) {
  const tones = {
    default: 'border-slate-200',
    warn: 'border-amber-300 bg-amber-50',
    bad: 'border-red-300 bg-red-50',
    good: 'border-teal-300 bg-teal-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-600">{sub}</p>}
      {children}
    </div>
  );
}

export default function Overview({ onNavigate }) {
  const [data, setData] = useState(null);
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
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) {
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  const { connection, waiting, today, sales, catalogue, limits, daily } = data;
  const connected = connection.status === 'connected';
  const needsAttention = waiting.handoffs + waiting.orders + (waiting.customers || 0);

  return (
    <div className="space-y-6">
      {/* ---- anything actually wrong, stated once, at the top ---- */}
      {limits.sendingPaused && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="font-medium text-red-800">Sending is paused — no customer is being answered</p>
          <p className="mt-1 text-sm text-red-700">{limits.pausedReason || 'Paused automatically.'}</p>
        </div>
      )}
      {!connected && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-medium text-amber-900">WhatsApp is not connected</p>
          <p className="mt-1 text-sm text-amber-800">
            Customers messaging you are not reaching the assistant.{' '}
            <button onClick={() => onNavigate?.('setup')} className="underline">Go to Setup</button>
          </p>
        </div>
      )}

      {/* ---- waiting for a human ---- */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Waiting for you</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {/* First, and deliberately so. A handoff is at least visible in the
              Inbox; an unanswered customer is invisible unless this card
              exists. It is the number most likely to be embarrassing, which
              is exactly why it goes first. */}
          <button onClick={() => onNavigate?.('inbox')} className="text-left">
            <Card
              label="Customers waiting for a reply"
              value={waiting.customers ?? 0}
              sub={
                waiting.customers
                  ? 'Their last message has had no answer from anyone'
                  : 'Everyone has been answered'
              }
              tone={waiting.customers > 0 ? 'warn' : 'default'}
            />
          </button>
          <button onClick={() => onNavigate?.('inbox')} className="text-left">
            <Card
              label="Conversations needing a person"
              value={waiting.handoffs}
              sub={waiting.handoffs ? 'Someone asked a question the assistant would not answer' : 'Nothing waiting'}
              tone={waiting.handoffs > 0 ? 'warn' : 'default'}
            />
          </button>
          <button onClick={() => onNavigate?.('orders')} className="text-left">
            <Card
              label="Orders to confirm"
              value={waiting.orders}
              sub={waiting.orders ? 'Stock is held until you confirm or the hold expires' : 'Nothing waiting'}
              tone={waiting.orders > 0 ? 'warn' : 'default'}
            />
          </button>
        </div>
        {needsAttention === 0 && (
          <p className="mt-2 text-xs text-slate-500">Nothing needs you right now.</p>
        )}
      </section>

      {/* ---- is the assistant working ---- */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Last 24 hours</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="Messages received" value={today.messagesIn} sub={`${today.conversations} conversation${today.conversations === 1 ? '' : 's'}`} />
          <Card label="Answered by assistant" value={today.replied} />
          {/* Deliberately adjacent to "answered". A high number here is not a
              failure of the safety design — it is the design working — but it
              is also a queue somebody has to actually work through. */}
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
      <section className="rounded-lg border border-slate-200 p-4">
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
          {/* Expiry is not a neutral statistic: each one is stock that sat off
              the shelf and a customer who was told nothing came of it. */}
          <Card
            label="Expired unconfirmed"
            value={sales.expired7d}
            sub={sales.expired7d > 0 ? 'Held stock nobody confirmed in time' : null}
            tone={sales.expired7d > 0 ? 'warn' : 'default'}
          />
        </div>
      </section>

      {/* ---- what the assistant can actually sell ---- */}
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

      {/* ---- limits, only when they are near enough to matter ---- */}
      <section className="rounded-lg border border-slate-200 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-slate-600">
            Replies sent today: <strong className="tabular-nums">{limits.sent24h}</strong> of {limits.cap}
            {limits.capSource === 'warmup' && (
              <span className="ml-1 text-xs text-slate-500">(warm-up day {limits.warmupDay})</span>
            )}
          </span>
          <span className="text-xs text-slate-500">
            Replying to: {limits.replyMode === 'all' ? 'everyone' : limits.replyMode === 'allowlist' ? 'allowlist only' : 'nobody'}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
          <div
            className={`h-full ${limits.sent24h / limits.cap > 0.8 ? 'bg-amber-500' : 'bg-teal-500'}`}
            style={{ width: `${Math.min(100, (limits.sent24h / Math.max(1, limits.cap)) * 100)}%` }}
          />
        </div>
      </section>
    </div>
  );
}
