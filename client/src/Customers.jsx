/**
 * Patients → All patients, and the one patient profile every Patients
 * screen opens.
 *
 * The list is PatientSearch: name or phone, and the eight filters, all run
 * on the server. Choosing a patient — here, from Refills due, or from
 * Conditions — opens the same PatientRecord, never a copy of it.
 */

import { useEffect, useState } from 'react';
import PatientRecord from './PatientRecord.jsx';
import Loading from './Loading.jsx';
import PatientSearch from './PatientSearch.jsx';

/**
 * The chronic register — conditions the pharmacy is tracking from purchase
 * history, and who is under each.
 *
 * A condition with no patients is not rendered at all. Four permanent
 * "Asthma — 0" cards would push the conditions that DO have patients off the
 * first screen, and a card that is always zero is one staff learn to ignore.
 * The server already omits them; this renders nothing if the whole register
 * is empty rather than an explanatory box about a feature that has not
 * produced anything yet.
 *
 * WHAT THE WORDING HAS TO CARRY
 * "Confirmed by purchase" is not a diagnosis, and the UI must never let that
 * distinction get lost — hence the basis line under the heading and the
 * per-patient evidence, both drawn from the engine rather than asserted here.
 */
export function ChronicRegister({ onOpen, standalone = false }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/customers/conditions/registry', {
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) { if (!cancelled) setFailed(true); return; }
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch {
        // Supplementary where it is embedded. As Patients → Conditions it is
        // the whole screen, and says so rather than going blank.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const conditions = data?.conditions || [];
  if (conditions.length === 0) {
    // Nothing at all while embedded; as a screen of its own, a blank page
    // would be a screen that is empty without saying why (design.md).
    if (!standalone) return null;
    if (failed) {
      return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">The condition register could not be loaded.</p>;
    }
    if (!data) return <p className="text-sm text-slate-500"><Loading /></p>;
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
        No patient has a tracked condition yet. Conditions appear here from what patients buy.
      </p>
    );
  }

  const shown = conditions.find((c) => c.code === open);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-700">Chronic conditions tracked</h3>
        <span className="text-xs text-slate-500">
          {data.trackedPatients} patient{data.trackedPatients === 1 ? '' : 's'} · from purchase history
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {conditions.map((c) => {
          const isOpen = c.code === open;
          return (
            <button
              key={c.code}
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : c.code)}
              className={`rounded-lg border px-3 py-2 text-left transition ${
                isOpen
                  ? 'border-teal-400 bg-teal-50'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="block text-xs text-slate-500">{c.name}</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{c.patientCount}</span>
            </button>
          );
        })}
      </div>

      {shown && (
        <div className="mt-3 rounded-lg border border-slate-200">
          <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
            {shown.name} — confirmed by purchase history, not a diagnosis
          </p>
          <ul className="divide-y divide-slate-100">
            {shown.patients.map((p) => (
              <li key={p.customerId}>
                <button
                  type="button"
                  onClick={() => onOpen(p.customerId)}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="font-medium text-slate-800">{p.name}</span>
                  <span className="text-xs text-slate-500">{p.phone}</span>
                  {/* Recency is the actionable part: a confirmed condition with
                      no recent purchase is the patient worth calling. */}
                  {p.purchaseStatus === 'NO_RECENT_PURCHASE' && (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                      no recent purchase
                    </span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-slate-400">
                    {p.purchases} purchase{p.purchases === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function Customers({
  onOpenConversation, onNavigate, initialQuery = '', openPatientId = null, onPatientOpened,
}) {
  const [selectedId, setSelectedId] = useState(openPatientId);

  // A patient chosen on another Patients screen (Refills due, Conditions)
  // opens here — the ONE patient profile, not a copy of it on each screen.
  // The request is acknowledged so App can clear it; otherwise choosing the
  // same patient twice would not fire this effect the second time.
  useEffect(() => {
    if (!openPatientId) return;
    setSelectedId(openPatientId);
    onPatientOpened?.();
  }, [openPatientId, onPatientOpened]);

  if (selectedId) {
    // Choosing a patient opens their RECORD — the twelve sections and the
    // navigation between them — not the profile on its own. The profile is
    // now one section of it (Patient summary).
    return (
      <PatientRecord
        // Keyed so a different patient is always a fresh component: the
        // record keeps its data on screen across a reload, and must never
        // keep one patient's data on screen while another's loads.
        key={selectedId}
        customerId={selectedId}
        onBack={() => setSelectedId(null)}
        onOpenConversation={onOpenConversation}
        onNavigate={onNavigate}
      />
    );
  }

  // Search state lives in PatientSearch; the header search's term arrives
  // as initialQuery and is followed there.
  return <PatientSearch initialQuery={initialQuery} onOpen={setSelectedId} />;
}
