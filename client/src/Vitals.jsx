/**
 * The patient record's Vitals & Biometrics section.
 *
 * Built to match the flow the owner asked to replicate (OpenMRS 3):
 *
 *   header   "Last recorded", and Record vitals
 *   tabs     Vitals | Biometrics — the same readings, different columns
 *   view     a table of readings, or one sign charted over time
 *   form     a panel over the screen: the vitals, the biometrics, notes
 *
 * WHAT THIS SCREEN MUST NEVER DO is make a number look like a judgement it
 * is not. A reading outside the usual adult range is shown in red and says
 * why on hover; nothing is ever marked "normal", nothing is scored, and no
 * range at all is applied to a child (the server decides this — see
 * services/clinical/vitalRanges.js).
 *
 * BMI IS SHOWN WHILE TYPING and never stored: it is weight and height, and
 * it updates as either changes, so a corrected weight cannot leave a stale
 * BMI on screen.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import VitalsChart from './VitalsChart.jsx';
import { IconChevronDown, IconTrendUp } from './Icons.jsx';
import {
  VITALS_COLUMNS, BIOMETRICS_COLUMNS, CHART_SIGNS,
  cellValue, cellFlag, readingStamp, shortDate, itemsLabel, chartSeries,
} from './vitalsFormat.js';

const PAGE = 5;

/** The form's fields, in the order the reference screen enters them. */
const FORM_VITALS = [
  { key: 'systolic', label: 'Systolic', unit: 'mmHg', width: 'w-20' },
  { key: 'diastolic', label: 'Diastolic', unit: 'mmHg', width: 'w-20' },
  { key: 'pulse', label: 'Pulse', unit: 'beats/min' },
  { key: 'spo2', label: 'SpO2', unit: '%' },
  { key: 'respiratoryRate', label: 'Respiration rate', unit: 'breaths/min' },
  { key: 'temperature', label: 'Temp', unit: 'DEG C', step: '0.1' },
];
const FORM_BIOMETRICS = [
  { key: 'weight', label: 'Weight', unit: 'kg', step: '0.1' },
  { key: 'height', label: 'Height', unit: 'cm' },
  { key: 'muac', label: 'MUAC', unit: 'cm', step: '0.1' },
];

/** BMI while typing — the same arithmetic the server does on read. */
function liveBmi(form) {
  const w = Number(form.weight);
  const h = Number(form.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
}

function Field({ spec, value, onChange, invalid }) {
  return (
    <label className="ui-vital-field">
      <span className="ui-vital-label">{spec.label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={spec.step || '1'}
        value={value ?? ''}
        onChange={(e) => onChange(spec.key, e.target.value)}
        aria-label={`${spec.label} in ${spec.unit}`}
        aria-invalid={invalid || undefined}
        className={`ui-vital-input ${invalid ? 'is-wrong' : ''}`}
      />
      <span className="ui-vital-unit">{spec.unit}</span>
    </label>
  );
}

/** The record panel: everything measured at once, saved as one reading. */
function RecordForm({ customerId, onClose, onSaved }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const bmi = liveBmi(form);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/customers/${customerId}/vitals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error || 'Could not save this reading.'), { field: body.field });
      onSaved(body);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Record vitals and biometrics">
      <form onSubmit={save} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Record vitals and biometrics</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          <h4 className="ui-vital-group">Vitals</h4>
          <div className="ui-vital-grid">
            {FORM_VITALS.map((spec) => (
              <Field
                key={spec.key}
                spec={spec}
                value={form[spec.key]}
                onChange={set}
                invalid={error?.field === spec.key}
              />
            ))}
          </div>

          <label className="mt-4 block">
            <span className="ui-vital-label">Notes</span>
            <textarea
              rows={2}
              value={form.notes || ''}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Type any additional notes here"
              className="mt-1 w-full px-3 py-2 text-[13px]"
            />
          </label>

          <h4 className="ui-vital-group mt-5">Biometrics</h4>
          <div className="ui-vital-grid">
            {FORM_BIOMETRICS.map((spec) => (
              <Field
                key={spec.key}
                spec={spec}
                value={form[spec.key]}
                onChange={set}
                invalid={error?.field === spec.key}
              />
            ))}
            {/* Calculated, never typed and never stored. */}
            <div className="ui-vital-field">
              <span className="ui-vital-label">BMI (calc.)</span>
              <output className="ui-vital-input is-derived">{bmi ?? ''}</output>
              <span className="ui-vital-unit">kg / m²</span>
            </div>
          </div>

          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving} className="ui-vital-save">
            {saving ? 'Saving…' : 'Sign & Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export default function Vitals({ customerId }) {
  const [tab, setTab] = useState('vitals');
  const [view, setView] = useState('table');
  const [sign, setSign] = useState(CHART_SIGNS[0].key);
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [series, setSeries] = useState(null);
  const [error, setError] = useState(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, line] = await Promise.all([
        fetch(`/api/customers/${customerId}/vitals?limit=${PAGE}&offset=${page * PAGE}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the readings.')))),
        fetch(`/api/customers/${customerId}/vitals/series`).then((r) => (r.ok ? r.json() : { readings: [] })),
      ]);
      setData(list);
      setSeries(line.readings);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId, page]);

  useEffect(() => { load(); }, [load]);

  const columns = tab === 'vitals' ? VITALS_COLUMNS : BIOMETRICS_COLUMNS;
  const readings = data?.readings || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const current = CHART_SIGNS.find((s) => s.key === sign) || CHART_SIGNS[0];
  const lines = chartSeries(series || [], current);
  // The newest value OF THE SIGN ON SCREEN, which is not the same as the
  // newest row: the last reading may have been a blood pressure and nothing
  // else, and a Temp chart headed with a number from a visit that took no
  // temperature would be a figure attached to the wrong day.
  const latestPoints = lines.map((l) => l.points[l.points.length - 1]).filter(Boolean);
  const latest = latestPoints.length
    ? latestPoints.map((p) => p.value).join(' / ')
    : null;
  const latestAt = latestPoints[0]?.at || null;
  // Flagged only if the server flagged that sign on the reading it came from.
  const latestReading = latestAt ? (series || []).find((r) => r.recordedAt === latestAt) : null;
  const latestFlag = latestReading
    ? (current.series.map((k) => latestReading.abnormal?.[k]).find(Boolean) || null)
    : null;

  if (error) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  return (
    <section className="ui-vitals">
      <header className="ui-vitals-head">
        <h2>
          Vitals &amp; Biometrics
          <span className="ui-vitals-last">
            {total ? `Last recorded: ${shortDate(readings[0]?.recordedAt)}` : 'Nothing recorded yet'}
          </span>
        </h2>
        <button type="button" onClick={() => setRecording(true)} className="ui-vitals-record">
          Record vitals
        </button>
      </header>

      {/* The same readings, two sets of columns — the desk's underline tabs. */}
      <div role="tablist" aria-label="Vitals or biometrics" className="ui-vitals-tabs">
        {[['vitals', 'Vitals'], ['biometrics', 'Biometrics']].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`ui-vitals-tab ${tab === id ? 'is-on' : ''}`}
          >
            {label}
          </button>
        ))}

        <div className="ui-vitals-views" role="group" aria-label="Table or chart">
          <button
            type="button"
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
            title="Table"
            className={`ui-vitals-view ${view === 'table' ? 'is-on' : ''}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
              <path d="M3.5 9.5h17M9 9.5V19.5" />
            </svg>
          </button>
          <button
            type="button"
            aria-pressed={view === 'chart'}
            onClick={() => setView('chart')}
            title="Chart"
            className={`ui-vitals-view ${view === 'chart' ? 'is-on' : ''}`}
          >
            <IconTrendUp width={15} height={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {view === 'table' ? (
        <div key={`table-${tab}-${page}`} className="ui-vitals-view-in">
          <div className="ui-vitals-tablewrap">
            <table className="ui-vitals-table">
              <thead>
                <tr>
                  <th>Date and time</th>
                  {columns.map((c) => (
                    <th key={c.key}>
                      {c.label} <span className="ui-vitals-unit">({c.unit})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {readings.length === 0 && (
                  <tr><td colSpan={columns.length + 1} className="ui-vitals-none">No reading recorded yet.</td></tr>
                )}
                {readings.map((r, i) => (
                  <tr key={r.id} style={{ '--row-i': i }}>
                    <td className="whitespace-nowrap">{readingStamp(r.recordedAt)}</td>
                    {columns.map((c) => {
                      const flag = cellFlag(r, c);
                      const value = cellValue(r, c);
                      return (
                        <td
                          key={c.key}
                          className={flag ? 'ui-vitals-flag' : ''}
                          // The reason a number is red, in words, rather than
                          // leaving the colour to be guessed at.
                          title={flag ? `${flag === 'low' ? 'Below' : 'Above'} the usual adult range` : undefined}
                        >
                          {value ?? <span className="text-[var(--ui-ink-faint)]">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ui-vitals-foot">
            <span>{itemsLabel(readings.length, total)}</span>
            {pages > 1 && (
              <span className="ui-vitals-pager">
                <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page">‹</button>
                <span>{page + 1} of {pages}</span>
                <button type="button" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} aria-label="Next page">›</button>
              </span>
            )}
          </div>
        </div>
      ) : (
        <div key={`chart-${sign}`} className="ui-vitals-chartwrap ui-vitals-view-in">
          {/* One sign at a time. Two units on one pair of axes is the
              commonest chart mistake there is. */}
          <div className="ui-chart-picker" role="group" aria-label="Vital sign displayed">
            <span className="ui-chart-picker-title">Vital sign displayed</span>
            {CHART_SIGNS.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={sign === s.key}
                onClick={() => setSign(s.key)}
                className={`ui-chart-pick ${sign === s.key ? 'is-on' : ''}`}
              >
                {s.label} <span className="ui-vitals-unit">({s.unit})</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="ui-chart-title">
              {current.label} <span className="ui-vitals-unit">({current.unit})</span>
              {/* The most recent value, said once and said large. A chart
                  answers "which way is this going"; the number beside it
                  answers "where is it now", which is the other half of the
                  question and was previously only in the table. */}
              {latest && (
                <span className={`ui-chart-now ${latestFlag ? 'is-flagged' : ''}`}>
                  {latest}
                  <span className="ui-chart-now-when">latest</span>
                </span>
              )}
            </h3>
            <VitalsChart series={lines} unit={current.unit} ranges={data.ranges} sign={current} />
          </div>
        </div>
      )}

      {recording && (
        <RecordForm
          customerId={customerId}
          onClose={() => setRecording(false)}
          onSaved={() => { setRecording(false); setPage(0); load(); }}
        />
      )}
    </section>
  );
}
