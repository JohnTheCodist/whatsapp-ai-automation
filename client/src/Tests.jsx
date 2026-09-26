/**
 * The patient record's Tests section — diagnostic tests and their results.
 *
 * THE RESULT IS IN THE ROW. "108 mg/dL · High ▲" is readable without opening
 * anything; that is the whole point of the screen (brief §30). The detail
 * carries the range, the specimen, the source, the consultation, the
 * corrections and the trend.
 *
 * A VALUE IS NOT A VERDICT. Entering a result saves it as PRELIMINARY; a
 * pharmacist marks it completed. Editing a completed report is a CORRECTION:
 * it asks why, and keeps what the report said before.
 *
 * A RESULT IS EVIDENCE, NOT A DIAGNOSIS. Recorded conditions and the
 * medicines for them are shown beside a test when they exist. Nothing here
 * creates or changes either.
 *
 * NOT A VITAL SIGN, EITHER. Blood pressure and weight belong to Vitals &
 * biometrics; a glucose TEST belongs here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Loading from './Loading.jsx';
import PartialDateInput from './PartialDateInput.jsx';
import VitalsChart from './VitalsChart.jsx';
import { IconChevronDown, IconFlask, IconAlertTriangle } from './Icons.jsx';
import {
  TEST_FILTERS, STATUS_TONE, INTERPRETATION_TONE, interpretationArrow, isCritical, labelFor,
  performedLabel, performedInput, dayLabel, resultValue, rowResult, rowInterpretation,
  referenceLabel, sourceLabel, encounterLabel, pendingLine, byLine, canTrend, trendSeries,
  formProblems,
} from './testFormat.js';

const Blank = () => <span className="ui-ptable-blank" aria-label="not recorded">–</span>;

async function send(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(json.error || 'Could not save. Try again.'), {
      field: json.field, status: r.status, code: json.code,
    });
  }
  return json;
}

/** The reading, said in words with its arrow — never colour alone. */
function Interpretation({ value, options }) {
  if (!value) return <Blank />;
  const arrow = interpretationArrow(value);
  return (
    <span className={`ui-med-status ${INTERPRETATION_TONE[value] || 'ui-tone-quiet'}`}>
      {isCritical(value) && <IconAlertTriangle width={11} height={11} aria-hidden="true" className="mr-1 inline" />}
      {arrow && !isCritical(value) ? `${arrow} ` : ''}
      {labelFor(options?.interpretations, value)}
    </span>
  );
}

export default function Tests({ customerId, onOpenTab }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState(null);       // null | { mode: 'order'|'result', test? }

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/tests`);
      if (!r.ok) throw new Error('Could not load this patient\'s tests.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/tests/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  if (error && !data) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head"><h2>Tests</h2></header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">Tests could not be loaded</p>
          <p>{error}</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  // Filtering here as well as on the server: the counts describe the whole
  // record, and a filter must not cost a round trip.
  const needle = query.trim().toLowerCase();
  const shown = data.tests.filter((t) => {
    if (filter === 'ordered' && t.status !== 'ordered') return false;
    if (filter === 'pending' && t.status !== 'pending') return false;
    if (filter === 'completed' && !['final', 'amended', 'corrected'].includes(t.status)) return false;
    if (filter === 'abnormal' && !t.abnormal) return false;
    if (filter === 'historical' && !t.historical) return false;
    if (category && t.category !== category) return false;
    if (needle && !t.testName.toLowerCase().includes(needle)) return false;
    return true;
  });

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Tests</h2>
        <span className="ui-test-actions">
          <button type="button" onClick={() => setForm({ mode: 'order' })} className="ui-mrev-btn">+ Order test</button>
          <button type="button" onClick={() => setForm({ mode: 'result' })} className="ui-meds-add">
            <IconFlask width={15} height={15} aria-hidden="true" />
            + Record result
          </button>
        </span>
      </header>

      <div className="ui-allergy-body">
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        {data.counts.all === 0 ? (
          <div className="ui-meds-empty">
            <p className="ui-meds-empty-title">No tests recorded</p>
            <p>This patient does not currently have any diagnostic tests recorded.</p>
            <span className="ui-test-actions mt-3">
              <button type="button" onClick={() => setForm({ mode: 'order' })} className="ui-mrev-btn">+ Order test</button>
              <button type="button" onClick={() => setForm({ mode: 'result' })} className="ui-meds-add">+ Record result</button>
            </span>
          </div>
        ) : (
          <>
            <div className="ui-cond-toolbar">
              <div className="ui-meds-filters" role="group" aria-label="Filter tests">
                {TEST_FILTERS.map((f) => (
                  <button key={f.value} type="button" aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)} className={`ui-quick-filter ${filter === f.value ? 'is-on' : ''}`}>
                    {f.label}
                    <span className="ui-test-count">{data.counts[f.count]}</span>
                  </button>
                ))}
              </div>
              <div className="ui-test-search">
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="ui-vital-input" aria-label="Category">
                  <option value="">All categories</option>
                  {(options?.categories || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a test"
                  aria-label="Search tests by name" className="ui-vital-input" />
              </div>
            </div>

            {shown.length === 0
              ? <p className="ui-meds-count">Nothing matches this filter.</p>
              : (
                <div className="ui-med-tablewrap">
                  <table className="ui-med-table ui-test-table">
                    <colgroup>
                      <col style={{ width: '220px' }} />
                      <col style={{ width: '120px' }} />
                      <col style={{ width: '110px' }} />
                      <col style={{ width: '170px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '160px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">Test</th>
                        <th scope="col">Category</th>
                        <th scope="col">Date</th>
                        <th scope="col">Result</th>
                        <th scope="col">Status</th>
                        <th scope="col">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((t, i) => (
                        <TestRow
                          key={t.id}
                          t={t}
                          index={i}
                          customerId={customerId}
                          options={options}
                          open={openId === t.id}
                          onToggle={() => setOpenId((o) => (o === t.id ? null : t.id))}
                          onEdit={(test) => setForm({ mode: 'edit', test })}
                          onAddResult={(test) => setForm({ mode: 'result', test })}
                          onOpenTab={onOpenTab}
                          onChanged={load}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}
      </div>

      {form && (
        <TestForm
          customerId={customerId}
          mode={form.mode}
          test={form.test || null}
          options={options}
          onClose={() => setForm(null)}
          onSaved={async (saved) => { setForm(null); setOpenId(saved?.id || null); await load(); }}
        />
      )}
    </section>
  );
}

function TestRow({ t, index, customerId, options, open, onToggle, onEdit, onAddResult, onOpenTab, onChanged }) {
  const value = rowResult(t);
  const reading = rowInterpretation(t);
  return (
    <>
      <tr className={`ui-med-row ${t.critical ? 'is-critical' : ''}`} style={{ '--row-i': index }}>
        <td>
          <button type="button" onClick={onToggle} aria-expanded={open} className="ui-med-name">
            <IconChevronDown width={13} height={13} aria-hidden="true" className={`ui-med-caret ${open ? 'is-open' : ''}`} />
            <span>
              <span className="ui-med-title">{t.testName}</span>
              {(t.specimen || t.historical) && (
                <span className="ui-med-sub">
                  {[labelFor(options?.specimens, t.specimen), t.historical ? 'Historical' : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
          </button>
        </td>
        <td className="ui-med-quiet">{labelFor(options?.categories, t.category)}</td>
        <td className="ui-med-quiet whitespace-nowrap">{performedLabel(t) || <Blank />}</td>
        <td className="ui-med-dosing">
          {value
            ? (
              <span className="ui-test-value">
                <span>{value}</span>
                <Interpretation value={reading} options={options} />
              </span>
            )
            : <span className="ui-test-pending">{pendingLine(t) || <Blank />}</span>}
        </td>
        <td><span className={`ui-med-status ${STATUS_TONE[t.status] || 'ui-tone-quiet'}`}>{labelFor(options?.statuses, t.status)}</span></td>
        <td className="ui-med-quiet">{sourceLabel(t, options?.sources) || <Blank />}</td>
      </tr>
      {open && (
        <tr className="ui-med-detail-row">
          <td colSpan={6}>
            <TestDetail
              t={t}
              customerId={customerId}
              options={options}
              onEdit={onEdit}
              onAddResult={onAddResult}
              onOpenTab={onOpenTab}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function TestDetail({ t, customerId, options, onEdit, onAddResult, onOpenTab, onChanged }) {
  const [full, setFull] = useState(null);
  const [trend, setTrend] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The corrections, the related records and the trend come with the full
  // record — the row carries only what it shows.
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/tests/${t.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this test.'))))
      .then((j) => { if (live) setFull(j); })
      .catch((e) => { if (live) setError(e.message); });
    const code = t.results[0]?.analyteCode || null;
    const name = t.results[0]?.analyteName || null;
    if (code || name) {
      const q = code ? `code=${encodeURIComponent(code)}` : `name=${encodeURIComponent(name)}`;
      fetch(`/api/customers/${customerId}/tests/trend?${q}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (live && j) setTrend(j); })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [customerId, t.id, t.results]);

  const d = full || t;
  const chart = trendSeries(trend);
  const finalised = ['final', 'amended', 'corrected'].includes(d.status);

  async function finalise() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/tests/${t.id}`, 'PATCH', { status: 'final' });
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ui-allergy-detail">
      {error && <p role="alert" className="ui-vital-error">{error}</p>}

      {d.results.length > 0 && (
        <table className="ui-test-results">
          <thead>
            <tr>
              <th scope="col">Result</th>
              <th scope="col">Value</th>
              <th scope="col">Reference</th>
              <th scope="col">Reading</th>
            </tr>
          </thead>
          <tbody>
            {d.results.map((r) => (
              <tr key={r.id || r.analyteName}>
                <td>{r.analyteName}</td>
                <td className="ui-test-value-cell">{resultValue(r)}</td>
                <td className="ui-med-quiet">{referenceLabel(r) || <Blank />}</td>
                <td><Interpretation value={r.interpretation} options={options} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.results.length === 0 && <p className="ui-test-pending">{pendingLine(d)}</p>}

      <dl className="ui-med-detail">
        {[
          ['Category', labelFor(options?.categories, d.category)],
          ['Status', labelFor(options?.statuses, d.status)],
          ['Priority', d.priority === 'urgent' ? 'Urgent' : null],
          ['Specimen', labelFor(options?.specimens, d.specimen)],
          ['Ordered', d.orderedOn ? dayLabel(`${d.orderedOn}T00:00:00Z`) : null],
          ['Ordered by', d.ordererName],
          ['Performed', performedLabel(d)],
          ['Performed by', d.performedByName],
          ['Source', sourceLabel(d, options?.sources)],
          ['Historical', d.historical ? 'Recorded for the history' : null],
          ['Documented during', encounterLabel(d)],
          ['Reason', d.reason],
          ['Report', d.reportSummary],
          [finalised && d.statusReason ? 'Why it changed' : 'Status note', d.statusReason],
          ['Notes', d.notes],
        ].filter(([, v]) => v).map(([label, value]) => (
          <div key={label} className={['Report', 'Notes', 'Why it changed', 'Status note'].includes(label) ? 'is-wide' : ''}>
            <dt>{label}</dt>
            <dd className="whitespace-pre-line">{value}</dd>
          </div>
        ))}
      </dl>

      {/* What this result is about, when a pharmacist has recorded it. Shown,
          never created: a high HbA1c does not make anybody diabetic here. */}
      {(full?.relatedConditions?.length > 0 || full?.relatedMedicines?.length > 0) && (
        <div className="ui-test-related">
          <h4>Related</h4>
          <ul>
            {(full.relatedConditions || []).map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onOpenTab?.('conditions')} className="ui-test-related-link">
                  {c.conditionName} — recorded condition
                </button>
              </li>
            ))}
            {(full.relatedMedicines || []).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onOpenTab?.('meds')} className="ui-test-related-link">
                  {[m.medicineName, m.strength].filter(Boolean).join(' ')} — current medicine
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* A trend, only where there is one to see. */}
      {canTrend(trend) && chart && (
        <div className="ui-test-trend">
          <h4>{trend.analyte} over time</h4>
          <VitalsChart series={chart.series} unit={chart.unit} ranges={chart.ranges} width={520} height={200} />
        </div>
      )}

      {full?.corrections?.length > 0 && (
        <div className="ui-test-corrections">
          <h4>Corrections</h4>
          <ul>
            {full.corrections.map((c) => (
              <li key={c.id}>
                <span className="ui-test-correction-when">{dayLabel(c.at)}{c.by ? ` · ${c.by}` : ''}</span>
                <span>{c.reason}</span>
                <span className="ui-test-correction-was">
                  Previously: {(c.snapshot?.results || []).map((r) => `${r.analyteName} ${resultValue(r)}`).join(', ') || '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="ui-allergy-by">{byLine(d)}</p>

      <div className="ui-allergy-actions">
        <button type="button" onClick={() => onEdit(d)} className="ui-mrev-btn">
          {finalised ? 'Correct result' : 'Edit'}
        </button>
        {d.results.length === 0 && d.status !== 'cancelled' && (
          <button type="button" onClick={() => onAddResult(d)} className="ui-mrev-btn is-primary">Add result</button>
        )}
        {d.status === 'preliminary' && (
          <button type="button" onClick={finalise} disabled={busy} className="ui-mrev-btn is-primary">
            {busy ? 'Saving…' : 'Mark completed'}
          </button>
        )}
        {['ordered', 'pending'].includes(d.status) && (
          <button type="button" onClick={() => onEdit({ ...d, _cancel: true })} className="ui-mrev-btn">Cancel test</button>
        )}
      </div>
    </div>
  );
}

/** The test box: free text always, with the catalogue behind it. */
function TestSearch({ customerId, value, onPick, onType, wrong }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q) => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      fetch(`/api/customers/${customerId}/tests/catalogue?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { tests: [] }))
        .then((j) => { setResults(j.tests || []); setOpen(true); })
        .catch(() => setResults([]));
    }, 160);
  };

  return (
    <div className="ui-allergy-search">
      <input
        autoFocus
        value={value}
        onChange={(e) => { onType(e.target.value); search(e.target.value); }}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Malaria RDT, fasting blood glucose, lipid profile…"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        className={`ui-vital-input ${wrong}`}
      />
      {open && results.length > 0 && (
        <ul className="ui-allergy-suggestions" role="listbox">
          {results.map((r) => (
            <li key={r.id} role="option" aria-selected="false">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(r); setOpen(false); }}>
                <span>{r.name}</span>
                <span className="ui-allergy-suggestion-kind">{r.unit || r.resultType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const emptyResult = () => ({
  analyteName: '', analyteCode: '', kind: 'number', valueNumber: '', unit: '', valueCode: '',
  valueDisplay: '', valueText: '', referenceLow: '', referenceHigh: '', interpretation: '', codedOptions: [],
});

function fromTest(t) {
  return {
    definitionId: t.definitionId || '',
    testCode: t.testCode || '',
    testName: t.testName,
    category: t.category,
    status: t.status,
    priority: t.priority,
    reason: t.reason || '',
    specimen: t.specimen || '',
    orderedOn: t.orderedOn || '',
    ordererName: t.ordererName || '',
    performed: performedInput(t),
    performedByName: t.performedByName || '',
    source: t.source,
    sourceName: t.sourceName || '',
    historical: t.historical,
    encounterId: t.encounter?.id || '',
    reportSummary: t.reportSummary || '',
    notes: t.notes || '',
    statusReason: '',
    results: (t.results || []).map((r) => ({
      analyteName: r.analyteName,
      analyteCode: r.analyteCode || '',
      kind: r.valueNumber !== null ? 'number' : r.valueCode ? 'code' : 'text',
      valueNumber: r.valueNumber ?? '',
      unit: r.unit || '',
      valueCode: r.valueCode || '',
      valueDisplay: r.valueDisplay || '',
      valueText: r.valueText || '',
      referenceLow: r.referenceLow ?? '',
      referenceHigh: r.referenceHigh ?? '',
      interpretation: r.interpretation || '',
      codedOptions: [],
    })),
  };
}

/**
 * One form for three jobs: ordering a test, recording what came back, and
 * correcting a report. They differ in what is filled in, not in shape — a
 * pharmacist should not have to learn two screens.
 */
function TestForm({ customerId, mode, test, options, onClose, onSaved }) {
  const cancelling = Boolean(test?._cancel);
  const [form, setForm] = useState(() => {
    if (test) return { ...fromTest(test), ...(cancelling ? { status: 'cancelled' } : {}) };
    return {
      definitionId: '', testCode: '', testName: '', category: 'laboratory',
      status: mode === 'result' ? 'preliminary' : 'ordered',
      priority: 'routine', reason: '', specimen: '', orderedOn: '', ordererName: '',
      performed: '', performedByName: '', source: 'rxmax_clinic', sourceName: '',
      historical: false, encounterId: '', reportSummary: '', notes: '', statusReason: '',
      results: mode === 'result' ? [emptyResult()] : [],
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [encounters, setEncounters] = useState([]);

  const correcting = Boolean(test) && ['final', 'amended', 'corrected'].includes(test.status) && !cancelling;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const pick = (name) => options?.[name] || [];
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');
  const problems = formProblems(form);
  const title = cancelling ? 'Cancel test'
    : correcting ? 'Correct result'
      : test ? 'Edit test'
        : mode === 'result' ? 'Record result' : 'Order test';

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/tests/encounters`)
      .then((r) => (r.ok ? r.json() : { encounters: [] }))
      .then((j) => { if (live) setEncounters(j.encounters || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  /** The catalogue fills the form in; everything stays editable. */
  const applyDefinition = (d) => setForm((f) => {
    const results = d.resultType === 'panel'
      ? (d.analytes || []).map((a) => ({
        ...emptyResult(), analyteName: a.name, analyteCode: a.code, unit: a.unit || '',
        referenceLow: a.low ?? '', referenceHigh: a.high ?? '',
      }))
      : [{
        ...emptyResult(),
        analyteName: d.name,
        analyteCode: d.code,
        kind: d.resultType === 'coded' ? 'code' : d.resultType === 'text' ? 'text' : 'number',
        unit: d.unit || '',
        referenceLow: d.referenceLow ?? '',
        referenceHigh: d.referenceHigh ?? '',
        codedOptions: d.codedOptions || [],
      }];
    // Only ever overwrite EMPTY rows. A blank row the form put there is not
    // data; anything typed is, and picking a test must not wipe it.
    const untouched = f.results.every((r) => !String(r.analyteName || '').trim()
      && r.valueNumber === '' && !r.valueCode && !r.valueText);
    const keepOrdering = mode === 'order' && !test && untouched;
    return {
      ...f,
      definitionId: d.id,
      testCode: d.code,
      testName: d.name,
      category: d.category,
      specimen: d.specimen || f.specimen,
      // Ordering a test asks for no values yet; recording one is handed the
      // analytes, units and ranges the catalogue knows — all editable.
      results: keepOrdering ? [] : (untouched ? results : f.results),
    };
  });

  const setResult = (i, key, value) => setForm((f) => ({
    ...f,
    results: f.results.map((r, j) => {
      if (j !== i) return r;
      const next = { ...r, [key]: value };
      // The reading is OFFERED from the range beside it — arithmetic, not a
      // diagnosis — and stays editable.
      if (['valueNumber', 'referenceLow', 'referenceHigh'].includes(key) && next.kind === 'number') {
        const v = Number(next.valueNumber);
        const lo = next.referenceLow === '' ? null : Number(next.referenceLow);
        const hi = next.referenceHigh === '' ? null : Number(next.referenceHigh);
        if (Number.isFinite(v) && (lo !== null || hi !== null)
            && !['critical_high', 'critical_low'].includes(next.interpretation)) {
          next.interpretation = lo !== null && v < lo ? 'low' : hi !== null && v > hi ? 'high' : 'normal';
        }
      }
      return next;
    }),
  }));

  const addResult = () => setForm((f) => ({ ...f, results: [...f.results, emptyResult()] }));
  const dropResult = (i) => setForm((f) => ({ ...f, results: f.results.filter((_, j) => j !== i) }));

  async function save(e) {
    e.preventDefault();
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      definitionId: form.definitionId || null,
      testCode: form.testCode || null,
      testName: form.testName,
      category: form.category,
      status: form.status,
      priority: form.priority,
      reason: form.reason || null,
      specimen: form.specimen || null,
      orderedOn: form.orderedOn,
      ordererName: form.ordererName || null,
      performed: form.performed,
      performedByName: form.performedByName || null,
      source: form.source,
      sourceName: form.sourceName || null,
      historical: form.historical,
      encounterId: form.encounterId || null,
      reportSummary: form.reportSummary || null,
      notes: form.notes || null,
      statusReason: form.statusReason || null,
      results: form.results
        .filter((r) => String(r.analyteName || '').trim())
        .map((r) => ({
          analyteName: r.analyteName,
          analyteCode: r.analyteCode || null,
          valueNumber: r.kind === 'number' && r.valueNumber !== '' ? Number(r.valueNumber) : null,
          unit: r.kind === 'number' ? (r.unit || null) : null,
          valueCode: r.kind === 'code' && r.valueCode ? r.valueCode : null,
          valueDisplay: r.kind === 'code' ? (r.valueDisplay || null) : null,
          valueText: r.kind === 'text' && r.valueText ? r.valueText : null,
          referenceLow: r.kind === 'number' && r.referenceLow !== '' ? Number(r.referenceLow) : null,
          referenceHigh: r.kind === 'number' && r.referenceHigh !== '' ? Number(r.referenceHigh) : null,
          interpretation: r.interpretation || null,
        })),
    };
    try {
      const saved = test
        ? await send(`/api/customers/${customerId}/tests/${test.id}`, 'PATCH', body)
        : await send(`/api/customers/${customerId}/tests`, 'POST', body);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <form onSubmit={save} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          {correcting && (
            <p className="ui-cond-hint">
              <IconAlertTriangle width={13} height={13} aria-hidden="true" />
              <span>This result is completed. Changing it records a correction and keeps what it said before.</span>
            </p>
          )}

          <div className="ui-med-field">
            <span className="ui-vital-label">Test</span>
            {test ? (
              <input value={form.testName} onChange={(e) => set('testName', e.target.value)} className={`ui-vital-input ${wrong('testName')}`} />
            ) : (
              <TestSearch
                customerId={customerId}
                value={form.testName}
                wrong={wrong('testName')}
                onType={(v) => setForm((f) => ({ ...f, testName: v, definitionId: '', testCode: '' }))}
                onPick={applyDefinition}
              />
            )}
          </div>

          <div className="ui-med-grid">
            <label className="ui-med-field">
              <span className="ui-vital-label">Category</span>
              <select value={form.category} onChange={(e) => set('category', e.target.value)} className="ui-vital-input">
                {pick('categories').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Specimen</span>
              <select value={form.specimen} onChange={(e) => set('specimen', e.target.value)} className="ui-vital-input">
                <option value="">Not recorded</option>
                {pick('specimens').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value)} className={`ui-vital-input ${wrong('status')}`}>
                {pick('statuses').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="ui-allergy-help">A result is preliminary until a pharmacist completes it.</span>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Priority</span>
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)} className="ui-vital-input">
                {pick('priorities').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {['cancelled', 'amended', 'corrected'].includes(form.status) || correcting ? (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">Why?</span>
              <input value={form.statusReason} onChange={(e) => set('statusReason', e.target.value)}
                placeholder={form.status === 'cancelled' ? 'Patient did not return with the sample.' : 'Laboratory reissued the report.'}
                className={`ui-vital-input ${wrong('statusReason')}`} />
            </label>
          ) : null}

          {/* ---- the results ---- */}
          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">Results</legend>
            {form.results.length === 0 && (
              <p className="ui-med-context-none">Nothing recorded yet — a test may be ordered now and answered later.</p>
            )}
            {form.results.map((r, i) => (
              <div key={i} className="ui-test-result-row">
                <input value={r.analyteName} onChange={(e) => setResult(i, 'analyteName', e.target.value)}
                  placeholder="What was measured" aria-label="Result name" className="ui-vital-input" />
                <select value={r.kind} onChange={(e) => setResult(i, 'kind', e.target.value)} aria-label="Kind of result" className="ui-vital-input">
                  <option value="number">Number</option>
                  <option value="code">Positive / negative</option>
                  <option value="text">Words</option>
                </select>
                {r.kind === 'number' && (
                  <>
                    <input value={r.valueNumber} onChange={(e) => setResult(i, 'valueNumber', e.target.value)}
                      inputMode="decimal" placeholder="Value" aria-label="Value" className={`ui-vital-input ${wrong('value')}`} />
                    <input value={r.unit} onChange={(e) => setResult(i, 'unit', e.target.value)}
                      placeholder="Unit" aria-label="Unit" className="ui-vital-input" />
                    <input value={r.referenceLow} onChange={(e) => setResult(i, 'referenceLow', e.target.value)}
                      inputMode="decimal" placeholder="Ref low" aria-label="Reference low" className={`ui-vital-input ${wrong('referenceLow')}`} />
                    <input value={r.referenceHigh} onChange={(e) => setResult(i, 'referenceHigh', e.target.value)}
                      inputMode="decimal" placeholder="Ref high" aria-label="Reference high" className="ui-vital-input" />
                  </>
                )}
                {r.kind === 'code' && (
                  <select value={r.valueCode} onChange={(e) => {
                    const opt = (r.codedOptions || []).find((o) => o.code === e.target.value);
                    setResult(i, 'valueCode', e.target.value);
                    setResult(i, 'valueDisplay', opt?.display || e.target.value);
                  }} aria-label="Result" className={`ui-vital-input ui-test-span2 ${wrong('value')}`}>
                    <option value="">Choose…</option>
                    {(r.codedOptions || []).map((o) => <option key={o.code} value={o.code}>{o.display}</option>)}
                    {(r.codedOptions || []).length === 0 && ['positive', 'negative', 'reactive', 'non_reactive', 'detected', 'not_detected'].map((c) => (
                      <option key={c} value={c}>{c.replace('_', '-').replace(/^\w/, (m) => m.toUpperCase())}</option>
                    ))}
                  </select>
                )}
                {r.kind === 'text' && (
                  <input value={r.valueText} onChange={(e) => setResult(i, 'valueText', e.target.value)}
                    placeholder="What the report says" aria-label="Result" className={`ui-vital-input ui-test-span4 ${wrong('value')}`} />
                )}
                <select value={r.interpretation} onChange={(e) => setResult(i, 'interpretation', e.target.value)}
                  aria-label="Reading" className="ui-vital-input">
                  <option value="">Reading…</option>
                  {pick('interpretations').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button type="button" onClick={() => dropResult(i)} aria-label="Remove this result" className="ui-icon-btn">×</button>
              </div>
            ))}
            <button type="button" onClick={addResult} className="ui-mrev-add">+ Add a result</button>
          </fieldset>

          <div className="ui-med-grid mt-3">
            <PartialDateInput label="Performed" value={form.performed} onChange={(v) => set('performed', v)} wrong={wrong('performed')} />
            <PartialDateInput label="Ordered on" value={form.orderedOn} onChange={(v) => set('orderedOn', v)} wrong={wrong('orderedOn')} />
            <label className="ui-med-field">
              <span className="ui-vital-label">Source</span>
              <select value={form.source} onChange={(e) => set('source', e.target.value)} className="ui-vital-input">
                {pick('sources').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Laboratory / report reference</span>
              <input value={form.sourceName} onChange={(e) => set('sourceName', e.target.value)}
                placeholder="Synlab · report 2026-0918-441" className="ui-vital-input" />
            </label>
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Requested by</span>
              <input value={form.ordererName} onChange={(e) => set('ordererName', e.target.value)} placeholder="Dr Okafor" className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Performed by</span>
              <input value={form.performedByName} onChange={(e) => set('performedByName', e.target.value)} placeholder="Synlab, Ikeja" className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Documented during</span>
              <select value={form.encounterId} onChange={(e) => set('encounterId', e.target.value)} className={`ui-vital-input ${wrong('encounterId')}`}>
                <option value="">Not linked to a consultation</option>
                {encounters.map((e) => (
                  <option key={e.id} value={e.id}>
                    Consultation — {dayLabel(e.startedAt)}{e.complaint ? ` · ${e.complaint}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="ui-med-field ui-test-historical">
              <input type="checkbox" checked={form.historical} onChange={(e) => set('historical', e.target.checked)} />
              <span>
                <span className="ui-vital-label">An older result, for the history</span>
                <span className="ui-allergy-help">Marks it as historical. Never guessed from the date.</span>
              </span>
            </label>
          </div>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why was it done? (optional)</span>
            <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Fatigue and thirst" className="ui-vital-input" />
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">The report&rsquo;s own words (optional)</span>
            <textarea rows={2} value={form.reportSummary} onChange={(e) => set('reportSummary', e.target.value)}
              placeholder="No focal consolidation. Heart size normal." className="ui-mrev-text" />
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} className="ui-mrev-text" />
          </label>

          {problems.length > 0 && form.testName && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : title}
          </button>
        </footer>
      </form>
    </div>
  );
}
