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
import NewPatient from './NewPatient.jsx';
import { ConsultationHistory } from './Consultation.jsx';

export default function ConsultationNotes({ onOpenConversation, onOpenTab }) {
  // The NAME comes with the id, so the next screen can title itself without a
  // second request for something the pharmacist was just shown.
  const [patient, setPatient] = useState(null);
  // Whether the create panel is open, and the one thing it may need to say
  // afterwards. The notice is NOT an error: a number that turned out to
  // belong to a known patient means the pharmacist found them.
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);

  if (patient) {
    return (
      <>
      {/* Said once, above the note, and cleared the moment the pharmacist
          goes back to the list. Rendered HERE rather than passed down:
          ConsultationHistory does not take a notice, and handing it a prop
          it ignores is a message nobody ever sees. */}
      {notice && <p className="ui-allergy-help ui-newpatient-notice">{notice}</p>}
      <ConsultationHistory
        // Keyed so a different patient is always a fresh component: a note
        // must never be on screen under the wrong patient's name while
        // another loads. The same rule PatientRecord follows.
        key={patient.id}
        customerId={patient.id}
        patientName={patient.name}
        onChoosePatient={() => { setNotice(null); setPatient(null); }}
        onOpenConversation={onOpenConversation}
        onOpenTab={onOpenTab}
      />
      </>
    );
  }

  return (
    <div className="ui-followup-main">
      <header className="ui-consult-page">
        <h1>Consultations</h1>
        <p>Choose the patient you are consulting with.</p>
      </header>

      {/* A patient could only come into being by messaging the pharmacy on
          WhatsApp until this existed, so a pharmacist consulting with
          somebody at the counter had nowhere to put them. The control sits
          HERE, beside the search, because this is the moment the gap is
          felt: you look for somebody, they are not there. */}
      {creating ? (
        <NewPatient
          onCancel={() => setCreating(false)}
          onCreated={({ id, name, alreadyExisted }) => {
            setCreating(false);
            // Straight into their consultation either way. A patient who
            // turned out to already exist has been FOUND, which is the
            // thing the pharmacist was trying to do.
            setNotice(alreadyExisted ? 'That number already belonged to a patient — opening them.' : null);
            setPatient({ id, name });
          }}
        />
      ) : (
        <>
          <div className="ui-newpatient-offer">
            <button type="button" className="ui-scribe-go" onClick={() => setCreating(true)}>
              New patient
            </button>
          </div>
          <PatientSearch onOpen={(id, p) => setPatient({ id, name: p?.name || null })} />
        </>
      )}
    </div>
  );
}
