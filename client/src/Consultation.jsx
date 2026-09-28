/**
 * The pharmacist's consultation workspace.
 *
 * See CONSULTATION_PLAN.md. This is the assessment layer beside the triage
 * DESK (`Consultations.jsx`), which is unchanged and keeps its name: the desk
 * answers "is this safe and appropriate for a pharmacy consultation", and this
 * answers "what did the pharmacist assess and do".
 *
 * IT DOCUMENTS; IT DOES NOT DECIDE (§36). Nothing on this screen creates a
 * Condition, an Allergy, a Medication or a Vitals reading as a side effect, no
 * intervention is generated, no referral is inferred from symptoms and no
 * treatment is recommended. A measurement taken during a consultation is
 * recorded in Vitals and pointed at; a diagnosis becomes a Condition only when
 * a pharmacist writes it down in Conditions.
 *
 * WHY THE SECTIONS ARE NOT ALL OPEN AT ONCE (§34)
 * A routine minor ailment should take a pharmacist under a minute. The type
 * decides which sections open first — that is `emphasis`, which comes from the
 * server as data — and the rest stay one click away rather than as twenty
 * empty boxes to scroll past.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Loading from './Loading.jsx';
import { readRecords } from './recordPicker.js';
import {
  statusLabel, statusTone, isOpen, whenLabel, dayLabel,
  reasonLine, outstandingLine, redFlagLine, summaryLines,
  problemLine, referralLine, RECORD_GONE, REFERRAL_NOT_CONSIDERED,
  NO_PROBLEMS, NO_INTERVENTIONS, NO_TRIAGE, EMPTY,
  amendedNote, canAmend, historyLine, snapshotLines, AMEND_RETIRED, NO_HISTORY,
} from './consultationFormat.js';

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'Something went wrong.');
    err.code = body.code;
    err.status = res.status;
    err.outstanding = body.outstanding;
    throw err;
  }
  return body;
}

/**
 * One write, answered with the whole fresh note.
 *
 * Every phase-2 endpoint returns the consultation as it now stands, so the
 * screen never reconstructs what the server did — which is how a screen ends
 * up disagreeing with the record it is showing.
 */
async function send(url, method, body) {
  return readJson(await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
}

/** A section of the note. Open when the type emphasises it, or when it has content. */
function Section({ id, title, emphasised, filled, children }) {
  const [open, setOpen] = useState(Boolean(emphasised || filled));
  return (
    <section className="ui-psection">
      <h3>
        <button type="button" aria-expanded={open} className="ui-psection-head" onClick={() => setOpen((o) => !o)}>
          <span className="flex-1 text-left">{title}</span>
          {filled && <span className="ui-cprog-quiet" aria-hidden="true">•</span>}
        </button>
      </h3>
      {open && <div className="ui-consult-body" data-section={id}>{children}</div>}
    </section>
  );
}

function Field({ label, value, onChange, placeholder, rows = 3, disabled }) {
  return (
    <label className="ui-consult-field">
      <span className="ui-cprog-quiet">{label}</span>
      {rows === 1
        ? <input type="text" value={value || ''} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        : <textarea rows={rows} value={value || ''} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/**
 * §6 — the triage summary, read from the episode.
 *
 * Read-only by design: the brief is explicit that Consultation receives triage
 * rather than re-asking it, and nothing here is editable. Where there is no
 * episode the panel says so, rather than rendering an empty one that would
 * read as "triage found nothing".
 */
function TriagePanel({ triage, onOpenConversation }) {
  if (!triage) return <p className="ui-allergy-help">{NO_TRIAGE}</p>;
  const flags = redFlagLine(triage);
  return (
    <div className="ui-consult-triage">
      <dl>
        <div><dt>Chief concern</dt><dd>{triage.chiefConcern || EMPTY.notRecorded}</dd></div>
        {triage.duration && <div><dt>Duration</dt><dd>{triage.duration}</dd></div>}
        {triage.severity && <div><dt>Severity</dt><dd>{triage.severity}</dd></div>}
        <div>
          <dt>Red flags</dt>
          <dd className={flags?.tone || ''}>{flags?.text}</dd>
        </div>
        {triage.reportedSymptoms && (
          <div><dt>Reported</dt><dd>{triage.reportedSymptoms}</dd></div>
        )}
      </dl>
      {triage.conversationId && onOpenConversation && (
        <button type="button" className="ui-psection-link" onClick={() => onOpenConversation(triage.conversationId)}>
          View the conversation
        </button>
      )}
    </div>
  );
}

/** §22 — assembled by the server from what was entered, and printed as-is. */
function SummaryPanel({ summary }) {
  const lines = summaryLines(summary);
  if (lines.length === 0) {
    return <p className="ui-allergy-help">Nothing has been recorded yet, so there is nothing to summarise.</p>;
  }
  return (
    <dl className="ui-consult-summary">
      {lines.map((l) => (
        <div key={l.id}><dt>{l.label}</dt><dd>{l.text}</dd></div>
      ))}
    </dl>
  );
}

/* ==========================================================================
 * Phase 2 — the problem list, what was done, and where the patient was sent
 *
 * All five panels below write through their own endpoint and are handed back
 * the whole fresh note, so the screen never has to reconstruct what the server
 * did. None of them creates anything in another section: a problem POINTS at a
 * condition, an intervention points at a problem, and the care programme is a
 * pointer at a programme somebody else enrolled the patient in.
 * ======================================================================== */

/** Pick a record this problem is about, from the section that owns it (§12). */
function RecordPointer({ customerId, kind, value, onPick, disabled }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    if (!kind) { setRows([]); return undefined; }
    readRecords(kind, customerId, dayLabel).then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [customerId, kind]);

  if (!kind) return null;
  if (rows === null) return <p className="ui-meds-count"><Loading /></p>;
  if (rows.length === 0) {
    // Said plainly, because the alternative is an empty select that a
    // pharmacist reads as "the record is not there" when it is in a section
    // they have not opened.
    return <p className="ui-allergy-help">This patient has no records of that kind yet.</p>;
  }
  return (
    <label className="ui-consult-field">
      <span className="ui-cprog-quiet">Which record</span>
      <select value={value || ''} disabled={disabled} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">Choose one</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>{[r.label, r.detail].filter(Boolean).join(' — ')}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * §11 / §12 — the problem list.
 *
 * The certainty is part of the label, because "angina" and "possible angina"
 * are different clinical statements. Nothing here writes a Condition: §36 is
 * explicit that a diagnosis becomes a Condition only when a pharmacist records
 * one in Conditions, and the help text says so on the screen rather than only
 * in a comment nobody reads.
 */
function ProblemList({ customerId, note, options, open, onNote }) {
  const BLANK = { label: '', certainty: 'possible', status: 'under_assessment', refKind: '', refId: null, note: '' };
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const reset = () => {
    setDraft(BLANK);
    setAdding(false);
    setError(null);
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/problems`, 'POST', {
        label: draft.label,
        certainty: draft.certainty,
        status: draft.status,
        refKind: draft.refKind || null,
        refId: draft.refKind ? draft.refId : null,
        note: draft.note || null,
      }));
      reset();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/problems/${id}`, 'DELETE'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const problems = note.problems || [];

  return (
    <>
      <p className="ui-allergy-help">
        What you are assessing, with your own level of certainty. Nothing here creates a
        Condition on the patient&rsquo;s record — record one in Conditions when you are
        ready to.
      </p>
      {error && <p className="ui-allergy-failed">{error}</p>}

      {problems.length === 0
        ? <p className="ui-meds-count">{NO_PROBLEMS}</p>
        : (
          <ol className="ui-consult-problems">
            {problems.map((p, i) => {
              const line = problemLine(p, options?.certainty || [], options?.problemStatuses || []);
              return (
                <li key={p.id}>
                  <span className="ui-cprog-name">{i + 1}. {line.label}</span>
                  {line.status && <span className="ui-cprog-card-meta">{line.status}</span>}
                  {p.refKind && (
                    <span className="ui-cprog-card-meta">
                      {line.gone ? RECORD_GONE : line.record?.label}
                    </span>
                  )}
                  {p.note && <span className="ui-cprog-card-meta">{p.note}</span>}
                  {open && (
                    <button type="button" className="ui-psection-link" disabled={busy} onClick={() => remove(p.id)}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

      {open && !adding && (
        <button type="button" className="ui-psection-link" onClick={() => setAdding(true)}>Add a problem</button>
      )}

      {open && adding && (
        <div className="ui-consult-add">
          <Field label="Problem" rows={1} value={draft.label} disabled={busy}
            placeholder="Elevated blood pressure" onChange={(v) => setDraft((d) => ({ ...d, label: v }))} />
          <label className="ui-consult-field">
            <span className="ui-cprog-quiet">How certain</span>
            <select value={draft.certainty} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, certainty: e.target.value }))}>
              {(options?.certainty || []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label className="ui-consult-field">
            <span className="ui-cprog-quiet">Status</span>
            <select value={draft.status} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
              {(options?.problemStatuses || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="ui-consult-field">
            <span className="ui-cprog-quiet">About a record (optional)</span>
            <select value={draft.refKind} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, refKind: e.target.value, refId: null }))}>
              <option value="">Not about a particular record</option>
              {(options?.problemRefKinds || []).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </label>
          <RecordPointer customerId={customerId} kind={draft.refKind} value={draft.refId} disabled={busy}
            onPick={(refId) => setDraft((d) => ({ ...d, refId }))} />
          <Field label="Note (optional)" rows={2} value={draft.note} disabled={busy}
            onChange={(v) => setDraft((d) => ({ ...d, note: v }))} />
          <div className="ui-followup-head">
            <button type="button" className="ui-cprog-check" disabled={busy || !draft.label.trim()} onClick={add}>
              {busy ? 'Saving…' : 'Add'}
            </button>
            <button type="button" className="ui-psection-link" disabled={busy} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * §14 — what the pharmacist did.
 *
 * Every entry is chosen by a person. §36: no intervention is generated, and
 * nothing reads the assessment and suggests one.
 */
function InterventionList({ customerId, note, options, open, onNote }) {
  const [draft, setDraft] = useState({ kind: '', problemId: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/interventions`, 'POST', {
        kind: draft.kind, problemId: draft.problemId || null, note: draft.note || null,
      }));
      setDraft({ kind: '', problemId: '', note: '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/interventions/${id}`, 'DELETE'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const problems = note.problems || [];
  const list = note.interventions || [];
  const kindLabel = (id) => (options?.interventions || []).find((i) => i.id === id)?.label || id;
  // "Problem 3" rather than a copy of its label: the problem list is right
  // above, numbered the same way, and a copy would go stale when it is edited.
  const about = (problemId) => {
    const i = problems.findIndex((p) => p.id === problemId);
    return i < 0 ? null : `Problem ${i + 1}`;
  };

  return (
    <>
      {error && <p className="ui-allergy-failed">{error}</p>}
      {list.length === 0
        ? <p className="ui-meds-count">{NO_INTERVENTIONS}</p>
        : (
          <ul className="ui-consult-problems">
            {list.map((iv) => (
              <li key={iv.id}>
                <span className="ui-cprog-name">{kindLabel(iv.kind)}</span>
                {about(iv.problemId) && <span className="ui-cprog-card-meta">{about(iv.problemId)}</span>}
                {iv.note && <span className="ui-cprog-card-meta">{iv.note}</span>}
                {open && (
                  <button type="button" className="ui-psection-link" disabled={busy} onClick={() => remove(iv.id)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

      {open && (
        <div className="ui-consult-add">
          <label className="ui-consult-field">
            <span className="ui-cprog-quiet">What you did</span>
            <select value={draft.kind} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}>
              <option value="">Choose one</option>
              {(options?.interventions || []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
            </select>
          </label>
          {problems.length > 0 && (
            <label className="ui-consult-field">
              <span className="ui-cprog-quiet">About which problem (optional)</span>
              <select value={draft.problemId} disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, problemId: e.target.value }))}>
                <option value="">The consultation as a whole</option>
                {problems.map((p, i) => <option key={p.id} value={p.id}>{i + 1}. {p.label}</option>)}
              </select>
            </label>
          )}
          <Field label="Note (optional)" rows={2} value={draft.note} disabled={busy}
            onChange={(v) => setDraft((d) => ({ ...d, note: v }))} />
          <button type="button" className="ui-cprog-check" disabled={busy || !draft.kind} onClick={add}>
            {busy ? 'Saving…' : 'Record it'}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * §17 — the referral decision.
 *
 * THE DISTINCTION THIS PANEL EXISTS FOR. The select starts on "Not recorded",
 * which is not an option a pharmacist chooses — it is where the note sits
 * until somebody decides. "No referral required" is a DECISION, stored
 * separately, so a note nobody was asked about shows nothing at all rather
 * than a reassurance nobody gave.
 *
 * Nothing is inferred. §17 requires a validated clinical rule before software
 * suggests a referral, and this product has none.
 */
function ReferralPanel({ customerId, note, options, open, onNote }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const current = referralLine(note, options?.referralDestinations || [], options?.referralUrgency || []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/referral`, 'PUT', {
        destination: draft.destination || null,
        reason: draft.reason || null,
        urgency: draft.urgency || null,
        notes: draft.notes || null,
      }));
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <p className="ui-allergy-failed">{error}</p>}
      {!draft && (
        <>
          {current
            ? (
              <dl className="ui-consult-summary">
                <div>
                  <dt>Referral</dt>
                  {/* The tone goes on a PILL, never on the dd. A dd is a
                      full-width block, so a tone class there paints a tinted
                      bar across the whole panel — and the summary rule wins
                      the colour, so the text is not even amber. Emphasis in
                      this app is a pill; this is one. */}
                  <dd>
                    {current.tone
                      ? <span className={`ui-cprog-pill ${current.tone}`}>{current.destination}</span>
                      : current.destination}
                  </dd>
                </div>
                {current.urgency && <div><dt>Urgency</dt><dd>{current.urgency}</dd></div>}
                {current.reason && <div><dt>Why</dt><dd>{current.reason}</dd></div>}
                {note.referralNotes && <div><dt>Notes</dt><dd>{note.referralNotes}</dd></div>}
              </dl>
            )
            : (
              <p className="ui-meds-count">
                {REFERRAL_NOT_CONSIDERED} — nobody has recorded a referral decision for this
                consultation.
              </p>
            )}
          {open && (
            <button type="button" className="ui-psection-link"
              onClick={() => setDraft({
                destination: note.referralDestination || '',
                reason: note.referralReason || '',
                urgency: note.referralUrgency || '',
                notes: note.referralNotes || '',
              })}>
              {current ? 'Change the referral decision' : 'Record a referral decision'}
            </button>
          )}
        </>
      )}

      {draft && (
        <div className="ui-consult-add">
          <label className="ui-consult-field">
            <span className="ui-cprog-quiet">Referral</span>
            <select value={draft.destination} disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, destination: e.target.value }))}>
              <option value="">Not recorded — leave this undecided</option>
              {(options?.referralDestinations || []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          {draft.destination && draft.destination !== 'none' && (
            <label className="ui-consult-field">
              <span className="ui-cprog-quiet">Urgency</span>
              <select value={draft.urgency} disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, urgency: e.target.value }))}>
                <option value="">Not stated</option>
                {(options?.referralUrgency || []).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </label>
          )}
          {draft.destination && (
            <Field
              label={draft.destination === 'none' ? 'Why not (optional)' : 'Why you are referring'}
              rows={2} value={draft.reason} disabled={busy}
              placeholder="Persistent elevated BP despite treatment"
              onChange={(v) => setDraft((d) => ({ ...d, reason: v }))} />
          )}
          {draft.destination && (
            <Field label="Notes (optional)" rows={2} value={draft.notes} disabled={busy}
              onChange={(v) => setDraft((d) => ({ ...d, notes: v }))} />
          )}
          <div className="ui-followup-head">
            <button type="button" className="ui-cprog-check" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="ui-psection-link" disabled={busy}
              onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** §16 — what was unclear about a prescription, and what the prescriber said. */
function PrescriptionPanel({ customerId, note, options, open, onNote }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);

  const issues = note.prescriptionIssues || [];
  const recorded = issues.length > 0 || Boolean(note.prescriberContactedAt);
  const issueLabel = (id) => (options?.prescriptionIssues || []).find((p) => p.id === id)?.label || id;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/prescription`, 'PUT', {
        issues: draft.issues,
        prescriberContacted: draft.contacted,
        prescriberOutcome: draft.outcome || null,
      }));
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <p className="ui-allergy-failed">{error}</p>}
      {!draft && (
        <>
          {recorded
            ? (
              <dl className="ui-consult-summary">
                {issues.length > 0 && (
                  <div><dt>What was unclear</dt><dd>{issues.map(issueLabel).join(', ')}</dd></div>
                )}
                {note.prescriberContactedAt && (
                  <div><dt>Prescriber contacted</dt><dd>{dayLabel(note.prescriberContactedAt)}</dd></div>
                )}
                {note.prescriberOutcome && <div><dt>What they said</dt><dd>{note.prescriberOutcome}</dd></div>}
              </dl>
            )
            : <p className="ui-meds-count">{EMPTY.notRecorded}</p>}
          {open && (
            <button type="button" className="ui-psection-link"
              onClick={() => setDraft({
                issues: [...issues],
                contacted: Boolean(note.prescriberContactedAt),
                outcome: note.prescriberOutcome || '',
              })}>
              {recorded ? 'Change this' : 'Record a prescription review'}
            </button>
          )}
        </>
      )}

      {draft && (
        <div className="ui-consult-add">
          <div className="ui-consult-actions">
            {(options?.prescriptionIssues || []).map((p) => {
              const on = draft.issues.includes(p.id);
              return (
                <label key={p.id} className="ui-cprog-check">
                  <input type="checkbox" checked={on} disabled={busy}
                    onChange={() => setDraft((d) => ({
                      ...d,
                      issues: on ? d.issues.filter((x) => x !== p.id) : [...d.issues, p.id],
                    }))} />
                  {p.label}
                </label>
              );
            })}
          </div>
          <label className="ui-cprog-check">
            <input type="checkbox" checked={draft.contacted} disabled={busy}
              onChange={() => setDraft((d) => ({ ...d, contacted: !d.contacted }))} />
            The prescriber was contacted
          </label>
          {/* An outcome with nobody contacted is a sentence nobody can
              attribute, which is why the server refuses it. */}
          {draft.contacted && (
            <Field label="What they said" rows={2} value={draft.outcome} disabled={busy}
              onChange={(v) => setDraft((d) => ({ ...d, outcome: v }))} />
          )}
          <div className="ui-followup-head">
            <button type="button" className="ui-cprog-check" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="ui-psection-link" disabled={busy}
              onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * §21 — the care programme this consultation belongs to.
 *
 * A POINTER, and nothing more. Nothing here enrols anybody, changes a
 * programme's plan or ticks off an activity: the Care program section owns all
 * of that, and a consultation that could quietly enrol somebody would be the
 * second task system CARE_PROGRAM_PLAN.md exists to prevent.
 */
function CareProgramPanel({ customerId, note, context, open, onNote }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const active = context?.carePrograms?.active || [];
  const current = active.find((p) => p.id === note.careProgramId);

  const point = async (id) => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/care-program`, 'PUT', {
        careProgramId: id || null,
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ui-allergy-help">
        Points this consultation at a programme the patient is already on. Nothing here
        enrols anybody or changes a programme&rsquo;s plan.
      </p>
      {error && <p className="ui-allergy-failed">{error}</p>}
      {active.length === 0
        ? <p className="ui-meds-count">This patient is not on a care programme.</p>
        : open
          ? (
            <label className="ui-consult-field">
              <span className="ui-cprog-quiet">Care programme</span>
              <select value={note.careProgramId || ''} disabled={busy}
                onChange={(e) => point(e.target.value || null)}>
                <option value="">Not part of a programme</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.programName}</option>)}
              </select>
            </label>
          )
          : <p className="ui-meds-count">{current ? current.programName : 'Not part of a programme'}</p>}
    </>
  );
}

/* ==========================================================================
 * Phase 3 — amending a finalised note, and its history (§32)
 * ======================================================================== */

/**
 * §32 — reopen a finalised note to correct it.
 *
 * The reason box is REQUIRED and the server refuses without one. It is asked
 * for here rather than after the edit for a reason: at the moment a pharmacist
 * decides to correct a record they know why, and asking afterwards produces
 * "updated" on every entry in the history.
 *
 * Amending does not edit anything. It reopens the note, and the ordinary
 * workspace above does the editing — so there is no second set of fields that
 * could accept something the normal one refuses.
 */
function AmendPanel({ customerId, note, onNote }) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const amend = async () => {
    setBusy(true);
    setError(null);
    try {
      onNote(await send(`/api/customers/${customerId}/consultations/${note.id}/amendment`, 'POST', { reason }));
      setReason('');
      setAsking(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!canAmend(note)) return null;

  return (
    <div className="ui-consult-amend">
      {error && <p className="ui-allergy-failed">{error}</p>}
      {!asking
        ? (
          <>
            <p className="ui-allergy-help">
              This note is finalised. Correcting it keeps what it said, with your reason,
              and reopens it so you can edit and sign it again.
            </p>
            <button type="button" className="ui-psection-link" onClick={() => setAsking(true)}>
              Amend this note
            </button>
          </>
        )
        : (
          <>
            <Field
              label="Why are you amending it?" rows={2} value={reason} disabled={busy}
              placeholder="BP was 148/92, not 149/92"
              onChange={setReason} />
            <div className="ui-followup-head">
              <button type="button" className="ui-cprog-check" disabled={busy || reason.trim().length < 3} onClick={amend}>
                {busy ? 'Reopening…' : 'Amend and reopen'}
              </button>
              <button type="button" className="ui-psection-link" disabled={busy}
                onClick={() => { setAsking(false); setReason(''); setError(null); }}>
                Cancel
              </button>
            </div>
          </>
        )}
    </div>
  );
}

/**
 * §32 — what has happened to this note.
 *
 * THIS note's history, not the patient's: the patient's whole timeline is its
 * own screen, and mixing them would bury eight events under three hundred
 * messages. Each amendment shows what the note SAID, because a history that
 * says "amended, and here is why" without saying what it said is a changelog,
 * not an audit trail.
 *
 * Loaded on demand: Section mounts its children only once it is opened, so a
 * pharmacist reading a note does not wait on eight more rows they did not ask
 * for.
 */
function HistoryPanel({ customerId, note }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetch(`/api/customers/${customerId}/consultations/${note.id}/history`)
      .then(readJson)
      .then((h) => { if (live) setData(h); })
      // A history that failed to load says so. It must NOT render as an empty
      // one, which reads as "nothing has happened to this note".
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
    // note.updatedAt: re-read after an amendment, so the panel is never stale.
  }, [customerId, note.id, note.updatedAt]);

  if (error) return <p className="ui-allergy-failed">{error}</p>;
  if (!data) return <Loading />;

  const { events = [], amendments = [] } = data;
  if (events.length === 0 && amendments.length === 0) {
    return <p className="ui-meds-count">{NO_HISTORY}</p>;
  }

  return (
    <>
      {amendments.length > 0 && (
        <ul className="ui-consult-amendments">
          {amendments.map((a, i) => (
            <li key={a.id}>
              <span className="ui-cprog-name">
                {amendments.length - i === 1 ? 'Amendment' : `Amendment ${amendments.length - i}`}
                {' — '}{a.reason}
              </span>
              <span className="ui-cprog-card-meta">
                {[dayLabel(a.at), a.by].filter(Boolean).join(' · ')}
              </span>
              {/* What the note SAID, exactly as it read. Never recomputed. */}
              <dl className="ui-consult-summary">
                {snapshotLines(a).map((l) => (
                  <div key={l.id}><dt>{l.label}</dt><dd>{l.text}</dd></div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}

      <ol className="ui-consult-events">
        {events.map((e) => {
          const line = historyLine(e);
          return (
            <li key={e.id}>
              <span className="ui-cprog-name">{line.label}</span>
              {line.reason && <span className="ui-cprog-card-meta">{line.reason}</span>}
              <span className="ui-cprog-card-meta">
                {[line.when, line.who].filter(Boolean).join(' · ')}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** One consultation, open. */
export default function Consultation({ customerId, consultationId, onBack, onOpenConversation, onChanged }) {
  const [note, setNote] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState({});
  const [context, setContext] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setNote(await readJson(await fetch(`/api/customers/${customerId}/consultations/${consultationId}`)));
    } catch (e) {
      // §34's error handling: a load failure says so. It does NOT render as an
      // empty note, which a pharmacist would start typing into.
      setNote(null);
      setError(e.message);
    }
  }, [customerId, consultationId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/consultations/options`)
      .then(readJson).then((o) => { if (live) setOptions(o); }).catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  // §21's programme list comes from the clinical context the Medications
  // screen already reads. One read, so the consultation and the medicine write-up
  // cannot disagree about what this patient is being followed for.
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/consultations/context`)
      .then(readJson).then((c) => { if (live) setContext(c); }).catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const emphasis = useMemo(() => new Set(note?.definition?.emphasis || []), [note]);

  const set = (key, value) => {
    setNote((n) => ({ ...n, [key]: value }));
    setDirty((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    if (Object.keys(dirty).length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await readJson(await fetch(
        `/api/customers/${customerId}/consultations/${consultationId}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dirty) },
      ));
      setNote(saved);
      setDirty({});
      onChanged?.();
    } catch (e) {
      // The typing stays on screen. It was not saved, and nobody should have
      // to retype a clinical note.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const finalise = async () => {
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(dirty).length > 0) await save();
      const done = await readJson(await fetch(
        `/api/customers/${customerId}/consultations/${consultationId}/completion`,
        { method: 'POST' },
      ));
      setNote(done);
      onChanged?.();
    } catch (e) {
      setError(outstandingLine(e.outstanding) || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !note) return <p className="ui-allergy-failed">{error}</p>;
  if (!note) return <Loading />;

  const open = isOpen(note);
  const tone = statusTone(note.status);
  const blocking = outstandingLine(note.outstanding);

  return (
    <div className="ui-consult">
      <div className="ui-followup-head">
        {onBack && <button type="button" className="ui-psection-link" onClick={onBack}>← Consultations</button>}
        <span className={`ui-cprog-pill ${tone || ''}`}>{statusLabel(note.status)}</span>
        {/* §32. Absent entirely on a note nobody has corrected — see
            `amendedNote`, which says nothing rather than "Original". */}
        {amendedNote(note) && (
          <span className="ui-cprog-quiet">{amendedNote(note)}</span>
        )}
      </div>

      <h2 className="ui-followup-title">{note.typeLabel || note.consultationType}</h2>
      <p className="ui-followup-context">
        {whenLabel(note.startedAt)}
        {note.completedAt ? ` · finalised ${dayLabel(note.completedAt)}` : ''}
      </p>

      {note.status === 'entered_in_error' && (
        <p className="ui-allergy-failed">
          Entered in error{note.errorReason ? ` — ${note.errorReason}` : ''}. This note is
          kept as a record of what was written; it is not deleted. {AMEND_RETIRED}
        </p>
      )}

      {error && <p className="ui-allergy-failed">{error}</p>}

      <Section id="triage" title="Triage summary" emphasised={Boolean(note.triage)} filled={Boolean(note.triage)}>
        <TriagePanel triage={note.triage} onOpenConversation={onOpenConversation} />
      </Section>

      <Section id="reason" title="Reason" emphasised filled={Boolean(reasonLine(note, options?.reasons || []))}>
        <label className="ui-consult-field">
          <span className="ui-cprog-quiet">Reason</span>
          <select value={note.reasonCode || ''} disabled={!open || busy} onChange={(e) => set('reasonCode', e.target.value || null)}>
            <option value="">Not stated</option>
            {(options?.reasons || []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <Field label="In your words" rows={1} value={note.reasonText} disabled={!open || busy}
          placeholder="Cough for four days" onChange={(v) => set('reasonText', v)} />
        <Field label="Duration" rows={1} value={note.durationText} disabled={!open || busy}
          placeholder="3 days" onChange={(v) => set('durationText', v)} />
        <Field label="What the patient wants to know" value={note.patientGoal} disabled={!open || busy}
          placeholder="Whether the dizziness is the new medicine" onChange={(v) => set('patientGoal', v)} />
      </Section>

      <Section id="subjective" title="Subjective" emphasised={emphasis.has('subjective')} filled={Boolean(note.subjective)}>
        <Field label="What the patient reported" rows={5} value={note.subjective} disabled={!open || busy}
          placeholder="Onset, duration, what makes it better or worse, what they have already tried"
          onChange={(v) => set('subjective', v)} />
      </Section>

      <Section id="objective" title="Objective" emphasised={emphasis.has('vitals') || emphasis.has('objective')} filled={Boolean(note.objective)}>
        {/* Measurements are recorded in Vitals and read from there. This box is
            for what was observed, not for a number another screen owns. */}
        <p className="ui-allergy-help">
          Measurements belong in Vitals &amp; biometrics, where they can be charted and
          compared. Record what you observed here.
        </p>
        <Field label="What you found" rows={4} value={note.objective} disabled={!open || busy}
          placeholder="General appearance, hydration, anything focused you examined"
          onChange={(v) => set('objective', v)} />
      </Section>

      <Section id="assessment" title="Assessment" emphasised filled={Boolean(note.assessmentText)}>
        <p className="ui-allergy-help">
          Your clinical impression, including the uncertainty — &ldquo;possible&rdquo;,
          &ldquo;provisional&rdquo;, &ldquo;needs evaluation&rdquo;. A definitive diagnosis is
          not required, and nothing here creates a Condition.
        </p>
        <Field label="Assessment" rows={4} value={note.assessmentText} disabled={!open || busy}
          placeholder="Possible medication-related dizziness" onChange={(v) => set('assessmentText', v)} />
      </Section>

      <Section id="problems" title="Problems" emphasised filled={(note.problems || []).length > 0}>
        <ProblemList customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>

      <Section id="interventions" title="What you did"
        emphasised={emphasis.has('interventions')} filled={(note.interventions || []).length > 0}>
        <InterventionList customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>

      <Section id="plan" title="Plan" emphasised filled={Boolean(note.planText || (note.planActions || []).length)}>
        <div className="ui-consult-actions">
          {(options?.planActions || []).map((a) => {
            const on = (note.planActions || []).includes(a.id);
            return (
              <label key={a.id} className="ui-cprog-check">
                <input
                  type="checkbox" checked={on} disabled={!open || busy}
                  onChange={() => set('planActions', on
                    ? note.planActions.filter((x) => x !== a.id)
                    : [...(note.planActions || []), a.id])}
                />
                {a.label}
              </label>
            );
          })}
        </div>
        <Field label="Plan" rows={4} value={note.planText} disabled={!open || busy}
          placeholder="Continue current therapy. Reinforce adherence. Repeat BP in 2 weeks."
          onChange={(v) => set('planText', v)} />
      </Section>

      {/* §17. Absent from the summary until somebody decides — see ReferralPanel. */}
      <Section id="referral" title="Referral"
        emphasised={emphasis.has('referral')} filled={Boolean(note.referralDestination)}>
        <ReferralPanel customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>

      <Section id="prescription" title="Prescription review"
        emphasised={emphasis.has('prescription')}
        filled={(note.prescriptionIssues || []).length > 0 || Boolean(note.prescriberContactedAt)}>
        <PrescriptionPanel customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>

      <Section id="care-program" title="Care programme"
        emphasised={emphasis.has('care_program')} filled={Boolean(note.careProgramId)}>
        <CareProgramPanel customerId={customerId} note={note} context={context} open={open} onNote={setNote} />
      </Section>

      <Section id="summary" title="Consultation summary" emphasised filled>
        <p className="ui-allergy-help">
          Built from what you recorded above. Nothing here is written by a model, and a
          section you left empty is absent rather than reported as none.
        </p>
        <SummaryPanel summary={note.summary} />
      </Section>

      {/* §32. Offered only on a finalised note: a draft is simply edited, and
          a retired one is not amended at all — which the banner above says,
          rather than a section headed with an action that will not happen. */}
      {canAmend(note) && (
        <Section id="amend" title="Amend this note" emphasised={false} filled={Boolean(note.amendmentCount)}>
          <AmendPanel customerId={customerId} note={note} onNote={setNote} />
        </Section>
      )}

      <Section id="history" title="History" emphasised={false} filled={Boolean(note.amendmentCount)}>
        <p className="ui-allergy-help">
          What has happened to this note, and what it said before each correction.
          This is the note&rsquo;s own history — the patient&rsquo;s whole timeline is on
          their record.
        </p>
        <HistoryPanel customerId={customerId} note={note} />
      </Section>

      {open && (
        <div className="ui-followup-head">
          <button type="button" className="ui-psection-link" disabled={busy || !Object.keys(dirty).length} onClick={save}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
          <button type="button" className="ui-cprog-check" disabled={busy} onClick={finalise}>
            Finalise
          </button>
          {blocking && <span className="ui-cprog-quiet">{blocking}</span>}
        </div>
      )}
    </div>
  );
}

/** The patient's consultations (§28), and the way to start a new one. */
export function ConsultationHistory({ customerId, onOpen, onOpenConversation }) {
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await readJson(await fetch(`/api/customers/${customerId}/consultations`)));
    } catch (e) {
      setData(null);
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/consultations/options`)
      .then(readJson).then((o) => { if (live) setOptions(o); }).catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const start = async () => {
    if (!type || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await readJson(await fetch(`/api/customers/${customerId}/consultations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consultationType: type }),
      }));
      setType('');
      await load();
      setOpenId(made.id);
      onOpen?.(made.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (openId) {
    return (
      <Consultation
        customerId={customerId}
        consultationId={openId}
        onBack={() => { setOpenId(null); load(); }}
        onOpenConversation={onOpenConversation}
        onChanged={load}
      />
    );
  }

  return (
    <div className="ui-followup-main">
      <div className="ui-followup-head">
        <h3 className="ui-allergy-heading">Consultations</h3>
      </div>

      <div className="ui-followup-head">
        <label>
          <span className="sr-only">Kind of consultation</span>
          <select value={type} disabled={busy} onChange={(e) => setType(e.target.value)}>
            <option value="">Start a consultation…</option>
            {(options?.types || []).map((t) => <option key={t.slug} value={t.slug}>{t.label}</option>)}
          </select>
        </label>
        <button type="button" className="ui-cprog-check" disabled={busy || !type} onClick={start}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>

      {error && <p className="ui-allergy-failed">{error}</p>}
      {!data && !error && <Loading />}

      {data && data.consultations.length === 0 && (
        <div className="ui-allergy-body">
          <p className="ui-allergy-heading">{EMPTY.none}</p>
          <p className="ui-allergy-help">{EMPTY.noneHelp}</p>
        </div>
      )}

      {data && data.consultations.length > 0 && (
        <ul className="ui-followup-list">
          {data.consultations.map((c) => (
            <li key={c.id}>
              <button type="button" className="ui-followup-subject" onClick={() => setOpenId(c.id)}>
                <span className="ui-followup-title">{c.typeLabel || c.consultationType}</span>
                {reasonLine(c, options?.reasons || []) && (
                  <span className="ui-cprog-said-text">{reasonLine(c, options?.reasons || [])}</span>
                )}
                <span className="ui-cprog-stamp">{dayLabel(c.startedAt)}</span>
                <span className={`ui-cprog-pill ${statusTone(c.status) || ''}`}>{statusLabel(c.status)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
