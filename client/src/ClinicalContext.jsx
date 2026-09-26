/**
 * The patient's clinical context, compact — for the screens where a
 * pharmacist needs it beside something else (Medications, the Review).
 *
 *   ConditionsBrief   recorded current conditions, and the purchase
 *                     inference on its own labelled line
 *   CarePrograms      what this patient is being followed for, and what is late
 *   FollowupsBrief    what needs to happen next, and what is late
 *   ClinicalContext   conditions · allergies · tests · vitals · care programmes ·
 *                     follow-ups
 *
 * POINTERS, NOT COPIES. Each part links into its own tab; none of them is
 * the full record, and none checks anything against anything else.
 */

import { AllergySafety } from './AllergySafety.jsx';
import { IconHeart, IconPulse, IconFlask, IconConsultations, IconClipboard } from './Icons.jsx';
import { displayName } from './conditionFormat.js';
import { INTERPRETATION_TONE, interpretationArrow, performedLabel } from './testFormat.js';
import { countsLine, EMPTY_TEXT as CARE_EMPTY } from './carePlanFormat.js';
import {
  summaryParts, outstandingCount, dueLabel, lagosToday,
  emptyText as followupEmptyText,
} from './followupFormat.js';

const STATUS_WORD = { active: 'Active', recurrence: 'Recurrence', relapse: 'Relapse' };

export function ConditionsBrief({ problems, onOpen }) {
  if (!problems) {
    return (
      <div className="ui-allergy-safety">
        <h3><IconHeart width={14} height={14} aria-hidden="true" /> Conditions</h3>
        <p className="ui-med-context-none">Could not be loaded</p>
      </div>
    );
  }
  const list = problems.conditions || [];
  const suggested = problems.purchaseSuggested || [];
  return (
    <div className="ui-allergy-safety">
      <h3><IconHeart width={14} height={14} aria-hidden="true" /> Conditions</h3>
      {list.length === 0
        ? <p className="ui-med-context-none">No conditions recorded</p>
        : (
          <ul>
            {list.map((c) => (
              <li key={c.id} className={c.verificationStatus === 'confirmed' ? '' : 'is-uncertain'}>
                <span className="ui-cond-brief-name">{displayName(c)}</span>
                <span className="ui-allergy-safety-reaction">
                  {STATUS_WORD[c.clinicalStatus] || c.clinicalStatus}
                  {c.verificationStatus !== 'confirmed' ? ` · ${c.verificationStatus}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      {/* The inference, on its own line and said to be what it is. */}
      {suggested.length > 0 && (
        <p className="ui-cond-brief-suggested">
          From purchases, not recorded: {suggested.map((s) => s.name).join(', ')}
        </p>
      )}
      {onOpen && <button type="button" onClick={onOpen} className="ui-psection-link">Open conditions</button>}
    </div>
  );
}

/**
 * The last few results, and anything still waiting. Shown beside the
 * medicines — never checked against them.
 */
export function TestsBrief({ tests, onOpen }) {
  if (!tests) {
    return (
      <div className="ui-allergy-safety">
        <h3><IconFlask width={14} height={14} aria-hidden="true" /> Recent tests</h3>
        <p className="ui-med-context-none">Could not be loaded</p>
      </div>
    );
  }
  const recent = tests.recent || [];
  return (
    <div className="ui-allergy-safety">
      <h3><IconFlask width={14} height={14} aria-hidden="true" /> Recent tests</h3>
      {recent.length === 0
        ? <p className="ui-med-context-none">No results recorded</p>
        : (
          <ul>
            {recent.map((t) => (
              <li key={t.id}>
                <span className="ui-cond-brief-name">{t.testName}</span>
                <span className="ui-allergy-safety-reaction">
                  {[
                    t.result ? [t.result.value, t.result.unit].filter(Boolean).join(' ') : null,
                    performedLabel({ performed: { at: t.performedAt, precision: 'day' } }),
                  ].filter(Boolean).join(' · ')}
                  {t.result?.interpretation && t.abnormal && (
                    <span className={`ui-med-status ${INTERPRETATION_TONE[t.result.interpretation] || 'ui-tone-quiet'} ml-1`}>
                      {interpretationArrow(t.result.interpretation) || ''} {t.result.interpretation.replace('_', ' ')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      {tests.pending > 0 && (
        <p className="ui-cond-brief-suggested">{tests.pending} awaiting a result</p>
      )}
      {onOpen && <button type="button" onClick={onOpen} className="ui-psection-link">Open tests</button>}
    </div>
  );
}

/**
 * The care programmes this patient is in, and what is late (0061, phase 3).
 *
 * Counts, never a percentage — the same rule the Care program section holds,
 * for the same reason: a percentage beside a patient's name reads as a claim
 * about the patient rather than about the admin.
 *
 * SHOWN, NEVER ACTED ON. Nothing here starts, changes or completes a
 * programme; it is a pointer to the section that does.
 */
export function CareProgramsBrief({ carePrograms, onOpen }) {
  if (!carePrograms) {
    return (
      <div className="ui-allergy-safety">
        <h3><IconConsultations width={14} height={14} aria-hidden="true" /> Care programmes</h3>
        <p className="ui-med-context-none">Could not be loaded</p>
      </div>
    );
  }
  const active = carePrograms.active || [];
  const overdue = carePrograms.counts?.overdueTasks || 0;
  return (
    <div className="ui-allergy-safety">
      <h3><IconConsultations width={14} height={14} aria-hidden="true" /> Care programmes</h3>
      {active.length === 0
        ? <p className="ui-med-context-none">{CARE_EMPTY.notEnrolled}</p>
        : (
          <ul>
            {active.map((p) => (
              <li key={p.id}>
                <span className="ui-cond-brief-name">{p.programName}</span>
                <span className="ui-allergy-safety-reaction">
                  {countsLine(p)}
                </span>
              </li>
            ))}
          </ul>
        )}
      {/* The one thing worth acting on, and only when it is true. */}
      {overdue > 0 && (
        <p className="ui-cond-brief-suggested">{overdue} task{overdue === 1 ? '' : 's'} past its due date</p>
      )}
      {onOpen && <button type="button" onClick={onOpen} className="ui-psection-link">Open care programmes</button>}
    </div>
  );
}

/**
 * What needs to happen next for this patient (0062, phase 3).
 *
 * Counts and the next thing, never a percentage or a score. SHOWN, NEVER
 * ACTED ON: nothing here creates, completes or cancels a follow-up — it is a
 * pointer to the section that does.
 */
export function FollowupsBrief({ followups, onOpen }) {
  const today = lagosToday();
  if (!followups) {
    return (
      <div className="ui-allergy-safety">
        <h3><IconClipboard width={14} height={14} aria-hidden="true" /> Follow-up</h3>
        <p className="ui-med-context-none">Could not be loaded</p>
      </div>
    );
  }
  const parts = summaryParts(followups.counts);
  const next = followups.next || [];
  return (
    <div className="ui-allergy-safety">
      <h3><IconClipboard width={14} height={14} aria-hidden="true" /> Follow-up</h3>
      {outstandingCount(followups.counts) === 0
        ? <p className="ui-med-context-none">{followupEmptyText(followups.counts)}</p>
        : (
          <>
            <p className="ui-followup-brief-counts">
              {parts.map((x) => <span key={x.id} className={x.tone || ''}>{x.text}</span>)}
            </p>
            <ul>
              {next.map((f) => (
                <li key={f.id}>
                  <span className="ui-cond-brief-name">{f.title}</span>
                  <span className="ui-allergy-safety-reaction">{dueLabel(f, today)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      {onOpen && <button type="button" onClick={onOpen} className="ui-psection-link">Open follow-up</button>}
    </div>
  );
}

function vitalsLine(v) {
  if (!v) return null;
  return [
    v.systolic && v.diastolic ? `BP ${v.systolic}/${v.diastolic}` : null,
    v.pulse ? `pulse ${v.pulse}` : null,
    v.temperature ? `${v.temperature} °C` : null,
  ].filter(Boolean).join(' · ') || null;
}

export function ClinicalContext({ context, onOpenTab }) {
  const open = (tab) => (onOpenTab ? () => onOpenTab(tab) : undefined);
  const v = context?.lastVitals || null;
  return (
    <div className="ui-clinical-context">
      <p className="ui-clinical-context-title">Clinical context</p>
      <div className="ui-clinical-context-grid">
        <ConditionsBrief problems={context?.problems} onOpen={open('conditions')} />
        <AllergySafety summary={context?.allergies} onOpen={open('allergies')} />
        <TestsBrief tests={context?.tests} onOpen={open('results')} />
        <CareProgramsBrief carePrograms={context?.carePrograms} onOpen={open('care')} />
        <FollowupsBrief followups={context?.followups} onOpen={open('followup')} />
        <div className="ui-allergy-safety">
          <h3><IconPulse width={14} height={14} aria-hidden="true" /> Recent vitals</h3>
          {vitalsLine(v)
            ? <p>{vitalsLine(v)}</p>
            : <p className="ui-med-context-none">Not recorded</p>}
          {onOpenTab && <button type="button" onClick={() => onOpenTab('vitals')} className="ui-psection-link">Open vitals</button>}
        </div>
      </div>
    </div>
  );
}
