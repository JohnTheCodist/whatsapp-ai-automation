/**
 * The patient record's Follow-up section — what needs to happen next.
 *
 * A CLINICAL ACTION QUEUE, not a reminder app (§30): overdue first, then due
 * today, then upcoming, each row saying what it is for, who has it and where
 * it came from. No calendar, no cards, no charts.
 *
 * IT IS THE PATIENT'S WHOLE QUEUE. A care-programme activity is a follow-up
 * too (0062 put both in one table), so it appears here saying which programme
 * it came from. There is no second task list.
 *
 * NOTHING IS CREATED AUTOMATICALLY (§27). A pharmacist says what needs to
 * happen; this keeps track of it. No reading, result or consultation raises a
 * follow-up on its own.
 *
 * NOTHING CLINICAL IS RECORDED HERE (§12). Completing "repeat blood pressure"
 * POINTS AT the reading in Vitals; the number lives there, once.
 *
 * OVERDUE IS AMBER, NEVER RED — design.md reserves red for a person waiting,
 * and the row says "4 days overdue" in words beside the colour.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { IconInfo } from './Icons.jsx';
import {
  BUCKET_TONE, EMPTY_TEXT,
  dueLabel, contextLine, resultLine, outcomeLine, movedLine, grouped, headline,
  labelFor, dayLabel, formProblems, completionProblems, cancelProblems, lagosToday,
  stampLabel, timelineSentence, hasAnyReading,
} from './followupFormat.js';

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

export default function Followups({ customerId, onOpenTab }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState(null);       // null | { followup? }
  const today = lagosToday();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/followups`);
      if (!r.ok) throw new Error('Could not load this patient\'s follow-ups.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/followups/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const changed = async () => { await load(); };

  if (error && !data) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head"><h2>Follow-up</h2></header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">Follow-ups could not be loaded</p>
          <p>{error}</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const shown = filter ? data.followups.filter((f) => f.bucket === filter) : data.followups;
  const groups = grouped(shown);
  const next = data.followups.find((f) => ['overdue', 'today', 'upcoming'].includes(f.bucket)) || null;
  const head = headline(data.counts, next, today);
  const filters = options?.filters || [];

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Follow-up</h2>
        <button type="button" onClick={() => setForm({})} className="ui-meds-add">+ Create follow-up</button>
      </header>

      <div className="ui-allergy-body">
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        {data.counts.all === 0 ? (
          <div className="ui-meds-empty">
            <p className="ui-meds-empty-title">{EMPTY_TEXT.none}</p>
            <p>{EMPTY_TEXT.noneHelp}</p>
            <button type="button" onClick={() => setForm({})} className="ui-meds-add">+ Create follow-up</button>
          </div>
        ) : (
          <>
            {/* What a pharmacist reads first: what is late, what is due, and
                the next thing to do. */}
            <div className="ui-followup-head">
              <p className="ui-followup-counts">
                {head.parts.length === 0
                  ? <span className="ui-cprog-quiet">{head.line}</span>
                  : head.parts.map((p) => <span key={p.id} className={p.tone || ''}>{p.text}</span>)}
              </p>
              {head.next && (
                <p className="ui-followup-next">
                  Next: {head.next.title} — {head.next.due}
                </p>
              )}
              {data.counts.urgent > 0 && (
                <p className="ui-cprog-banner">
                  <IconInfo width={14} height={14} aria-hidden="true" />
                  {data.counts.urgent} marked urgent
                </p>
              )}
            </div>

            <div className="ui-meds-filters" role="group" aria-label="Filter follow-ups">
              {filters.map((f) => (
                <button key={f.value || 'all'} type="button" aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)} className={`ui-quick-filter ${filter === f.value ? 'is-on' : ''}`}>
                  {f.label}
                  {data.counts[f.count] > 0 && <span className="ui-cprog-pill">{data.counts[f.count]}</span>}
                </button>
              ))}
            </div>

            {groups.length === 0
              ? <p className="ui-meds-count">{EMPTY_TEXT.filtered}</p>
              : groups.map((group) => (
                <section key={group.id} aria-labelledby={`fu-${group.id}`}>
                  <h3 id={`fu-${group.id}`} className="ui-allergy-heading">{group.label}</h3>
                  <ul className="ui-followup-list">
                    {group.items.map((f) => (
                      <FollowupRow
                        key={f.id}
                        followup={f}
                        options={options}
                        today={today}
                        open={openId === f.id}
                        onToggle={() => setOpenId(openId === f.id ? null : f.id)}
                        customerId={customerId}
                        onChanged={changed}
                        onEdit={() => setForm({ followup: f })}
                        onOpenTab={onOpenTab}
                      />
                    ))}
                  </ul>
                </section>
              ))}
          </>
        )}
      </div>

      {form && (
        <FollowupForm
          customerId={customerId}
          followup={form.followup || null}
          options={options}
          today={today}
          onClose={() => setForm(null)}
          onSaved={async (saved) => { setForm(null); setOpenId(saved?.id || null); await changed(); }}
        />
      )}
    </section>
  );
}

function FollowupRow({ followup, options, today, open, onToggle, customerId, onChanged, onEdit, onOpenTab }) {
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(null);  // 'complete' | 'reschedule' | 'cancel'
  const [error, setError] = useState(null);
  // WHAT RAISED IT AND WHAT IT PRODUCED ARE READ WHEN THE ROW IS OPENED.
  // The list does not resolve them — it would be two queries per row for
  // something most rows never show — and rendering the detail from the list
  // would print "no longer on the record" about a record that is perfectly
  // fine. So the detail asks for the full follow-up, and shows what it gets.
  const [full, setFull] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setFull(null);
    fetch(`/api/customers/${customerId}/followups/${followup.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setFull(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [open, customerId, followup.id, followup.updatedAt]);
  const f = followup;
  const late = f.bucket === 'overdue';

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/followups/${f.id}/reopen`, 'POST');
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const finished = ['completed', 'skipped', 'cancelled'].includes(f.status);

  return (
    <li className={`ui-followup ${late ? 'is-late' : ''} ${finished ? 'is-done' : ''}`}>
      <div className="ui-followup-main">
        <button type="button" onClick={onToggle} aria-expanded={open} className="ui-followup-title">
          <span>
            {f.title}
            {f.priority === 'urgent' && !finished && <span className="ui-followup-urgent">Urgent</span>}
          </span>
          <span className={`ui-followup-due ${BUCKET_TONE[f.bucket] || ''}`}>{dueLabel(f, today)}</span>
        </button>
        <p className="ui-followup-context">{contextLine(f, options) || <Blank />}</p>
        {error && <p role="alert" className="ui-vital-error">{error}</p>}
      </div>

      <div className="ui-cprog-rowactions">
        {!finished && (
          <>
            <button type="button" onClick={() => setAction('complete')} className="ui-mrev-btn is-primary">Complete</button>
            <button type="button" onClick={() => setAction('reschedule')} className="ui-mrev-btn">Reschedule</button>
          </>
        )}
        {finished && (
          <button type="button" disabled={busy} onClick={reopen} className="ui-mrev-btn">Reopen</button>
        )}
      </div>

      {open && (
        <div className="ui-followup-detail">
          {!full && <p className="ui-meds-count"><Loading /></p>}
          {full && (
          <dl className="ui-med-detail">
            {[
              ['Status', labelFor(options?.statuses, full.status)],
              ['Type', labelFor(options?.types, f.kind)],
              ['Priority', labelFor(options?.priorities, f.priority)],
              ['Due', dueLabel(f, today)],
              ['Assigned to', f.assignedToName || f.assignedToEmail],
              ['Why', f.reason],
              ['Raised by', full.source ? [labelFor(options?.sourceTypes, full.sourceType), full.source.label].filter(Boolean).join(' — ') : labelFor(options?.sourceTypes, full.sourceType)],
              ['Care programme', f.programName],
              ['Repeats', f.recurrence ? `every ${f.recurrence.every === 1 ? '' : `${f.recurrence.every} `}${f.recurrence.unit}${f.recurrence.every === 1 ? '' : 's'}` : null],
              ['Moved', movedLine(f)],
              ['Completed', f.completedAt ? dayLabel(f.completedAt) : null],
              ['Outcome', outcomeLine(full, options)],
              ['Result', resultLine(full, options)],
              ['Cancelled', f.cancelledAt ? dayLabel(f.cancelledAt) : null],
              ['Reason', f.statusReason],
              ['Notes', f.notes],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className={k === 'Notes' ? 'whitespace-pre-line' : ''}>{v}</dd>
              </div>
            ))}
          </dl>
          )}
          <FollowupHistory customerId={customerId} followup={f} options={options} />

          <div className="ui-cprog-rowactions">
            <button type="button" onClick={onEdit} className="ui-mrev-btn">Edit</button>
            {f.programId && (
              <button type="button" onClick={() => onOpenTab?.('care')} className="ui-mrev-btn">Open care programme</button>
            )}
            {!finished && (
              <button type="button" onClick={() => setAction('cancel')} className="ui-mrev-btn">Cancel follow-up</button>
            )}
          </div>
        </div>
      )}

      {action === 'complete' && (
        <CompletionPanel
          customerId={customerId} followup={f} options={options} today={today}
          onClose={() => setAction(null)}
          onDone={async () => { setAction(null); await onChanged(); }}
        />
      )}
      {action === 'reschedule' && (
        <ReschedulePanel
          customerId={customerId} followup={f} today={today}
          onClose={() => setAction(null)}
          onDone={async () => { setAction(null); await onChanged(); }}
        />
      )}
      {action === 'cancel' && (
        <CancelPanel
          customerId={customerId} followup={f} options={options}
          onClose={() => setAction(null)}
          onDone={async () => { setAction(null); await onChanged(); }}
        />
      )}
    </li>
  );
}

/**
 * What happened to THIS follow-up (§18, §29).
 *
 * Not the patient's history, and not the other follow-ups' — the queue's
 * Completed and Cancelled groups already answer that. This answers what the
 * groups cannot: when it was raised, every time it moved, and who did it.
 */
function FollowupHistory({ customerId, followup, options }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/followups/${followup.id}/timeline`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setData(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId, followup.id, followup.updatedAt]);

  if (!data || data.events.length === 0) return null;
  return (
    <div className="ui-followup-history">
      <h4 className="ui-allergy-heading">History</h4>
      <ol className="ui-cprog-timeline">
        {data.events.map((e) => {
          const said = timelineSentence(e, options);
          return (
            <li key={e.id}>
              <span className="ui-cprog-stamp">{stampLabel(e.occurredAt)}</span>
              <span className="ui-cprog-said">
                <span className="ui-cprog-said-text">{said.text}</span>
                {said.detail && <span className="ui-med-sub">{said.detail}</span>}
                {e.actor && <span className="ui-med-sub">{e.actor}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

const EMPTY_FORM = {
  title: '', kind: 'follow_up', priority: 'routine', reason: '', dueOn: '', dueTime: '',
  assignedToName: '', notes: '', sourceType: '', sourceId: '',
  repeats: false, every: 1, unit: 'month',
};

function FollowupForm({ customerId, followup, options, today, onClose, onSaved }) {
  const [form, setForm] = useState(() => (followup ? {
    title: followup.title || '',
    kind: followup.kind || 'follow_up',
    priority: followup.priority || 'routine',
    reason: followup.reason || '',
    dueOn: followup.dueOn || '',
    dueTime: followup.dueTime || '',
    assignedToName: followup.assignedToName || '',
    notes: followup.notes || '',
    sourceType: followup.sourceType || '',
    sourceId: followup.sourceId || '',
    repeats: Boolean(followup.recurrence),
    every: followup.recurrence?.every || 1,
    unit: followup.recurrence?.unit || 'month',
  } : { ...EMPTY_FORM, dueOn: today }));
  const [sources, setSources] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // What this patient already has to point at. Read-only, and this patient's
  // own — the server checks the id again before storing it.
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/followups/sources`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setSources(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = formProblems(form);
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  const sourceList = {
    consultation: sources?.consultations,
    medication_review: sources?.medicationReviews,
    care_program: sources?.carePrograms,
    test: sources?.tests,
    vitals: sources?.vitals,
    condition: sources?.conditions,
  }[form.sourceType] || null;

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      title: form.title,
      kind: form.kind,
      priority: form.priority,
      reason: form.reason || null,
      dueOn: form.dueOn || null,
      dueTime: form.dueTime || null,
      assignedToName: form.assignedToName || null,
      notes: form.notes || null,
      sourceType: form.sourceType || null,
      sourceId: form.sourceId || null,
      recurrence: form.repeats ? { every: Number(form.every), unit: form.unit } : null,
    };
    try {
      const saved = followup
        ? await send(`/api/customers/${customerId}/followups/${followup.id}`, 'PATCH', body)
        : await send(`/api/customers/${customerId}/followups`, 'POST', body);
      onSaved(saved);
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={followup ? 'Edit follow-up' : 'Create follow-up'}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{followup ? 'Edit follow-up' : 'Create follow-up'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}

          <label className="ui-med-field">
            <span className="ui-vital-label">What needs to happen</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)}
              className={`ui-vital-input ${wrong('title')}`} maxLength={200} placeholder="Repeat blood pressure" />
          </label>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Type</span>
              <select value={form.kind} onChange={(e) => set('kind', e.target.value)} className="ui-vital-input">
                {(options?.types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Priority</span>
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)} className="ui-vital-input">
                {(options?.priorities || []).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why</span>
            <textarea value={form.reason} onChange={(e) => set('reason', e.target.value)}
              className="ui-mrev-text" rows={2} maxLength={500}
              placeholder="BP was elevated during the consultation." />
          </label>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Due date</span>
              <input type="date" value={form.dueOn} onChange={(e) => set('dueOn', e.target.value)}
                className={`ui-vital-input ${wrong('dueOn')}`} />
              {/* A follow-up with no date is allowed: "review the result when
                  it arrives" is real, and a made-up date is worse. */}
              <span className="ui-allergy-help">Leave blank if the date is not known yet</span>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Time (optional)</span>
              <input type="time" value={form.dueTime} onChange={(e) => set('dueTime', e.target.value)}
                className={`ui-vital-input ${wrong('dueTime')}`} />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Assigned to</span>
              <input value={form.assignedToName} onChange={(e) => set('assignedToName', e.target.value)}
                className="ui-vital-input" maxLength={200} placeholder="Pharm. John" />
            </label>
          </div>

          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">What raised this (optional)</legend>
            <span className="ui-allergy-help">
              The follow-up points at the record. Nothing is copied out of it.
            </span>
            <div className="ui-med-grid mt-3">
              <label className="ui-med-field">
                <span className="ui-vital-label">Kind</span>
                <select value={form.sourceType}
                  onChange={(e) => { set('sourceType', e.target.value); set('sourceId', ''); }}
                  className="ui-vital-input">
                  <option value="">Not recorded</option>
                  {(options?.sourceTypes || []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              {sourceList && (
                <label className="ui-med-field">
                  <span className="ui-vital-label">Which one</span>
                  <select value={form.sourceId} onChange={(e) => set('sourceId', e.target.value)}
                    className={`ui-vital-input ${wrong('sourceId')}`}>
                    <option value="">Not a specific one</option>
                    {sourceList.map((s) => (
                      <option key={s.id} value={s.id}>
                        {[dayLabel(s.at), s.label, s.detail].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </fieldset>

          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">Repeat</legend>
            <label className="ui-cprog-check">
              <input type="checkbox" checked={form.repeats} onChange={(e) => set('repeats', e.target.checked)} />
              <span>This follow-up repeats</span>
            </label>
            {form.repeats && (
              <>
                <div className="ui-med-grid mt-3">
                  <label className="ui-med-field">
                    <span className="ui-vital-label">Every</span>
                    <input value={form.every} onChange={(e) => set('every', e.target.value)}
                      className="ui-vital-input" inputMode="numeric" />
                  </label>
                  <label className="ui-med-field">
                    <span className="ui-vital-label">Unit</span>
                    <select value={form.unit} onChange={(e) => set('unit', e.target.value)} className="ui-vital-input">
                      {(options?.recurrenceUnits || []).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                    </select>
                  </label>
                </div>
                <span className="ui-allergy-help">
                  Completing it adds the next one — dated from when it was due, not when it was done.
                </span>
              </>
            )}
          </fieldset>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)}
              className="ui-mrev-text" rows={2} maxLength={1000} />
          </label>

          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : followup ? 'Save' : 'Create follow-up'}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completing, rescheduling, cancelling — each its own act
// ---------------------------------------------------------------------------

function CompletionPanel({ customerId, followup, options, today, onClose, onDone }) {
  const [form, setForm] = useState({
    outcome: '', outcomeNote: '', completedOn: today, linkedType: '', linkedId: '',
    // Recording the reading here writes it to VITALS and points at the row it
    // creates. Nothing clinical is stored on the follow-up either way.
    recordReading: false, reading: {},
  });
  const [records, setRecords] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = completionProblems(form);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/followups/sources`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setRecords(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const list = {
    vitals: records?.vitals,
    test: records?.tests,
    condition: records?.conditions,
    encounter: records?.consultations,
  }[form.linkedType] || null;

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/followups/${followup.id}/completion`, 'POST', {
        outcome: form.outcome,
        outcomeNote: form.outcomeNote || null,
        completedOn: form.completedOn || null,
        linkedType: form.linkedId ? form.linkedType : null,
        linkedId: form.linkedId || null,
        // The Vitals contract checks the numbers; empty boxes are dropped here
        // so an untouched field never becomes a stored zero.
        reading: form.recordReading && hasAnyReading(form.reading)
          ? Object.fromEntries(Object.entries(form.reading).filter(([, v]) => String(v ?? '').trim() !== ''))
          : null,
      });
      await onDone();
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Complete follow-up">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Complete follow-up</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
          <p className="ui-followup-subject">{followup.title}</p>

          <div className="ui-med-grid">
            <label className="ui-med-field">
              <span className="ui-vital-label">How did it go?</span>
              <select value={form.outcome} onChange={(e) => set('outcome', e.target.value)} className="ui-vital-input">
                <option value="">Choose…</option>
                {(options?.outcomes || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">When</span>
              <input type="date" value={form.completedOn} onChange={(e) => set('completedOn', e.target.value)}
                className="ui-vital-input" />
            </label>
          </div>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">What happened</span>
            <textarea value={form.outcomeNote} onChange={(e) => set('outcomeNote', e.target.value)}
              className="ui-mrev-text" rows={3} maxLength={1000}
              placeholder="BP improved from the previous reading." />
          </label>

          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">What it produced (optional)</legend>
            {/* The reading, test or consultation this follow-up led to. It
                lives in its own section; this points at it. */}
            <span className="ui-allergy-help">
              Record a reading here and it is saved to Vitals, or point at a record that already exists.
            </span>

            <label className="ui-cprog-check mt-3">
              <input
                type="checkbox"
                checked={form.recordReading}
                onChange={(e) => { set('recordReading', e.target.checked); set('linkedType', ''); set('linkedId', ''); }}
              />
              <span>Record a reading now</span>
            </label>

            {form.recordReading && (
              <>
                <div className="ui-followup-reading mt-3">
                  {(options?.vitalsFields || []).map((v) => (
                    <label key={v.key} className="ui-med-field">
                      <span className="ui-vital-label">{v.label}{v.unit ? ` (${v.unit})` : ''}</span>
                      <input
                        value={form.reading[v.key] ?? ''}
                        onChange={(e) => setForm((f) => ({ ...f, reading: { ...f.reading, [v.key]: e.target.value } }))}
                        className={`ui-vital-input ${error?.field === v.key ? 'is-wrong' : ''}`}
                        inputMode="decimal"
                        step={v.step}
                      />
                    </label>
                  ))}
                </div>
                {/* Said plainly, because it is the whole point: this is not a
                    second blood-pressure store. */}
                <span className="ui-allergy-help">
                  Saved to Vitals &amp; biometrics, like any other reading. The follow-up points at it.
                </span>
              </>
            )}
            <div className="ui-med-grid mt-3" hidden={form.recordReading}>
              <label className="ui-med-field">
                <span className="ui-vital-label">Kind</span>
                <select value={form.linkedType}
                  onChange={(e) => { set('linkedType', e.target.value); set('linkedId', ''); }}
                  className="ui-vital-input">
                  <option value="">Nothing to link</option>
                  {(options?.linkKinds || []).filter((k) => k.value !== 'medication')
                    .map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </label>
              {list && (
                <label className="ui-med-field">
                  <span className="ui-vital-label">Which one</span>
                  <select value={form.linkedId} onChange={(e) => set('linkedId', e.target.value)} className="ui-vital-input">
                    <option value="">Choose…</option>
                    {list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {[dayLabel(s.at), s.label, s.detail].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </fieldset>

          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Complete'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ReschedulePanel({ customerId, followup, today, onClose, onDone }) {
  const [form, setForm] = useState({ dueOn: '', dueTime: followup.dueTime || '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    if (!form.dueOn) return;
    setSaving(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/followups/${followup.id}/reschedule`, 'POST', {
        dueOn: form.dueOn, dueTime: form.dueTime || null, reason: form.reason || null,
      });
      await onDone();
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Reschedule follow-up">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Reschedule follow-up</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
          <p className="ui-followup-subject">{followup.title}</p>
          {/* The date it had, beside the date it is moving to — the change is
              the thing a pharmacist is deciding. */}
          <dl className="ui-med-detail">
            <div>
              <dt>Currently due</dt>
              <dd>{followup.dueOn ? dayLabel(followup.dueOn) : 'No date yet'}</dd>
            </div>
          </dl>
          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">New due date</span>
              <input type="date" min={today} value={form.dueOn} onChange={(e) => set('dueOn', e.target.value)}
                className={`ui-vital-input ${error?.field === 'dueOn' ? 'is-wrong' : ''}`} />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Time (optional)</span>
              <input type="time" value={form.dueTime} onChange={(e) => set('dueTime', e.target.value)} className="ui-vital-input" />
            </label>
          </div>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why (optional)</span>
            <input value={form.reason} onChange={(e) => set('reason', e.target.value)}
              className="ui-vital-input" maxLength={500} placeholder="Patient travelling" />
          </label>
          {followup.rescheduledCount > 0 && (
            <p className="ui-allergy-help">{movedLine(followup)} already.</p>
          )}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || !form.dueOn} className="ui-vital-save">
            {saving ? 'Saving…' : 'Reschedule'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function CancelPanel({ customerId, followup, options, onClose, onDone }) {
  const [form, setForm] = useState({ reason: '', note: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = cancelProblems(form);

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      await send(`/api/customers/${customerId}/followups/${followup.id}/cancellation`, 'POST', {
        reason: form.reason, note: form.note || null,
      });
      await onDone();
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Cancel follow-up">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Cancel follow-up</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
          <p className="ui-followup-subject">{followup.title}</p>
          <p className="ui-allergy-help">
            The follow-up stays on the record with the reason, so why it never happened is answerable later.
            Only a pharmacist can cancel one.
          </p>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why</span>
            <select value={form.reason} onChange={(e) => set('reason', e.target.value)} className="ui-vital-input">
              <option value="">Choose…</option>
              {(options?.cancelReasons || []).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Anything to add (optional)</span>
            <input value={form.note} onChange={(e) => set('note', e.target.value)}
              className="ui-vital-input" maxLength={400} />
          </label>
          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Keep it</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Cancel follow-up'}
          </button>
        </footer>
      </form>
    </div>
  );
}
