/**
 * Customer 360 — who this person is, what they've bought, what they've
 * asked, and whether the pharmacy can currently reach them.
 *
 * DELIBERATELY NOT AN EHR
 * No diagnosis, no medical history, no clinical notes anywhere on this
 * screen. Medication journeys are a named placeholder, not a feature — an
 * order for Amlodipine is a purchase, not evidence of an ongoing treatment
 * relationship, and this screen must not imply otherwise.
 *
 * EVERY NUMBER CAME FROM THE SERVER
 * This component formats; it does not compute. Order counts, spend, and
 * conversation counts are exactly what /api/customers/:id returned — see
 * that route for what each number does and does not include.
 *
 * THE TIMELINE IS QUOTES, NOT SUMMARIES
 * A "customer asked" entry is their own words, verbatim, from the database.
 * Nothing on this screen is generated to fill space.
 */

import { useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import CustomerTimeline from './CustomerTimeline.jsx';
import CustomerCrm from './CustomerCrm.jsx';
import ConversationState from './ConversationState.jsx';

const STATUS_TONE = {
  active: 'bg-teal-50 text-teal-700',
  inactive: 'bg-slate-100 text-slate-500',
  blocked: 'bg-red-50 text-red-700',
};

const ORDER_STATUS_TONE = {
  pending: 'bg-amber-50 text-amber-700',
  confirmed: 'bg-teal-50 text-teal-700',
  processing: 'bg-teal-50 text-teal-700',
  ready: 'bg-teal-50 text-teal-700',
  completed: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-slate-100 text-slate-400',
  rejected: 'bg-red-50 text-red-700',
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}
function naira(n) {
  return `₦${Number(n || 0).toLocaleString('en-NG')}`;
}

export default function CustomerProfile({ customerId, onBack, onOpenConversation, onNavigate }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/customers/${customerId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not load this customer.');
        if (!cancelled) setData(j);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [customerId]);

  if (error) {
    return (
      <div className="space-y-3">
        <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700">&larr; Back to customers</button>
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-slate-500"><Loading /></p>;

  const {
    customer, orders, medicationJourneys, conversations, communication, activeConversation,
    // Defaulted so an older API response (or a cached one mid-deploy) renders
    // the empty state rather than throwing on `refills.due`.
    refills = { due: 0, completed: 0 },
  } = data;
  // fullName first: it is what the customer told the pharmacy, verified
  // against their own typed words. displayName is whatever they set on their
  // phone ("John's iPhone") and is a fallback for recognition only.
  const name = customer.fullName || customer.displayName || customer.waPhone;
  const optedOut = communication.status === 'opted_out';

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700">&larr; Back to customers</button>

      {/* ---- header ---- */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{name}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <span className="text-teal-600">●</span> WhatsApp · {customer.waPhone}
            </p>
          </div>
          <span className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${STATUS_TONE[customer.status] || 'bg-slate-100 text-slate-500'}`}>
            {customer.status}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm sm:w-80">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Customer since</p>
            <p className="mt-0.5 text-slate-700">{fmtDate(customer.createdAt)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Last interaction</p>
            <p className="mt-0.5 text-slate-700">{fmtDateTime(customer.lastSeenAt)}</p>
          </div>
        </div>
      </div>

      {/* ---- what is happening right now ----
          Above the aggregate cards on purpose. Counts describe the
          relationship; this describes the situation, and a pharmacist opening
          a profile mid-conversation needs the situation first. */}
      {activeConversation ? (
        <section
          className={`rounded-lg border p-4 ${
            activeConversation.priority === 'high'
              ? 'border-red-300 bg-red-50/60'
              : 'border-slate-200 bg-white'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Current conversation
            </h3>
            <ConversationState state={activeConversation.workflowState} />
          </div>
          {activeConversation.preview && (
            <p className="mt-2 text-sm text-slate-800">
              {/* Whose words these are matters: an unanswered question and our
                  own last reply look identical without it. */}
              <span className="text-slate-400">
                {activeConversation.previewDirection === 'inbound' ? 'Customer: ' : 'We replied: '}
              </span>
              {activeConversation.preview}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Last message {fmtDateTime(activeConversation.lastMessageAt)}
          </p>
          <button
            onClick={() => onOpenConversation?.(activeConversation.id)}
            className="mt-3 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-teal-600"
          >
            Open conversation
          </button>
        </section>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Current conversation
          </h3>
          {/* An honest empty state. Showing the most recent CLOSED thread here
              would read as live and is how someone replies into a conversation
              that ended weeks ago. */}
          <p className="mt-2 text-sm text-slate-400">No active conversation.</p>
        </section>
      )}

      {/* ---- quick actions ---- */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onNavigate?.('orders')}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          View orders
        </button>
        <button
          onClick={() => onNavigate?.('consultations')}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          View consultations
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ---- orders ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Orders</h3>
          <div className="mt-2 flex items-baseline gap-4">
            <div>
              <p className="text-2xl font-semibold text-slate-900">{orders.count}</p>
              <p className="text-xs text-slate-500">{orders.count === 1 ? 'order' : 'orders'}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-slate-900">{naira(orders.totalSpend)}</p>
              <p className="text-xs text-slate-500">confirmed spend</p>
            </div>
          </div>
          {orders.lastOrderAt && (
            <p className="mt-1 text-xs text-slate-400">Last order {fmtDate(orders.lastOrderAt)}</p>
          )}

          {orders.recent.length > 0 ? (
            <ul className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              {orders.recent.map((o) => (
                <li key={o.id} className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-mono text-xs text-slate-400">{o.reference}</span>
                    <span className="ml-2 text-slate-700">{naira(o.total)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs capitalize ${ORDER_STATUS_TONE[o.status] || 'bg-slate-100 text-slate-500'}`}>
                      {o.status}
                    </span>
                    <span className="text-xs text-slate-400">{fmtDate(o.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-400">No orders yet.</p>
          )}
        </section>

        {/* ---- conversations ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversations</h3>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{conversations.count}</p>
          {conversations.lastConversationAt && (
            <p className="text-xs text-slate-400">Last active {fmtDateTime(conversations.lastConversationAt)}</p>
          )}

          {conversations.active > 0 && (
            <p className="text-xs text-teal-700">{conversations.active} active</p>
          )}

          {/* Conversation HISTORY — distinct threads, each with its own state
              and message count. This is the section that makes "one patient,
              many conversations" visible; before segmentation worked, it would
              have shown a single row for months of activity. */}
          {conversations.recent.length > 0 ? (
            <ul className="mt-4 space-y-3 border-t border-slate-100 pt-3">
              {conversations.recent.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onOpenConversation?.(c.id)}
                    className="w-full rounded p-1 text-left transition hover:bg-slate-50 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-slate-400">{fmtDateTime(c.lastMessageAt)}</span>
                      <ConversationState state={c.workflowState} />
                    </div>
                    {/* The customer's own words, verbatim — never generated. */}
                    <p className="mt-0.5 text-sm text-slate-700">
                      {c.preview ? `"${c.preview}"` : <span className="text-slate-400">No message text</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {c.messageCount} {c.messageCount === 1 ? 'message' : 'messages'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-400">No conversations yet.</p>
          )}
        </section>

        {/* ---- medication journeys — foundation only ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Medication journeys</h3>
          {medicationJourneys.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {medicationJourneys.map((j) => (
                <li key={j.id} className="text-sm text-slate-700">{j.name}</li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 rounded border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center">
              <p className="text-sm text-slate-500">No active medication journeys yet.</p>
              <p className="mt-1 text-xs text-slate-400">
                Medication journeys will appear here when a customer is enrolled in a medication follow-up workflow.
              </p>
            </div>
          )}
        </section>

        {/* ---- refills — foundation only ----

            Deliberately shows nothing rather than a plausible number. A
            pharmacist who reads "1 due" will act on it: ring the customer,
            pull the stock off the shelf. A placeholder here is not a harmless
            mock, it is a false instruction to do clinical work. */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Refills</h3>
          {refills.due > 0 || refills.completed > 0 ? (
            <div className="mt-2 flex items-baseline gap-6">
              <div>
                <p className={`text-2xl font-semibold ${refills.due > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
                  {refills.due}
                </p>
                <p className="text-xs text-slate-500">due</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-slate-900">{refills.completed}</p>
                <p className="text-xs text-slate-500">completed</p>
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center">
              <p className="text-sm text-slate-500">No refill activity yet.</p>
              <p className="mt-1 text-xs text-slate-400">
                Refills are driven by medication journeys, so they will start appearing here once that
                follow-up workflow is enrolled.
              </p>
            </div>
          )}
        </section>

        {/* ---- communication ---- */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Communication</h3>

          {optedOut ? (
            <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2.5">
              <p className="text-sm font-medium text-red-800">⚠ Opted out of WhatsApp messages</p>
              <p className="mt-1 text-xs text-red-700">
                This customer asked to stop receiving messages. Existing conversations and orders are kept —
                nothing here is being sent to them unless they message first.
              </p>
            </div>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700">
              <span className="text-teal-600">✓</span> WhatsApp communication enabled
            </p>
          )}

          {/* Per-category preferences. Shown even when the customer has opted
              out, greyed rather than hidden: staff need to see WHY a message
              would be blocked, and "they opted out of the channel" is a
              different answer from "they never subscribed to marketing". */}
          <dl className="mt-3 space-y-1.5">
            {[
              ['Transactional', data.communication?.preferences?.transactional],
              ['Order notifications', data.communication?.preferences?.orderNotifications],
              ['Medication-related', data.communication?.preferences?.medication],
              ['Marketing & promotions', data.communication?.preferences?.marketing],
            ].map(([label, on]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-sm">
                <dt className={optedOut ? 'text-slate-400' : 'text-slate-700'}>{label}</dt>
                <dd className={`flex items-center gap-1.5 ${
                  optedOut ? 'text-slate-400' : on ? 'text-teal-700' : 'text-slate-500'
                }`}>
                  {/* Not colour alone — the symbol carries the state too. */}
                  <span aria-hidden="true">{on ? '✓' : '✗'}</span>
                  <span>{on ? 'Enabled' : 'Not subscribed'}</span>
                </dd>
              </div>
            ))}
          </dl>

          {data.communication?.marketingConsent?.at && (
            <p className="mt-2 text-xs text-slate-500">
              Marketing consent given by {data.communication.marketingConsent.source || 'unknown'} on{' '}
              {new Date(data.communication.marketingConsent.at).toLocaleDateString('en-NG', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </p>
          )}

          {optedOut && (
            <p className="mt-2 text-xs text-slate-500">
              These preferences are kept but not in effect — the opt-out above overrides all of them.
            </p>
          )}
        </section>
      </div>

      {/* ---- timeline: owns its own filters and pagination ---- */}
      <CustomerCrm customerId={customerId} />

      <CustomerTimeline customerId={customerId} onOpenConversation={onOpenConversation} />
    </div>
  );
}
