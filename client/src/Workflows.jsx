/**
 * Workflows — what the assistant does on this pharmacy's behalf.
 *
 * AGENTIC_PLAN.md phase 1, at the owner's request ("the workflow should look
 * like this", pointing at the reference's Workflows page), with its own
 * follow-up that the sidebar modules stay permanent — so this is a screen in
 * the existing rail, not a second navigation world.
 *
 * WHAT THIS REPLACES: nothing. There was no protocols endpoint and no
 * protocol screen, so a pharmacy could not see which clinical protocols run
 * in its name, what they ask, which version, or whether one is switched on.
 * Three of them run against real patients' WhatsApp messages.
 *
 * READ-ONLY ON PURPOSE. The reference offers a button that makes a new one.
 * This screen offers none. Protocol content is clinical governance —
 * clinicalProtocolService.js is explicit that interpreting a protocol is
 * "a later stage's job, under clinical governance this module has no part
 * in" — and a web form that writes question sets is that change wearing a
 * UI. Showing is not editing, and this screen only shows.
 *
 * THE TABS ARE OURS, NOT THE REFERENCE'S. It offers My workflows / Discover /
 * Pinned / Past runs. We have no community library to discover, no pinning,
 * and past runs live in clinical_encounters, which is its own phase. Shipping
 * those four tabs with two of them empty would be the screen promising
 * something the product does not have — the exact defect it was built to
 * surface. The filters here are the states a protocol can actually be in.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  STATES, stateOf, stateText, stateTone, summaryLine, stepsOf, matchProtocols,
} from './workflowFormat.js';

export default function Workflows() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    setFailed(false);
    fetch('/api/protocols')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Three states, as everywhere else: the read failed, it has not landed, or
     it landed. A screen that renders "no protocols" when the request failed
     tells a pharmacy nothing is running on their behalf, which is the most
     wrong thing this particular screen could say. */
  if (failed) {
    return (
      <div className="rounded-lg border border-slate-200 p-6 text-center">
        <p className="text-sm font-medium text-slate-700">The protocols could not be loaded</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
          That is this page failing to read them, not the assistant having none.
        </p>
        <button
          type="button"
          onClick={load}
          className="mt-4 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;

  const all = data.protocols || [];
  const matched = matchProtocols(all, query);
  const shown = filter === 'all' ? matched : matched.filter((p) => stateOf(p) === filter);

  return (
    <div>
      <p className="text-sm text-slate-500">{summaryLine(data)}</p>

      {/* The filters. Each names a state a protocol can really be in, and
          each shows its count — a filter that leads to an empty list is a
          dead end you only discover by clicking it. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <FilterChip id="all" label="All" count={matched.length} active={filter} onPick={setFilter} />
        {STATES.map((s) => (
          <FilterChip
            key={s.id}
            id={s.id}
            label={s.label}
            count={matched.filter((p) => stateOf(p) === s.id).length}
            active={filter}
            onPick={setFilter}
          />
        ))}

        <label className="relative ml-auto block w-56">
          <span className="sr-only">Search protocols</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search protocols"
            className="w-full py-1.5 pl-3 pr-3 text-[13px]"
          />
        </label>
      </div>

      {shown.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">
          {all.length === 0
            ? 'No clinical protocols ship with this version.'
            : 'Nothing matches that.'}
        </p>
      )}

      <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {shown.map((p) => (
          <ProtocolCard
            key={`${p.slug}@${p.version}`}
            protocol={p}
            open={open === `${p.slug}@${p.version}`}
            onToggle={() => setOpen(open === `${p.slug}@${p.version}` ? null : `${p.slug}@${p.version}`)}
          />
        ))}
      </div>
    </div>
  );
}

function FilterChip({ id, label, count, active, onPick }) {
  const on = active === id;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      aria-pressed={on}
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
        on
          ? 'border-slate-300 bg-slate-100 text-slate-900'
          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
      <span className="ml-1.5 tabular-nums text-slate-400">{count}</span>
    </button>
  );
}

function ProtocolCard({ protocol, open, onToggle }) {
  const state = stateOf(protocol);
  const tone = stateTone(state);
  const label = STATES.find((s) => s.id === state)?.label || '';

  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{protocol.name}</h3>
          {/* The version is on the card and not buried, because two versions
              of the same protocol ship together and mean different things:
              fever v1 asks 7 questions and has NO red flags, v2 asks 12 and
              has 8. */}
          <p className="mt-0.5 font-mono text-[11px] text-slate-400">
            {protocol.slug} · v{protocol.version}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            tone === 'accent'
              ? 'bg-[var(--ui-accent-wash)] text-[var(--ui-accent-ink)]'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {label}
        </span>
      </div>

      <p className="mt-2 text-xs text-slate-500">{stateText(state)}</p>

      <dl className="mt-3 space-y-1">
        {stepsOf(protocol).map((s) => (
          <div key={s.label} className="flex items-baseline gap-2 text-xs">
            <dt className="w-24 shrink-0 text-slate-400">{s.label}</dt>
            <dd className="text-slate-700">
              <span className="font-medium tabular-nums">{s.value}</span>{' '}
              <span className="text-slate-500">{s.unit}</span>
            </dd>
          </div>
        ))}
      </dl>

      <button
        type="button"
        onClick={onToggle}
        className="mt-3 text-xs font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900"
      >
        {open ? 'Hide the questions' : `Show the ${protocol.questions?.length || 0} questions`}
      </button>

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {/* The patient's own words, verbatim. This is the part of the
              product a patient actually experiences, and paraphrasing it for
              a card would show a pharmacist something their patients are not
              being asked. */}
          <ol className="space-y-2">
            {(protocol.questions || []).map((q, i) => (
              <li key={q.key} className="text-xs text-slate-600">
                <span className="mr-1.5 tabular-nums text-slate-400">{i + 1}.</span>
                {q.text}
                {!q.required && <span className="ml-1 text-slate-400">(optional)</span>}
              </li>
            ))}
          </ol>
          {protocol.source && (
            <p className="mt-3 text-[11px] text-slate-400">Source: {protocol.source}</p>
          )}
        </div>
      )}
    </section>
  );
}
