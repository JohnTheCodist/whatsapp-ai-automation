/**
 * The allergy record, compact, for everywhere that is NOT the Allergies tab.
 *
 *   AllergyStrip   one line at the top of every patient-record section:
 *                  "⚠ Allergies: Penicillin, Peanuts" — click to open the tab
 *   AllergySafety  a short list for a clinical side panel: each current
 *                  allergy with its reactions (Medications, the Review)
 *
 * DISPLAY ONLY. Neither checks a medicine against an allergy, warns, or
 * blocks — there is no validated rules engine, so the software shows and the
 * pharmacist decides (ALLERGIES_PLAN.md §5.4). Neither duplicates the
 * Allergies tab: each is a pointer to it.
 *
 * A FAILED LOAD IS SAID AS A FAILED LOAD. It never falls back to a state it
 * could not read — least of all "no known allergies".
 */

import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconCheckCircle, IconInfo } from './Icons.jsx';
import { ALLERGY_STATE, stateLabel, stripLabel } from './allergyFormat.js';

const ICON = { alert: IconAlertTriangle, check: IconCheckCircle, unknown: IconInfo };

/**
 * The record-wide strip. `version` changes whenever the Allergies tab saves,
 * so the strip is never a step behind the record it points at.
 */
export function AllergyStrip({ customerId, version = 0, onOpen }) {
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/allergies`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((j) => { if (live) { setSummary(j); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [customerId, version]);

  if (failed) {
    return (
      <button type="button" onClick={onOpen} className="ui-allergy-strip ui-allergy-unassessed">
        <IconInfo width={14} height={14} aria-hidden="true" />
        <span>Allergies could not be loaded</span>
      </button>
    );
  }
  // Nothing rather than a guess while it loads.
  if (!summary) return <span className="ui-allergy-strip-placeholder" aria-hidden="true" />;

  const s = ALLERGY_STATE[summary.state] || ALLERGY_STATE.not_assessed;
  const Icon = ICON[s.icon];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`ui-allergy-strip ${s.tone}`}
      title="Open the patient's allergies"
    >
      <Icon width={14} height={14} aria-hidden="true" />
      <span className="truncate">{stripLabel({ state: summary.state, allergies: summary.allergies })}</span>
    </button>
  );
}

/**
 * The side-panel list. Takes the summary the server already sends with the
 * medication context, so it costs no request of its own.
 */
export function AllergySafety({ summary, onOpen, title = 'Allergies' }) {
  if (!summary) {
    return (
      <div className="ui-allergy-safety">
        <h3><IconInfo width={14} height={14} aria-hidden="true" /> {title}</h3>
        <p className="ui-med-context-none">Could not be loaded</p>
      </div>
    );
  }
  const s = ALLERGY_STATE[summary.state] || ALLERGY_STATE.not_assessed;
  const Icon = ICON[s.icon];
  const list = summary.allergies || [];

  return (
    <div className="ui-allergy-safety">
      <h3><Icon width={14} height={14} aria-hidden="true" /> {title}</h3>
      {summary.state === 'known'
        ? (
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <span className="ui-allergy-safety-name">
                  {a.criticality === 'high' && <IconAlertTriangle width={11} height={11} aria-label="High criticality" className="mr-1 inline" />}
                  {a.allergenName}
                </span>
                {(a.reactionLabels || []).length > 0 && (
                  <span className="ui-allergy-safety-reaction">{a.reactionLabels.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        )
        : <p className={summary.state === 'none_known' ? '' : 'ui-med-context-none'}>{stateLabel(summary.state)}</p>}
      {onOpen && (
        <button type="button" onClick={onOpen} className="ui-psection-link">Open allergies</button>
      )}
    </div>
  );
}
