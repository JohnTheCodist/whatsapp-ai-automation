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
import ConsultationScribe from './ConsultationScribe.jsx';
import {
  statusLabel, statusTone, isOpen, whenLabel, dayLabel,
  reasonLine, outstandingLine, redFlagLine, summaryLines,
  problemLine, referralLine, RECORD_GONE, REFERRAL_NOT_CONSIDERED,
  NO_PROBLEMS, NO_INTERVENTIONS, NO_TRIAGE, EMPTY,
  amendedNote, canAmend, historyLine, snapshotLines, AMEND_RETIRED, NO_HISTORY,
  sectionPlan, bannerFacts, patientLine, contextBlocks,
} from './consultationFormat.js';

/**
 * Read a JSON reply, and say something a pharmacist can act on when it is not
 * one.
 *
 * WHY THIS EXISTS. When the API is unreachable the body is empty or HTML, and
 * a bare `res.json()` throws "Failed to execute 'json' on 'Response':
 * Unexpected end of JSON input" — which is what a pharmacist saw. That is a
 * browser internal, not a fact about their pharmacy, and it tells them nothing
 * about whether their note was saved.
 *
 * §34: the interface must clearly show when something did not happen. "The
 * pharmacy server is not responding" is the honest version, and it is
 * deliberately about the SERVER rather than about the note, because from here
 * we genuinely cannot tell whether the write landed.
 */
async function readJson(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (body === null) {
    // A reply we cannot read at all. On a 2xx this is still a failure: we
    // asked for JSON and got something else, so we must not report success.
    const err = new Error(res.ok
      ? 'The pharmacy server sent a reply this screen could not read. Nothing has been changed on screen.'
      : 'The pharmacy server is not responding. Your work has not been lost — try again in a moment.');
    err.status = res.status;
    err.code = 'UNREADABLE';
    throw err;
  }

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

/* ==========================================================================
 * The redesign — the banner and the patient-context column (§3, §12, §28)
 * ======================================================================== */

/**
 * §12 — the three facts that change what is safe to do, above everything.
 *
 * Allergies first and always. It is the one that stops a recommendation, and
 * the only item here that takes a tone.
 *
 * "Allergies not recorded" and "No known allergies" are DIFFERENT and stay
 * different. The allergy record has distinguished them since 0058, and a
 * banner that flattened them would be the strongest possible place to tell a
 * pharmacist somebody is safe when nobody has ever asked.
 */
function PatientBanner({ patient, context, onOpenTab }) {
  // Where no parent can open a tab the facts are still SHOWN — they are the
  // three that change what is safe to do — just not as buttons.
  const Fact = ({ tab, children, tone }) => (onOpenTab
    ? <button type="button" className={`ui-consult-fact ${tone || ''}`} onClick={() => onOpenTab(tab)}>{children}</button>
    : <span className={`ui-consult-fact ${tone || ''}`}>{children}</span>);
  if (!patient && !context) return null;
  const facts = bannerFacts(context);
  const line = patientLine(patient);

  return (
    <header className="ui-consult-banner">
      <div className="ui-consult-banner-who">
        <h2>{patient?.name || 'Patient'}</h2>
        {line && <span className="ui-cprog-card-meta">{line}</span>}
      </div>

      <div className="ui-consult-banner-facts">
        {/* Not colour alone: the word "Allergies" is in the label, so this
            reads the same to somebody who cannot see the tone. */}
        <Fact tab="allergies" tone={facts.allergyTone}>
          <span className="ui-consult-fact-key">Allergies</span>
          <span>{facts.allergyText}</span>
        </Fact>

        {facts.conditions.length > 0 && (
          <Fact tab="conditions">
            <span className="ui-consult-fact-key">Conditions</span>
            <span>{facts.conditions.join(', ')}</span>
          </Fact>
        )}

        {facts.medications.length > 0 && (
          <Fact tab="medications">
            <span className="ui-consult-fact-key">Medicines</span>
            <span>{facts.medications.join(', ')}</span>
          </Fact>
        )}
      </div>
    </header>
  );
}

/**
 * §28 — the patient's clinical context, beside the note rather than inside it.
 *
 * READ ONLY, AND THAT IS THE ARCHITECTURE. Every block is a pointer at the
 * section that owns the record (§12: "this is context only"). Nothing here
 * edits anything, which is why the consultation can show a patient's whole
 * picture without becoming a second copy of it.
 *
 * THIS COLUMN IS WHY THE PROSE WENT. The first build explained in a paragraph
 * that measurements live in Vitals; this shows the vitals and a button that
 * opens them. Structure says it better than a sentence, and says it every
 * time instead of once.
 */
function ContextColumn({ context, onOpenTab }) {
  if (!context) return <Loading />;
  const blocks = contextBlocks(context);

  return (
    <aside className="ui-consult-context" aria-label="Patient context">
      {blocks.map((b) => (
        <section key={b.id} className="ui-consult-ctx-block">
          <h3>
            {b.label}
            {onOpenTab && (
              <button type="button" className="ui-consult-ctx-open" onClick={() => onOpenTab(b.tab)}>
                Open
              </button>
            )}
          </h3>
          {b.items.length === 0
            // An empty block SAYS it is empty rather than disappearing: a
            // missing panel and one with nothing in it mean different things,
            // and a pharmacist cannot tell which they are looking at.
            ? <p className="ui-consult-ctx-empty">{b.empty}</p>
            : (
              <ul>
                {b.items.map((it, i) => <li key={`${b.id}-${i}`}>{it}</li>)}
              </ul>
            )}
        </section>
      ))}
    </aside>
  );
}

/** One consultation, open. */
// `onOpenTab` is OPTIONAL: the Clinics module opens a consultation with no
// patient record beside it, and the context column must not draw buttons
// that would do nothing there. Where it is absent the blocks still READ,
// which is what the column is for.
export default function Consultation({
  customerId, consultationId, onBack, onOpenConversation, onChanged, onOpenTab,
}) {
  const [note, setNote] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState({});
  const [context, setContext] = useState(null);
  // One control, not a per-section preference: §31 asks for complexity
  // LEVELS, and a screen where every section remembers its own state is a
  // screen that looks different every time it is opened.
  const [showAll, setShowAll] = useState(false);

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

  // §31. Which sections this TYPE opens with. A minor ailment should not
  // present the same fourteen-section wall as a comprehensive medication
  // review — and the answer is already in the type, so nothing new is
  // stored. Sections that are not opened move behind one control; none is
  // removed, because a pharmacist who needs Referral on a cough must still
  // be able to reach it.
  const filledSections = {
    triage: Boolean(note.triage),
    subjective: Boolean(note.subjective),
    objective: Boolean(note.objective),
    problems: (note.problems || []).length > 0,
    interventions: (note.interventions || []).length > 0,
    referral: Boolean(note.referralDestination),
    prescription: (note.prescriptionIssues || []).length > 0 || Boolean(note.prescriberContactedAt),
    'care-program': Boolean(note.careProgramId),
    amend: canAmend(note),
    history: Boolean(note.amendmentCount),
  };
  const plan = sectionPlan(note, filledSections);
  const shows = (id) => plan.shown.includes(id) || showAll;

  return (
    <div className="ui-consult">
      {/* ONE header, and the NOTE is the subject — it was previously smaller
          than the module label above it, which is the hierarchy upside down.
          The status, the date and the amendment count sit on one line under
          the title instead of being scattered across three rows. */}
      <header className="ui-consult-page">
        {onBack && (
          <button type="button" className="ui-consult-back" onClick={onBack}>
            ← All consultations
          </button>
        )}
        <h1>{note.typeLabel || note.consultationType}</h1>
        <div className="ui-consult-page-meta">
          <span className={`ui-cprog-pill ${tone || ''}`}>{statusLabel(note.status)}</span>
          <span>{whenLabel(note.startedAt)}</span>
          {note.completedAt && <span>Finalised {dayLabel(note.completedAt)}</span>}
          {/* §32. Absent entirely on a note nobody has corrected. */}
          {amendedNote(note) && <span>{amendedNote(note)}</span>}
        </div>
      </header>

      <PatientBanner patient={context?.patient} context={context} onOpenTab={onOpenTab} />

      {note.status === 'entered_in_error' && (
        // A dashed 28px-padded box is the EMPTY-STATE style; using it for a
        // one-sentence notice gave a retired note a wall of whitespace where
        // its content should be.
        <p className="ui-consult-notice" role="status">
          <strong>Entered in error</strong>
          {note.errorReason ? ` — ${note.errorReason}.` : '.'} Kept as a record of what
          was written; not deleted. {AMEND_RETIRED}
        </p>
      )}

      {error && <p className="ui-allergy-failed">{error}</p>}

      {/* §3 — documentation on the work surface, patient context beside it.
          Under 1000px the context column moves BELOW the note rather than
          into a drawer: a pharmacist on a phone scrolls past it to the
          fields, and a drawer would hide the allergies behind a tap. */}
      <div className="ui-consult-split">
        <div className="ui-consult-main">

      {shows('triage') && (
      <Section id="triage" title="Triage summary" emphasised={Boolean(note.triage)} filled={Boolean(note.triage)}>
        <TriagePanel triage={note.triage} onOpenConversation={onOpenConversation} />
      </Section>
      )}

      <Section id="reason" title="Reason" emphasised filled={Boolean(reasonLine(note, options?.reasons || []))}>
        <label className="ui-consult-field">
          <span className="ui-cprog-quiet">Primary reason</span>
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

      {shows('subjective') && (
      <Section id="subjective" title="Subjective" emphasised={emphasis.has('subjective')} filled={Boolean(note.subjective)}>
        {/* The scribe sits ABOVE the box it drafts into, and only while the
            note is open. It writes nothing itself: accepting a draft calls
            the same `set` a keystroke does, so the note has one writer and
            the ordinary Save is still what commits it. */}
        {open && (
          <ConsultationScribe
            customerId={customerId}
            consultationId={consultationId}
            note={note}
            available={Boolean(options?.scribe?.available)}
            existing={note.subjective}
            whenLabel={whenLabel}
            onAccept={({ subjective, consented }) => {
              // Consent is a SERVER fact and comes back as the whole note,
              // so it is merged rather than set — nothing is dirtied by
              // asking the patient.
              if (consented) setNote(consented);
              if (typeof subjective === 'string') set('subjective', subjective);
            }}
          />
        )}
        <Field label="What the patient reported" rows={5} value={note.subjective} disabled={!open || busy}
          placeholder="Onset, duration, what makes it better or worse, what they have already tried"
          onChange={(v) => set('subjective', v)} />
      </Section>
      )}

      {shows('objective') && (
      <Section id="objective" title="Objective" emphasised={emphasis.has('vitals') || emphasis.has('objective')} filled={Boolean(note.objective)}>
        {/* Measurements are recorded in Vitals and read from there. This box is
            for what was observed, not for a number another screen owns. */}
        <Field label="What you found" rows={4} value={note.objective} disabled={!open || busy}
          placeholder="General appearance, hydration, anything focused you examined"
          onChange={(v) => set('objective', v)} />
      </Section>
      )}

      <Section id="assessment" title="Assessment" emphasised filled={Boolean(note.assessmentText)}>
        {/* §13: the pharmacist's impression, not a diagnosis. The one piece
            of the old prose worth keeping, as a hint on the field it is
            about rather than a paragraph above the section. */}
        <Field label="Assessment — your impression, including the uncertainty" rows={4}
          value={note.assessmentText} disabled={!open || busy}
          placeholder="Possible medication-related dizziness" onChange={(v) => set('assessmentText', v)} />
      </Section>

      {shows('problems') && (
      <Section id="problems" title="Problems" emphasised filled={(note.problems || []).length > 0}>
        <ProblemList customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>
      )}

      {shows('interventions') && (
      <Section id="interventions" title="What you did"
        emphasised={emphasis.has('interventions')} filled={(note.interventions || []).length > 0}>
        <InterventionList customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>
      )}

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
      {shows('referral') && (
      <Section id="referral" title="Referral"
        emphasised={emphasis.has('referral')} filled={Boolean(note.referralDestination)}>
        <ReferralPanel customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>
      )}

      {shows('prescription') && (
      <Section id="prescription" title="Prescription review"
        emphasised={emphasis.has('prescription')}
        filled={(note.prescriptionIssues || []).length > 0 || Boolean(note.prescriberContactedAt)}>
        <PrescriptionPanel customerId={customerId} note={note} options={options} open={open} onNote={setNote} />
      </Section>
      )}

      {shows('care-program') && (
      <Section id="care-program" title="Care programme"
        emphasised={emphasis.has('care_program')} filled={Boolean(note.careProgramId)}>
        <CareProgramPanel customerId={customerId} note={note} context={context} open={open} onNote={setNote} />
      </Section>
      )}

      <Section id="summary" title="Consultation summary" emphasised filled>
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
        <HistoryPanel customerId={customerId} note={note} />
      </Section>

      {/* Everything this type did not open with, one click away. */}
      {plan.more.length > 0 && (
        <button type="button" className="ui-psection-link ui-consult-more"
          aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer sections' : `More sections (${plan.more.length})`}
        </button>
      )}

        </div>
        <ContextColumn context={context} onOpenTab={onOpenTab} />
      </div>

      {open && (
        <div className="ui-followup-head ui-consult-foot">
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
export function ConsultationHistory({
  customerId, patientName, onOpen, onChoosePatient, onOpenConversation, onOpenTab,
}) {
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
        onOpenTab={onOpenTab}
        onChanged={load}
      />
    );
  }

  return (
    <div className="ui-followup-main">
      {/* ONE place marker: the patient, because that is the subject of this
          list. The module is already named in the breadcrumb above. */}
      <header className="ui-consult-page">
        {onChoosePatient && (
          <button type="button" className="ui-consult-back" onClick={onChoosePatient}>
            ← Choose another patient
          </button>
        )}
        <h1>{patientName || 'Consultations'}</h1>
        <p>Consultations recorded for this patient.</p>
      </header>

      {/* One row, not a stacked select and button: starting a consultation is
          a single decision and the two controls belong on the same line. */}
      <div className="ui-consult-start">
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

      {/* Its own rows rather than the follow-up module's: that list was laid
          out for one line of text, and four inline spans in it had nothing
          holding them apart. What a pharmacist scans for is the TYPE and the
          STATE, so those are the two anchors — type and reason on the left,
          date and state on the right. */}
      {data && data.consultations.length > 0 && (
        <ul className="ui-consult-list">
          {data.consultations.map((c) => {
            const reason = reasonLine(c, options?.reasons || []);
            return (
              <li key={c.id}>
                <button type="button" onClick={() => setOpenId(c.id)}>
                  <span className="ui-consult-list-main">
                    <span className="ui-consult-list-type">{c.typeLabel || c.consultationType}</span>
                    {reason && <span className="ui-consult-list-reason">{reason}</span>}
                  </span>
                  <span className="ui-consult-list-meta">
                    <span className="ui-consult-list-when">{dayLabel(c.startedAt)}</span>
                    <span className={`ui-cprog-pill ${statusTone(c.status) || ''}`}>
                      {statusLabel(c.status)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
