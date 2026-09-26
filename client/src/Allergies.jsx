/**
 * The patient record's Allergies section.
 *
 * WHAT IT MUST ANSWER IN SECONDS: does this patient react to anything, to
 * what, how did it show, how bad, how risky next time, and how sure is
 * anyone. The state line answers the first; the table answers the rest
 * without a click; a row opens in place for everything else.
 *
 * THREE STATES, NEVER TWO. "Not assessed" is what an empty record says —
 * never "None". "No known allergies" appears only after a pharmacist has
 * said so, with their name and the date beside it.
 *
 * NOTHING IS DELETED. Resolve, inactive, refuted and entered-in-error are
 * status changes; the record moves to History and stays readable, with the
 * reason it moved.
 *
 * NOTHING HERE IS A CLINICAL JUDGEMENT the software made. No interaction
 * check, no cross-sensitivity, no suggested criticality. The pharmacist
 * records; the screen shows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Loading from './Loading.jsx';
import PartialDateInput from './PartialDateInput.jsx';
import { IconAlertTriangle, IconCheckCircle, IconInfo, IconChevronDown } from './Icons.jsx';
import {
  ALLERGY_STATE, stateLabel, CRITICALITY_TONE, VERIFICATION_TONE, labelFor, partialDateLabel,
  partialDateInput, reactionsLine, kindLine, historyStatus, byLine, formProblems,
} from './allergyFormat.js';

const STATE_ICON = { alert: IconAlertTriangle, check: IconCheckCircle, unknown: IconInfo };

/** Nothing recorded — quiet, and never mistaken for an answer. */
const Blank = () => <span className="ui-ptable-blank" aria-label="not recorded">–</span>;

function Chip({ tone, children }) {
  return <span className={`ui-med-status ${tone || 'ui-tone-quiet'}`}>{children}</span>;
}

async function send(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(json.error || 'Could not save. Try again.'), { field: json.field, status: r.status });
  }
  return json;
}

export default function Allergies({ customerId, onChanged }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);          // null | 'new' | an allergy
  const [openId, setOpenId] = useState(null);
  const [action, setAction] = useState(null);      // { allergy, kind }
  const [assessing, setAssessing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/allergies`);
      if (!r.ok) throw new Error('Could not load this patient\'s allergies.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/allergies/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const changed = async () => { await load(); onChanged?.(); };

  // An error with nothing to show is a screen of its own, with a way out.
  if (error && !data) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head"><h2>Allergies</h2></header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">Allergies could not be loaded</p>
          <p>{error} This does not mean the patient has no allergies.</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Allergies</h2>
        <button type="button" onClick={() => setForm('new')} className="ui-meds-add">+ Add allergy</button>
      </header>

      <div className="ui-allergy-body">
        <StateLine
          data={data}
          onAssess={() => setAssessing(true)}
          onAdd={() => setForm('new')}
          onWithdraw={async () => {
            try {
              await send(`/api/customers/${customerId}/allergies/status`, 'PUT', { assert: 'clear' });
              await changed();
            } catch (e) { setError(e.message); }
          }}
        />
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        {data.allergies.length > 0 && (
          <section aria-labelledby="allergy-active">
            <h3 id="allergy-active" className="ui-allergy-heading">Active</h3>
            <AllergyTable
              allergies={data.allergies}
              options={options}
              openId={openId}
              onToggle={(id) => setOpenId((o) => (o === id ? null : id))}
              onEdit={setForm}
              onAction={(allergy, kind) => setAction({ allergy, kind })}
            />
          </section>
        )}

        {data.history.length > 0 && (
          <details className="ui-allergy-history">
            <summary>
              <IconChevronDown width={13} height={13} aria-hidden="true" className="ui-med-caret" />
              History
              <span className="ui-pcount">{data.history.length}</span>
              <span className="ui-allergy-history-note">resolved, inactive, refuted, entered in error</span>
            </summary>
            <AllergyTable
              allergies={data.history}
              options={options}
              history
              openId={openId}
              onToggle={(id) => setOpenId((o) => (o === id ? null : id))}
              onEdit={setForm}
              onAction={(allergy, kind) => setAction({ allergy, kind })}
            />
          </details>
        )}
      </div>

      {form && (
        <AllergyForm
          customerId={customerId}
          allergy={form === 'new' ? null : form}
          options={options}
          onClose={() => setForm(null)}
          onSaved={async (saved) => { setForm(null); setOpenId(saved?.id || null); await changed(); }}
        />
      )}

      {action && (
        <StatusDialog
          customerId={customerId}
          allergy={action.allergy}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={async () => { setAction(null); await changed(); }}
        />
      )}

      {assessing && (
        <AssessDialog
          customerId={customerId}
          onClose={() => setAssessing(false)}
          onAdd={() => { setAssessing(false); setForm('new'); }}
          onDone={async () => { setAssessing(false); await changed(); }}
        />
      )}
    </section>
  );
}

/** The answer, first: known / no known / not assessed. */
function StateLine({ data, onAssess, onAdd, onWithdraw }) {
  const s = ALLERGY_STATE[data.state] || ALLERGY_STATE.not_assessed;
  const Icon = STATE_ICON[s.icon];
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

  let sub = null;
  let act = null;
  if (data.state === 'known') {
    const high = data.allergies.filter((a) => a.criticality === 'high').length;
    sub = high ? `${high} marked high criticality` : null;
  } else if (data.state === 'none_known') {
    // Who said so and when — the whole point of storing the assertion.
    sub = [
      'Recorded',
      data.nka?.by?.email ? `by ${data.nka.by.email}` : null,
      data.nka?.at ? `on ${when(data.nka.at)}` : null,
    ].filter(Boolean).join(' ');
    act = (
      <span className="ui-allergy-state-actions">
        <button type="button" onClick={onAdd} className="ui-mrev-btn">Record an allergy</button>
        <button type="button" onClick={onWithdraw} className="ui-mrev-btn">Withdraw</button>
      </span>
    );
  } else {
    // No explanation line: the state and the button say it (the owner asked
    // for clean tabs, 2026-09-21).
    act = <button type="button" onClick={onAssess} className="ui-mrev-btn is-primary">Assess allergy status</button>;
  }

  return (
    <div className={`ui-allergy-state ${s.tone}`} role="status">
      <Icon width={18} height={18} aria-hidden="true" className="ui-allergy-state-icon" />
      <div className="min-w-0 flex-1">
        <p className="ui-allergy-state-label">{stateLabel(data.state, data.allergies.length)}</p>
        {sub && <p className="ui-allergy-state-sub">{sub}</p>}
      </div>
      {act}
    </div>
  );
}

function AllergyTable({ allergies, options, history = false, openId, onToggle, onEdit, onAction }) {
  return (
    <div className="ui-med-tablewrap">
      <table className="ui-med-table ui-allergy-table">
        <colgroup>
          <col style={{ width: '210px' }} />
          <col style={{ width: '240px' }} />
          <col style={{ width: '100px' }} />
          <col style={{ width: '110px' }} />
          <col style={{ width: '120px' }} />
          <col style={{ width: '100px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Allergen</th>
            <th scope="col">Reaction</th>
            <th scope="col">Severity</th>
            <th scope="col">Criticality</th>
            <th scope="col">{history ? 'Status' : 'Verification'}</th>
            <th scope="col">Last reaction</th>
          </tr>
        </thead>
        <tbody>
          {allergies.map((a, i) => (
            <AllergyRow
              key={a.id}
              a={a}
              index={i}
              options={options}
              history={history}
              open={openId === a.id}
              onToggle={() => onToggle(a.id)}
              onEdit={onEdit}
              onAction={onAction}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllergyRow({ a, index, options, history, open, onToggle, onEdit, onAction }) {
  const reactions = reactionsLine(a.reactions, options?.manifestations);
  return (
    <>
      <tr className={`ui-med-row ${history ? 'is-history' : ''}`} style={{ '--row-i': index }}>
        <td>
          <button type="button" onClick={onToggle} aria-expanded={open} className="ui-med-name">
            <IconChevronDown width={13} height={13} aria-hidden="true" className={`ui-med-caret ${open ? 'is-open' : ''}`} />
            <span>
              <span className="ui-med-title">{a.allergenName}</span>
              {kindLine(a, options) && <span className="ui-med-sub">{kindLine(a, options)}</span>}
            </span>
          </button>
        </td>
        {/* The reaction is read right after the allergen — it is the second
            thing a pharmacist needs, so it is the second column. */}
        <td className="ui-med-dosing">{reactions || <Blank />}</td>
        <td className="ui-med-quiet">{labelFor(options?.severities, a.severity) || <Blank />}</td>
        <td>
          {a.criticality
            ? (
              <Chip tone={CRITICALITY_TONE[a.criticality]}>
                {a.criticality === 'high' && <IconAlertTriangle width={11} height={11} aria-hidden="true" className="mr-1 inline" />}
                {labelFor(options?.criticalities, a.criticality)}
              </Chip>
            )
            : <Blank />}
        </td>
        <td>
          {history
            ? <Chip tone="ui-tone-quiet">{historyStatus(a)}</Chip>
            : <Chip tone={VERIFICATION_TONE[a.verificationStatus]}>{labelFor(options?.verificationStatuses, a.verificationStatus)}</Chip>}
        </td>
        <td className="ui-med-quiet whitespace-nowrap">{partialDateLabel(a.lastOccurrence) || <Blank />}</td>
      </tr>
      {open && (
        <tr className="ui-med-detail-row">
          <td colSpan={6}>
            <AllergyDetail a={a} options={options} history={history} onEdit={onEdit} onAction={onAction} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Everything about one allergy, and what can be done with it. */
function AllergyDetail({ a, options, history, onEdit, onAction }) {
  const untrue = ['refuted', 'entered_in_error'].includes(a.verificationStatus);
  return (
    <div className="ui-allergy-detail">
      <dl className="ui-med-detail">
        {[
          ['Allergen', a.allergenName],
          ['Category', a.category !== 'unknown' ? labelFor(options?.categories, a.category) : 'Unknown'],
          ['Classification', labelFor(options?.types, a.type)],
          ['Status', historyStatus(a)],
          ['Verification', labelFor(options?.verificationStatuses, a.verificationStatus)],
          ['Criticality', labelFor(options?.criticalities, a.criticality)],
          ['Reaction severity', labelFor(options?.severities, a.severity)],
          ['Reactions', reactionsLine(a.reactions, options?.manifestations)],
          ['Exposure', labelFor(options?.exposureRoutes, a.exposureRoute)],
          ['First identified', partialDateLabel(a.onset) || 'Unknown'],
          ['Last reaction', partialDateLabel(a.lastOccurrence) || 'Unknown'],
          ['Reported by', labelFor(options?.sources, a.source)],
          [untrue ? 'Why' : 'Status note', a.statusReason],
          ['Notes', a.notes],
        ].filter(([, v]) => v).map(([label, value]) => (
          <div key={label} className={label === 'Notes' || label === 'Why' || label === 'Status note' ? 'is-wide' : ''}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="ui-allergy-by">{byLine(a)}</p>

      <div className="ui-allergy-actions">
        <button type="button" onClick={() => onEdit(a)} className="ui-mrev-btn">Edit</button>
        {!history && (
          <>
            <button type="button" onClick={() => onAction(a, 'resolved')} className="ui-mrev-btn">Mark resolved</button>
            <button type="button" onClick={() => onAction(a, 'inactive')} className="ui-mrev-btn">Mark inactive</button>
          </>
        )}
        {history && !untrue && (
          <button type="button" onClick={() => onAction(a, 'active')} className="ui-mrev-btn">Make active again</button>
        )}
        {a.verificationStatus !== 'refuted' && (
          <button type="button" onClick={() => onAction(a, 'refuted')} className="ui-mrev-btn">Mark refuted</button>
        )}
        {a.verificationStatus !== 'entered_in_error' && (
          <button type="button" onClick={() => onAction(a, 'entered_in_error')} className="ui-mrev-btn">Mark entered in error</button>
        )}
      </div>
    </div>
  );
}

const ACTIONS = {
  resolved: {
    title: 'Mark resolved',
    body: 'The allergy no longer applies — outgrown, or cleared by a specialist. It stays in the history.',
    patch: { clinicalStatus: 'resolved' },
    reason: 'optional',
  },
  inactive: {
    title: 'Mark inactive',
    body: 'Not currently a concern. It stays in the history and can be made active again.',
    patch: { clinicalStatus: 'inactive' },
    reason: 'optional',
  },
  active: {
    title: 'Make active again',
    body: 'Return this allergy to the patient\'s current list.',
    patch: { clinicalStatus: 'active' },
    reason: 'none',
  },
  refuted: {
    title: 'Mark refuted',
    body: 'The allergy was found not to be real. The record is kept, with your reason, so the history reads honestly.',
    patch: { verificationStatus: 'refuted' },
    reason: 'required',
    pharmacist: true,
  },
  entered_in_error: {
    title: 'Mark entered in error',
    body: 'This was recorded by mistake — the wrong patient, or the wrong allergen. It is kept, not deleted.',
    patch: { verificationStatus: 'entered_in_error' },
    reason: 'required',
    pharmacist: true,
  },
};

/** One status change, with the reason it happened. */
function StatusDialog({ customerId, allergy, kind, onClose, onDone }) {
  const spec = ACTIONS[kind];
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const blocked = spec.reason === 'required' && !reason.trim();

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/allergies/${allergy.id}`, 'PATCH', {
        ...spec.patch,
        ...(spec.reason !== 'none' && reason.trim() ? { statusReason: reason.trim() } : {}),
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
        <h3>{spec.title}: {allergy.allergenName}</h3>
        <p>{spec.body}</p>
        {spec.pharmacist && <p className="ui-allergy-dialog-note">A pharmacist or owner makes this change.</p>}
        {spec.reason !== 'none' && (
          <label className="ui-med-field">
            <span className="ui-vital-label">{spec.reason === 'required' ? 'Why' : 'Why (optional)'}</span>
            <textarea
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={kind === 'refuted' ? 'Tolerated a full amoxicillin course in 2025.' : ''}
              className="ui-mrev-text"
            />
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

/**
 * Establishing allergy status for the first time. Two answers, and "no known
 * allergies" asks for a deliberate confirmation — it is the claim the next
 * person relies on to decide something is safe to give.
 */
function AssessDialog({ customerId, onClose, onAdd, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function markNone() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/allergies/status`, 'PUT', { assert: 'no_known' });
      onDone();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="ui-allergy-dialog-scrim" role="dialog" aria-modal="true" aria-label="Assess allergy status">
      <div className="ui-allergy-dialog">
        <h3>Assess allergy status</h3>
        {!confirming ? (
          <>
            <p>Ask the patient whether they have ever reacted badly to a medicine, a food, or anything else.</p>
            <div className="ui-allergy-dialog-choices">
              <button type="button" onClick={onAdd} className="ui-allergy-choice">
                <IconAlertTriangle width={16} height={16} aria-hidden="true" />
                <span><strong>They have an allergy</strong><span>Record it now</span></span>
              </button>
              <button type="button" onClick={() => setConfirming(true)} className="ui-allergy-choice">
                <IconCheckCircle width={16} height={16} aria-hidden="true" />
                <span><strong>No known allergies</strong><span>The patient was asked and reports none</span></span>
              </button>
            </div>
            <div className="ui-allergy-dialog-buttons">
              <button type="button" onClick={onClose} className="ui-mrev-btn">Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p>
              Record that this patient was asked and has <strong>no known allergies</strong>? It will
              show with your name and today&rsquo;s date, and is withdrawn automatically if an
              allergy is recorded later.
            </p>
            <p className="ui-allergy-dialog-note">A pharmacist or owner makes this change.</p>
            {error && <p role="alert" className="ui-vital-error">{error}</p>}
            <div className="ui-allergy-dialog-buttons">
              <button type="button" onClick={() => setConfirming(false)} className="ui-mrev-btn">Back</button>
              <button type="button" onClick={markNone} disabled={busy} className="ui-mrev-btn is-primary">
                {busy ? 'Saving…' : 'Confirm no known allergies'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The allergen box: free text always, with suggestions from the register. */
function AllergenSearch({ customerId, value, onPick, onType, wrong }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q) => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      fetch(`/api/customers/${customerId}/allergies/allergens?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { allergens: [] }))
        .then((j) => { setResults(j.allergens || []); setOpen(true); })
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
        placeholder="Penicillin, peanuts, latex…"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        className={`ui-vital-input ${wrong}`}
      />
      {open && results.length > 0 && (
        <ul className="ui-allergy-suggestions" role="listbox">
          {results.map((r) => (
            <li key={r.code} role="option" aria-selected="false">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(r); setOpen(false); }}>
                <span>{r.label}</span>
                <span className="ui-allergy-suggestion-kind">{r.drugClass ? 'Drug class' : r.category === 'medication' ? 'Medicine' : r.category}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Add or edit, in the record panel the rest of the record uses. */
function AllergyForm({ customerId, allergy, options, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const other = (allergy?.reactions || []).find((r) => r.manifestation === 'other');
    return allergy
      ? {
        allergenName: allergy.allergenName,
        allergenCode: allergy.allergenCode || '',
        category: allergy.category,
        type: allergy.type,
        reactions: [...new Set((allergy.reactions || []).map((r) => r.manifestation))],
        otherReaction: other?.description || '',
        severity: allergy.severity || '',
        criticality: allergy.criticality || '',
        verificationStatus: allergy.verificationStatus,
        clinicalStatus: allergy.clinicalStatus,
        statusReason: allergy.statusReason || '',
        exposureRoute: allergy.exposureRoute || '',
        onset: partialDateInput(allergy.onset),
        lastOccurrence: partialDateInput(allergy.lastOccurrence),
        source: allergy.source,
        notes: allergy.notes || '',
      }
      // Honest defaults: nothing about the danger is assumed, and nobody has
      // checked it yet.
      : {
        allergenName: '', allergenCode: '', category: 'unknown', type: 'unknown', reactions: [],
        otherReaction: '', severity: '', criticality: '', verificationStatus: 'unconfirmed',
        clinicalStatus: 'active', statusReason: '', exposureRoute: '', onset: '', lastOccurrence: '',
        source: 'patient', notes: '',
      };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const pick = (name) => options?.[name] || [];
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');
  const problems = formProblems(form);
  const untrue = ['refuted', 'entered_in_error'].includes(form.verificationStatus);

  // From the latest state, not this render's: two quick taps must both land.
  const toggleReaction = (code) => setForm((f) => ({
    ...f,
    reactions: f.reactions.includes(code) ? f.reactions.filter((c) => c !== code) : [...f.reactions, code],
  }));

  async function save(e) {
    e.preventDefault();
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      allergenName: form.allergenName,
      allergenCode: form.allergenCode || null,
      category: form.category,
      type: form.type,
      reactions: form.reactions.map((m) => (m === 'other'
        ? { manifestation: 'other', description: form.otherReaction }
        : { manifestation: m })),
      severity: form.severity || null,
      criticality: form.criticality || null,
      verificationStatus: form.verificationStatus,
      clinicalStatus: form.clinicalStatus,
      statusReason: form.statusReason || null,
      exposureRoute: form.exposureRoute || null,
      onset: form.onset,
      lastOccurrence: form.lastOccurrence,
      source: form.source,
      notes: form.notes || null,
    };
    try {
      const saved = allergy
        ? await send(`/api/customers/${customerId}/allergies/${allergy.id}`, 'PATCH', body)
        : await send(`/api/customers/${customerId}/allergies`, 'POST', body);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={allergy ? 'Edit allergy' : 'Add allergy'}>
      <form onSubmit={save} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{allergy ? 'Edit allergy' : 'Add allergy'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          <div className="ui-med-field">
            <span className="ui-vital-label">Allergen</span>
            <AllergenSearch
              customerId={customerId}
              value={form.allergenName}
              wrong={wrong('allergenName')}
              onType={(v) => setForm((f) => ({ ...f, allergenName: v, allergenCode: '' }))}
              onPick={(r) => setForm((f) => ({
                ...f,
                allergenName: r.label.replace(/ \(drug class\)$/, ''),
                allergenCode: r.code,
                category: f.category === 'unknown' ? r.category : f.category,
              }))}
            />
          </div>

          <div className="ui-med-grid">
            <label className="ui-med-field">
              <span className="ui-vital-label">Category</span>
              <select value={form.category} onChange={(e) => set('category', e.target.value)} className="ui-vital-input">
                {pick('categories').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <div className="ui-med-field">
              <span className="ui-vital-label">Allergy or intolerance?</span>
              <div className="ui-mrev-choices" role="radiogroup" aria-label="Allergy or intolerance">
                {pick('types').map((o) => (
                  <button key={o.value} type="button" role="radio" aria-checked={form.type === o.value}
                    onClick={() => set('type', o.value)} className={`ui-mrev-choice ${form.type === o.value ? 'is-on' : ''}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="ui-med-field mt-3">
            <span className="ui-vital-label">Reactions — choose all that apply</span>
            <div className="ui-allergy-reactions" role="group" aria-label="Reactions">
              {pick('manifestations').map((o) => (
                <button key={o.value} type="button" aria-pressed={form.reactions.includes(o.value)}
                  onClick={() => toggleReaction(o.value)}
                  className={`ui-mrev-choice ${form.reactions.includes(o.value) ? 'is-on' : ''} ${o.value === 'anaphylaxis' ? 'is-serious' : ''}`}>
                  {o.label}
                </button>
              ))}
            </div>
            {form.reactions.includes('other') && (
              <input value={form.otherReaction} onChange={(e) => set('otherReaction', e.target.value)}
                placeholder="What was the other reaction?" aria-label="Other reaction"
                className={`ui-vital-input mt-2 ${wrong('otherReaction')}`} />
            )}
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Reaction severity</span>
              <select value={form.severity} onChange={(e) => set('severity', e.target.value)} className="ui-vital-input">
                <option value="">Not recorded</option>
                {pick('severities').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="ui-allergy-help">How bad the reaction that happened was.</span>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Criticality</span>
              <select value={form.criticality} onChange={(e) => set('criticality', e.target.value)} className="ui-vital-input">
                <option value="">Not recorded</option>
                {pick('criticalities').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="ui-allergy-help">How clinically significant could future exposure be?</span>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Verification</span>
              <select value={form.verificationStatus} onChange={(e) => set('verificationStatus', e.target.value)} className={`ui-vital-input ${wrong('verificationStatus')}`}>
                {pick('verificationStatuses').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {allergy && !untrue && (
              <label className="ui-med-field">
                <span className="ui-vital-label">Status</span>
                <select value={form.clinicalStatus} onChange={(e) => set('clinicalStatus', e.target.value)} className="ui-vital-input">
                  {pick('clinicalStatuses').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            )}
          </div>

          {(untrue || (allergy && form.clinicalStatus !== 'active')) && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">{untrue ? 'Why?' : 'Why? (optional)'}</span>
              <input value={form.statusReason} onChange={(e) => set('statusReason', e.target.value)}
                placeholder={form.verificationStatus === 'refuted' ? 'Tolerated a full amoxicillin course in 2025.' : ''}
                className={`ui-vital-input ${wrong('statusReason')}`} />
            </label>
          )}

          <div className="ui-med-grid mt-3">
            <PartialDateInput label="First identified" value={form.onset} onChange={(v) => set('onset', v)} wrong={wrong('onset')} />
            <PartialDateInput label="Last reaction" value={form.lastOccurrence} onChange={(v) => set('lastOccurrence', v)} wrong={wrong('lastOccurrence')} />
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Reported by</span>
              <select value={form.source} onChange={(e) => set('source', e.target.value)} className="ui-vital-input">
                {pick('sources').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Exposure</span>
              <select value={form.exposureRoute} onChange={(e) => set('exposureRoute', e.target.value)} className="ui-vital-input">
                <option value="">Not recorded</option>
                {pick('exposureRoutes').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Clinical notes</span>
            <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)}
              placeholder="Generalised rash after the first dose of amoxicillin in 2023. No breathing difficulty."
              className="ui-mrev-text" />
          </label>

          {problems.length > 0 && form.allergenName && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : allergy ? 'Save changes' : 'Add allergy'}
          </button>
        </footer>
      </form>
    </div>
  );
}
