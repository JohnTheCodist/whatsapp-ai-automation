/**
 * Medication journeys on the patient profile, and the refill call list on
 * the Patients screen.
 *
 * A JOURNEY IS SOMETHING A PHARMACIST ENROLLED
 * Nothing here is inferred from orders. An order for Amlodipine is a
 * purchase; a journey is the pharmacist saying "this patient takes this, and
 * we gave them 30 days today". Only the second can put a date on a refill.
 *
 * THE SERVER DECIDES, THIS FILE SAYS IT
 * Run-out dates, due / overdue / lapsed and every count come from
 * /api/customers/:id and /api/refills. Nothing is recomputed here — see
 * refillFormat.js for the only transformation, which is into words.
 *
 * SILENT SUCCESS (design.md)
 * A recorded refill shows its result — the row's new date — not a toast.
 * Nothing on this file messages a patient, so nothing here needs a
 * confirmation dialog; stopping a medicine asks for its reason inline and is
 * undone by enrolling it again.
 */

import { useEffect, useId, useState } from 'react';
import Loading from './Loading.jsx';
import {
  fmtDay, supplyLabel, messagingBlock, postJson,
  REFILL_STATUS_LABEL, REFILL_STATUS_TONE,
} from './refillFormat.js';

const INPUT = 'rounded border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-2 focus:outline-offset-1 focus:outline-teal-600';
const PRIMARY = 'rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40';
const SECONDARY = 'rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 focus:outline-2 focus:outline-offset-1 focus:outline-teal-600';
const DESTRUCTIVE = 'rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40';

function StatusPill({ status }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${REFILL_STATUS_TONE[status] || 'bg-slate-100 text-slate-500'}`}>
      {REFILL_STATUS_LABEL[status] || status}
    </span>
  );
}

function FormError({ message }) {
  if (!message) return null;
  return <p role="alert" className="text-xs text-red-700">{message}</p>;
}

/**
 * Record that the patient came back. Days prefill from the last supply
 * because a chronic patient almost always gets the same pack again; the date
 * left blank is today, which the server fills in (refillInput.js).
 */
function RecordRefillForm({ journeyId, lastDaysSupply, onDone, onCancel }) {
  const ids = useId();
  const [daysSupply, setDaysSupply] = useState(lastDaysSupply ? String(lastDaysSupply) : '');
  const [dispensedOn, setDispensedOn] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/refills/journeys/${journeyId}/dispense`, { daysSupply, dispensedOn });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2 rounded border border-slate-200 bg-slate-50 p-2">
      <label htmlFor={`${ids}-days`} className="text-xs text-slate-600">
        Days of supply
        <input
          id={`${ids}-days`} inputMode="numeric" required value={daysSupply}
          onChange={(e) => setDaysSupply(e.target.value)} className={`${INPUT} mt-0.5 block w-24 tabular-nums`}
        />
      </label>
      <label htmlFor={`${ids}-date`} className="text-xs text-slate-600">
        Dispensed
        <input
          id={`${ids}-date`} type="date" value={dispensedOn}
          onChange={(e) => setDispensedOn(e.target.value)} className={`${INPUT} mt-0.5 block`}
        />
      </label>
      <span className="pb-2 text-xs text-slate-400">{dispensedOn ? '' : 'Blank means today'}</span>
      <div className="flex gap-2 pb-0.5">
        <button type="submit" disabled={saving} className={PRIMARY}>{saving ? 'Saving…' : 'Record refill'}</button>
        <button type="button" onClick={onCancel} className={SECONDARY}>Cancel</button>
      </div>
      <div className="basis-full"><FormError message={error} /></div>
    </form>
  );
}

function StopForm({ journeyId, onDone, onCancel }) {
  const ids = useId();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/refills/journeys/${journeyId}/stop`, { reason });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2 rounded border border-slate-200 bg-slate-50 p-2">
      <label htmlFor={`${ids}-reason`} className="min-w-48 flex-1 text-xs text-slate-600">
        Why is it stopping? <span className="text-slate-400">(optional, staff only)</span>
        <input
          id={`${ids}-reason`} value={reason} maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Changed to losartan by doctor"
          className={`${INPUT} mt-0.5 block w-full`}
        />
      </label>
      <div className="flex gap-2 pb-0.5">
        <button type="submit" disabled={saving} className={DESTRUCTIVE}>{saving ? 'Stopping…' : 'Stop following'}</button>
        <button type="button" onClick={onCancel} className={SECONDARY}>Keep</button>
      </div>
      <div className="basis-full"><FormError message={error} /></div>
    </form>
  );
}

/**
 * Enrol on a medicine. Days of supply only — the way a chronic pack is
 * thought about at the counter. Quantity × daily dose is supported by the
 * API for integrations, but a second way to say the same thing on the
 * busiest form in the app is a second way to get it wrong.
 */
function EnrolForm({ customerId, onDone, onCancel }) {
  const ids = useId();
  const [medicineName, setMedicineName] = useState('');
  const [daysSupply, setDaysSupply] = useState('30');
  const [dispensedOn, setDispensedOn] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await postJson(`/api/customers/${customerId}/medications`, { medicineName, daysSupply, dispensedOn });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={`${ids}-name`} className="block text-xs text-slate-600">
        Medicine
        <input
          id={`${ids}-name`} required maxLength={200} value={medicineName}
          onChange={(e) => setMedicineName(e.target.value)}
          placeholder="e.g. Amlodipine 5mg tablets"
          className={`${INPUT} mt-0.5 block w-full`}
        />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={`${ids}-days`} className="text-xs text-slate-600">
          Days of supply given
          <input
            id={`${ids}-days`} inputMode="numeric" required value={daysSupply}
            onChange={(e) => setDaysSupply(e.target.value)} className={`${INPUT} mt-0.5 block w-24 tabular-nums`}
          />
        </label>
        <label htmlFor={`${ids}-date`} className="text-xs text-slate-600">
          Dispensed
          <input
            id={`${ids}-date`} type="date" value={dispensedOn}
            onChange={(e) => setDispensedOn(e.target.value)} className={`${INPUT} mt-0.5 block`}
          />
        </label>
        <span className="pb-2 text-xs text-slate-400">{dispensedOn ? '' : 'Blank means today'}</span>
      </div>
      <FormError message={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={PRIMARY}>{saving ? 'Saving…' : 'Start following'}</button>
        <button type="button" onClick={onCancel} className={SECONDARY}>Cancel</button>
      </div>
    </form>
  );
}

function JourneyRow({ journey, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'refill' | 'stop'
  const current = journey.currentRefill;
  const done = () => { setMode(null); onChanged(); };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-sm font-medium ${journey.status === 'active' ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
          {journey.name}
        </span>
        {journey.status === 'active' && current && <StatusPill status={current.status} />}
        {journey.status === 'stopped' && <span className="text-xs text-slate-400">Stopped</span>}
        <span className="ml-auto text-xs tabular-nums text-slate-400">
          {journey.completedRefills} refill{journey.completedRefills === 1 ? '' : 's'}
        </span>
      </div>

      {journey.status === 'active' && current && (
        <p className="mt-0.5 text-xs text-slate-500">
          {supplyLabel(current)} · {current.daysSupply} days from {fmtDay(current.dispensedOn)} · runs out{' '}
          <span className="tabular-nums">{fmtDay(current.runOutOn)}</span>
        </p>
      )}
      {journey.status === 'stopped' && journey.stopReason && (
        <p className="mt-0.5 text-xs text-slate-400">{journey.stopReason}</p>
      )}

      {journey.status === 'active' && mode === null && (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => setMode('refill')} className={SECONDARY}>Record refill</button>
          <button type="button" onClick={() => setMode('stop')} className="px-2 text-xs text-slate-500 hover:text-slate-700">Stop following</button>
        </div>
      )}
      {mode === 'refill' && (
        <RecordRefillForm
          journeyId={journey.id} lastDaysSupply={current?.daysSupply}
          onDone={done} onCancel={() => setMode(null)}
        />
      )}
      {mode === 'stop' && <StopForm journeyId={journey.id} onDone={done} onCancel={() => setMode(null)} />}
    </li>
  );
}

/** The profile's "Medications" section. */
export function MedicationJourneysPanel({ customerId, journeys, onChanged }) {
  const [enrolling, setEnrolling] = useState(false);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Medications followed</h3>
        {!enrolling && (
          <button type="button" onClick={() => setEnrolling(true)} className={SECONDARY}>Add medicine</button>
        )}
      </div>

      {enrolling && (
        <EnrolForm
          customerId={customerId}
          onDone={() => { setEnrolling(false); onChanged(); }}
          onCancel={() => setEnrolling(false)}
        />
      )}

      {journeys.length > 0 ? (
        <ul className="mt-2 divide-y divide-slate-100">
          {journeys.map((j) => <JourneyRow key={j.id} journey={j} onChanged={onChanged} />)}
        </ul>
      ) : (
        !enrolling && (
          <p className="mt-3 text-sm text-slate-500">
            Not following any medicines for this patient. Add one when you dispense a chronic
            medicine, and it will come up for refill before it runs out.
          </p>
        )
      )}
    </section>
  );
}

/**
 * The refill call list on the Patients screen.
 *
 * Renders nothing when nobody is due — the same choice ChronicRegister makes:
 * a panel that is always empty is a panel staff learn to skip, and it would
 * sit above the patient list on every visit. When it does show, it states
 * the day it was computed for (design.md: every screen states its own
 * freshness).
 */
export function RefillQueue({ onOpen, standalone = false }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [recording, setRecording] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/refills', { signal: AbortSignal.timeout(20000) });
        if (!r.ok) { if (!cancelled) setFailed(true); return; }
        const j = await r.json();
        if (!cancelled) setData(j);
      } catch {
        // Supplementary where it is embedded — the screen around it still
        // works. As a screen of its own (standalone) it says so instead.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [reload]);

  const items = data?.items || [];
  if (items.length === 0) {
    // STANDALONE — Patients → Refills due. Rendering nothing is right when
    // this sits above another list; as the whole screen it would be a blank
    // page, and a screen that can be empty must say why (design.md).
    if (!standalone) return null;
    if (failed) {
      return <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">The refill list could not be loaded.</p>;
    }
    if (!data) return <p className="text-sm text-slate-500"><Loading /></p>;
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
        No refills are due. Patients appear here when a medicine they are taking is about to run out.
      </p>
    );
  }
  const { counts } = data;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-700">Refills to follow up</h3>
        <span className="text-xs tabular-nums text-slate-500">
          {counts.due} due · {counts.overdue} overdue · {counts.lapsed} lapsed · as of {fmtDay(data.today)}
        </span>
      </div>

      <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {items.map((item) => {
          const block = messagingBlock(item.customer);
          return (
            <li key={item.refillId} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <button
                  type="button"
                  onClick={() => onOpen(item.customer.id)}
                  className="font-medium text-slate-800 hover:underline focus:outline-2 focus:outline-offset-1 focus:outline-teal-600"
                >
                  {item.customer.name || item.customer.phone}
                </button>
                <span className="text-xs text-slate-500">{item.customer.phone}</span>
                <span className="text-slate-600">{item.medicineName}</span>
                <StatusPill status={item.status} />
                <span className="text-xs tabular-nums text-slate-500">{supplyLabel(item)}</span>
                {/* Before anyone reaches for WhatsApp: this one is a phone call. */}
                {block && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{block}</span>
                )}
                {recording !== item.refillId && (
                  <button type="button" onClick={() => setRecording(item.refillId)} className={`ml-auto ${SECONDARY}`}>
                    Record refill
                  </button>
                )}
              </div>
              {recording === item.refillId && (
                <RecordRefillForm
                  journeyId={item.journeyId} lastDaysSupply={item.daysSupply}
                  onDone={() => { setRecording(null); setReload((n) => n + 1); }}
                  onCancel={() => setRecording(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
