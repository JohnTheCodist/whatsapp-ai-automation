/**
 * A patient's care details on their profile: the pharmacist they are
 * assigned to, and the age and gender staff record at the counter.
 *
 * GET/PATCH /api/customers/:id/care (server/services/customers/patientCare.js).
 * The pharmacist list is the search's own option list, so the profile and
 * the "Assigned pharmacist" filter always offer the same people — pharmacists
 * and the owner, never general staff.
 *
 * Only what changed is sent, so saving the gender never touches an age the
 * assistant recorded. Silent success (design.md): the saved values are the
 * confirmation.
 */

import { useEffect, useId, useState } from 'react';

function fromCare(care) {
  return {
    assignedPharmacistId: care?.assignedPharmacist?.id || '',
    ageYears: care?.ageYears != null ? String(care.ageYears) : '',
    sex: care?.sex || '',
  };
}

export default function PatientCare({ customerId }) {
  const ids = useId();
  const [care, setCare] = useState(null);
  const [pharmacists, setPharmacists] = useState([]);
  const [form, setForm] = useState(fromCare(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/customers/${customerId}/care`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not load care details.');
        if (live) { setCare(j); setForm(fromCare(j)); }
      })
      .catch((e) => { if (live) setError(e.message); });
    fetch('/api/customers/search/options')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setPharmacists(j.pharmacist.filter((p) => p.value !== 'unassigned')); })
      .catch(() => {});
    return () => { live = false; };
  }, [customerId]);

  const saved = fromCare(care);
  const changed = Object.keys(form).filter((k) => form[k] !== saved[k]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, form[k]]));
      const r = await fetch(`/api/customers/${customerId}/care`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'That did not save. Try again.');
      setCare(j);
      setForm(fromCare(j));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Care details</h3>
      {!care && !error && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
      {care && (
        <form onSubmit={save} className="mt-3 grid gap-4 sm:grid-cols-3">
          <label htmlFor={`${ids}-ph`} className="text-xs text-slate-600">
            Assigned pharmacist
            <select id={`${ids}-ph`} value={form.assignedPharmacistId} onChange={set('assignedPharmacistId')} className="mt-1 block w-full px-2.5 py-1.5 text-sm">
              <option value="">Unassigned</option>
              {pharmacists.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label htmlFor={`${ids}-age`} className="text-xs text-slate-600">
            Age
            <input
              id={`${ids}-age`} inputMode="numeric" value={form.ageYears} onChange={set('ageYears')}
              disabled={care.ageFromDateOfBirth} placeholder="Not recorded"
              className="mt-1 block w-full px-2.5 py-1.5 text-sm tabular-nums"
            />
            {/* A date of birth outranks a typed age on the server; say so
                rather than letting an edit silently not stick. */}
            {care.ageFromDateOfBirth && <span className="mt-1 block text-slate-400">From their date of birth</span>}
          </label>
          <label htmlFor={`${ids}-sex`} className="text-xs text-slate-600">
            Gender
            <select id={`${ids}-sex`} value={form.sex} onChange={set('sex')} className="mt-1 block w-full px-2.5 py-1.5 text-sm">
              <option value="">Not recorded</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
          {(changed.length > 0 || error) && (
            <div className="flex items-center gap-3 sm:col-span-3">
              {changed.length > 0 && (
                <>
                  <button type="submit" disabled={saving} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40">
                    {saving ? 'Saving…' : 'Save care details'}
                  </button>
                  <button type="button" onClick={() => setForm(saved)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700">
                    Undo changes
                  </button>
                </>
              )}
              {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
            </div>
          )}
        </form>
      )}
      {!care && error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}
    </section>
  );
}
