/**
 * Billing — what this pharmacy is on, and what happens next.
 *
 * WHAT THIS SCREEN IS FOR
 * Answering two questions without the owner having to ask anyone: how long
 * have I got, and what happens when it runs out. A trial that ends without
 * warning is not a pricing decision, it is a support call and a lost pilot.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * A naira balance, or a per-conversation cost. Nobody is billed per
 * conversation — the pilot is a flat fee — and putting a price next to a
 * number the pharmacy is not being charged is a figure that can only
 * mislead. The conversation count is shown as work done, nothing more.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from './DashboardKit.jsx';
import Loading from './Loading.jsx';

const naira = (kobo) => `₦${Math.round(Number(kobo || 0) / 100).toLocaleString('en-NG')}`;

const longDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
  : null);

/**
 * The state chip. Colour carries the same meaning it does everywhere else in
 * this dashboard: green is fine, amber is "act this week", red is "the
 * assistant has stopped".
 */
function StateChip({ state, daysLeft }) {
  const map = {
    trial: {
      text: daysLeft === 1 ? '1 day left' : `${daysLeft} days left`,
      cls: 'bg-amber-50 text-amber-800 border-amber-200',
    },
    active: { text: 'Active', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    trial_expired: { text: 'Trial ended', cls: 'bg-red-50 text-red-800 border-red-200' },
    subscription_expired: { text: 'Expired', cls: 'bg-red-50 text-red-800 border-red-200' },
    cancelled: { text: 'Cancelled', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
    not_started: { text: 'Not started', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  };
  const s = map[state] || map.not_started;
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${s.cls}`}>
      {s.text}
    </span>
  );
}

export default function Billing() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/billing')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not load billing');
        return r.json();
      })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {error}
      </p>
    );
  }
  if (!data) return <Loading />;

  const stopped = !data.allowed;

  return (
    <div className="space-y-5">
      {/* ---- the answer to "how long have I got", first and largest ---- */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight text-[var(--ui-ink)]">
                {data.plan.label}
              </h2>
              <StateChip state={data.state} daysLeft={data.daysLeft} />
            </div>

            <p className="mt-1 text-sm text-[var(--ui-ink-soft)]">
              {naira(data.plan.priceKobo)} a {data.plan.interval}
              {data.state === 'active' && data.currentPeriodEnd
                && ` · renews ${longDate(data.currentPeriodEnd)}`}
              {data.inTrial && data.trialEndsAt
                && ` · trial ends ${longDate(data.trialEndsAt)}`}
            </p>

            {/* The one sentence that says what is happening and what to do.
                Comes from the server so the wording cannot drift between
                the banner, this screen and any future reminder email. */}
            {data.message && (
              <p className={`mt-3 max-w-prose text-sm leading-relaxed ${
                stopped ? 'text-red-800' : 'text-[var(--ui-ink-soft)]'}`}
              >
                {data.message}
              </p>
            )}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ui-ink-soft)]">
              Conversations
            </p>
            <p className="mt-0.5 text-2xl font-semibold tracking-tight text-[var(--ui-ink)]">
              {data.usage.conversations.toLocaleString('en-NG')}
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--ui-ink-soft)]">
              {data.inTrial ? 'during your trial' : 'this period'}
            </p>
          </div>
        </div>

        {/* No limit, and saying so plainly. A pilot pharmacy leaning on the
            assistant is the outcome being paid for — they should not be
            wondering whether they are about to run out of something. */}
        <div className="border-t border-[var(--ui-line)] px-5 py-3">
          <p className="text-xs text-[var(--ui-ink-soft)]">
            Unlimited conversations. There is no cap and nothing is deducted per reply.
          </p>
        </div>
      </Panel>

      {/* ---- what stopping actually means ----
          Shown only when it has happened. A pharmacy reading this is worried
          they have lost their customers; the first thing it must say is that
          they have not. */}
      {stopped && (
        <Panel className="border-red-200">
          <div className="p-5">
            <h3 className="text-sm font-semibold text-red-900">
              What is still working
            </h3>
            <ul className="mt-2 space-y-1.5 text-sm text-[var(--ui-ink-soft)]">
              <li>· Your inbox, and every conversation in it</li>
              <li>· Replying to customers yourself</li>
              <li>· Orders, patients, catalogue — all still here</li>
            </ul>
            <p className="mt-3 text-sm text-[var(--ui-ink-soft)]">
              Only the automatic replies have paused. Nothing has been deleted, and
              your customers have not been told anything about your account.
            </p>
          </div>
        </Panel>
      )}

      {/* ---- plans ---- */}
      <Panel>
        <PanelHead>Plans</PanelHead>
        <div className="grid gap-px bg-[var(--ui-line)] sm:grid-cols-2">
          {data.plans.map((p) => {
            const current = p.id === data.plan.id;
            const monthly = p.interval === 'year'
              ? `≈ ₦${Math.round(p.priceKobo / 100 / 12).toLocaleString('en-NG')} a month`
              : null;
            return (
              <div key={p.id} className="bg-[var(--ui-panel)] p-5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-[var(--ui-ink)]">{p.label}</h3>
                  {current && (
                    <span className="rounded-full bg-[var(--ui-accent-wash)] px-2 py-0.5 text-[11px] font-medium text-[var(--ui-accent-ink)]">
                      Current
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--ui-ink)]">
                  {naira(p.priceKobo)}
                  <span className="text-sm font-normal text-[var(--ui-ink-soft)]"> / {p.interval}</span>
                </p>
                {monthly && <p className="mt-0.5 text-xs text-[var(--ui-ink-soft)]">{monthly}</p>}
              </div>
            );
          })}
        </div>
        {/* Honest about where this is. Payment is not wired yet, and a dead
            "Pay now" button would be worse than none — it teaches people the
            screen is broken. */}
        <div className="border-t border-[var(--ui-line)] px-5 py-3">
          <p className="text-xs text-[var(--ui-ink-soft)]">
            Card payment is coming shortly. In the meantime, contact RxNaija to change
            or renew your plan and it will be applied to your account the same day.
          </p>
        </div>
      </Panel>

      {/* ---- history ---- */}
      <Panel>
        <PanelHead>Payments</PanelHead>
        {data.payments.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--ui-ink-soft)]">
            Nothing yet — you are on the free trial.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--ui-line)]">
            {data.payments.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--ui-ink)]">
                    {p.kind === 'payment' && 'Payment'}
                    {p.kind === 'refund' && 'Refund'}
                    {p.kind === 'grant' && 'Free time added'}
                    {p.kind === 'adjustment' && 'Adjustment'}
                  </p>
                  <p className="text-xs text-[var(--ui-ink-soft)]">
                    {longDate(p.createdAt)}
                    {p.periodEnd && ` · covers to ${longDate(p.periodEnd)}`}
                    {p.note && ` · ${p.note}`}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-medium tabular-nums text-[var(--ui-ink)]">
                  {p.kind === 'refund' ? '−' : ''}{naira(p.amountKobo)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
