/**
 * Assistant identity — pharmacy name, bot name, welcome note, menu on/off.
 *
 * DESIGN NOTE
 * The live preview calls POST /me/assistant/preview, which runs the SERVER's
 * buildMenu() — the exact function used for a real customer — rather than a
 * hand-copied approximation in JSX. An owner should never discover a
 * mismatch between "what I saved" and "what customers get" by asking a
 * customer. Debounced so typing a sentence does not fire a request per
 * keystroke.
 */

import { useEffect, useRef, useState } from 'react';
import FieldHint from './FieldHint.jsx';

const MAX_BOT_NAME = 40;
const MAX_WELCOME_NOTE = 300;

export default function AssistantSettings() {
  const [pharmacy, setPharmacy] = useState(null);
  const [pharmacyName, setPharmacyName] = useState('');
  const [botName, setBotName] = useState('');
  const [welcomeNote, setWelcomeNote] = useState('');
  const [menuEnabled, setMenuEnabled] = useState(true);
  const [notifyPhone, setNotifyPhone] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [previewText, setPreviewText] = useState('');
  const previewTimer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/pharmacies/me');
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Could not load settings.');
        setPharmacy(j.pharmacy);
        setPharmacyName(j.pharmacy.name || '');
        setBotName(j.pharmacy.bot_name || '');
        setWelcomeNote(j.pharmacy.welcome_note || '');
        setMenuEnabled(j.pharmacy.menu_enabled !== false);
        setNotifyPhone(j.pharmacy.notify_phone || '');
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
    setSaved(false);
    try {
      // Two endpoints, because they are two different kinds of fact: the
      // registered pharmacy name has its own validation and slug handling on
      // the server, while bot identity is presentation. Sending the name
      // patch only when it actually changed avoids re-triggering that
      // validation on every unrelated save.
      const calls = [];
      if (pharmacyName.trim() !== (pharmacy?.name || '')) {
        calls.push(
          fetch('/api/pharmacies/me', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: pharmacyName.trim() }),
          })
        );
      }
      calls.push(
        fetch('/api/pharmacies/me/assistant', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botName, welcomeNote, menuEnabled, notifyPhone }),
        })
      );

      const results = await Promise.all(calls);
      for (const r of results) {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || 'Could not save.');
        }
      }
      const [{ pharmacy: updated }] = await Promise.all(results.map((r) => r.json()));
      setPharmacy((prev) => ({ ...prev, ...updated, name: pharmacyName.trim() }));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Debounced preview against the server's real buildMenu(), not a JSX copy.
  useEffect(() => {
    if (!pharmacyName.trim()) { setPreviewText(''); return undefined; }
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/pharmacies/me/assistant/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pharmacyName: pharmacyName.trim(), botName, welcomeNote, menuEnabled }),
        });
        const j = await r.json();
        if (r.ok) setPreviewText(j.text);
      } catch { /* the form still works without a live preview */ }
    }, 400);
    return () => clearTimeout(previewTimer.current);
  }, [pharmacyName, botName, welcomeNote, menuEnabled]);

  async function generateNote() {
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch('/api/pharmacies/me/assistant/welcome-note/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botName: botName.trim() || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not generate a note.');
      // Fills the box; does NOT save. The owner reads it and decides —
      // writing an unapproved sentence into what customers see is not a
      // shortcut worth taking.
      setWelcomeNote(j.note);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return <section className="rounded-lg border border-slate-200 p-5 text-sm text-slate-500">Loading…</section>;
  }

  return (
    <section className="rounded-lg border border-slate-200">
      <header className="border-b border-slate-200 px-5 py-4">
        <h2 className="font-medium">Assistant identity</h2>
        <p className="mt-1 text-sm text-slate-600">
          How the assistant introduces itself the first time someone messages you.
        </p>
      </header>

      <div className="grid gap-6 p-5 md:grid-cols-2">
        {/* ---- form ---- */}
        <div className="space-y-4">
          {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <label className="block">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              Pharmacy name
              <FieldHint label="Pharmacy name">
                Shown to customers and used as the assistant's name if you don't set one below.
              </FieldHint>
            </span>
            <input
              value={pharmacyName}
              onChange={(e) => setPharmacyName(e.target.value)}
              placeholder="Sterling Pharmacy"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
              Assistant name
              <FieldHint label="Assistant name">
                Optional. Leave blank to use "{pharmacyName || 'the pharmacy'}".
              </FieldHint>
            </span>
            <input
              value={botName}
              onChange={(e) => setBotName(e.target.value.slice(0, MAX_BOT_NAME))}
              placeholder={pharmacyName || 'e.g. Ada'}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
            {/* The counter stays inline, not behind the hint — it is the
                current state of what you just typed, not background reading. */}
            <span className="mt-1 block text-xs text-slate-400">{botName.length}/{MAX_BOT_NAME}</span>
          </label>

          <label className="block">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
                Welcome note
                <FieldHint label="Welcome note">
                  One line shown right after the greeting. Optional.
                </FieldHint>
              </span>
              <button
                type="button"
                onClick={generateNote}
                disabled={generating || !pharmacyName.trim()}
                className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                title={!pharmacyName.trim() ? 'Enter a pharmacy name first' : ''}
              >
                {generating ? 'Writing…' : '✨ Write it for me'}
              </button>
            </div>
            <textarea
              value={welcomeNote}
              onChange={(e) => setWelcomeNote(e.target.value.slice(0, MAX_WELCOME_NOTE))}
              placeholder="e.g. We deliver across Ikeja and open every day, including holidays."
              rows={3}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-slate-400">{welcomeNote.length}/{MAX_WELCOME_NOTE}</span>
          </label>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={menuEnabled} onChange={(e) => setMenuEnabled(e.target.checked)} />
            <span className="text-sm text-slate-700">Show the menu of options after greeting</span>
          </label>

          {/* Deliberately boxed and labelled against the customer QR panel.
              These two numbers do opposite jobs and both mix-ups fail
              silently: a staff phone used as the customer line leaves people
              messaging someone with no assistant behind them, and the bot's
              own line used here makes it message itself. Naming whose phone
              this is — and what arrives on it — is the cheapest guard. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <label className="block">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
                Staff alert number
                <FieldHint label="Staff alert number">
                  New orders and pharmacist escalations are sent here, and whoever
                  holds it can reply <strong>1</strong> to confirm or{' '}
                  <strong>2</strong> to reject without opening this dashboard.
                  Leave blank for no alerts.
                </FieldHint>
              </span>
              <input
                value={notifyPhone}
                onChange={(e) => setNotifyPhone(e.target.value.slice(0, 32))}
                placeholder="2348012345678"
                inputMode="tel"
                className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              />
              {/* The one fact that must never be a click away: this is the
                  distinction that prevents the silent mix-up the surrounding
                  box exists to guard against (see the comment above it). */}
              <span className="mt-1 block text-xs text-slate-500">
                A <strong>staff member's own phone</strong> — not the pharmacy line customers message.
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || !pharmacyName.trim()}
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-sm text-teal-700">Saved.</span>}
          </div>
        </div>

        {/* ---- live preview ---- */}
        <div>
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
            Preview
            <FieldHint label="Preview">
              This is the exact message the assistant sends — "Chidi" is a
              stand-in; real customers are greeted using their own WhatsApp name.
            </FieldHint>
          </span>
          <div className="mt-1 rounded-lg bg-[#e5ddd5] p-3">
            <div className="max-w-[95%] whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
              {previewText || (pharmacyName.trim() ? '…' : 'Enter a pharmacy name to see the greeting.')}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
