/**
 * The pharmacy's CUSTOMER-facing phone number — not the staff order-alert
 * number (AssistantSettings' "Alert this number about new orders"), which
 * WhatsApp routes to and customers never see. This one is the opposite: it
 * exists specifically to BE shown to a customer, by the assistant's
 * contact_pharmacy tool, when it has genuinely run out of things it can do
 * automatically.
 *
 * Kept as its own section, deliberately not folded into assistant identity
 * or staff notifications — three different audiences (how the bot
 * introduces itself, what pages staff, what a customer is told to call).
 * Labelled "Customer support phone" and nothing else, because "Contact" or
 * "Phone" reads ambiguous next to a staff-alert field one screen over.
 */

import { useEffect, useState } from 'react';

/**
 * Stored canonical digits (234801...) -> "+234 801 234 5678".
 * Mirrors catalogueTools.js's formatPhoneForDisplay — kept as a small,
 * independent client copy rather than importing across the server/client
 * boundary. The input itself stays raw and editable; this only labels what
 * is already saved, so reformatting never fights someone mid-keystroke.
 */
function formatForDisplay(digits) {
  if (!digits) return null;
  const clean = digits.replace(/\D/g, '');
  const cc = clean.slice(0, 3);
  const rest = clean.slice(3);
  if (rest.length !== 10) return `+${clean}`;
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
}

export default function CustomerContactSettings() {
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);
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
        setPhone(j.profile?.phone || '');
        setSaved(Boolean(j.profile?.phone));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/pharmacies/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not save.');
      // The server normalises (0801... and +234801... collapse to one
      // value) — reflect what was actually stored, not what was typed.
      setPhone(j.profile?.phone || '');
      setSaved(Boolean(j.profile?.phone));
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <section className="rounded-lg border border-slate-200 p-5 text-sm text-slate-500">Loading…</section>;
  }

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="font-medium">Customer contact</h2>
          <p className="mt-1 text-sm text-slate-600">
            The number the assistant may give a customer when it has done everything it can.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
          saved ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-700'
        }`}>
          {saved ? '✓ Configured' : '⚠ Not configured'}
        </span>
      </header>

      <div className="space-y-4 p-5">
        {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <label className="block max-w-sm">
          <span className="text-sm font-medium text-slate-700">Customer support phone</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value.slice(0, 40))}
            placeholder="0801 234 5678"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-500">
            This number may be shown to customers when the assistant cannot resolve a request and direct
            pharmacy assistance is needed. Any format works — it&apos;s stored and matched consistently either way.
          </span>
          {/* What a customer will actually be told — the editable box above
              stays a plain text field, but the number this system sends over
              WhatsApp is always this grouped, obviously-a-phone-number form. */}
          {phone.trim() && (
            <p className="mt-1.5 text-xs text-slate-600">
              Shown to customers as: <span className="font-medium text-slate-800">{formatForDisplay(phone) || phone}</span>
            </p>
          )}
        </label>

        {/* Stated explicitly, because "phone number" fields on this kind of
            dashboard usually mean something staff-only (order alerts,
            account login) — this is the one exception, on purpose. */}
        <p className="max-w-sm rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Unlike other phone numbers in Setup, this one is customer-facing — it can appear in a WhatsApp
          reply. Not a staff or admin line.
        </p>

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
