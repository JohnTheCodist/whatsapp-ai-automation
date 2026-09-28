/**
 * The patient record's Care program section — where months of care are managed.
 *
 * WHAT IT MUST ANSWER AT A GLANCE: which programmes is this person in, what is
 * each one trying to achieve, what is due, and what has already been done.
 *
 * IT ORGANISES THE OTHER SECTIONS AND DUPLICATES NONE OF THEM. A goal reads
 * its value from Vitals or Tests; a task can point at the reading, test,
 * medicine, condition or consultation it produced. Nothing clinical is entered
 * here — the sections that own those records are where they are entered.
 *
 * PROGRESS IS COUNTS. "Goals 1/3 · Tasks 8/12 · 2 overdue" and never a
 * percentage: a percentage over tasks reads as a statement about the patient.
 *
 * NOTHING IS DELETED. A programme enrolled by mistake is cancelled with a
 * reason; one that ends is completed or discontinued with an outcome, and
 * keeps every goal and task it had. A task already done cannot be deleted —
 * the row offers "cancelled", which keeps what happened.
 *
 * OVERDUE IS AMBER. design.md reserves red for a person waiting, and colour is
 * never alone: an overdue task says so in words.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { IconInfo } from './Icons.jsx';
import { ConditionsBrief } from './ClinicalContext.jsx';
import { RECORD_PICKERS } from './recordPicker.js';
import {
  PROGRAM_TONE, GOAL_TONE, TASK_TONE, PROGRAM_SECTIONS, EMPTY_TEXT,
  isOpen, labelFor, dayLabel, rangeLabel, progressParts, nextUpLine, dueLabel, isOverdue,
  taskList, recurrenceLabel, targetLabel, currentLabel, outcomeLine, responsibleLine,
  programProblems, endingProblems, taskProblems, goalProblems, lagosToday,
  monitoringValue, monitoringChange, readingCount, timelineSentence, stampLabel,
} from './carePlanFormat.js';

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

export default function CarePrograms({ customerId, onChanged, onOpenTab }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const today = lagosToday();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/care-programs`);
      if (!r.ok) throw new Error('Could not load this patient\'s care programmes.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/care-programs/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const changed = async () => { await load(); onChanged?.(); };

  if (error && !data) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head"><h2>Care program</h2></header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">Care programmes could not be loaded</p>
          <p>{error}</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  if (openId) {
    return (
      <Workspace
        customerId={customerId}
        programId={openId}
        options={options}
        today={today}
        onBack={() => setOpenId(null)}
        onChanged={changed}
        onOpenTab={onOpenTab}
      />
    );
  }

  const none = data.active.length === 0 && data.past.length === 0;

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Care program</h2>
        <button type="button" onClick={() => setEnrolling(true)} className="ui-meds-add">
          + Enrol in a care programme
        </button>
      </header>

      <div className="ui-allergy-body">
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        {none ? (
          <div className="ui-meds-empty">
            <p className="ui-meds-empty-title">{EMPTY_TEXT.programs}</p>
            <p>
              A care programme organises what this patient is being followed for — goals,
              what is due, and what has been done. It reads the conditions, medicines,
              tests and vitals already on this record rather than repeating them.
            </p>
            <button type="button" onClick={() => setEnrolling(true)} className="ui-meds-add">
              + Enrol in a care programme
            </button>
          </div>
        ) : (
          <>
            {data.counts.overdueTasks > 0 && (
              <p className="ui-cprog-banner">
                <IconInfo width={14} height={14} aria-hidden="true" />
                {data.counts.overdueTasks} task{data.counts.overdueTasks === 1 ? '' : 's'} past its due date
                {data.counts.dueForReview > 0 && `, ${data.counts.dueForReview} programme${data.counts.dueForReview === 1 ? '' : 's'} due for review`}
              </p>
            )}

            <section aria-labelledby="cprog-active">
              <h3 id="cprog-active" className="ui-allergy-heading">Active</h3>
              {data.active.length === 0
                ? <p className="ui-meds-count">No programme is currently being followed.</p>
                : (
                  <ul className="ui-cprog-list">
                    {data.active.map((p) => (
                      <ProgramCard key={p.id} program={p} options={options} today={today} onOpen={() => setOpenId(p.id)} />
                    ))}
                  </ul>
                )}
            </section>

            {data.past.length > 0 && (
              <section aria-labelledby="cprog-past">
                <h3 id="cprog-past" className="ui-allergy-heading">Past</h3>
                <ul className="ui-cprog-list">
                  {data.past.map((p) => (
                    <ProgramCard key={p.id} program={p} options={options} today={today} past onOpen={() => setOpenId(p.id)} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {enrolling && (
        <EnrolForm
          customerId={customerId}
          today={today}
          onClose={() => setEnrolling(false)}
          onViewExisting={(existingId) => { setEnrolling(false); setOpenId(existingId); }}
          onSaved={async (saved) => { setEnrolling(false); setOpenId(saved?.id || null); await changed(); }}
        />
      )}
    </section>
  );
}

function ProgramCard({ program, options, today, past = false, onOpen }) {
  const parts = progressParts(program);
  return (
    <li className={`ui-cprog-card ${past ? 'is-past' : ''}`}>
      <button type="button" onClick={onOpen} className="ui-cprog-open">
        <span className="ui-cprog-card-top">
          <span className="ui-cprog-name">{program.programName}</span>
          <span className={`ui-med-status ${PROGRAM_TONE[program.status] || 'ui-tone-quiet'}`}>
            {labelFor(options?.statuses, program.status)}
          </span>
        </span>
        <span className="ui-cprog-card-meta">{rangeLabel(program)}</span>
        {past
          ? <span className="ui-cprog-card-meta">{outcomeLine(program, options)}</span>
          : (
            <>
              <span className="ui-cprog-progress">
                {parts.length === 0
                  ? <span className="ui-cprog-quiet">Nothing planned yet</span>
                  : parts.map((x) => <span key={x.id} className={x.tone || ''}>{x.text}</span>)}
              </span>
              <span className="ui-cprog-card-meta">{nextUpLine(program, today)}</span>
            </>
          )}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// One programme
// ---------------------------------------------------------------------------

function Workspace({ customerId, programId, options, today, onBack, onChanged, onOpenTab }) {
  const [program, setProgram] = useState(null);
  const [error, setError] = useState(null);
  const [section, setSection] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(null);   // 'completed' | 'discontinued' | 'cancelled' | 'on_hold'
  const [goalForm, setGoalForm] = useState(null);
  const [taskForm, setTaskForm] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/care-programs/${programId}`);
      if (!r.ok) throw new Error('Could not load this care programme.');
      setProgram(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId, programId]);

  useEffect(() => { load(); }, [load]);

  const changed = async (fresh) => {
    if (fresh) setProgram(fresh);
    else await load();
    onChanged?.();
  };

  if (error && !program) {
    return (
      <section className="ui-meds">
        <header className="ui-meds-head">
          <button type="button" onClick={onBack} className="ui-cprog-back">← All programmes</button>
        </header>
        <div className="ui-allergy-failed" role="alert">
          <p className="ui-meds-empty-title">This programme could not be loaded</p>
          <p>{error}</p>
          <button type="button" onClick={load} className="ui-meds-add">Try again</button>
        </div>
      </section>
    );
  }
  if (!program) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const open = isOpen(program);
  const tasks = taskList(program, today);

  return (
    <section className="ui-meds">
      <header className="ui-meds-head ui-cprog-head">
        <div>
          <button type="button" onClick={onBack} className="ui-cprog-back">← All programmes</button>
          <h2>
            {program.programName}
            <span className={`ui-med-status ${PROGRAM_TONE[program.status] || 'ui-tone-quiet'}`}>
              {labelFor(options?.statuses, program.status)}
            </span>
          </h2>
        </div>
        <div className="ui-cprog-actions">
          <button type="button" onClick={() => setEditing(true)} className="ui-mrev-btn">Edit</button>
          {open && (
            <>
              {program.status !== 'on_hold' && (
                <button type="button" onClick={() => setEnding('on_hold')} className="ui-mrev-btn">Put on hold</button>
              )}
              <button type="button" onClick={() => setEnding('discontinued')} className="ui-mrev-btn">Discontinue</button>
              <button type="button" onClick={() => setEnding('completed')} className="ui-mrev-btn is-primary">Complete</button>
            </>
          )}
        </div>
      </header>

      <div className="ui-allergy-body">
        {error && <p role="alert" className="ui-vital-error">{error}</p>}

        <div className="ui-meds-filters" role="group" aria-label="Sections of this programme">
          {PROGRAM_SECTIONS.map((s) => (
            <button key={s.id} type="button" aria-pressed={section === s.id}
              onClick={() => setSection(s.id)} className={`ui-quick-filter ${section === s.id ? 'is-on' : ''}`}>
              {s.label}
              {s.id === 'tasks' && tasks.length > 0 && <span className="ui-cprog-pill">{tasks.length}</span>}
            </button>
          ))}
        </div>

        {section === 'overview' && (
          <Overview
            customerId={customerId}
            program={program}
            options={options}
            today={today}
            onGoTo={setSection}
            onOpenTab={onOpenTab}
          />
        )}

        {section === 'goals' && (
          <Goals
            customerId={customerId}
            program={program}
            options={options}
            onAdd={() => setGoalForm({})}
            onEdit={(g) => setGoalForm({ goal: g })}
            onChanged={changed}
            onOpenTab={onOpenTab}
          />
        )}

        {section === 'plan' && (
          <Plan program={program} options={options} today={today} onAdd={() => setTaskForm({})} onEdit={(a) => setTaskForm({ task: a })} />
        )}

        {section === 'tasks' && (
          <Tasks
            customerId={customerId}
            program={program}
            options={options}
            today={today}
            tasks={tasks}
            onAdd={() => setTaskForm({})}
            onEdit={(a) => setTaskForm({ task: a })}
            onChanged={changed}
          />
        )}

        {section === 'monitoring' && (
          <Monitoring customerId={customerId} program={program} onOpenTab={onOpenTab} />
        )}

        {section === 'timeline' && (
          <Timeline customerId={customerId} program={program} options={options} />
        )}
      </div>

      {editing && (
        <ProgramForm
          customerId={customerId}
          program={program}
          onClose={() => setEditing(false)}
          onSaved={async (saved) => { setEditing(false); await changed(saved); }}
        />
      )}

      {ending && (
        <EndDialog
          customerId={customerId}
          program={program}
          status={ending}
          options={options}
          onClose={() => setEnding(null)}
          onSaved={async (saved) => { setEnding(null); await changed(saved); }}
        />
      )}

      {goalForm && (
        <GoalForm
          customerId={customerId}
          program={program}
          goal={goalForm.goal || null}
          options={options}
          onClose={() => setGoalForm(null)}
          onSaved={async (saved) => { setGoalForm(null); await changed(saved); }}
        />
      )}

      {taskForm && (
        <TaskForm
          customerId={customerId}
          program={program}
          task={taskForm.task || null}
          options={options}
          onClose={() => setTaskForm(null)}
          onSaved={async (saved) => { setTaskForm(null); await changed(saved); }}
        />
      )}
    </section>
  );
}

function Overview({ customerId, program, options, today, onGoTo, onOpenTab }) {
  const parts = progressParts(program);
  const p = program.progress;
  // The patient's conditions beside the programme (§25). The same component
  // the Medications screen uses, reading the same endpoint — a pointer to the
  // Conditions section, never a second copy of it.
  const [problems, setProblems] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/problems`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setProblems({ conditions: j.conditions || [], purchaseSuggested: j.suggestions || [] }); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  return (
    <div className="ui-cprog-overview">
      <dl className="ui-med-detail">
        {[
          ['Why enrolled', program.reason],
          ['Status', labelFor(options?.statuses, program.status)],
          ['Started', dayLabel(program.startDate || program.enrolledOn)],
          ['Next review', program.nextReviewOn ? dueLabel(program.nextReviewOn, today) : 'Not set'],
          ['Ended', dayLabel(program.endDate)],
          ['Outcome', outcomeLine(program, options)],
          ['Outcome notes', program.outcomeNotes],
          ['What next', program.followUpRecommendation],
          ['Pharmacist', responsibleLine(program)],
          ['Notes', program.notes],
          ['About this programme', program.description],
          ['Recorded by', program.recordedBy?.email || null],
        ].filter(([, v]) => v).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={k === 'Notes' || k === 'Outcome notes' ? 'whitespace-pre-line' : ''}>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="ui-cprog-counts">
        <h3 className="ui-allergy-heading">Progress</h3>
        {parts.length === 0
          ? <p className="ui-meds-count">Nothing planned yet.</p>
          : (
            <p className="ui-cprog-progress">
              {parts.map((x) => <span key={x.id} className={x.tone || ''}>{x.text}</span>)}
            </p>
          )}
        <p className="ui-cprog-next">{nextUpLine(program, today)}</p>
        <div className="ui-cprog-jump">
          <button type="button" onClick={() => onGoTo('goals')} className="ui-mrev-btn">
            Goals ({p.goals.total})
          </button>
          <button type="button" onClick={() => onGoTo('tasks')} className="ui-mrev-btn">
            Tasks due ({p.activities.open})
          </button>
          <button type="button" onClick={() => onGoTo('monitoring')} className="ui-mrev-btn">
            Monitoring
          </button>
        </div>

        <div className="ui-cprog-side">
          <ConditionsBrief problems={problems} onOpen={() => onOpenTab?.('conditions')} />
        </div>

        <Related customerId={customerId} program={program} options={options} onOpenTab={onOpenTab} />
      </div>
    </div>
  );
}

// ---- related records: attached by hand, or sharing the programme's code ---

function Related({ customerId, program, options, onOpenTab }) {
  const [data, setData] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/care-programs/${program.id}/related`);
      if (!r.ok) throw new Error('Related records could not be loaded.');
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId, program.id]);

  useEffect(() => { load(); }, [load]);

  async function detach(linkId) {
    try {
      setData(await send(`/api/customers/${customerId}/care-programs/${program.id}/links/${linkId}`, 'DELETE'));
    } catch (e) {
      setError(e.message);
    }
  }

  const derived = data
    ? [
      ...data.conditions.map((c) => ({ key: `c${c.id}`, kind: 'condition', label: c.conditionName, detail: c.clinicalStatus, tab: 'conditions' })),
      ...data.medicines.map((m) => ({ key: `m${m.id}`, kind: 'medication', label: [m.medicineName, m.strength].filter(Boolean).join(' '), detail: m.status, tab: 'meds' })),
      ...data.tests.map((t) => ({ key: `t${t.id}`, kind: 'test', label: t.testName, detail: t.status, tab: 'results' })),
    ]
    : [];

  return (
    <div className="ui-cprog-related">
      <div className="ui-cond-toolbar">
        <h3 className="ui-allergy-heading">Related records</h3>
        <button type="button" onClick={() => setAttaching(true)} className="ui-mrev-btn">Attach</button>
      </div>
      {error && <p role="alert" className="ui-vital-error">{error}</p>}
      {!data ? <p className="ui-meds-count"><Loading /></p> : (
        <>
          {data.links.length === 0 && derived.length === 0 && (
            <p className="ui-meds-count">{EMPTY_TEXT.related}</p>
          )}
          {data.links.length > 0 && (
            <ul className="ui-cprog-related-list">
              {data.links.map((l) => (
                <li key={l.id}>
                  <span>
                    <span className="ui-cprog-related-kind">{labelFor(options?.linkKinds, l.kind)}</span>
                    <span className={l.missing ? 'ui-cprog-quiet' : ''}>{l.label}</span>
                    {l.note && <span className="ui-med-sub">{l.note}</span>}
                  </span>
                  <button type="button" onClick={() => detach(l.id)} className="ui-icon-btn" aria-label={`Detach ${l.label}`}>×</button>
                </li>
              ))}
            </ul>
          )}
          {derived.length > 0 && (
            <>
              {/* Not attached by anybody: these share the programme's condition
                  code, and are read from the sections that hold them. */}
              <p className="ui-allergy-help">On this record, for the same condition</p>
              <ul className="ui-cprog-related-list">
                {derived.map((d) => (
                  <li key={d.key}>
                    <span>
                      <span className="ui-cprog-related-kind">{labelFor(options?.linkKinds, d.kind)}</span>
                      <button type="button" className="ui-cprog-link" onClick={() => onOpenTab?.(d.tab)}>{d.label}</button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {attaching && (
        <AttachDialog
          customerId={customerId}
          program={program}
          options={options}
          onClose={() => setAttaching(false)}
          onAttached={(fresh) => { setAttaching(false); setData(fresh); }}
        />
      )}
    </div>
  );
}

// The record pickers moved to recordPicker.js when the consultation problem
// list needed the same four kinds. Same endpoints, same row shapes — one copy.

/**
 * Attach a record that already exists.
 *
 * The list is read from the section that OWNS those records, so nothing can be
 * attached that is not already on this patient's record — and the server
 * checks the id again before storing it.
 */
function AttachDialog({ customerId, program, options, onClose, onAttached }) {
  const [kind, setKind] = useState('condition');
  const [rows, setRows] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(null);
    const picker = RECORD_PICKERS[kind];
    fetch(picker.url(customerId))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setRows(j ? picker.rows(j, dayLabel) : []); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [customerId, kind]);

  async function attach(refId) {
    setSaving(true);
    setError(null);
    try {
      onAttached(await send(`/api/customers/${customerId}/care-programs/${program.id}/links`, 'POST', {
        kind, refId, note: note || null,
      }));
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Attach a record">
      <div className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Attach a record</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error}</p>}
          <p className="ui-allergy-help">
            Nothing is copied. The programme points at the record, and the record stays where it lives.
          </p>

          <div className="ui-meds-filters" role="group" aria-label="Kind of record">
            {(options?.linkKinds || []).map((k) => (
              <button key={k.value} type="button" aria-pressed={kind === k.value}
                onClick={() => setKind(k.value)} className={`ui-quick-filter ${kind === k.value ? 'is-on' : ''}`}>
                {k.label}
              </button>
            ))}
          </div>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className="ui-vital-input" maxLength={300} />
          </label>

          {rows === null
            ? <p className="ui-meds-count"><Loading /></p>
            : rows.length === 0
              ? <p className="ui-meds-count">This patient has no records of that kind yet.</p>
              : (
                <ul className="ui-cprog-pick mt-3">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <button type="button" disabled={saving} onClick={() => attach(r.id)} className="ui-cprog-pick-btn">
                        <span className="ui-cprog-name">{r.label}</span>
                        {r.detail && <span className="ui-cprog-card-meta">{r.detail}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Close</button>
        </footer>
      </div>
    </div>
  );
}

// ---- monitoring: read from Vitals and Tests ------------------------------

function Monitoring({ customerId, program, onOpenTab }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/care-programs/${program.id}/monitoring`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Monitoring could not be loaded.'))))
      .then((j) => { if (live) setData(j); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [customerId, program.id]);

  if (error) return <p role="alert" className="ui-vital-error">{error}</p>;
  if (!data) return <p className="ui-meds-count"><Loading /></p>;

  return (
    <section aria-labelledby="cprog-monitoring">
      <h3 id="cprog-monitoring" className="ui-allergy-heading">Monitoring</h3>
      {data.metrics.length === 0 ? (
        <div className="ui-meds-empty">
          <p className="ui-meds-empty-title">{EMPTY_TEXT.monitoring}</p>
          <p>
            A goal that reads a measurement adds it here. Values come from Vitals and
            Tests — this section records nothing of its own.
          </p>
        </div>
      ) : (
        <>
          <ul className="ui-cprog-metrics">
            {data.metrics.map((m) => (
              <li key={`${m.source}:${m.code}`} className="ui-cprog-metric">
                <p className="ui-cprog-metric-name">{m.label}</p>
                <p className={`ui-cprog-metric-value ${m.latest ? '' : 'ui-cprog-quiet'}`}>{monitoringValue(m)}</p>
                <p className="ui-cprog-metric-meta">
                  {[m.latest ? dayLabel(m.latest.at) : null, monitoringChange(m), readingCount(m)]
                    .filter(Boolean).join(' · ')}
                </p>
                <button type="button" className="ui-cprog-link" onClick={() => onOpenTab?.(m.tab)}>
                  {m.source === 'vitals' ? 'Open Vitals' : 'Open Tests'}
                </button>
              </li>
            ))}
          </ul>
          <p className="ui-allergy-help">
            Every value here is read from the section that recorded it. Nothing is
            stored twice, so a correction made there shows here straight away.
          </p>
        </>
      )}
    </section>
  );
}

// ---- the timeline: this programme's own history --------------------------

function Timeline({ customerId, program, options }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/care-programs/${program.id}/timeline`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('The timeline could not be loaded.'))))
      .then((j) => { if (live) setData(j); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [customerId, program.id]);

  if (error) return <p role="alert" className="ui-vital-error">{error}</p>;
  if (!data) return <p className="ui-meds-count"><Loading /></p>;

  return (
    <section aria-labelledby="cprog-timeline">
      <h3 id="cprog-timeline" className="ui-allergy-heading">Timeline</h3>
      {data.events.length === 0
        ? <p className="ui-meds-count">{EMPTY_TEXT.timeline}</p>
        : (
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
        )}
      {/* The patient's whole history is its own screen; this is one programme. */}
      <p className="ui-allergy-help">Only what happened to this programme.</p>
    </section>
  );
}

// ---- goals ---------------------------------------------------------------

function Goals({ customerId, program, options, onAdd, onEdit, onChanged, onOpenTab }) {
  const { goals } = program;
  return (
    <section aria-labelledby="cprog-goals">
      <div className="ui-cond-toolbar">
        <h3 id="cprog-goals" className="ui-allergy-heading">Goals</h3>
        <button type="button" onClick={onAdd} className="ui-meds-add">+ Add goal</button>
      </div>
      {goals.length === 0
        ? <p className="ui-meds-count">{EMPTY_TEXT.goals}</p>
        : (
          <div className="ui-med-tablewrap">
            <table className="ui-med-table">
              <colgroup>
                <col style={{ width: '280px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '160px' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '120px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Goal</th>
                  <th scope="col">Target</th>
                  <th scope="col">Current</th>
                  <th scope="col">Status</th>
                  <th scope="col">By</th>
                </tr>
              </thead>
              <tbody>
                {goals.map((g, i) => (
                  <GoalRow key={g.id} customerId={customerId} program={program} goal={g} index={i}
                    options={options} onEdit={onEdit} onChanged={onChanged} onOpenTab={onOpenTab} />
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function GoalRow({ customerId, program, goal, index, options, onEdit, onChanged, onOpenTab }) {
  const [reading, setReading] = useState(null);
  const [busy, setBusy] = useState(false);

  // THE CURRENT VALUE IS READ FROM THE RECORD, not stored on the goal. A goal
  // and the reading it is about can never disagree, because there is only one
  // of them. Both readers use the section's OWN endpoint — Vitals' series and
  // Tests' trend — so neither this screen nor the care-programme tables hold a
  // second copy of a clinical number.
  useEffect(() => {
    if (!goal.measureSource || !goal.measureCode) return undefined;
    let live = true;
    if (goal.measureSource === 'vitals') {
      fetch(`/api/customers/${customerId}/vitals/series`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live || !j) return;
          // Oldest first, so the last row carrying this metric is the latest.
          const withValue = (j.readings || []).filter((x) => x[goal.measureCode] !== null && x[goal.measureCode] !== undefined);
          const last = withValue[withValue.length - 1] || null;
          if (last) setReading({ value: last[goal.measureCode], unit: goal.unit, at: last.recordedAt });
        })
        .catch(() => {});
    } else {
      fetch(`/api/customers/${customerId}/tests/trend?code=${encodeURIComponent(goal.measureCode)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!live || !j) return;
          const points = j.points || [];
          const last = points[points.length - 1] || null;
          if (last) setReading({ value: last.value, unit: j.unit || goal.unit, at: last.at });
        })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [customerId, goal.measureSource, goal.measureCode, goal.unit]);

  async function settle(status) {
    setBusy(true);
    try {
      const saved = await send(
        `/api/customers/${customerId}/care-programs/${program.id}/goals/${goal.id}`, 'PATCH', { status },
      );
      await onChanged(saved);
    } catch {
      setBusy(false);
    }
  }

  const tabFor = goal.measureSource === 'vitals' ? 'vitals' : 'results';

  return (
    <tr className="ui-med-row" style={{ '--row-i': index }}>
      <td>
        <span className="ui-med-title">{goal.title}</span>
        {goal.description && <span className="ui-med-sub">{goal.description}</span>}
      </td>
      <td className="ui-med-quiet">
        {targetLabel(goal)}
        {goal.targetDate && <span className="ui-med-sub">by {dayLabel(goal.targetDate)}</span>}
      </td>
      <td className="ui-med-quiet">
        {goal.measureSource
          ? (
            <button type="button" className="ui-cprog-link" onClick={() => onOpenTab?.(tabFor)}>
              {currentLabel(goal, reading)}
            </button>
          )
          : <Blank />}
        {goal.baselineValue !== null && goal.baselineValue !== undefined && (
          <span className="ui-med-sub">
            from {[goal.baselineValue, goal.unit].filter((v) => v !== null && v !== undefined && v !== '').join(' ')}
          </span>
        )}
      </td>
      <td>
        <span className={`ui-med-status ${GOAL_TONE[goal.status] || 'ui-tone-quiet'}`}>
          {labelFor(options?.goalStatuses, goal.status)}
        </span>
        {goal.achievedOn && <span className="ui-med-sub">{dayLabel(goal.achievedOn)}</span>}
      </td>
      <td className="ui-cprog-rowactions">
        {isOpen(program) && goal.status !== 'achieved' && (
          <button type="button" disabled={busy} onClick={() => settle('achieved')} className="ui-mrev-btn">Achieved</button>
        )}
        <button type="button" onClick={() => onEdit(goal)} className="ui-mrev-btn">Edit</button>
      </td>
    </tr>
  );
}

// ---- the care plan (everything) and the task list (what is left) ---------

function Plan({ program, options, today, onAdd, onEdit }) {
  const { activities } = program;
  return (
    <section aria-labelledby="cprog-plan">
      <div className="ui-cond-toolbar">
        <h3 id="cprog-plan" className="ui-allergy-heading">Care plan</h3>
        <button type="button" onClick={onAdd} className="ui-meds-add">+ Add activity</button>
      </div>
      {activities.length === 0
        ? <p className="ui-meds-count">{EMPTY_TEXT.plan}</p>
        : (
          <div className="ui-med-tablewrap">
            <table className="ui-med-table">
              <colgroup>
                <col style={{ width: '280px' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '100px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Activity</th>
                  <th scope="col">Type</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {activities.map((a, i) => (
                  <tr key={a.id} className={`ui-med-row ${['skipped', 'cancelled'].includes(a.status) ? 'is-history' : ''}`} style={{ '--row-i': i }}>
                    <td>
                      <span className="ui-med-title">{a.title}</span>
                      <span className="ui-med-sub">
                        {[recurrenceLabel(a), a.assignedToName, a.description].filter(Boolean).join(' · ') || null}
                      </span>
                    </td>
                    <td className="ui-med-quiet">{labelFor(options?.activityKinds, a.kind)}</td>
                    <td className="ui-med-quiet whitespace-nowrap">
                      {a.dueOn ? dayLabel(a.dueOn) : <Blank />}
                      {isOverdue(a, today) && <span className="ui-med-sub ui-tone-3">overdue</span>}
                    </td>
                    <td>
                      <span className={`ui-med-status ${TASK_TONE[a.status] || 'ui-tone-quiet'}`}>
                        {labelFor(options?.activityStatuses, a.status)}
                      </span>
                      {a.completedAt && <span className="ui-med-sub">{dayLabel(a.completedAt)}</span>}
                      {a.statusReason && <span className="ui-med-sub">{a.statusReason}</span>}
                      {a.outcomeNote && <span className="ui-med-sub">{a.outcomeNote}</span>}
                    </td>
                    <td className="ui-cprog-rowactions">
                      <button type="button" onClick={() => onEdit(a)} className="ui-mrev-btn">Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function Tasks({ customerId, program, options, today, tasks, onAdd, onEdit, onChanged }) {
  const [busyId, setBusyId] = useState(null);

  async function complete(task) {
    setBusyId(task.id);
    try {
      const saved = await send(
        `/api/customers/${customerId}/care-programs/${program.id}/activities/${task.id}`,
        'PATCH', { status: 'completed' },
      );
      await onChanged(saved);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="cprog-tasks">
      <div className="ui-cond-toolbar">
        <h3 id="cprog-tasks" className="ui-allergy-heading">Tasks</h3>
        <button type="button" onClick={onAdd} className="ui-meds-add">+ Add task</button>
      </div>
      {tasks.length === 0
        ? <p className="ui-meds-count">{EMPTY_TEXT.tasks}</p>
        : (
          <ul className="ui-cprog-tasks">
            {tasks.map((a) => (
              <li key={a.id} className={`ui-cprog-task ${isOverdue(a, today) ? 'is-late' : ''}`}>
                <div>
                  <p className="ui-cprog-task-title">{a.title}</p>
                  <p className="ui-cprog-task-meta">
                    {[
                      labelFor(options?.activityKinds, a.kind),
                      a.dueOn ? dueLabel(a.dueOn, today) : 'no date set',
                      recurrenceLabel(a),
                      a.assignedToName,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="ui-cprog-rowactions">
                  <button type="button" onClick={() => onEdit(a)} className="ui-mrev-btn">Edit</button>
                  <button type="button" disabled={busyId === a.id} onClick={() => complete(a)} className="ui-mrev-btn is-primary">
                    {busyId === a.id ? 'Saving…' : 'Mark done'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {tasks.some((a) => a.recurrence) && (
        <p className="ui-allergy-help">
          Marking a repeating task done adds the next one automatically, and keeps the one just finished.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

function EnrolForm({ customerId, today, onClose, onSaved, onViewExisting }) {
  const [catalogue, setCatalogue] = useState(null);
  const [chosen, setChosen] = useState(null);      // a catalogue row, or 'custom'
  const [plan, setPlan] = useState(null);          // { goals, activities } as the template expands
  const [form, setForm] = useState({
    programName: '', startDate: today, reason: '', responsibleName: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [duplicate, setDuplicate] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/care-programs/catalogue`)
      .then((r) => (r.ok ? r.json() : { programs: [] }))
      .then((j) => { if (live) setCatalogue(j.programs || []); })
      .catch(() => { if (live) setCatalogue([]); });
    return () => { live = false; };
  }, [customerId]);

  // What enrolling WOULD create, shown before anything is saved.
  useEffect(() => {
    if (!chosen || chosen === 'custom') { setPlan(null); return undefined; }
    let live = true;
    fetch(`/api/customers/${customerId}/care-programs/plan?definitionId=${chosen.id}&startDate=${form.startDate || ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setPlan(j.plan); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId, chosen, form.startDate]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const name = chosen && chosen !== 'custom' ? chosen.name : form.programName;
  const problems = programProblems({ ...form, programName: name });
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  const dropGoal = (i) => setPlan((p) => ({ ...p, goals: p.goals.filter((_, x) => x !== i) }));
  const dropActivity = (i) => setPlan((p) => ({ ...p, activities: p.activities.filter((_, x) => x !== i) }));

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await send(`/api/customers/${customerId}/care-programs`, 'POST', {
        definitionId: chosen && chosen !== 'custom' ? chosen.id : null,
        programName: chosen && chosen !== 'custom' ? null : form.programName,
        startDate: form.startDate || null,
        reason: form.reason || null,
        responsibleName: form.responsibleName || null,
        notes: form.notes || null,
        ...(plan ? { plan } : {}),
      });
      onSaved(saved);
    } catch (err) {
      if (err.code === 'DUPLICATE_ACTIVE_PROGRAM') setDuplicate({ message: err.message, existing: err.existing });
      else setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Enrol in a care programme">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Enrol in a care programme</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}

          {!chosen ? (
            <>
              <p className="ui-allergy-help">Pick a programme. Its goals and tasks are created with it, and can be changed before or after saving.</p>
              {catalogue === null
                ? <p className="ui-meds-count"><Loading /></p>
                : (
                  <ul className="ui-cprog-pick">
                    {catalogue.map((d) => (
                      <li key={d.id}>
                        <button type="button" onClick={() => setChosen(d)} className="ui-cprog-pick-btn">
                          <span className="ui-cprog-name">{d.name}</span>
                          {d.description && <span className="ui-cprog-card-meta">{d.description}</span>}
                          <span className="ui-cprog-card-meta">
                            {d.goals.length} goal{d.goals.length === 1 ? '' : 's'} · {d.activities.length} activit{d.activities.length === 1 ? 'y' : 'ies'}
                          </span>
                        </button>
                      </li>
                    ))}
                    <li>
                      <button type="button" onClick={() => setChosen('custom')} className="ui-cprog-pick-btn">
                        <span className="ui-cprog-name">Something else</span>
                        <span className="ui-cprog-card-meta">Name it yourself and write the plan from scratch</span>
                      </button>
                    </li>
                  </ul>
                )}
            </>
          ) : (
            <>
              <div className="ui-cond-toolbar">
                <p className="ui-cprog-name">{chosen === 'custom' ? 'A programme of your own' : chosen.name}</p>
                <button type="button" onClick={() => { setChosen(null); setPlan(null); }} className="ui-mrev-btn">Choose another</button>
              </div>

              {chosen === 'custom' && (
                <label className="ui-med-field">
                  <span className="ui-vital-label">Programme name</span>
                  <input value={form.programName} onChange={(e) => set('programName', e.target.value)}
                    className={`ui-vital-input ${wrong('programName')}`} maxLength={120} />
                </label>
              )}

              <div className="ui-med-grid">
                <label className="ui-med-field">
                  <span className="ui-vital-label">Start date</span>
                  <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)}
                    className={`ui-vital-input ${wrong('startDate')}`} />
                </label>
                <label className="ui-med-field">
                  <span className="ui-vital-label">Pharmacist responsible (optional)</span>
                  <input value={form.responsibleName} onChange={(e) => set('responsibleName', e.target.value)}
                    className="ui-vital-input" maxLength={200} />
                </label>
              </div>

              <label className="ui-med-field mt-3">
                <span className="ui-vital-label">Why this patient is being enrolled</span>
                <textarea value={form.reason} onChange={(e) => set('reason', e.target.value)}
                  className="ui-mrev-text" rows={2} maxLength={500} />
              </label>

              {plan && (
                <div className="ui-cprog-preview">
                  <h4 className="ui-allergy-heading">Goals to create</h4>
                  {plan.goals.length === 0
                    ? <p className="ui-meds-count">{EMPTY_TEXT.goals}</p>
                    : (
                      <ul className="ui-cprog-preview-list">
                        {plan.goals.map((g, i) => (
                          <li key={`${g.title}-${i}`}>
                            <span>{g.title}{g.targetDate ? ` — by ${dayLabel(g.targetDate)}` : ''}</span>
                            <button type="button" onClick={() => dropGoal(i)} className="ui-icon-btn" aria-label={`Remove ${g.title}`}>×</button>
                          </li>
                        ))}
                      </ul>
                    )}

                  <h4 className="ui-allergy-heading">Tasks to create</h4>
                  {plan.activities.length === 0
                    ? <p className="ui-meds-count">{EMPTY_TEXT.plan}</p>
                    : (
                      <ul className="ui-cprog-preview-list">
                        {plan.activities.map((a, i) => (
                          <li key={`${a.title}-${i}`}>
                            <span>
                              {a.title}
                              {a.dueOn ? ` — ${dayLabel(a.dueOn)}` : ''}
                              {recurrenceLabel(a) ? `, ${recurrenceLabel(a)}` : ''}
                            </span>
                            <button type="button" onClick={() => dropActivity(i)} className="ui-icon-btn" aria-label={`Remove ${a.title}`}>×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  <p className="ui-allergy-help">These become this patient&apos;s own. Editing one later changes their plan, not the template.</p>
                </div>
              )}
            </>
          )}

          {problems.length > 0 && chosen && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || !chosen || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Enrol'}
          </button>
        </footer>
      </form>

      {duplicate && (
        <div className="ui-allergy-dialog-scrim" role="dialog" aria-modal="true" aria-label="Already enrolled">
          <div className="ui-allergy-dialog">
            <p>{duplicate.message}</p>
            <p className="ui-allergy-help">
              One open programme at a time keeps the plan in one place. Open the one that exists, or end it first.
            </p>
            <div className="ui-allergy-dialog-buttons">
              <button type="button" onClick={() => setDuplicate(null)} className="ui-mrev-btn">Cancel</button>
              <button type="button" onClick={() => onViewExisting(duplicate.existing?.id)} className="ui-mrev-btn is-primary">
                Open it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing, ending, goals and tasks
// ---------------------------------------------------------------------------

function ProgramForm({ customerId, program, onClose, onSaved }) {
  const [form, setForm] = useState({
    programName: program.programName || '',
    startDate: program.startDate || '',
    nextReviewOn: program.nextReviewOn || '',
    responsibleName: program.responsible?.name || '',
    reason: program.reason || '',
    notes: program.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = programProblems(form);
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await send(`/api/customers/${customerId}/care-programs/${program.id}`, 'PATCH', {
        programName: form.programName,
        startDate: form.startDate || null,
        nextReviewOn: form.nextReviewOn || null,
        responsibleName: form.responsibleName || null,
        reason: form.reason || null,
        notes: form.notes || null,
      }));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label="Edit care programme">
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>Edit care programme</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
          <label className="ui-med-field">
            <span className="ui-vital-label">Programme name</span>
            <input value={form.programName} onChange={(e) => set('programName', e.target.value)}
              className={`ui-vital-input ${wrong('programName')}`} maxLength={120} />
            {program.definitionName && program.definitionName !== program.programName && (
              <span className="ui-allergy-help">Template is now called &ldquo;{program.definitionName}&rdquo;</span>
            )}
          </label>
          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Start date</span>
              <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Next review</span>
              <input type="date" value={form.nextReviewOn} onChange={(e) => set('nextReviewOn', e.target.value)} className="ui-vital-input" />
            </label>
          </div>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Pharmacist responsible</span>
            <input value={form.responsibleName} onChange={(e) => set('responsibleName', e.target.value)}
              className="ui-vital-input" maxLength={200} />
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Why this patient is enrolled</span>
            <textarea value={form.reason} onChange={(e) => set('reason', e.target.value)} className="ui-mrev-text" rows={2} maxLength={500} />
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} className="ui-mrev-text" rows={3} maxLength={2000} />
          </label>
          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

const ENDING_TITLE = Object.freeze({
  completed: 'Complete this programme',
  discontinued: 'Discontinue this programme',
  cancelled: 'Cancel this enrolment',
  on_hold: 'Put this programme on hold',
});

function EndDialog({ customerId, program, status, options, onClose, onSaved }) {
  const [form, setForm] = useState({
    status,
    outcome: '',
    outcomeNotes: '',
    followUpRecommendation: '',
    discontinuationReason: '',
    statusReason: '',
    endDate: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = status === 'on_hold'
    ? (String(form.statusReason).trim() ? [] : ['Say why the programme is on hold.'])
    : endingProblems(form);

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await send(`/api/customers/${customerId}/care-programs/${program.id}`, 'PATCH', {
        status,
        ...(status === 'completed' ? {
          outcome: form.outcome,
          outcomeNotes: form.outcomeNotes || null,
          followUpRecommendation: form.followUpRecommendation || null,
        } : {}),
        ...(status === 'discontinued' ? { discontinuationReason: form.discontinuationReason } : {}),
        ...(form.statusReason ? { statusReason: form.statusReason } : {}),
        ...(form.endDate ? { endDate: form.endDate } : {}),
      }));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={ENDING_TITLE[status]}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{ENDING_TITLE[status]}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
          <p className="ui-allergy-help">
            {status === 'on_hold'
              ? 'The plan stays exactly as it is and nothing is due while it is paused.'
              : 'The goals and every task stay on the record. Only a pharmacist can end a programme.'}
          </p>

          {status === 'completed' && (
            <>
              <label className="ui-med-field">
                <span className="ui-vital-label">How did it end?</span>
                <select value={form.outcome} onChange={(e) => set('outcome', e.target.value)} className="ui-vital-input">
                  <option value="">Choose…</option>
                  {(options?.outcomes || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="ui-med-field mt-3">
                <span className="ui-vital-label">Outcome notes</span>
                <textarea value={form.outcomeNotes} onChange={(e) => set('outcomeNotes', e.target.value)}
                  className="ui-mrev-text" rows={3} maxLength={2000} />
              </label>
              <label className="ui-med-field mt-3">
                <span className="ui-vital-label">What should happen next (optional)</span>
                <textarea value={form.followUpRecommendation} onChange={(e) => set('followUpRecommendation', e.target.value)}
                  className="ui-mrev-text" rows={2} maxLength={1000} />
              </label>
            </>
          )}

          {status === 'discontinued' && (
            <label className="ui-med-field">
              <span className="ui-vital-label">Why was it stopped?</span>
              <select value={form.discontinuationReason} onChange={(e) => set('discontinuationReason', e.target.value)} className="ui-vital-input">
                <option value="">Choose…</option>
                {(options?.discontinuationReasons || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">
              {status === 'on_hold' ? 'Why?' : status === 'cancelled' ? 'Why was this cancelled?' : 'Anything else to record'}
            </span>
            <textarea value={form.statusReason} onChange={(e) => set('statusReason', e.target.value)}
              className="ui-mrev-text" rows={2} maxLength={500} />
          </label>

          {status !== 'on_hold' && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">Date it ended (optional — today if left blank)</span>
              <input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} className="ui-vital-input" />
            </label>
          )}

          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function GoalForm({ customerId, program, goal, options, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: goal?.title || '',
    description: goal?.description || '',
    status: goal?.status || 'planned',
    measure: goal?.measure || '',
    measureSource: goal?.measureSource || '',
    measureCode: goal?.measureCode || '',
    unit: goal?.unit || '',
    baselineValue: goal?.baselineValue ?? '',
    targetValue: goal?.targetValue ?? '',
    targetText: goal?.targetText || '',
    targetDate: goal?.targetDate || '',
    statusReason: goal?.statusReason || '',
    notes: goal?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = goalProblems(form);
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      title: form.title,
      description: form.description || null,
      status: form.status,
      measure: form.measure || null,
      measureSource: form.measureSource || null,
      measureCode: form.measureCode || null,
      unit: form.unit || null,
      baselineValue: form.baselineValue === '' ? null : form.baselineValue,
      targetValue: form.targetValue === '' ? null : form.targetValue,
      targetText: form.targetText || null,
      targetDate: form.targetDate || null,
      statusReason: form.statusReason || null,
      notes: form.notes || null,
    };
    try {
      const base = `/api/customers/${customerId}/care-programs/${program.id}/goals`;
      onSaved(goal ? await send(`${base}/${goal.id}`, 'PATCH', body) : await send(base, 'POST', body));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      onSaved(await send(`/api/customers/${customerId}/care-programs/${program.id}/goals/${goal.id}`, 'DELETE'));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={goal ? 'Edit goal' : 'Add goal'}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{goal ? 'Edit goal' : 'Add goal'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}

          <label className="ui-med-field">
            <span className="ui-vital-label">Goal</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)}
              className={`ui-vital-input ${wrong('title')}`} maxLength={200} placeholder="Blood pressure below 140/90" />
          </label>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value)} className="ui-vital-input">
                {(options?.goalStatuses || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Target date</span>
              <input type="date" value={form.targetDate} onChange={(e) => set('targetDate', e.target.value)} className="ui-vital-input" />
            </label>
          </div>

          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">What is measured (optional)</legend>
            <span className="ui-allergy-help">
              The current value is read from Vitals or Tests. Nothing is measured or stored here.
            </span>
            <div className="ui-med-grid mt-3">
              <label className="ui-med-field">
                <span className="ui-vital-label">Read from</span>
                <select value={form.measureSource} onChange={(e) => set('measureSource', e.target.value)} className="ui-vital-input">
                  <option value="">Not measured</option>
                  {(options?.measureSources || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="ui-med-field">
                <span className="ui-vital-label">Which measurement</span>
                {form.measureSource === 'vitals' ? (
                  <select value={form.measureCode} onChange={(e) => set('measureCode', e.target.value)}
                    className={`ui-vital-input ${wrong('measureCode')}`}>
                    <option value="">Choose…</option>
                    {(options?.vitalsCodes || []).map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input value={form.measureCode} onChange={(e) => set('measureCode', e.target.value.toUpperCase())}
                    className={`ui-vital-input ${wrong('measureCode')}`} maxLength={40} placeholder="HBA1C"
                    disabled={!form.measureSource} />
                )}
              </label>
            </div>
            <div className="ui-med-grid mt-3">
              <label className="ui-med-field">
                <span className="ui-vital-label">Target value</span>
                <input value={form.targetValue} onChange={(e) => set('targetValue', e.target.value)}
                  className="ui-vital-input" inputMode="decimal" />
              </label>
              <label className="ui-med-field">
                <span className="ui-vital-label">Unit</span>
                <input value={form.unit} onChange={(e) => set('unit', e.target.value)} className="ui-vital-input" maxLength={20} />
              </label>
              <label className="ui-med-field">
                <span className="ui-vital-label">Where it started</span>
                <input value={form.baselineValue} onChange={(e) => set('baselineValue', e.target.value)}
                  className="ui-vital-input" inputMode="decimal" />
              </label>
            </div>
          </fieldset>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Target in words (for a goal that is not a number)</span>
            <input value={form.targetText} onChange={(e) => set('targetText', e.target.value)}
              className="ui-vital-input" maxLength={300} placeholder="No missed doses reported at review" />
          </label>

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} className="ui-mrev-text" rows={2} maxLength={1000} />
          </label>

          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          {goal && (
            <button type="button" onClick={remove} disabled={saving} className="ui-vital-cancel">Remove goal</button>
          )}
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TaskForm({ customerId, program, task, options, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: task?.title || '',
    description: task?.description || '',
    kind: task?.kind || 'other',
    status: task?.status || 'not_started',
    dueOn: task?.dueOn || '',
    goalId: task?.goalId || '',
    assignedToName: task?.assignedToName || '',
    repeats: Boolean(task?.recurrence),
    every: task?.recurrence?.every || 1,
    unit: task?.recurrence?.unit || 'month',
    outcomeNote: task?.outcomeNote || '',
    statusReason: task?.statusReason || '',
    notes: task?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const problems = taskProblems(form);
  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  async function save() {
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const body = {
      title: form.title,
      description: form.description || null,
      kind: form.kind,
      status: form.status,
      dueOn: form.dueOn || null,
      goalId: form.goalId || null,
      assignedToName: form.assignedToName || null,
      recurrence: form.repeats ? { every: Number(form.every), unit: form.unit } : null,
      outcomeNote: form.outcomeNote || null,
      statusReason: form.statusReason || null,
      notes: form.notes || null,
    };
    try {
      const base = `/api/customers/${customerId}/care-programs/${program.id}/activities`;
      onSaved(task ? await send(`${base}/${task.id}`, 'PATCH', body) : await send(base, 'POST', body));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await send(`/api/customers/${customerId}/care-programs/${program.id}/activities/${task.id}`, 'DELETE'));
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={task ? 'Edit task' : 'Add task'}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{task ? 'Edit task' : 'Add task'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>
        <div className="ui-vital-sheet-body">
          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}

          <label className="ui-med-field">
            <span className="ui-vital-label">What needs to be done</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)}
              className={`ui-vital-input ${wrong('title')}`} maxLength={200} placeholder="Check blood pressure" />
          </label>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Type</span>
              <select value={form.kind} onChange={(e) => set('kind', e.target.value)} className="ui-vital-input">
                {(options?.activityKinds || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Due</span>
              <input type="date" value={form.dueOn} onChange={(e) => set('dueOn', e.target.value)}
                className={`ui-vital-input ${wrong('dueOn')}`} />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value)} className="ui-vital-input">
                {(options?.activityStatuses || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">For which goal (optional)</span>
              <select value={form.goalId} onChange={(e) => set('goalId', e.target.value)} className="ui-vital-input">
                <option value="">No particular goal</option>
                {(program.goals || []).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Who is doing it (optional)</span>
              <input value={form.assignedToName} onChange={(e) => set('assignedToName', e.target.value)}
                className="ui-vital-input" maxLength={200} />
            </label>
          </div>

          <fieldset className="ui-med-field mt-3">
            <legend className="ui-vital-label">Repeat</legend>
            <label className="ui-cprog-check">
              <input type="checkbox" checked={form.repeats} onChange={(e) => set('repeats', e.target.checked)} />
              <span>This task repeats</span>
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
                      {(options?.recurrenceUnits || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </div>
                <span className="ui-allergy-help">
                  When this is marked done, the next one is added automatically — dated from when it was due, not when it was done.
                </span>
              </>
            )}
          </fieldset>

          {['skipped', 'cancelled'].includes(form.status) && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">Why?</span>
              <textarea value={form.statusReason} onChange={(e) => set('statusReason', e.target.value)}
                className={`ui-mrev-text ${wrong('statusReason')}`} rows={2} maxLength={500} />
            </label>
          )}

          {form.status === 'completed' && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">What happened (optional)</span>
              <textarea value={form.outcomeNote} onChange={(e) => set('outcomeNote', e.target.value)}
                className="ui-mrev-text" rows={2} maxLength={1000} />
            </label>
          )}

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Notes</span>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} className="ui-mrev-text" rows={2} maxLength={1000} />
          </label>

          {problems.length > 0 && <p className="ui-mrev-blocking mt-3">{problems.join(' ')}</p>}
        </div>
        <footer className="ui-vital-sheet-foot">
          {task && task.status !== 'completed' && (
            <button type="button" onClick={remove} disabled={saving} className="ui-vital-cancel">Remove task</button>
          )}
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving || problems.length > 0} className="ui-vital-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}
