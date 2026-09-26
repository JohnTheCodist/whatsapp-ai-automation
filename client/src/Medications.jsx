/**
 * The patient record's Medications section — a pharmacist's medication
 * workspace, not a product list.
 *
 *   Current            what the patient is taking now
 *   History            what they have taken, grouped by month
 *   Medication review  what a pharmacist found, and did about it
 *
 * WHAT THIS SCREEN IS FOR, in the order a pharmacist asks it: what is this
 * patient on, how do they take it, why, who said so, and is any of it
 * finished. The table answers the first three at a glance; a row expands for
 * the rest, in place, so the answer never costs the screen you were on.
 *
 * IT IS NOT A SHOP. No price, no pack size, no stock, no "buy" — those are
 * Stock's, and a medicine a patient takes is a different fact from a pack on
 * a shelf (0055's header). The only green on the screen is the word Active.
 *
 * NOTHING HERE FORMS A CLINICAL JUDGEMENT. No interaction check, no dose
 * warning, no recommendation. It records what a pharmacist observed or was
 * told, with its provenance attached — see customerProfile.js's header for
 * the line this product draws and where it now sits.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import MedicationReview from './MedicationReview.jsx';
import { IconChevronDown, IconPill, IconPulse } from './Icons.jsx';
import { AllergySafety } from './AllergySafety.jsx';
import { ConditionsBrief, TestsBrief, CareProgramsBrief, FollowupsBrief } from './ClinicalContext.jsx';
import {
  MED_TABS, HISTORY_FILTERS, MED_STATUS, MED_SOURCE,
  productLine, dosingLine, durationLabel, prescriberLabel, medDate, courseLabel,
  groupByMonth, medicationsSummary, frequencyLabel, routeLabel,
} from './medicationFormat.js';

/** A status, said once, in the app's status tones. */
function Status({ value }) {
  const s = MED_STATUS[value] || { label: value, tone: 'ui-tone-quiet' };
  return <span className={`ui-med-status ${s.tone}`}>{s.label}</span>;
}

/** Nothing recorded — quiet, and never mistaken for an answer. */
const Blank = () => <span className="ui-ptable-blank" aria-label="not recorded">–</span>;

/**
 * One medicine, expandable in place.
 *
 * The row carries what is read while scanning; the panel carries everything
 * else. Opening it does not navigate, so a pharmacist comparing two medicines
 * never loses the list.
 */
function MedicationRow({ m, index, onEdit }) {
  const [open, setOpen] = useState(false);
  const source = MED_SOURCE[m.source];
  return (
    <>
      <tr className="ui-med-row" style={{ '--row-i': index }}>
        <td>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="ui-med-name"
          >
            <IconChevronDown
              width={13}
              height={13}
              aria-hidden="true"
              className={`ui-med-caret ${open ? 'is-open' : ''}`}
            />
            <span>
              <span className="ui-med-title">{m.medicineName}</span>
              {productLine(m) && <span className="ui-med-sub">{productLine(m)}</span>}
            </span>
          </button>
        </td>
        <td className="ui-med-dosing">{dosingLine(m) || <Blank />}</td>
        <td className="ui-med-quiet">{m.indication || <Blank />}</td>
        <td className="ui-med-quiet">{prescriberLabel(m) || <Blank />}</td>
        <td className="ui-med-quiet whitespace-nowrap">{courseLabel(m) || <Blank />}</td>
        <td>
          <Status value={m.status} />
          {/* Shown only when it is NOT a prescription — the distinction a
              community pharmacist needs, and noise on every other row. */}
          {source && <span className="ui-med-source">{source}</span>}
        </td>
        <td className="text-right">
          <button type="button" onClick={() => onEdit(m)} className="ui-med-edit">Edit</button>
        </td>
      </tr>

      {open && (
        <tr className="ui-med-detail-row">
          <td colSpan={7}>
            <dl className="ui-med-detail">
              {[
                ['Generic name', m.genericName],
                ['Brand name', m.brandName],
                ['Strength', m.strength],
                ['Form', m.form],
                ['Dose', m.dose],
                ['Route', routeLabel(m.route)],
                ['Frequency', frequencyLabel(m.frequency)],
                ['Timing', m.timing],
                ['Duration', durationLabel(m)],
                ['Started', medDate(m.startedOn)],
                ['Ended', medDate(m.endedOn)],
                ['Indication', m.indication],
                ['Prescriber', prescriberLabel(m)],
                ['Instructions', m.instructions],
                ['Notes', m.notes],
                ['Stopped because', m.stopReason],
                ['Recorded', medDate(m.createdAt)],
                ['Last updated', medDate(m.updatedAt)],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function MedicationTable({ medications, onEdit }) {
  return (
    <div className="ui-med-tablewrap">
      <table className="ui-med-table">
        <colgroup>
          <col style={{ width: '230px' }} />
          <col style={{ width: '250px' }} />
          <col style={{ width: '150px' }} />
          <col style={{ width: '150px' }} />
          <col style={{ width: '160px' }} />
          <col style={{ width: '130px' }} />
          <col style={{ width: '64px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Medication</th>
            <th scope="col">Dose · route · frequency</th>
            <th scope="col">Indication</th>
            <th scope="col">Prescriber</th>
            <th scope="col">Course</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {medications.map((m, i) => <MedicationRow key={m.id} m={m} index={i} onEdit={onEdit} />)}
        </tbody>
      </table>
    </div>
  );
}

/** Conditions, last vitals, last visit — compact, and linked, never a chart. */
function ContextPanel({ context, onOpenAllergies, onOpenConditions, onOpenTests, onOpenCare, onOpenFollowup }) {
  if (!context) return null;
  const v = context.lastVitals;
  return (
    <aside className="ui-med-context" aria-label="Patient context">
      {/* The allergy record (0058), compact, FIRST — it is the fact a
          pharmacist reads before anything else on this screen. Shown, never
          checked against the medicines here: the pharmacist decides. */}
      <AllergySafety summary={context.allergies} onOpen={onOpenAllergies} />
      {/* The problem list (0059): what was recorded, and the purchase
          inference on its own labelled line — never merged. */}
      <ConditionsBrief problems={context.problems} onOpen={onOpenConditions} />
      {/* The last few diagnostic results (0060), shown — never checked
          against the medicines on this screen. */}
      <TestsBrief tests={context.tests} onOpen={onOpenTests} />
      {/* The care programmes (0061): what this patient is being followed for,
          and whether a task is late. A pointer, like every other panel here —
          nothing on this screen starts or changes a programme. */}
      <CareProgramsBrief carePrograms={context.carePrograms} onOpen={onOpenCare} />
      {/* What needs to happen next (0062). A pointer, like every other panel
          here — nothing on this screen creates or completes a follow-up. */}
      <FollowupsBrief followups={context.followups} onOpen={onOpenFollowup} />
      <div>
        <h3><IconPulse width={14} height={14} aria-hidden="true" /> Last vitals</h3>
        {v
          ? (
            <p>
              {[
                v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic} mmHg` : null,
                v.pulse ? `${v.pulse} bpm` : null,
                v.temperature ? `${v.temperature} °C` : null,
              ].filter(Boolean).join(' · ') || '—'}
              <span className="ui-med-context-when">{medDate(v.recordedAt)}</span>
            </p>
          )
          : <p className="ui-med-context-none">Not recorded</p>}
      </div>
    </aside>
  );
}

export default function Medications({ customerId, onOpenTab }) {
  const [tab, setTab] = useState('current');
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [context, setContext] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);       // a medication, or 'new'

  const load = useCallback(async () => {
    try {
      const [list, ctx] = await Promise.all([
        fetch(`/api/customers/${customerId}/medications`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this patient\'s medication.')))),
        fetch(`/api/customers/${customerId}/medication-context`)
          .then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setData(list);
      setContext(ctx);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/medications/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  if (error) {
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const all = data.medications;
  const current = all.filter((m) => m.status === 'active' || m.status === 'draft');
  const history = all.filter((m) => !['active', 'draft'].includes(m.status));
  const filtered = filter ? history.filter((m) => m.status === filter) : history;

  return (
    <section className="ui-meds">
      <header className="ui-meds-head">
        <h2>Medications</h2>
        <button type="button" onClick={() => setEditing('new')} className="ui-meds-add">
          <IconPill width={15} height={15} aria-hidden="true" />
          Add medication
        </button>
      </header>

      <div role="tablist" aria-label="Medication sections" className="ui-vitals-tabs">
        {MED_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`ui-vitals-tab ${tab === t.id ? 'is-on' : ''}`}
          >
            {t.label}
            {t.id === 'current' && data.counts.current > 0 && (
              <span className="ui-pcount">{data.counts.current}</span>
            )}
          </button>
        ))}
      </div>

      <div className="ui-meds-body">
        <div className="min-w-0 flex-1">
          {tab === 'current' && (
            current.length === 0
              ? (
                <div className="ui-meds-empty">
                  <p className="ui-meds-empty-title">No medications recorded</p>
                  <p>Add this patient&rsquo;s current medication, or record a historical one.</p>
                  <button type="button" onClick={() => setEditing('new')} className="ui-meds-add">
                    <IconPill width={15} height={15} aria-hidden="true" />
                    Add medication
                  </button>
                </div>
              )
              : (
                <>
                  <p className="ui-meds-count">{medicationsSummary(data.counts, 'current')}</p>
                  <MedicationTable medications={current} onEdit={setEditing} />
                </>
              )
          )}

          {tab === 'history' && (
            <>
              <div className="ui-meds-filters" role="group" aria-label="Filter history by status">
                {HISTORY_FILTERS.map((f) => (
                  <button
                    key={f.value || 'all'}
                    type="button"
                    aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)}
                    className={`ui-quick-filter ${filter === f.value ? 'is-on' : ''}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {filtered.length === 0
                ? <p className="ui-meds-count">Nothing in the history.</p>
                : groupByMonth(filtered).map((month) => (
                  <section key={month.key} className="ui-med-month">
                    <h3>{month.label}</h3>
                    <MedicationTable medications={month.medications} onEdit={setEditing} />
                  </section>
                ))}
            </>
          )}

          {tab === 'review' && (
            <MedicationReview
              customerId={customerId}
              onMedicationsChanged={load}
              context={context}
              onOpenTab={onOpenTab}
            />
          )}
        </div>

        {tab !== 'review' && <ContextPanel context={context} onOpenAllergies={() => onOpenTab?.('allergies')} onOpenConditions={() => onOpenTab?.('conditions')} onOpenTests={() => onOpenTab?.('results')} onOpenCare={() => onOpenTab?.('care')} onOpenFollowup={() => onOpenTab?.('followup')} />}
      </div>

      {editing && (
        <MedicationForm
          customerId={customerId}
          medication={editing === 'new' ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </section>
  );
}

/** Add or edit, in the record panel the app already uses for vitals. */
function MedicationForm({ customerId, medication, options, onClose, onSaved }) {
  const [form, setForm] = useState(() => (medication
    ? {
      medicineName: medication.medicineName || '',
      genericName: medication.genericName || '',
      brandName: medication.brandName || '',
      strength: medication.strength || '',
      form: medication.form || '',
      dose: medication.dose || '',
      route: medication.route || '',
      frequency: medication.frequency || '',
      timing: medication.timing || '',
      durationDays: medication.durationDays ?? '',
      startedOn: medication.startedOn || '',
      endedOn: medication.endedOn || '',
      indication: medication.indication || '',
      prescriberName: medication.prescriber?.name || '',
      instructions: medication.instructions || '',
      notes: medication.notes || '',
      source: medication.source || 'prescribed',
      status: medication.status || 'active',
      stopReason: medication.stopReason || '',
    }
    // Sensible defaults rather than eighteen empty boxes: what a pharmacist
    // writes up is overwhelmingly an oral tablet, taken once a day, that the
    // patient is on now.
    : {
      medicineName: '', form: 'tablet', route: 'oral', frequency: 'once_daily',
      source: 'prescribed', status: 'active', durationDays: '',
    }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const url = medication
        ? `/api/customers/${customerId}/medications/${medication.id}`
        : `/api/customers/${customerId}/medications`;
      const r = await fetch(url, {
        method: medication ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error || 'Could not save this medication.'), { field: body.field });
      onSaved(body);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');
  const pick = (name) => options?.[name] || [];

  return (
    <div className="ui-vital-sheet" role="dialog" aria-modal="true" aria-label={medication ? 'Edit medication' : 'Add medication'}>
      <form onSubmit={save} className="ui-vital-sheet-inner">
        <header className="ui-vital-sheet-head">
          <h3>{medication ? 'Edit medication' : 'Add medication'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="ui-icon-btn">×</button>
        </header>

        <div className="ui-vital-sheet-body">
          <label className="ui-med-field">
            <span className="ui-vital-label">Medication</span>
            <input
              autoFocus
              value={form.medicineName || ''}
              onChange={(e) => set('medicineName', e.target.value)}
              placeholder="Amlodipine"
              className={`ui-vital-input ${wrong('medicineName')}`}
            />
          </label>

          <div className="ui-med-grid">
            <label className="ui-med-field">
              <span className="ui-vital-label">Strength</span>
              <input value={form.strength || ''} onChange={(e) => set('strength', e.target.value)} placeholder="10 mg" className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Form</span>
              <select value={form.form || ''} onChange={(e) => set('form', e.target.value)} className="ui-vital-input">
                <option value="">—</option>
                {pick('form').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Dose</span>
              <input value={form.dose || ''} onChange={(e) => set('dose', e.target.value)} placeholder="1 tablet" className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Route</span>
              <select value={form.route || ''} onChange={(e) => set('route', e.target.value)} className="ui-vital-input">
                <option value="">—</option>
                {pick('route').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Frequency</span>
              <select value={form.frequency || ''} onChange={(e) => set('frequency', e.target.value)} className="ui-vital-input">
                <option value="">—</option>
                {pick('frequency').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Duration (days)</span>
              <input
                type="number"
                min="1"
                value={form.durationDays ?? ''}
                onChange={(e) => set('durationDays', e.target.value)}
                placeholder="Ongoing"
                className={`ui-vital-input ${wrong('durationDays')}`}
              />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Started</span>
              <input type="date" value={form.startedOn || ''} onChange={(e) => set('startedOn', e.target.value)} className={`ui-vital-input ${wrong('startedOn')}`} />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Ended</span>
              <input type="date" value={form.endedOn || ''} onChange={(e) => set('endedOn', e.target.value)} className={`ui-vital-input ${wrong('endedOn')}`} />
            </label>
          </div>

          <div className="ui-med-grid mt-3">
            <label className="ui-med-field">
              <span className="ui-vital-label">Indication</span>
              <input value={form.indication || ''} onChange={(e) => set('indication', e.target.value)} placeholder="Hypertension" className="ui-vital-input" />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Prescriber</span>
              <input value={form.prescriberName || ''} onChange={(e) => set('prescriberName', e.target.value)} placeholder="Dr John" className={`ui-vital-input ${wrong('prescriberName')}`} />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Source</span>
              <select value={form.source || 'prescribed'} onChange={(e) => set('source', e.target.value)} className="ui-vital-input">
                {pick('source').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">Status</span>
              <select value={form.status || 'active'} onChange={(e) => set('status', e.target.value)} className="ui-vital-input">
                {pick('status').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {/* Only when it is needed — stopping is the one ending that has to
              say why, and the field appearing is how the form says so. */}
          {form.status === 'stopped' && (
            <label className="ui-med-field mt-3">
              <span className="ui-vital-label">Why was it stopped?</span>
              <input
                value={form.stopReason || ''}
                onChange={(e) => set('stopReason', e.target.value)}
                placeholder="Swollen ankles"
                className={`ui-vital-input ${wrong('stopReason')}`}
              />
            </label>
          )}

          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Instructions for the patient</span>
            <textarea rows={2} value={form.instructions || ''} onChange={(e) => set('instructions', e.target.value)} placeholder="Take after food." className="w-full px-3 py-2 text-[13px]" />
          </label>
          <label className="ui-med-field mt-3">
            <span className="ui-vital-label">Pharmacist notes</span>
            <textarea rows={2} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} className="w-full px-3 py-2 text-[13px]" />
          </label>

          {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
        </div>

        <footer className="ui-vital-sheet-foot">
          <button type="button" onClick={onClose} className="ui-vital-cancel">Cancel</button>
          <button type="submit" disabled={saving} className="ui-vital-save">
            {saving ? 'Saving…' : medication ? 'Save changes' : 'Add medication'}
          </button>
        </footer>
      </form>
    </div>
  );
}
