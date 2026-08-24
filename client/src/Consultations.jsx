/**
 * The pharmacist's consultation desk.
 *
 * WHY THIS IS A DESK AND NOT A LIST
 * The previous version was a stack of triage cards: who is waiting, what they
 * typed, how long it has been. A pharmacist could see there was a decision to
 * make but had nothing to make it with — every case meant opening the thread
 * and reconstructing it by hand.
 *
 * Meanwhile the assessment engine had already collected the patient's age,
 * how long the symptom had lasted, its severity, which red flag fired, and
 * the chronic conditions confirmed from their purchase history. None of it
 * reached this screen. The queue was the product; the clinical picture was
 * sitting in tables nothing rendered.
 *
 * So: queue on the left, the whole case on the right. That split is what
 * clinical software uses because it matches the work — scan the list once,
 * then stay in one patient until a decision is made.
 *
 * NOTHING ON THIS SCREEN IS SUMMARISED BY A MODEL.
 * Verbatim quotes are labelled as quotes; structured answers are shown as the
 * normaliser parsed them, with the patient's original sentence kept beside
 * any it could not read. A fluent paraphrase that turns three months into
 * three years is the exact failure this product exists to avoid, and the
 * person making the medical decision is the last one who should receive it.
 */

import { useEffect, useState, useCallback } from 'react';
import Loading from './Loading.jsx';

/* ---- small building blocks ------------------------------------------- */

function Section({ title, children, tone = 'default' }) {
  const tones = {
    default: 'border-slate-200',
    alert: 'border-red-300',
    warn: 'border-amber-300',
  };
  return (
    <section className={`rounded-lg border bg-white ${tones[tone]}`}>
      <h3 className="border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h3>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** A labelled value that stays legible when the value is missing. */
function Field({ label, value, hint }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-sm ${value ? 'text-slate-900' : 'text-slate-400'}`}>
        {value || 'Not recorded'}
      </p>
      {hint && value && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

const relTime = (iso) => {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/* ---- the case ---------------------------------------------------------- */

function CaseDetail({ item, onOpenConversation, onResolve, busy }) {
  const [brief, setBrief] = useState(null);
  const [briefError, setBriefError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setBrief(null);
    setBriefError(null);
    (async () => {
      try {
        const r = await fetch(`/api/conversations/${item.conversationId}/clinical-brief`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error('Could not load the clinical detail.');
        const j = await r.json();
        if (!cancelled) setBrief(j);
      } catch (e) {
        // The queue card's own information still renders — a failure here
        // must not blank a case a pharmacist is actively looking at.
        if (!cancelled) setBriefError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [item.conversationId]);

  const p = brief?.patient;
  const enc = brief?.encounter;

  // Age and sex belong together and read as one clinical descriptor.
  const demographic = [
    p?.ageYears != null ? `${p.ageYears} years` : null,
    p?.sex || null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- header: who, and what a pharmacist can do about it ---- */}
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              {p?.name || item.customer}
            </h2>
            {item.urgent && (
              <span className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                Urgent
              </span>
            )}
            {item.technical && (
              <span className="rounded bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                Not clinical
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {[demographic, p?.phone, `waiting ${item.waiting}`].filter(Boolean).join('  ·  ')}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => onOpenConversation?.(item.conversationId)}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            Open &amp; reply
          </button>
          <button
            onClick={() => onResolve(item.conversationId)}
            disabled={busy === item.conversationId}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            {busy === item.conversationId ? 'Closing…' : 'Mark handled'}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">

        {/* ---- why this reached a pharmacist ----
            First, and its own block. This is the question the pharmacist is
            actually being asked, and burying it under demographics is how a
            red flag gets read third. */}
        <Section title="Why this needs you" tone={item.urgent ? 'alert' : 'warn'}>
          <p className={`text-sm font-medium ${item.urgent ? 'text-red-800' : 'text-slate-800'}`}>
            {item.headline}
          </p>
          {enc?.redFlags && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-800">
              Red flag: {enc.redFlags}
            </p>
          )}
          {item.awaitingCustomerAnswer && (
            <p className="mt-2 text-xs text-slate-500">
              A pharmacist was offered — the patient has not answered yet.
            </p>
          )}
        </Section>

        {/* ---- what they said, verbatim ---- */}
        <Section title="In the patient's words">
          {item.trigger ? (
            <blockquote className="border-l-2 border-slate-300 pl-3 text-sm text-slate-800">
              “{item.trigger}”
            </blockquote>
          ) : (
            <p className="text-sm text-slate-400">No trigger message recorded.</p>
          )}

          {item.unansweredSince > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                {item.unansweredSince} message{item.unansweredSince > 1 ? 's' : ''} since — nobody has replied
              </p>
              <ul className="mt-1 space-y-1">
                {item.since.map((s, i) => (
                  <li key={i} className="border-l-2 border-amber-300 pl-3 text-sm text-slate-700">“{s}”</li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        {briefError && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {briefError} The queue information above is still current.
          </p>
        )}

        {/* ---- the assessment the assistant already did ---- */}
        {enc && (
          <Section title="Assessment">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Complaint" value={enc.complaint} />
              <Field label="Duration" value={enc.duration} />
              <Field label="Severity" value={enc.severity} />
            </div>
            {(enc.allergiesReported || enc.medicationsReported) && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Allergies reported" value={enc.allergiesReported} />
                <Field label="Medicines reported" value={enc.medicationsReported} />
              </div>
            )}
            {enc.protocol && (
              <p className="mt-3 text-[11px] text-slate-400">
                {enc.protocol} · {enc.status}
              </p>
            )}
          </Section>
        )}

        {/* ---- the questions and answers ----
            The raw sentence is kept beside anything the parser could not
            read, because "unparsable" with no text is strictly worse than
            the patient's own words. */}
        {brief?.answers?.length > 0 && (
          <Section title={`Questions answered (${brief.answers.length})`}>
            <ul className="divide-y divide-slate-100">
              {brief.answers.map((a, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                  <span className="min-w-0 flex-1 text-sm text-slate-600">{a.question}</span>
                  <span className="text-sm font-medium text-slate-900">
                    {a.answer || <span className="text-slate-400">unclear</span>}
                    {a.unit && a.unit !== 'days' ? ` ${a.unit}` : ''}
                  </span>
                  {a.raw && a.raw !== a.answer && (
                    <span className="w-full text-[11px] text-slate-400">said: “{a.raw}”</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* ---- what this pharmacy already knows about them ---- */}
        {(brief?.conditions?.length > 0 || brief?.medications?.length > 0) && (
          <Section title="Patient background">
            {brief.conditions.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Tracked conditions</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {brief.conditions.map((c) => (
                    <span key={c.code} className="rounded bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800">
                      {c.name}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  From purchase history — not diagnoses.
                </p>
              </div>
            )}

            {brief.medications.length > 0 && (
              <div className={brief.conditions.length > 0 ? 'mt-3' : ''}>
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Recently dispensed</p>
                <ul className="mt-1 space-y-0.5">
                  {brief.medications.map((m) => (
                    <li key={m.name} className="flex flex-wrap items-baseline gap-2 text-sm text-slate-700">
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="text-[11px] text-slate-400">
                        {relTime(m.lastBought)}{m.times > 1 ? ` · ${m.times}×` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        )}

        {brief && (
          <p className="px-1 pb-2 text-[11px] leading-relaxed text-slate-400">{brief.disclaimer}</p>
        )}
      </div>
    </div>
  );
}

/* ---- the desk ---------------------------------------------------------- */

export default function Consultations({ onOpenConversation }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/conversations/waiting', { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load the queue.');
      setData(j);
      setError(null);
    } catch (e) {
      setError(
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'The server did not respond — this list may be out of date.'
          : e.message,
      );
    }
  }, []);

  useEffect(() => {
    load();
    // 20s. Someone waiting on a pharmacist is the one thing in this app worth
    // polling for, but the pooler has been exhausted once already by eager
    // refreshes, so this is the only screen that polls this often.
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function resolve(conversationId) {
    setBusy(conversationId);
    try {
      await fetch(`/api/conversations/${conversationId}/resolve`, { method: 'POST' });
      // Move off the case that no longer exists rather than leaving the panel
      // showing a patient who has just been cleared.
      setSelected(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!data) return <p className="text-sm text-slate-500"><Loading /></p>;

  const { counts, waiting } = data;

  if (waiting.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm font-medium text-slate-700">Nobody is waiting for a pharmacist</p>
        <p className="mt-1 text-sm text-slate-500">
          Clinical questions the assistant will not answer appear here.
        </p>
      </div>
    );
  }

  // Selection follows the queue: default to the top case, and if the selected
  // one is resolved out from under us, fall back rather than showing nothing.
  const current = waiting.find((w) => w.conversationId === selected) || waiting[0];

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-slate-700">{counts.total} waiting</span>
        {counts.urgent > 0 && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
            {counts.urgent} urgent
          </span>
        )}
        {counts.technical > 0 && (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {counts.technical} not clinical
          </span>
        )}
      </div>

      {/* Fixed height so the queue and the case scroll independently — a
          pharmacist reading a long case should not lose the list. */}
      <div className="grid gap-3 lg:h-[calc(100vh-13rem)] lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">

        {/* ---- queue ---- */}
        <div className="min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {waiting.map((w) => {
              const isCurrent = w.conversationId === current.conversationId;
              return (
                <li key={w.handoffId}>
                  <button
                    type="button"
                    onClick={() => setSelected(w.conversationId)}
                    aria-current={isCurrent ? 'true' : undefined}
                    className={`w-full px-3 py-2.5 text-left transition ${
                      isCurrent ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      {/* Severity as a shape as well as a colour — a queue
                          that relies on hue alone loses its ordering for
                          anyone who cannot separate red from amber. */}
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          w.urgent ? 'bg-red-600' : w.technical ? 'bg-slate-300' : 'bg-amber-500'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                        {w.customer}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{w.waiting}</span>
                    </div>
                    <p className="mt-0.5 truncate pl-4 text-xs text-slate-500">{w.headline}</p>
                    {w.unansweredSince > 0 && (
                      <p className="mt-0.5 pl-4 text-[11px] font-medium text-amber-700">
                        {w.unansweredSince} unanswered
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ---- the case ---- */}
        <div className="min-h-0 overflow-hidden rounded-lg border border-slate-200">
          <CaseDetail
            key={current.conversationId}
            item={current}
            onOpenConversation={onOpenConversation}
            onResolve={resolve}
            busy={busy}
          />
        </div>
      </div>
    </div>
  );
}
