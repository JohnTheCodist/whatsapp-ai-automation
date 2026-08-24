/**
 * Opening hours and physical location — what the assistant tells a customer
 * who asks "are you open" or "where are you". Backed by pharmacy_profile's
 * existing opening_hours (jsonb, one entry per day) and address_line/city/
 * state/landmark columns — see server/services/pharmacies.js's getProfile /
 * updateProfile / normalizeOpeningHours. This is the first UI for either.
 *
 * Every day gets its own row, weekends included — a pharmacy open Saturday
 * but closed Sunday (or vice versa) is common, and collapsing "weekend" into
 * one toggle would not let it say that. Closed days keep their times in
 * local state so re-opening a day does not lose whatever hours were last
 * entered for it.
 */

import { useEffect, useState } from 'react';
import FieldHint from './FieldHint.jsx';
import Loading from './Loading.jsx';

const DAYS = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

const DEFAULT_OPEN = '09:00';
const DEFAULT_CLOSE = '18:00';

/** opening_hours as stored (sparse — only days the pharmacy has set) -> one row per day, always. */
function toRows(stored) {
  const byDay = new Map((stored || []).map((d) => [d.day, d]));
  return DAYS.map(({ key }) => {
    const existing = byDay.get(key);
    if (!existing) return { day: key, closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
    if (existing.closed) return { day: key, closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
    return { day: key, closed: false, open: existing.open, close: existing.close };
  });
}

/** Rows -> the array shape the server's normalizeOpeningHours expects. */
function toPayload(rows) {
  return rows.map((r) => (r.closed ? { day: r.day, closed: true } : { day: r.day, open: r.open, close: r.close, closed: false }));
}

export default function PharmacyHoursSettings() {
  const [rows, setRows] = useState(() => toRows([]));
  const [address, setAddress] = useState({ address_line: '', city: '', state: '', landmark: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/pharmacies/me/profile');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not load settings.');
        const p = j.profile || {};
        setRows(toRows(p.opening_hours));
        setAddress({
          address_line: p.address_line || '',
          city: p.city || '',
          state: p.state || '',
          landmark: p.landmark || '',
        });
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function updateRow(day, patch) {
    setRows((prev) => prev.map((r) => (r.day === day ? { ...r, ...patch } : r)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Every day sent, closed ones included — so a day the pharmacy just
      // closed overwrites whatever open entry was there before, rather than
      // leaving a stale one in place because it was omitted.
      const payload = toPayload(rows);

      const r = await fetch('/api/pharmacies/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opening_hours: payload, ...address }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not save.');
      setRows(toRows(j.profile?.opening_hours));
      setAddress({
        address_line: j.profile?.address_line || '',
        city: j.profile?.city || '',
        state: j.profile?.state || '',
        landmark: j.profile?.landmark || '',
      });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <section className="rounded-lg border border-slate-200 p-5 text-sm text-slate-500"><Loading /></section>;
  }

  const anyOpen = rows.some((r) => !r.closed);

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="font-medium">Hours & location</h2>
          <p className="mt-1 text-sm text-slate-600">
            When you&apos;re open and where you are — the assistant uses this to answer directly instead of guessing.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
          anyOpen ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700'
        }`}>
          {anyOpen ? '✓ Configured' : '⚠ Not configured'}
        </span>
      </header>

      <div className="space-y-5 p-5">
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div>
          <h3 className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
            Opening hours
            <FieldHint label="Opening hours">
              Set every day independently — weekends included. A day left off
              just means it hasn't been set.
            </FieldHint>
          </h3>
          <div className="mt-3 space-y-2">
            {rows.map((row) => {
              const dayLabel = DAYS.find((d) => d.key === row.day).label;
              const isWeekend = row.day === 'sat' || row.day === 'sun';
              return (
                <div
                  key={row.day}
                  className={`flex flex-wrap items-center gap-3 rounded border px-3 py-2 ${
                    isWeekend ? 'border-slate-200 bg-slate-50' : 'border-slate-200'
                  }`}
                >
                  <label className="flex w-28 shrink-0 items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={!row.closed}
                      onChange={(e) => updateRow(row.day, { closed: !e.target.checked })}
                      className="rounded border-slate-300"
                    />
                    {dayLabel}
                  </label>

                  {row.closed ? (
                    <span className="text-sm text-slate-400">Closed</span>
                  ) : (
                    <div className="flex items-center gap-2 text-sm">
                      <input
                        type="time"
                        value={row.open}
                        onChange={(e) => updateRow(row.day, { open: e.target.value })}
                        className="rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                      <span className="text-slate-400">to</span>
                      <input
                        type="time"
                        value={row.close}
                        onChange={(e) => updateRow(row.day, { close: e.target.value })}
                        className="rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-slate-700">Location</h3>
          <div className="mt-2 grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Address</span>
              <input
                value={address.address_line}
                onChange={(e) => setAddress((a) => ({ ...a, address_line: e.target.value.slice(0, 200) }))}
                placeholder="12 Allen Avenue"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">City</span>
              <input
                value={address.city}
                onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value.slice(0, 80) }))}
                placeholder="Ikeja"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">State</span>
              <input
                value={address.state}
                onChange={(e) => setAddress((a) => ({ ...a, state: e.target.value.slice(0, 80) }))}
                placeholder="Lagos"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Landmark (optional)</span>
              <input
                value={address.landmark}
                onChange={(e) => setAddress((a) => ({ ...a, landmark: e.target.value.slice(0, 200) }))}
                placeholder="Opposite First Bank"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {justSaved && <span className="text-sm text-teal-700">Saved.</span>}
        </div>
      </div>
    </section>
  );
}
