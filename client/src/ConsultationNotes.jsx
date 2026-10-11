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
 *
 * ONE PLACE MARKER AT A TIME (2026-10-04). This screen passes through three
 * subjects — no patient, a patient, an open note — and the first build gave
 * each of them its own heading AND its own back link while the app shell added
 * a fixed title above all three. Five stacked markers, two of them back links
 * that looked identical and went to different places. Now the screen titles
 * itself, which is why `App.jsx` exempts it the way it exempts Setup.
 */

import { useState } from 'react';
import PatientSearch from './PatientSearch.jsx';
import { ConsultationHistory } from './Consultation.jsx';

export default function ConsultationNotes({ onOpenConversation, onOpenTab }) {
  // The NAME comes with the id, so the next screen can title itself without a
  // second request for something the pharmacist was just shown.
  const [patient, setPatient] = useState(null);

  if (patient) {
    return (
      <ConsultationHistory
        // Keyed so a different patient is always a fresh component: a note
        // must never be on screen under the wrong patient's name while
        // another loads. The same rule PatientRecord follows.
        key={patient.id}
        customerId={patient.id}
        patientName={patient.name}
        onChoosePatient={() => setPatient(null)}
        onOpenConversation={onOpenConversation}
        onOpenTab={onOpenTab}
      />
    );
  }

  return (
    <div className="ui-followup-main">
      <header className="ui-consult-page">
        <h1>Consultations</h1>
        <p>Choose the patient you are consulting with.</p>
      </header>
      <PatientSearch onOpen={(id, p) => setPatient({ id, name: p?.name || null })} />
    </div>
  );
}
