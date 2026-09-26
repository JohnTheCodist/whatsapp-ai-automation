/**
 * The patient record's Conditions section — the problem list.
 *
 * WHAT IT MUST ANSWER AT A GLANCE: what does this patient have now, how sure
 * is anyone, and what did they have before. The Active table answers the
 * first two; History answers the third, as a list or a timeline.
 *
 * UNCERTAINTY IS VISIBLE. "Possible asthma", outlined chip, softer ink — a
 * provisional condition never looks like a confirmed one, and nothing here
 * reads as though the pharmacist diagnosed what was only reported.
 *
 * THE PURCHASE INFERENCE IS KEPT APART. Conditions the engine inferred from
 * purchases sit in their own block, labelled "not a diagnosis", and become a
 * record only when a pharmacist chooses to write one down.
 *
 * NOTHING IS DELETED, AND NOTHING IS DIAGNOSED. Status changes move a record
 * to History with its reason; the symptom and allergy hints are words, never
 * refusals and never automatic changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Loading from './Loading.jsx';
import PartialDateInput from './PartialDateInput.jsx';
import { IconChevronDown, IconInfo } from './Icons.jsx';
import {
  CONDITION_FILTERS, matchesFilter, VERIFICATION_TONE, isCertain, displayName, labelFor,
  partialDateLabel, partialDateInput, onsetLabel, dayLabel, historyStatus, encounterLabel,
  timeline, byLine, HINT_TEXT, formProblems,
} from './conditionFormat.js';

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
      field: json.field, status: r.status, code: json.code, existing: json.existing,
    });
  }
  return json;
}

export default function Conditions({ customerId, onChanged, onOpenTab }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);          // null | { condition?, prefill? }
  const [openId, setOpenId] = useState(null);
  const [action, setAction] = useState(null);      // { condition, kind }
  const [filter, setFilter] = useState('');
  const [view, setView] = useState('list');        // list | timeline

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/problems`);
      if (!r.ok) throw new Error('Could not load this patient\'s conditions.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/problems/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const changed = async () => { await load(); onChanged?.(); };

  if (error && !data) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head"><h2>Conditions</h2></header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">Conditions could not be loaded</p>
          <p>{error}</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const all = [...data.conditions, ...data.history];
  const current = data.conditions.filter((p) => matchesFilter(p, filter));
  const history = data.history.filter((p) => matchesFilter(p, filter));
  const shown = [...current, ...history];
  const toggle = (id) => setOpenId((o) => (o === id ? null : id));
  const tableProps = {
    customerId, options, openId, onToggle: toggle, onEdit: (c) => setForm({ condition: c }), onAction: (c, kind) => setAction({ condition: c, kind }),
  };

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Conditions</h2>
        <button type="button" onClick={() => setForm({})} className="ui-meds-add">+ Add condition</button>
      </header>

      <div className="ui-allergy-body">
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        {all.length === 0 ? (
          <div className="ui-meds-empty">
            <p className="ui-meds-empty-title">No conditions recorded</p>
            <p>This patient does not currently have any conditions documented in RxNaija.</p>
            <button type="button" onClick={() => setForm({})} className="ui-meds-add">+ Add condition</button>
          </div>
        ) : (
          <>
            <div className="ui-cond-toolbar">
              <div className="ui-meds-filters" role="group" aria-label="Filter conditions">
                {CONDITION_FILTERS.map((f) => (
                  <button key={f.value} type="button" aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)} className={`ui-quick-filter ${filter === f.value ? 'is-on' : ''}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="ui-meds-filters" role="group" aria-label="View">
                {[['list', 'List'], ['timeline', 'Timeline']].map(([v, label]) => (
                  <button key={v} type="button" aria-pressed={view === v}
                    onClick={() => setView(v)} className={`ui-quick-filter ${view === v ? 'is-on' : ''}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {view === 'timeline' ? (
              shown.length === 0
                ? <p className="ui-meds-count">Nothing matches this filter.</p>
                : timeline(shown).map((g) => (
                  <section key={g.key} className="ui-med-month">
                    <h3>{g.label}</h3>
                    <ConditionTable conditions={g.problems} mixed {...tableProps} />
                  </section>
                ))
            ) : (
              <>
                {current.length > 0 && (
                  <section aria-labelledby="cond-active">
                    <h3 id="cond-active" className="ui-allergy-heading">Active</h3>
                    <ConditionTable conditions={current} {...tableProps} />
                  </section>
                )}
                {history.length > 0 && (
                  <section aria-labelledby="cond-history">
                    <h3 id="cond-history" className="ui-allergy-heading">History</h3>
                    <ConditionTable conditions={history} history {...tableProps} />
                  </section>
                )}
                {current.length === 0 && history.length === 0 && <p className="ui-meds-count">Nothing matches this filter.</p>}
              </>
            )}
          </>
        )}

        {data.suggestions.length > 0 && (
          <Suggestions suggestions={data.suggestions} onRecord={(s) => setForm({ prefill: s.prefill })} />
        )}
      </div>

      {form && (
        <ConditionForm
          customerId={customerId}
          condition={form.condition || null}
          prefill={form.prefill || null}
          options={options}
          onClose={() => setForm(null)}
          onViewExisting={(id) => { setForm(null); setFilter(''); setView('list'); setOpenId(id); }}
          onOpenAllergies={() => { setForm(null); onOpenTab?.('allergies'); }}
          onSaved={async (saved) => { setForm(null); setOpenId(saved?.id || null); await changed(); }}
        />
      )}

      {action && (
        <StatusDialog
          customerId={customerId}
          condition={action.condition}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={async () => { setAction(null); await changed(); }}
        />
      )}
    </section>
  );
}

function ConditionTable({ customerId, conditions, options, history = false, mixed = false, openId, onToggle, onEdit, onAction }) {
  return (
    <div className="ui-med-tablewrap">
      <table className="ui-med-table ui-cond-table">
        <colgroup>
          <col style={{ width: '240px' }} />
          <col style={{ width: '120px' }} />
          <col style={{ width: '120px' }} />
          <col style={{ width: '100px' }} />
          <col style={{ width: '120px' }} />
          <col style={{ width: '100px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Condition</th>
            <th scope="col">Status</th>
            <th scope="col">Verification</th>
            <th scope="col">Severity</th>
            <th scope="col">Onset</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {conditions.map((p, i) => (
            <ConditionRow key={p.id} customerId={customerId} p={p} index={i} options={options} history={history || (mixed && !isCurrentish(p))}
              open={openId === p.id} onToggle={() => onToggle(p.id)} onEdit={onEdit} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const isCurrentish = (p) => ['active', 'recurrence', 'relapse'].includes(p.clinicalStatus)
  && !['refuted', 'entered_in_error'].includes(p.verificationStatus);

function ConditionRow({ customerId, p, index, options, history, open, onToggle, onEdit, onAction }) {
  const sub = [labelFor(options?.categories, p.category), p.code ? p.code : null, p.bodySite].filter(Boolean).join(' · ');
  return (
    <>
      <tr className={`ui-med-row ${history ? 'is-history' : ''} ${isCertain(p) ? '' : 'is-uncertain'}`} style={{ '--row-i': index }}>
        <td>
          <button type="button" onClick={onToggle} aria-expanded={open} className="ui-med-name">
            <IconChevronDown width={13} height={13} aria-hidden="true" className={`ui-med-caret ${open ? 'is-open' : ''}`} />
            <span>
              <span className="ui-med-title">{displayName(p)}</span>
              {sub && <span className="ui-med-sub">{sub}</span>}
            </span>
          </button>
        </td>
        <td>
          <span className={`ui-med-status ${history ? 'ui-tone-quiet' : 'ui-med-active'}`}>
            {history ? historyStatus(p, options?.clinicalStatuses) : labelFor(options?.clinicalStatuses, p.clinicalStatus)}
          </span>
        </td>
        <td>
          <span className={`ui-med-status ${VERIFICATION_TONE[p.verificationStatus] || 'ui-tone-quiet'}`}>
            {labelFor(options?.verificationStatuses, p.verificationStatus)}
          </span>
        </td>
        <td className="ui-med-quiet">{labelFor(options?.severities, p.severity) || <Blank />}</td>
        <td className="ui-med-quiet whitespace-nowrap">{onsetLabel(p) || <Blank />}</td>
        <td className="ui-med-quiet whitespace-nowrap">{dayLabel(p.updatedAt)}</td>
      </tr>
      {open && (
        <tr className="ui-med-detail-row">
          <td colSpan={6}>
            <ConditionDetail customerId={customerId} p={p} options={options} history={history} onEdit={onEdit} onAction={onAction} />
          </td>
        </tr>
      )}
    </>
  );
}

function ConditionDetail({ customerId, p, options, history, onEdit, onAction }) {
  const untrue = ['refuted', 'entered_in_error'].includes(p.verificationStatus);
  const [related, setRelated] = useState([]);
  // The medicines whose indication is this condition come with the full
  // record, not the list row — read when the detail opens. Shown beside the
  // condition, never merged into it.
  useEffect(() => {
    if (!p.localCode) return undefined;
    let live = true;
    fetch(`/api/customers/${customerId}/problems/${p.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setRelated(j.relatedMedicines || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId, p.id, p.localCode]);

  const evidence = (p.evidence || []).map((v) => [
    dayLabel(v.recordedAt),
    v.systolic && v.diastolic ? `BP ${v.systolic}/${v.diastolic}` : null,
    v.pulse ? `pulse ${v.pulse}` : null,
    v.temperature ? `${v.temperature} °C` : null,
    v.spo2 ? `SpO₂ ${v.spo2}%` : null,
  ].filter(Boolean).join(' · '));

  return (
    <div className="ui-allergy-detail">
      <dl className="ui-med-detail">
        {[
          ['Condition', p.conditionName],
          ['Code', p.code ? `${p.codeSystem === 'icd10' ? 'ICD-10' : p.codeSystem} ${p.code}` : null],
          ['Category', labelFor(options?.categories, p.category)],
          ['Clinical status', labelFor(options?.clinicalStatuses, p.clinicalStatus)],
          ['Verification', labelFor(options?.verificationStatuses, p.verificationStatus)],
          ['Severity', labelFor(options?.severities, p.severity)],
          ['Body site', p.bodySite],
          ['Onset', [partialDateLabel(p.onset), p.onset?.note].filter(Boolean).join(' — ') || 'Unknown'],
          ['Resolved / remission', partialDateLabel(p.abatement)],
          ['Source', labelFor(options?.sources, p.source)],
          ['Diagnosed by', p.assertedByName],
          ['Documented during', encounterLabel(p)],
          ['Last updated', dayLabel(p.updatedAt)],
          [untrue ? 'Why' : 'Status note', p.statusReason],
          ['Supporting readings', evidence.length ? evidence.join('\n') : null],
          ['Medicines for this condition', related.length
            ? related.map((m) => [m.medicineName, m.strength].filter(Boolean).join(' ')).join(', ')
            : null],
          ['Notes', p.notes],
        ].filter(([, v]) => v).map(([label, value]) => (
          <div key={label} className={['Notes', 'Why', 'Status note', 'Supporting readings', 'Medicines for this condition'].includes(label) ? 'is-wide' : ''}>
            <dt>{label}</dt>
            <dd className="whitespace-pre-line">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="ui-allergy-by">{byLine(p)}</p>

      <div className="ui-allergy-actions">
        <button type="button" onClick={() => onEdit(p)} className="ui-mrev-btn">Edit</button>
        {!history && (
          <>
            <button type="button" onClick={() => onAction(p, 'inactive')} className="ui-mrev-btn">Mark inactive</button>
            <button type="button" onClick={() => onAction(p, 'resolved')} className="ui-mrev-btn">Mark resolved</button>
            <button type="button" onClick={() => onAction(p, 'remission')} className="ui-mrev-btn">Mark in remission</button>
          </>
        )}
        {history && !untrue && (
          <button type="button" onClick={() => onAction(p, 'active')} className="ui-mrev-btn">Make active again</button>
        )}
        {p.verificationStatus !== 'refuted' && (
          <button type="button" onClick={() => onAction(p, 'refuted')} className="ui-mrev-btn">Mark refuted</button>
        )}
        {p.verificationStatus !== 'entered_in_error' && (
          <button type="button" onClick={() => onAction(p, 'entered_in_error')} className="ui-mrev-btn">Mark entered in error</button>
        )}
      </div>
    </div>
  );
}

/** The purchase engine's conditions, kept apart and labelled for what they are. */
function Suggestions({ suggestions, onRecord }) {
  return (
    <section className="ui-cond-suggest" aria-labelledby="cond-suggest">
      <h3 id="cond-suggest">
        <IconInfo width={14} height={14} aria-hidden="true" />
        Suggested by purchase history — not a diagnosis
      </h3>
      <ul>
        {suggestions.map((s) => (
          <li key={s.localCode}>
            <span>
              <span className="ui-cond-suggest-name">{s.name}</span>
              <span className="ui-cond-suggest-basis">
                {[
                  s.purchases ? `${s.purchases} purchase${s.purchases === 1 ? '' : 's'}` : null,
                  s.firstObserved ? `since ${partialDateLabel({ date: s.firstObserved, precision: 'month' })}` : null,
                ].filter(Boolean).join(' ')}
              </span>
            </span>
            <button type="button" onClick={() => onRecord(s)} className="ui-mrev-btn">Record as condition</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ACTIONS = {
  inactive: {
    title: 'Mark inactive',
    body: 'Not currently affecting the patient. It stays in the history and can be made active again.',
    patch: { clinicalStatus: 'inactive' },
    reason: 'optional',
    date: 'optional',
  },
  resolved: {
    title: 'Mark resolved',
    body: 'The condition has resolved. It stays in the patient\'s history.',
    patch: { clinicalStatus: 'resolved' },
    reason: 'optional',
    date: 'optional',
  },
  remission: {
    title: 'Mark in remission',
    body: 'The condition is in remission. It stays in the history and can recur.',
    patch: { clinicalStatus: 'remission' },
    reason: 'optional',
    date: 'optional',
  },
  active: {
    title: 'Make active again',
    body: 'Return this condition to the active list. Its old resolution date is cleared.',
    patch: { clinicalStatus: 'recurrence' },
    reason: 'none',
  },
  refuted: {
    title: 'Mark refuted',
    body: 'The condition was found not to be present. The record is kept, with your reason.',
    patch: { verificationStatus: 'refuted' },
    reason: 'required',
    pharmacist: true,
  },
  entered_in_error: {
    title: 'Mark entered in error',
    body: 'This was recorded by mistake. It is kept, not deleted.',
    patch: { verificationStatus: 'entered_in_error' },
    reason: 'required',
    pharmacist: true,
  },
};

function StatusDialog({ customerId, condition, kind, onClose, onDone }) {
  const spec = ACTIONS[kind];
  const [reason, setReason] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const blocked = spec.reason === 'required' && !reason.trim();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/problems/${condition.id}`, 'PATCH', {
        ...spec.patch,
        ...(spec.reason !== 'none' && reason.trim() ? { statusReason: reason.trim() } : {}),
        ...(spec.date && when ? { abatement: when } : {}),
      });
      onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="ui-allergy-dialog-scrim" role="dialog" aria-modal="true" aria-label={spec.title}>
      <div className="ui-allergy-dialog">
        <h3>{spec.title}: {condition.conditionName}</h3>
        <p>{spec.body}</p>
        {spec.pharmacist && <p className="ui-allergy-dialog-note">A pharmacist or owner makes this change.</p>}
        {spec.date && (
          <PartialDateInput label={kind === 'remission' ? 'In remission since' : kind === 'inactive' ? 'Inactive since' : 'Resolved on'} value={when} onChange={setWhen} />
        )}
        {spec.reason !== 'none' && (
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">{spec.reason === 'required' ? 'Why' : 'Why (optional)'}</span>
            <textarea autoFocus={spec.reason === 'required'} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="ui-mrev-text" />
          </label>
        )}
        {error && <p role="alert" className="ui-vital-error">{error}</p>}
        <div className="ui-allergy-dialog-buttons">
          <button type="button" onClick={onClose} className="ui-mrev-btn">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy || blocked} className="ui-mrev-btn is-primary">
            {busy ? 'Saving…' : spec.title}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The condition box: free text always, with suggestions from the catalogue. */
function ConditionSearch({ customerId, value, onPick, onType, wrong }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q) => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      fetch(`/api/customers/${customerId}/problems/catalogue?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { conditions: [] }))
        .then((j) => { setResults(j.conditions || []); setOpen(true); })
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
        placeholder="Hypertension, asthma, type 2 diabetes…"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        className={`ui-vital-input ${wrong}`}
      />
      {open && results.length > 0 && (
        <ul className="ui-allergy-suggestions" role="listbox">
          {results.map((r) => (
            <li key={`${r.code}-${r.name}`} role="option" aria-selected="false">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(r); setOpen(false); }}>
                <span>{r.name}</span>
                <span className="ui-allergy-suggestion-kind">ICD-10 {r.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EMPTY = {
  conditionName: '', codeSystem: '', code: '', localCode: '', category: 'problem_list',
  clinicalStatus: 'active', verificationStatus: 'unconfirmed', severity: '', bodySite: '',
  onset: '', onsetNote: '', abatement: '', source: 'patient', assertedByName: '', encounterId: '',
  evidenceVitalsIds: [], notes: '', statusReason: '',
};

function fromCondition(c) {
  return {
    conditionName: c.conditionName,
    codeSystem: c.codeSystem || '',
    code: c.code || '',
    localCode: c.localCode || '',
    category: c.category,
    clinicalStatus: c.clinicalStatus,
    verificationStatus: c.verificationStatus,
    severity: c.severity || '',
    bodySite: c.bodySite || '',
    onset: partialDateInput(c.onset),
    onsetNote: c.onset?.note || '',
    abatement: partialDateInput(c.abatement),
    source: c.source,
    assertedByName: c.assertedByName || '',
    encounterId: c.encounter?.id || '',
    evidenceVitalsIds: (c.evidence || []).map((e) => e.vitalsId),
    notes: c.notes || '',
    statusReason: c.statusReason || '',
  };
}

/** Add or edit, in the record panel the rest of the record uses. */
function ConditionForm({ customerId, condition, prefill, options, onClose, onSaved, onViewExisting, onOpenAllergies }) {
  const [form, setForm] = useState(() => (condition ? fromCondition(condition) : { ...EMPTY, ...(prefill || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [duplicate, setDuplicate] = useState(null);
  const [hints, setHints] = useState([]);
  const [encounters, setEncounters] = useState([]);
  const [readings, setReadings] = useState([]);
  const hintTimer = useRef(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const pick = (name) => options?.[name] || [];
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');
  const problems = formProblems(form);
  const untrue = ['refuted', 'entered_in_error'].includes(form.verificationStatus);
  const abated = ['inactive', 'remission', 'resolved'].includes(form.clinicalStatus);

  // What this patient has on record to link to — consultations and readings.
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/problems/encounters`).then((r) => (r.ok ? r.json() : { encounters: [] }))
      .then((j) => { if (live) setEncounters(j.encounters || []); }).catch(() => {});
    fetch(`/api/customers/${customerId}/vitals?limit=10`).then((r) => (r.ok ? r.json() : { readings: [] }))
      .then((j) => { if (live) setReadings(j.readings || []); }).catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  // Hints for the name as typed — informative only.
  useEffect(() => {
    clearTimeout(hintTimer.current);
    const name = form.conditionName.trim();
    if (name.length < 3 || form.code) { setHints([]); return undefined; }
    hintTimer.current = setTimeout(() => {
      fetch(`/api/customers/${customerId}/problems/hints?name=${encodeURIComponent(name)}`)
        .then((r) => (r.ok ? r.json() : { hints: [] }))
        .then((j) => setHints(j.hints || []))
        .catch(() => setHints([]));
    }, 300);
    return () => clearTimeout(hintTimer.current);
  }, [customerId, form.conditionName, form.code]);

  async function save(allowDuplicate = false) {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      conditionName: form.conditionName,
      codeSystem: form.code ? (form.codeSystem || 'icd10') : null,
      code: form.code || null,
      localCode: form.localCode || null,
      category: form.category,
      clinicalStatus: form.clinicalStatus,
      verificationStatus: form.verificationStatus,
      severity: form.severity || null,
      bodySite: form.bodySite || null,
      onset: form.onset,
      onsetNote: form.onsetNote || null,
      abatement: abated ? form.abatement : '',
      source: form.source,
      assertedByName: form.assertedByName || null,
      encounterId: form.encounterId || null,
      evidenceVitalsIds: form.evidenceVitalsIds,
      notes: form.notes || null,
      statusReason: form.statusReason || null,
      ...(allowDuplicate ? { allowDuplicate: true } : {}),
    };
    try {
      const saved = condition
        ? await send(`/api/customers/${customerId}/problems/${condition.id}`, 'PATCH', body)
        : await send(`/api/customers/${customerId}/problems`, 'POST', body);
      onSaved(saved);
    } catch (err) {
      if (err.code === 'DUPLICATE_ACTIVE') setDuplicate({ message: err.message, existing: err.existing });
      else setError(err);
      setSaving(false);
    }
  }

  const toggleReading = (id) => setForm((f) => ({
    ...f,
    evidenceVitalsIds: f.evidenceVitalsIds.includes(id) ? f.evidenceVitalsIds.filter((x) => x !== id) : [...f.evidenceVitalsIds, id],
  }));

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={condition ? 'Edit condition' : 'Add condition'}>
      <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{condition ? 'Edit condition' : 'Add condition'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          <div className="ui-med-field">
            <span className="ui-vital-label">Condition</span>
            <ConditionSearch
              customerId={customerId}
              value={form.conditionName}
              wrong={wrong('conditionName')}
              onType={(v) => setForm((f) => ({ ...f, conditionName: v, codeSystem: '', code: '', localCode: '' }))}
              onPick={(r) => setForm((f) => ({
                ...f, conditionName: r.name, codeSystem: r.codeSystem, code: r.code, localCode: r.localCode || '',
                category: f.category === 'problem_list' ? r.category : f.category,
              }))}
            />
            {form.code && <span className="ui-allergy-help">ICD-10 {form.code}</span>}
            {hints.map((h) => (
              <p key={h} className="ui-cond-hint">
                <IconInfo width={13} height={13} aria-hidden="true" />
                <span>
                  {HINT_TEXT[h]}
                  {h === 'allergy' && <> <button type="button" onClick={onOpenAllergies} className="ui-cond-hint-link">Open Allergies</button></>}
                </span>
              </p>
            ))}
          </div>

          <div className="ui-med-grid">
            <label className="ui-med-field">
              <span className="ui-vital-label">Category</span>
              <select value={form.category} onChange={(e) => set('category', e.target.value)} className="ui-vital-input">
                {pick('categories').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {!untrue && (
              <label className="ui-med-field">
                <span className="ui-vital-label">Status</span>
                <select value={form.clinicalStatus} onChange={(e) => set('clinicalStatus', e.target.value)} className="ui-vital-input">
                  {pick('clinicalStatuses').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            )}
            <label className="ui-med-field">
              <span className="ui-vital-label">Verification</span>
              <select value={form.verificationStatus} onChange={(e) => set('verificationStatus', e.target.value)} className={`ui-vital-input ${wrong('verificationStatus')}`}>
                {pick('verificationStatuses').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="ui-allergy-help">How sure is this? Only a pharmacist confirms.</span>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Severity</span>
              <select value={form.severity} onChange={(e) => set('severity', e.target.value)} className="ui-vital-input">
                <option value="">Not recorded</option>
                {pick('severities').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {untrue && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">Why?</span>
              <input value={form.statusReason} onChange={(e) => set('statusReason', e.target.value)} className={`ui-vital-input ${wrong('statusReason')}`} />
            </label>
          )}

          <div className="ui-med-grid mt-3">
            <PartialDateInput label="Onset" value={form.onset} onChange={(v) => set('onset', v)} wrong={wrong('onset')} />
            <label className="ui-med-field">
              <span className="ui-vital-label">Onset note (optional)</span>
              <input value={form.onsetNote} onChange={(e) => set('onsetNote', e.target.value)} placeholder="Since childhood" className="ui-vital-input" />
            </label>
            {abated && (
              <PartialDateInput label="Resolved / remission" value={form.abatement} onChange={(v) => set('abatement', v)} wrong={wrong('abatement')} />
            )}
            <label className="ui-med-field">
              <span className="ui-vital-label">Body site (optional)</span>
              <input value={form.bodySite} onChange={(e) => set('bodySite', e.target.value)} placeholder="Left knee" className="ui-vital-input" />
            </label>
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Source</span>
              <select value={form.source} onChange={(e) => set('source', e.target.value)} className="ui-vital-input">
                {pick('sources').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Diagnosed by (optional)</span>
              <input value={form.assertedByName} onChange={(e) => set('assertedByName', e.target.value)} placeholder="Dr Okafor, LUTH" className="ui-vital-input" />
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
          </div>

          {readings.length > 0 && (
            <fieldset className="ui-med-field mt-3">
              <legend className="ui-vital-label">Supporting readings (optional)</legend>
              <div className="ui-cond-readings">
                {readings.map((r) => (
                  <label key={r.id} className="ui-cond-reading">
                    <input type="checkbox" checked={form.evidenceVitalsIds.includes(r.id)} onChange={() => toggleReading(r.id)} />
                    <span>
                      {dayLabel(r.recordedAt)}
                      {r.systolic && r.diastolic ? ` · BP ${r.systolic}/${r.diastolic}` : ''}
                      {r.pulse ? ` · pulse ${r.pulse}` : ''}
                      {r.temperature ? ` · ${r.temperature} °C` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)}
              placeholder="Patient reports diagnosis made at a hospital in 2022. Currently taking amlodipine." className="ui-mrev-text" />
          </label>

          {problems.length > 0 && form.conditionName && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : condition ? 'Save changes' : 'Add condition'}
          </button>
        </footer>
      </form>

      {duplicate && (
        <div className="ui-allergy-dialog-scrim" role="dialog" aria-modal="true" aria-label="Already recorded">
          <div className="ui-allergy-dialog">
            <h3>Already recorded</h3>
            <p>{duplicate.message}</p>
            <div className="ui-allergy-dialog-buttons">
              <button type="button" onClick={() => setDuplicate(null)} className="ui-mrev-btn">Cancel</button>
              {duplicate.existing?.id && (
                <button type="button" onClick={() => onViewExisting(duplicate.existing.id)} className="ui-mrev-btn">View existing</button>
              )}
              <button type="button" onClick={() => { setDuplicate(null); save(true); }} className="ui-mrev-btn is-primary">Continue anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
