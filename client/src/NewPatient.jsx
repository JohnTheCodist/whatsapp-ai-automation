/**
 * Create a patient from the counter.
 *
 * Until this existed a patient could only come into being by messaging the
 * pharmacy on WhatsApp — the inbound ingest was the only thing in the product
 * that had ever created one. A pharmacist consulting with somebody standing
 * in front of them had nowhere to put them.
 *
 * A PHONE NUMBER IS REQUIRED, and the panel says why rather than only
 * refusing. It is what identifies a patient in this product, and it is what
 * makes the record merge with their WhatsApp thread the first time they
 * message rather than becoming a second copy of the same person.
 *
 * ALREADY-EXISTS IS NOT AN ERROR. The server answers 200 instead of 201 and
 * the screen says the patient was already here before opening them. Somebody
 * typing a number that turns out to belong to a known patient has found them.
 */

import { useState } from 'react';

const SEXES = [
  { value: '', label: 'Not recorded' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
];

export default function NewPatient({ onCreated, onCancel }) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [sex, setSex] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [field, setField] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setField(null);
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, phone, sex, dateOfBirth }),
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (body === null) {
        throw new Error('The pharmacy server is not responding. The patient has not been created.');
      }
      if (!res.ok) {
        // The server names the box that is wrong, so the form can point at
        // it rather than showing a sentence above eight identical fields.
        setField(body.field || null);
        throw new Error(body.error || 'Could not create the patient.');
      }
      onCreated?.({
        id: body.customerId,
        name: fullName.trim(),
        alreadyExisted: body.created === false,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ui-newpatient" onSubmit={submit}>
      <p className="ui-scribe-ask">New patient</p>

      <label className="ui-consult-field">
        <span className="ui-cprog-quiet">Full name</span>
        <input
          type="text"
          value={fullName}
          autoFocus
          placeholder="Ngozi Okafor"
          aria-invalid={field === 'fullName' ? 'true' : undefined}
          onChange={(e) => setFullName(e.target.value)}
        />
      </label>

      <label className="ui-consult-field">
        <span className="ui-cprog-quiet">Phone number</span>
        <input
          type="tel"
          value={phone}
          placeholder="0803 123 4567"
          aria-invalid={field === 'phone' ? 'true' : undefined}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      {/* Said once, here, because it explains a required field rather than
          decorating the form: the number is how this patient is recognised
          when they message, which is what stops a second record appearing. */}
      <p className="ui-allergy-help">
        The number is how this patient is recognised. If they message the
        pharmacy later, it joins this record instead of making a new one.
      </p>

      <div className="ui-newpatient-pair">
        <label className="ui-consult-field">
          <span className="ui-cprog-quiet">Sex</span>
          <select value={sex} onChange={(e) => setSex(e.target.value)}>
            {SEXES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="ui-consult-field">
          <span className="ui-cprog-quiet">Date of birth</span>
          <input
            type="date"
            value={dateOfBirth}
            aria-invalid={field === 'dateOfBirth' ? 'true' : undefined}
            onChange={(e) => setDateOfBirth(e.target.value)}
          />
        </label>
      </div>
      {/* Both optional, and the form says so rather than leaving a pharmacist
          to guess. A date of birth nobody knows must stay empty: it drives
          the age on the consultation banner, and a guess there is one of the
          three facts that change what is safe to do. */}
      <p className="ui-allergy-help">Both optional — leave them empty if you do not know.</p>

      <div className="ui-scribe-actions">
        <button type="submit" className="ui-scribe-go" disabled={busy}>
          {busy ? 'Creating…' : 'Create patient'}
        </button>
        <button type="button" className="ui-psection-link" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      {error && <p className="ui-allergy-failed">{error}</p>}
    </form>
  );
}
