/**
 * Clinical → Consultation notes.
 *
 * The Clinical module's second screen, beside the consultation DESK
 * (`Consultations.jsx`), which is unchanged. The two answer different
 * questions and the boundary is the point:
 *
 *   the desk             who is waiting, what the engine found, is this safe
 *                        and appropriate for a pharmacy consultation
 *   consultation notes   what the pharmacist assessed and did about it
 *
 * A consultation is about one patient, so this screen begins by choosing one —
 * through `PatientSearch`, the list the Patients module already uses. A second
 * patient list would be a second answer to "who is this", which is the thing
 * every module here has been built to avoid.
 */

import { useState } from 'react';
import PatientSearch from './PatientSearch.jsx';
import { ConsultationHistory } from './Consultation.jsx';

export default function ConsultationNotes({ onOpenConversation }) {
  const [patientId, setPatientId] = useState(null);

  if (patientId) {
    return (
      <div className="ui-followup-main">
        <div className="ui-followup-head">
          <button type="button" className="ui-psection-link" onClick={() => setPatientId(null)}>
            ← Choose another patient
          </button>
        </div>
        <ConsultationHistory
          // Keyed so a different patient is always a fresh component: a note
          // must never be on screen under the wrong patient's name while
          // another loads. The same rule PatientRecord follows.
          key={patientId}
          customerId={patientId}
          onOpenConversation={onOpenConversation}
        />
      </div>
    );
  }

  return (
    <div className="ui-followup-main">
      <div className="ui-followup-head">
        <h3 className="ui-allergy-heading">Consultation notes</h3>
      </div>
      <p className="ui-allergy-help">
        Choose the patient you are consulting with. The triage desk is the screen
        beside this one — this is where what you assessed and did is written down.
      </p>
      <PatientSearch onOpen={setPatientId} />
    </div>
  );
}
