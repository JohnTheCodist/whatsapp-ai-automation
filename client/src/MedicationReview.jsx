/**
 * The medication review — a pharmacist sitting down with a patient's
 * medicines and writing what they found.
 *
 * IT IS NOT A MODAL. The other forms in this workspace are: adding a
 * medicine is one fact, entered and closed. A review is read against the
 * medication list while it is written, and a sheet over the screen would
 * hide the thing being reviewed. So it opens in place, in the tab.
 *
 * A DRAFT, NOT A SUBMISSION. The pharmacist saves as they go and signs when
 * they are finished. Signing is a separate button with its own wording
 * because it is a separate act: the assertion that this is the record.
 *
 * NOTHING HERE SUGGESTS ANYTHING. No proposed intervention for a problem,
 * no interaction check, no "3 issues found". The pharmacist records what
 * they found and what they did; the software holds it and does not grade it
 * — see customerProfile.js's header for the line this product draws.
 */

import { useCallback, useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { IconChevronDown, IconClipboard } from './Icons.jsx';
import { ClinicalContext } from './ClinicalContext.jsx';
import {
  ADHERENCE_TONE, OUTCOME_TONE, labelFor, reviewDate, findingsLine, followUpLine,
  reviewByLine, findingsByProblem, blockingReasons, medicineLabel, reviewsSummary,
} from './reviewFormat.js';

/** A fresh draft as the form holds it, before anything has been written. */
const emptyDraft = (review) => ({
  reviewedOn: review.reviewedOn || '',
  adherence: review.adherence || 'unknown',
  adherenceNotes: review.adherenceNotes || '',
  notes: review.notes || '',
  outcome: review.outcome || '',
  followUpOn: review.followUpOn || '',
  followUpReason: review.followUpReason || '',
  followUpNotes: review.followUpNotes || '',
  // Refs are the form's own, and only have to be stable within one save —
  // the server turns each into a real id when the rows are written.
  problems: (review.problems || []).map((p, i) => ({
    ref: `p${i}`, problem: p.problem, journeyId: p.journeyId || '', notes: p.notes || '',
  })),
  actions: (review.actions || []).map((a) => {
    const at = (review.problems || []).findIndex((p) => p.id === a.problemId);
    return { action: a.action, problemRef: at === -1 ? '' : `p${at}`, notes: a.notes || '' };
  }),
});

let seq = 0;
const nextRef = () => `n${(seq += 1)}`;

export default function MedicationReview({ customerId, onMedicationsChanged, context, onOpenTab }) {
  const [state, setState] = useState(null);         // { reviews, medications }
  const [options, setOptions] = useState(null);
  const [open, setOpen] = useState(null);           // the review being written
  const [error, setError] = useState(null);
  // Which signed reviews already have a follow-up pointing at them (§34). A
  // review's follow-up date used to be written down and then shown nowhere;
  // this is the offer to turn it into something that comes round. NOTHING IS
  // CREATED AUTOMATICALLY — the pharmacist presses the button (§27).
  const [followupsBySource, setFollowupsBySource] = useState({});

  const loadFollowups = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${customerId}/followups`);
      if (!r.ok) return;
      const j = await r.json();
      const by = {};
      for (const f of j.followups || []) {
        if (f.sourceType === 'medication_review' && f.sourceId) by[f.sourceId] = f;
      }
      setFollowupsBySource(by);
    } catch {
      // The offer simply does not appear if this cannot be read. A review is
      // still a review.
    }
  }, [customerId]);
  useEffect(() => { loadFollowups(); }, [loadFollowups]);

  async function createFollowupFor(review) {
    const r = await fetch(`/api/customers/${customerId}/followups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The pharmacist's own words, from the review they just signed.
        title: review.followUpReason,
        kind: 'medication_review',
        dueOn: review.followUpOn,
        reason: review.followUpNotes || null,
        sourceType: 'medication_review',
        sourceId: review.id,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'The follow-up could not be created.');
    }
    await loadFollowups();
  }

  const load = useCallback(async () => {
    try {
      const [list, reviewable] = await Promise.all([
        fetch(`/api/customers/${customerId}/medication-reviews`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load this patient\'s reviews.')))),
        fetch(`/api/customers/${customerId}/medication-reviews/reviewable`)
          .then((r) => (r.ok ? r.json() : { medications: [] })).catch(() => ({ medications: [] })),
      ]);
      setState({ reviews: list.reviews, medications: reviewable.medications });
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/medication-reviews/options`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setOptions(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  async function start() {
    setError(null);
    try {
      const r = await fetch(`/api/customers/${customerId}/medication-reviews`, { method: 'POST' });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not start a review.');
      // Starting twice hands back the draft already being written, so this
      // is also how a half-finished review is picked up again.
      setOpen(body);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (error && !state) {
    return <p role="alert" className="ui-vital-error">{error}</p>;
  }
  if (!state) return <p className="text-sm text-[var(--ui-ink-faint)]"><Loading /></p>;

  const draft = state.reviews.find((r) => r.status === 'draft') || null;
  const history = state.reviews.filter((r) => r.status === 'signed');

  if (open) {
    return (
      <ReviewEditor
        customerId={customerId}
        review={open}
        medications={state.medications}
        options={options}
        onClose={() => { setOpen(null); load(); }}
        onSaved={() => { load(); onMedicationsChanged?.(); }}
        context={context}
        onOpenTab={onOpenTab}
      />
    );
  }

  return (
    <div className="ui-mrev">
      <header className="ui-mrev-head">
        <div>
          <p className="ui-meds-count">{reviewsSummary(state.reviews)}</p>
          {/* What a review IS, said once, where a pharmacist decides whether
              to start one. */}
          <p className="ui-mrev-blurb">
            A record of what you found going through this patient&rsquo;s medicines, and
            what you did about it.
          </p>
        </div>
        <button type="button" onClick={() => (draft ? setOpen(draft) : start())} className="ui-meds-add">
          <IconClipboard width={15} height={15} aria-hidden="true" />
          {draft ? 'Continue review' : 'Start review'}
        </button>
      </header>

      {error && <p role="alert" className="ui-vital-error">{error}</p>}

      {draft && (
        <button type="button" onClick={() => setOpen(draft)} className="ui-mrev-draft">
          <span className="ui-mrev-draft-tag">Draft</span>
          <span>
            Started {reviewDate(draft.createdAt)} · {findingsLine(draft)}
          </span>
          <span className="ui-mrev-draft-go">Continue →</span>
        </button>
      )}

      {/* No empty box when there is nothing signed: the line above already
          says "No medication review recorded", and saying it twice is noise. */}
      {history.length > 0 && (
        <ol className="ui-mrev-list">
          {history.map((r, i) => (
            <PastReview
              key={r.id}
              review={r}
              index={i}
              options={options}
              followup={followupsBySource[r.id] || null}
              onCreateFollowup={createFollowupFor}
              onOpenFollowups={() => onOpenTab?.('followup')}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/** One signed review, expandable to its findings. */
function PastReview({ review, index, options, followup, onCreateFollowup, onOpenFollowups }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(null);
  const { problems, general } = findingsByProblem(review);
  const follow = followUpLine(review);

  async function create() {
    setCreating(true);
    setFailed(null);
    try {
      await onCreateFollowup(review);
    } catch (e) {
      setFailed(e.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <li className="ui-mrev-card" style={{ '--row-i': index }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ui-mrev-card-head">
        <IconChevronDown
          width={13}
          height={13}
          aria-hidden="true"
          className={`ui-med-caret ${open ? 'is-open' : ''}`}
        />
        <span className="ui-mrev-card-date">{reviewDate(review.reviewedOn)}</span>
        <span className={`ui-med-status ${ADHERENCE_TONE[review.adherence] || 'ui-tone-quiet'}`}>
          {labelFor(options?.adherence, review.adherence)} adherence
        </span>
        {review.outcome && (
          <span className={`ui-med-status ${OUTCOME_TONE[review.outcome] || 'ui-tone-quiet'}`}>
            {labelFor(options?.outcomes, review.outcome)}
          </span>
        )}
        <span className="ui-mrev-card-findings">{findingsLine(review)}</span>
      </button>

      {open && (
        <div className="ui-mrev-card-body">
          {review.adherenceNotes && <p className="ui-mrev-note">{review.adherenceNotes}</p>}

          {problems.length === 0 && general.length === 0
            ? <p className="ui-med-context-none">Nothing found. The medicines were checked.</p>
            : (
              <ul className="ui-mrev-findings">
                {problems.map((p) => (
                  <li key={p.id}>
                    <p className="ui-mrev-problem">
                      {labelFor(options?.problems, p.problem)}
                      {p.medicineName && <span className="ui-mrev-about">{p.medicineName}</span>}
                    </p>
                    {p.notes && <p className="ui-mrev-note">{p.notes}</p>}
                    {p.actions.length > 0 && (
                      <ul className="ui-mrev-actions">
                        {p.actions.map((a) => (
                          <li key={a.id}>
                            {labelFor(options?.actions, a.action)}
                            {a.notes && <span className="ui-mrev-note"> — {a.notes}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
                {general.length > 0 && (
                  <li>
                    <p className="ui-mrev-problem">Over the whole review</p>
                    <ul className="ui-mrev-actions">
                      {general.map((a) => (
                        <li key={a.id}>
                          {labelFor(options?.actions, a.action)}
                          {a.notes && <span className="ui-mrev-note"> — {a.notes}</span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </ul>
            )}

          {follow && (
            <div className="ui-mrev-follow-row">
              <p className="ui-mrev-follow">{follow}</p>
              {followup
                ? (
                  <button type="button" onClick={onOpenFollowups} className="ui-psection-link">
                    Follow-up created — open it
                  </button>
                )
                : onCreateFollowup && (
                  <button type="button" disabled={creating} onClick={create} className="ui-mrev-btn">
                    {creating ? 'Creating…' : 'Create follow-up'}
                  </button>
                )}
            </div>
          )}
          {failed && <p role="alert" className="ui-vital-error">{failed}</p>}
          {review.notes && <p className="ui-mrev-note">{review.notes}</p>}
          <p className="ui-mrev-by">{reviewByLine(review)}</p>
        </div>
      )}
    </li>
  );
}

/** Writing one. */
function ReviewEditor({ customerId, review, medications, options, onClose, onSaved, context, onOpenTab }) {
  const [draft, setDraft] = useState(() => emptyDraft(review));
  const [saving, setSaving] = useState(null);       // 'save' | 'sign'
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);

  const set = (key, value) => { setDraft((d) => ({ ...d, [key]: value })); setSaved(null); };
  const pick = (name) => options?.[name] || [];
  const blocking = blockingReasons(draft);

  async function submit(sign) {
    setSaving(sign ? 'sign' : 'save');
    setError(null);
    try {
      const r = await fetch(
        `/api/customers/${customerId}/medication-reviews/${review.id}${sign ? '?sign=1' : ''}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...draft,
            // The server reads an absent value as "not recorded"; an empty
            // string from a select would be a value it has to refuse.
            outcome: draft.outcome || null,
            followUpOn: draft.followUpOn || null,
            followUpReason: draft.followUpReason || null,
            problems: draft.problems.map((p) => ({ ...p, journeyId: p.journeyId || null })),
            actions: draft.actions.map((a) => ({ ...a, problemRef: a.problemRef || null })),
          }),
        },
      );
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(body.error || 'Could not save this review.'), { field: body.field });
      onSaved(body);
      if (sign) onClose();
      else setSaved(new Date());
    } catch (e) {
      setError(e);
    } finally {
      setSaving(null);
    }
  }

  const wrong = (field) => (error?.field === field ? 'is-wrong' : '');

  const addProblem = () => setDraft((d) => ({
    ...d,
    problems: [...d.problems, { ref: nextRef(), problem: '', journeyId: '', notes: '' }],
  }));
  const setProblem = (ref, key, value) => setDraft((d) => ({
    ...d,
    problems: d.problems.map((p) => (p.ref === ref ? { ...p, [key]: value } : p)),
  }));
  const dropProblem = (ref) => setDraft((d) => ({
    ...d,
    problems: d.problems.filter((p) => p.ref !== ref),
    // An intervention answering a problem that has just been removed would
    // point at nothing; it becomes a general one rather than disappearing.
    actions: d.actions.map((a) => (a.problemRef === ref ? { ...a, problemRef: '' } : a)),
  }));

  const addAction = () => setDraft((d) => ({
    ...d, actions: [...d.actions, { action: '', problemRef: '', notes: '' }],
  }));
  const setAction = (i, key, value) => setDraft((d) => ({
    ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, [key]: value } : a)),
  }));
  const dropAction = (i) => setDraft((d) => ({ ...d, actions: d.actions.filter((_, j) => j !== i) }));

  return (
    <div className="ui-mrev-editor">
      <header className="ui-mrev-editor-head">
        <div>
          <h3>Medication review</h3>
          <p className="ui-mrev-blurb">
            {medications.length === 0
              ? 'This patient has no current medication recorded.'
              : `${medications.length} medicine${medications.length === 1 ? '' : 's'} on the record today.`}
          </p>
        </div>
        <button type="button" onClick={onClose} className="ui-mrev-btn">Close</button>
      </header>

      <div className="ui-mrev-editor-body">
        {/* ---- clinical context ---- */}
        {/* First, before any medicine is looked at: what this patient has,
            what they react to, and their latest readings. Shown, never
            checked against the list — the pharmacist is the one reviewing
            (ALLERGIES_PLAN.md §5.4, CONDITIONS_PLAN.md §6.3). */}
        <section className="ui-mrev-section ui-mrev-safety" aria-label="Clinical context">
          <ClinicalContext context={context} onOpenTab={onOpenTab} />
        </section>

        {/* ---- adherence ---- */}
        <section className="ui-mrev-section">
          <h4>How is the patient taking them?</h4>
          <div className="ui-mrev-choices" role="radiogroup" aria-label="Adherence">
            {pick('adherence').map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={draft.adherence === o.value}
                onClick={() => set('adherence', o.value)}
                className={`ui-mrev-choice ${draft.adherence === o.value ? 'is-on' : ''}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={draft.adherenceNotes}
            onChange={(e) => set('adherenceNotes', e.target.value)}
            placeholder="What the patient said about taking them."
            className="ui-mrev-text"
          />
        </section>

        {/* ---- problems ---- */}
        <section className="ui-mrev-section">
          <h4>What did you find?</h4>
          {draft.problems.length === 0 && (
            <p className="ui-med-context-none">
              Nothing recorded. A review that finds nothing is a result — sign it as it is.
            </p>
          )}
          {draft.problems.map((p) => (
            <div key={p.ref} className="ui-mrev-row">
              <select
                value={p.problem}
                onChange={(e) => setProblem(p.ref, 'problem', e.target.value)}
                aria-label="Problem"
                className={`ui-vital-input ${wrong('problem')}`}
              >
                <option value="">Choose a problem…</option>
                {pick('problems').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                value={p.journeyId}
                onChange={(e) => setProblem(p.ref, 'journeyId', e.target.value)}
                aria-label="Which medicine"
                className="ui-vital-input"
              >
                {/* Not every problem is about one medicine — "cannot afford
                    their medicines" is about the patient. */}
                <option value="">Not about one medicine</option>
                {medications.map((m) => (
                  <option key={m.id} value={m.id}>{medicineLabel(m)}</option>
                ))}
              </select>
              <input
                value={p.notes}
                onChange={(e) => setProblem(p.ref, 'notes', e.target.value)}
                placeholder="What exactly"
                aria-label="Notes on the problem"
                className="ui-vital-input"
              />
              <button type="button" onClick={() => dropProblem(p.ref)} aria-label="Remove this problem" className="ui-icon-btn">×</button>
            </div>
          ))}
          <button type="button" onClick={addProblem} className="ui-mrev-add">+ Add a problem</button>
        </section>

        {/* ---- interventions ---- */}
        <section className="ui-mrev-section">
          <h4>What did you do about it?</h4>
          {draft.actions.map((a, i) => (
            <div key={i} className="ui-mrev-row">
              <select
                value={a.action}
                onChange={(e) => setAction(i, 'action', e.target.value)}
                aria-label="Intervention"
                className={`ui-vital-input ${wrong('action')}`}
              >
                <option value="">Choose an intervention…</option>
                {pick('actions').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select
                value={a.problemRef}
                onChange={(e) => setAction(i, 'problemRef', e.target.value)}
                aria-label="Which problem this answers"
                className="ui-vital-input"
              >
                {/* Linking the intervention to its problem is what lets the
                    record answer "which interaction did you ring about". */}
                <option value="">Over the whole review</option>
                {draft.problems.filter((p) => p.problem).map((p) => (
                  <option key={p.ref} value={p.ref}>
                    {labelFor(pick('problems'), p.problem)}
                    {p.journeyId ? ` · ${medicineLabel(medications.find((m) => m.id === p.journeyId))}` : ''}
                  </option>
                ))}
              </select>
              <input
                value={a.notes}
                onChange={(e) => setAction(i, 'notes', e.target.value)}
                placeholder="What you did"
                aria-label="Notes on the intervention"
                className="ui-vital-input"
              />
              <button type="button" onClick={() => dropAction(i)} aria-label="Remove this intervention" className="ui-icon-btn">×</button>
            </div>
          ))}
          <button type="button" onClick={addAction} className="ui-mrev-add">+ Add an intervention</button>
        </section>

        {/* ---- outcome and follow-up ---- */}
        <section className="ui-mrev-section">
          <h4>How was it left?</h4>
          <div className="ui-mrev-choices" role="radiogroup" aria-label="Outcome">
            {pick('outcomes').map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={draft.outcome === o.value}
                onClick={() => set('outcome', draft.outcome === o.value ? '' : o.value)}
                className={`ui-mrev-choice ${draft.outcome === o.value ? 'is-on' : ''} ${wrong('outcome')}`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="ui-mrev-followup">
            <label className="ui-med-field">
              <span className="ui-vital-label">Follow up on</span>
              <input
                type="date"
                value={draft.followUpOn}
                onChange={(e) => set('followUpOn', e.target.value)}
                className={`ui-vital-input ${wrong('followUpOn')}`}
              />
            </label>
            <label className="ui-med-field">
              <span className="ui-vital-label">What for</span>
              <input
                value={draft.followUpReason}
                onChange={(e) => set('followUpReason', e.target.value)}
                placeholder="Check the blood pressure"
                className={`ui-vital-input ${wrong('followUpReason')}`}
              />
            </label>
          </div>

          <textarea
            rows={3}
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Anything else worth recording."
            className="ui-mrev-text"
          />
        </section>

        {error && <p role="alert" className="ui-vital-error">{error.message}</p>}
      </div>

      <footer className="ui-mrev-editor-foot">
        {/* Why it cannot be signed yet, said before the button is pressed
            rather than as a failure after it. */}
        {blocking.length > 0 && (
          <p className="ui-mrev-blocking">
            To sign: {blocking.join(' ')}
          </p>
        )}
        {saved && blocking.length === 0 && <p className="ui-mrev-saved">Draft saved.</p>}
        <div className="ui-mrev-editor-buttons">
          <button type="button" onClick={() => submit(false)} disabled={saving !== null} className="ui-mrev-btn">
            {saving === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={saving !== null || blocking.length > 0}
            className="ui-mrev-btn is-primary"
          >
            {saving === 'sign' ? 'Signing…' : 'Sign review'}
          </button>
        </div>
      </footer>
    </div>
  );
}
