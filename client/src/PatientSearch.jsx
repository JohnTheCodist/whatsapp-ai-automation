/**
 * Patients: search by name or phone, narrowed by eight filters — Age,
 * Condition, Gender, Medication, Last visit, Follow-up due, Assigned
 * pharmacist, Risk flag — and by the chronic switch.
 *
 * HOW THE TOOLBAR IS ORGANISED, AND WHY
 * A row of three separate controls above the list, left to right — the
 * outlined search box, the funnel, the chronic switch — then everything
 * they open, underneath:
 *
 *   row    a search box of a fixed width, not a full-width bar. Most visits
 *          to this screen start by filtering rather than typing, and a bar
 *          spanning the page says the opposite. Then the funnel, carrying
 *          the count of filters applied on its corner, then the switch.
 *   panel  opened by the funnel: a grid of LABELLED controls in its own
 *          hairline card. An earlier version was eight identical pills whose
 *          meaning only appeared once you opened one; a label above each
 *          control is what makes the set readable without touching it.
 *   under  a chip per applied filter, reading "Age · 60 and over", each one
 *          removable on its own, with Clear all beside them. The panel can
 *          then be closed without losing sight of what is narrowing the list.
 *
 * THE SWITCH IS NOT A FILTER PILL. "Only chronic patients" is the state a
 * pharmacist works in for an entire morning — diabetes and hypertension are
 * the conditions this pharmacy follows over years — so it sits in the open
 * with a label, on or off at a glance, instead of hiding inside the panel
 * as a ninth dropdown. It narrows ALONGSIDE the eight: switch on plus
 * Condition: diabetes is the diabetics.
 *
 * MEDICATION IS TYPED, NOT PICKED. A pharmacy carries hundreds of lines, so
 * a select listing every medicine is a scroll, not a choice. It is an input
 * with the pharmacy's own medicines as suggestions, and the server matches
 * on any part of the name — "metfor" finds Metformin 500mg tablets.
 *
 * THE SERVER DECIDES. Every filter runs in the database
 * (server/services/customers/patientSearch.js), scoped to this pharmacy, and
 * every value offered comes from GET /api/customers/search/options — the
 * same list the server validates against. Nothing is filtered here.
 *
 * NEWEST ANSWER WINS. Typing searches 250ms after the last key; a filter
 * applies at once. Each request aborts the one before it, so a slow reply to
 * an old search can never overwrite the current list.
 */

import { useEffect, useId, useRef, useState } from 'react';
import Loading from './Loading.jsx';
import { IconSearch, IconFilter, IconOpen, IconPhone } from './Icons.jsx';
import {
  FILTERS, CHRONIC, EMPTY_FILTERS, activeFilterCount, buildSearchQuery, isNarrowed,
  optionLabel, resultSummary, visitLabel, RISK_LABEL,
} from './patientSearchQuery.js';
import { REFILL_STATUS_LABEL, REFILL_STATUS_TONE, supplyLabel } from './refillFormat.js';

/** Risk is queued work, never the red design.md keeps for a person waiting. */
const RISK_TONE = {
  red_flag: 'ui-tone-3',
  lapsed: 'ui-tone-2',
  follow_up: 'ui-tone-1',
};

/**
 * The row's actions.
 *
 * Only two, and both do exactly what they say with what is already on the
 * row: open the record, or ring the patient. There is deliberately no
 * third — a WhatsApp button here would open the PHARMACIST'S own WhatsApp,
 * not the pharmacy's number, and a delete would be a destructive act on a
 * patient record offered one stray click from a list.
 *
 * `stopPropagation` because the row itself opens the profile: without it,
 * pressing Call would open the record underneath the dialler.
 */
function RowActions({ p, onOpen }) {
  const stop = (e) => e.stopPropagation();
  return (
    <span className="ui-row-actions" onClick={stop} onKeyDown={stop} role="presentation">
      <button
        type="button"
        onClick={() => onOpen(p.id)}
        aria-label={`Open ${p.name}'s record`}
        title="Open record"
        className="ui-action-btn"
      >
        <IconOpen width={16} height={16} />
      </button>
      <a
        href={`tel:+${p.phone.replace(/\D/g, '')}`}
        aria-label={`Call ${p.name}`}
        title={`Call ${p.phone}`}
        className="ui-action-btn"
      >
        <IconPhone width={16} height={16} />
      </a>
    </span>
  );
}

/**
 * One patient, one line.
 *
 * REDESIGNED 2026-09-21 (hallmark redesign, component scope, inside the
 * locked system in design.md). What the previous version got wrong, and what
 * each fix is for:
 *
 *   NINE COLUMNS OF EQUAL WEIGHT. Every cell was 13px in the same grey, so
 *   the eye had nowhere to land. Now there is exactly one primary column —
 *   the patient — at ink/600 with the phone beneath it as one identity
 *   block, and every other column is secondary by construction.
 *
 *   ROWS OF RANDOM HEIGHT. "Glibenclamide 5mg tablets, Metformin 500mg
 *   tablets, paracetamol 500mg" wrapped to four lines while the row above it
 *   was one, which is what made the table read as scattered. The table is
 *   now `table-layout: fixed` with tuned widths: every row is the same
 *   height, lists truncate to their first item and carry a `+N` for the
 *   rest, and the full list is the cell's tooltip.
 *
 *   "AGE · GENDER". A number and a category joined with a decorative middot
 *   — the single most generated-looking thing on the screen. Split: age is a
 *   right-aligned tabular numeral, sex is its own narrow column.
 *
 *   SIX EM-DASHES A ROW AT FULL WEIGHT, so absence shouted as loudly as
 *   data. Absence is now a hairline at 30% — present, quiet, not an answer.
 */

/** Nothing recorded. Quiet on purpose — see the header. */
function Blank() {
  return <span className="ui-ptable-blank" aria-label="not recorded">–</span>;
}

/**
 * A list in one line: the first item, then how many more. The whole list is
 * the tooltip, so nothing is hidden — only folded.
 */
function Folded({ items, className = '' }) {
  if (!items || items.length === 0) return <Blank />;
  const [first, ...rest] = items;
  return (
    <span className={`ui-ptable-fold ${className}`} title={items.join(', ')}>
      <span className="ui-ptable-fold-first">{first}</span>
      {rest.length > 0 && <span className="ui-ptable-more">+{rest.length}</span>}
    </span>
  );
}

function PatientRow({ p, today, onOpen, index = 0 }) {
  const open = () => onOpen(p.id);
  // One letter, because a column of "Female"/"Male" is a column of noise
  // next to a column of numbers. The word is still read aloud and still on
  // hover — the glyph is only what the eye gets.
  const sex = p.sex ? p.sex[0].toUpperCase() : null;
  return (
    // A clickable row needs a role, a tab stop and a key handler, or the only
    // way to open a patient is a mouse.
    <tr
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      role="button"
      tabIndex={0}
      aria-label={`Open ${p.name}`}
      className="ui-ptable-row"
      style={{ '--row-i': index }}
    >
      <td className="ui-ptable-who">
        <span className="ui-ptable-name">{p.name}</span>
        <span className="ui-ptable-phone">{p.phone}</span>
      </td>

      <td className="ui-ptable-num">{p.age != null ? p.age : <Blank />}</td>
      <td className="ui-ptable-sex">
        {sex ? <abbr title={p.sex[0].toUpperCase() + p.sex.slice(1)}>{sex}</abbr> : <Blank />}
      </td>

      <td><Folded items={p.conditions} /></td>
      <td><Folded items={p.medications} /></td>

      <td className="ui-ptable-quiet">{visitLabel(p.lastVisitOn, today)}</td>

      <td>
        {p.followUp ? (
          <span
            title={supplyLabel(p.followUp)}
            className={`ui-ptable-chip ${REFILL_STATUS_TONE[p.followUp.status]}`}
          >
            {REFILL_STATUS_LABEL[p.followUp.status]}
          </span>
        ) : <Blank />}
      </td>

      <td className="ui-ptable-quiet">
        {p.assignedPharmacist?.email
          ? <span className="ui-ptable-fold-first" title={p.assignedPharmacist.email}>{p.assignedPharmacist.email}</span>
          : <span className="ui-ptable-unassigned">Unassigned</span>}
      </td>

      <td>
        {p.risks.length === 0 ? <Blank /> : (
          <span className="ui-ptable-chips">
            {p.risks.slice(0, 1).map((r) => (
              <span key={r} className={`ui-ptable-chip ${RISK_TONE[r]}`}>{RISK_LABEL[r]}</span>
            ))}
            {p.risks.length > 1 && (
              <span className="ui-ptable-more" title={p.risks.map((r) => RISK_LABEL[r]).join(', ')}>
                +{p.risks.length - 1}
              </span>
            )}
          </span>
        )}
      </td>

      <td className="ui-ptable-actions">
        <RowActions p={p} onOpen={onOpen} />
      </td>
    </tr>
  );
}

export default function PatientSearch({ initialQuery = '', onOpen }) {
  const [q, setQ] = useState(initialQuery);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [options, setOptions] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const inFlight = useRef(null);
  const searchRef = useRef(null);
  const medicinesId = useId();

  // The header search sends its term here; follow it.
  useEffect(() => { setQ(initialQuery); }, [initialQuery]);

  useEffect(() => {
    let live = true;
    fetch('/api/customers/search/options')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const query = buildSearchQuery(q, filters);
  const typed = useRef(q);
  useEffect(() => {
    const delay = typed.current !== q ? 250 : 0;   // typing pauses; a filter applies at once
    typed.current = q;
    const t = setTimeout(async () => {
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      setLoading(true);
      try {
        const r = await fetch(`/api/customers/search${query ? `?${query}` : ''}`, { signal: ctrl.signal });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not search patients.');
        setData(j);
        setError(null);
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message);
      } finally {
        if (inFlight.current === ctrl) setLoading(false);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [query, q]);

  const count = activeFilterCount(filters);
  const chronicOn = Boolean(filters[CHRONIC.key]);
  const narrowed = isNarrowed(q, filters);
  const showPanel = panelOpen || count > 0;
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const clearAll = () => { setFilters(EMPTY_FILTERS); setPanelOpen(false); };

  return (
    <div className="space-y-4">
      <section aria-label="Search and filter patients">
        {/* ---- search box · funnel · chronic switch ----
            Three separate controls on the page, in that order. */}
        <div className="flex items-center gap-2">
          <div className="ui-searchbox">
            <span className="text-[var(--ui-ink-faint)]" aria-hidden="true">
              <IconSearch width={16} height={16} />
            </span>
            <input
              ref={searchRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search patients by name or phone"
              placeholder="Search"
              className="ui-toolbar-input ui-field-plain"
            />
            {q && (
              <button
                type="button"
                onClick={() => { setQ(''); searchRef.current?.focus(); }}
                aria-label="Clear search"
                className="ui-icon-btn"
              >
                ×
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setPanelOpen((open) => (count > 0 ? true : !open))}
            aria-expanded={showPanel}
            aria-label={count > 0 ? `Filters, ${count} applied` : 'Filters'}
            title="Filters"
            className={`ui-toolbar-filters ${showPanel ? 'is-open' : ''}`}
          >
            <IconFilter width={18} height={18} aria-hidden="true" />
            {count > 0 && <span className="ui-toolbar-count tabular-nums">{count}</span>}
          </button>

          {/* The switch says what it does in words. An unlabelled toggle is a
              control you have to flip to find out what it was. */}
          <button
            type="button"
            role="switch"
            aria-checked={chronicOn}
            onClick={() => setFilter(CHRONIC.key, !chronicOn)}
            className={`ui-switch-row ${chronicOn ? 'is-on' : ''}`}
          >
            <span className="ui-switch" aria-hidden="true"><span className="ui-switch-knob" /></span>
            <span className="hidden whitespace-nowrap sm:inline">Show only chronic patients</span>
            <span className="whitespace-nowrap sm:hidden">Chronic</span>
          </button>
        </div>

        {/* ---- the filter panel ----
            Grid rows 0fr → 1fr: it opens to exactly its own height with no
            measuring and no fixed max-height to outgrow. */}
        <div className="ui-panel" data-open={showPanel ? 'true' : 'false'}>
          <div className="ui-panel-inner">
            <div className="ui-panel-card mt-3 grid gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
              {FILTERS.map(({ key, label }) => (
                <label key={key} className="block text-[12px] font-medium text-[var(--ui-ink-soft)]">
                  {label}
                  {key === 'medication' ? (
                    // Typed, with the pharmacy's own medicines as suggestions.
                    // The server matches any part of the name, so a partial
                    // word is a real search rather than a failed exact match.
                    <>
                      <input
                        type="text"
                        list={medicinesId}
                        value={filters[key]}
                        onChange={(e) => setFilter(key, e.target.value)}
                        placeholder="Any — type a medicine"
                        className="mt-1 block w-full px-2.5 py-1.5 text-[13px]"
                      />
                      <datalist id={medicinesId}>
                        {(options?.medication || []).map((o) => <option key={o.value} value={o.value} />)}
                      </datalist>
                    </>
                  ) : (
                    <select
                      value={filters[key]}
                      onChange={(e) => setFilter(key, e.target.value)}
                      disabled={!options}
                      className="mt-1 block w-full px-2.5 py-1.5 text-[13px]"
                    >
                      <option value="">Any</option>
                      {(options?.[key] || []).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  )}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- what is applied, and how to drop it ---- */}
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.filter(({ key }) => filters[key]).map(({ key, label }) => (
            <span key={key} className="ui-chip-filter">
              <span className="text-[var(--ui-ink-faint)]">{label}</span>
              <span className="font-medium">{optionLabel(options, key, filters[key]) || filters[key]}</span>
              <button type="button" onClick={() => setFilter(key, '')} aria-label={`Remove ${label} filter`}>×</button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-[13px] font-medium text-[var(--ui-ink-soft)] underline-offset-2 hover:text-[var(--ui-ink)] hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ---- results ---- */}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!data && !error && <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>}

      {data && (
        <section aria-live="polite" aria-busy={loading} className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <p className="mb-2 text-[13px] font-medium tabular-nums text-[var(--ui-ink-soft)]">
            {resultSummary({ total: data.total, shown: data.patients.length, filtered: narrowed })}
            {chronicOn && <span className="font-normal text-[var(--ui-ink-faint)]"> · chronic only</span>}
          </p>
          {data.patients.length > 0 ? (
            <div key={query} className={`ui-ptable-wrap ${loading ? 'ui-ptable-stale' : ''}`}>
              <table className="ui-ptable">
                {/* Widths are declared, not negotiated. With table-layout
                    fixed the columns land in the same place on every page of
                    results, so paging does not shuffle the grid sideways. */}
                <colgroup>
                  <col style={{ width: '216px' }} />
                  <col style={{ width: '52px' }} />
                  <col style={{ width: '46px' }} />
                  <col style={{ width: '150px' }} />
                  <col style={{ width: '186px' }} />
                  <col style={{ width: '104px' }} />
                  <col style={{ width: '96px' }} />
                  <col style={{ width: '150px' }} />
                  <col style={{ width: '126px' }} />
                  <col style={{ width: '70px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    {/* Split from "Age · Gender". A number and a category
                        joined by a middot is a compound column, and a
                        compound column is where a table stops being a grid. */}
                    <th scope="col" className="ui-ptable-num">Age</th>
                    <th scope="col" className="ui-ptable-sex">Sex</th>
                    <th scope="col">Conditions</th>
                    <th scope="col">Medication</th>
                    <th scope="col">Last visit</th>
                    <th scope="col">Follow-up</th>
                    <th scope="col">Pharmacist</th>
                    <th scope="col">Risk</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.patients.map((p, i) => (
                    <PatientRow key={p.id} p={p} index={i} today={data.today} onOpen={onOpen} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-xl border border-[var(--ui-line)] px-4 py-10 text-center text-sm text-[var(--ui-ink-soft)]">
              {narrowed
                ? 'No patients match this search. Try removing a filter.'
                : 'No patients yet. They appear here the first time they message the pharmacy.'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
