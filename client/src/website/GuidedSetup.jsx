/**
 * Confirm your details, then choose how it looks.
 *
 * THIS FORM EDITS THE PHARMACY, NOT THE WEBSITE. Every field below writes to
 * `pharmacy_profile` or to `pharmacies` through the endpoints that already
 * own them — the same rows Settings edits, the same rows the assistant reads.
 * The website has no copy of any of it; the blocks declare `from` bindings
 * and inherit these values at render time.
 *
 * That is why the screen says "confirm", not "enter". Most of it is already
 * filled in, because the pharmacy told us during onboarding, and the point of
 * this step is to let them check it before it goes on the public internet.
 *
 * OPENING HOURS ARE DELIBERATELY NOT EDITABLE HERE. They have a seven-day
 * editor in Settings with real validation behind it, and building a second
 * one would be the fastest route to a website that says 8pm while the
 * assistant says 7pm. The current hours are shown, with a link to the one
 * place that changes them.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconSetup } from '../Icons.jsx';
import * as api from './api.js';
import LogoUpload from './LogoUpload.jsx';
import PhotoUpload from './PhotoUpload.jsx';
import ServicesPicker from './ServicesPicker.jsx';
import HealthTopics from './HealthTopics.jsx';

const DAY_NAMES = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

export default function GuidedSetup({ site, onThemeChange, onSaved, onNavigate }) {
  const [profile, setProfile] = useState(null);
  const [pharmacy, setPharmacy] = useState(null);
  const [contract, setContract] = useState(null);
  const [theme, setTheme] = useState(site.theme || {});
  const [status, setStatus] = useState({ state: 'loading' });

  useEffect(() => {
    let live = true;
    Promise.all([api.getProfile(), api.getPharmacy(), api.getBlockContract()])
      .then(([p, ph, c]) => {
        if (!live) return;
        setProfile(p);
        setPharmacy(ph);
        setContract(c);
        setStatus({ state: 'idle' });
      })
      .catch((err) => live && setStatus({ state: 'error', message: err.message }));
    return () => { live = false; };
  }, []);

  const set = (key) => (e) => setProfile((p) => ({ ...p, [key]: e.target.value }));

  async function saveDetails() {
    setStatus({ state: 'saving' });
    try {
      // Only the fields this screen owns. A PATCH carrying the whole profile
      // would let a stale read here overwrite a change made in Settings in
      // another tab.
      const saved = await api.saveProfile({
        phone: profile.phone,
        address_line: profile.address_line,
        city: profile.city,
        state: profile.state,
        landmark: profile.landmark,
        maps_url: profile.maps_url,
        description: profile.description,
      });
      if (pharmacy?.public_whatsapp_number !== undefined) {
        await api.savePublicWhatsappNumber(pharmacy.public_whatsapp_number || null);
      }
      setProfile(saved);
      setStatus({ state: 'saved' });
      onSaved?.();
    } catch (err) {
      setStatus({ state: 'error', message: err.message });
    }
  }

  async function applyTheme(next) {
    setTheme(next);
    try {
      await api.saveTheme(next);
      onThemeChange?.();
    } catch (err) {
      setStatus({ state: 'error', message: err.message });
    }
  }

  if (status.state === 'loading') {
    return <Panel className="p-6"><p className="text-slate-500">Loading your details…</p></Panel>;
  }
  if (!profile) {
    return <Panel className="p-6"><p className="text-red-700">{status.message}</p></Panel>;
  }

  const hours = Array.isArray(profile.opening_hours) ? profile.opening_hours : [];
  const byDay = new Map(hours.filter((h) => h?.day).map((h) => [h.day, h]));

  return (
    <div className="space-y-5">
      {status.state === 'error' && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>
      )}

      {/* ---- details ---- */}
      <Panel className="p-5">
        <PanelHead Icon={IconSetup}>Your pharmacy details</PanelHead>
        <p className="mt-1 mb-4 text-sm text-slate-600">
          These come from your pharmacy profile and appear on your website. Changing
          them here changes them everywhere — including what the assistant tells
          customers.
        </p>

        <div className="mb-5 border-b border-slate-100 pb-5">
          <LogoUpload profile={profile} onChanged={(saved) => { setProfile(saved); onSaved?.(); }} />
        </div>

        {/* No onChanged: gallery photos are found by kind rather than
            referenced from the profile, so there is nothing for the parent to
            re-read after an upload. */}
        <div className="mb-5 border-b border-slate-100 pb-5">
          <PhotoUpload />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Pharmacy name" hint="Changed in Setup, because it identifies your account everywhere.">
            <input className={`${inputClass} bg-slate-50 text-slate-500`} value={pharmacy?.name || ''} readOnly />
          </Field>

          <Field label="WhatsApp number" hint="The number on your website button and your printed QR code.">
            <input
              className={inputClass}
              value={pharmacy?.public_whatsapp_number || ''}
              onChange={(e) => setPharmacy((p) => ({ ...p, public_whatsapp_number: e.target.value }))}
              placeholder="2348012345678"
              inputMode="numeric"
            />
          </Field>

          <Field label="Phone number">
            <input className={inputClass} value={profile.phone || ''} onChange={set('phone')} placeholder="08012345678" />
          </Field>

          <Field label="Street address">
            <input className={inputClass} value={profile.address_line || ''} onChange={set('address_line')} />
          </Field>

          <Field label="City">
            <input className={inputClass} value={profile.city || ''} onChange={set('city')} />
          </Field>

          <Field label="State">
            <input className={inputClass} value={profile.state || ''} onChange={set('state')} />
          </Field>

          <Field label="Nearest landmark" hint="How customers actually describe where you are.">
            <input className={inputClass} value={profile.landmark || ''} onChange={set('landmark')} />
          </Field>

          <Field label="Directions link" hint="A Google Maps link, so customers can navigate to you.">
            <input className={inputClass} value={profile.maps_url || ''} onChange={set('maps_url')} placeholder="https://maps.google.com/…" />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="About your pharmacy" hint="A short introduction. Leave a blank line between paragraphs.">
            <textarea
              className={`${inputClass} min-h-32`}
              value={profile.description || ''}
              onChange={set('description')}
              placeholder="We have served the community since…"
            />
          </Field>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={saveDetails}
            disabled={status.state === 'saving'}
            className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
          >
            {status.state === 'saving' ? 'Saving…' : 'Save details'}
          </button>
          {status.state === 'saved' && <span className="text-sm text-teal-700">Saved.</span>}
        </div>
      </Panel>

      {/* ---- what the pharmacy offers, and what it publishes ----
          These two decide which PAGES the website has. Everything above is
          the same information rendered differently; this is the only place
          where a choice adds or removes a URL. Kept as one panel because to
          an owner it is one question — "what goes on my site?" — and split
          across two would imply they are unrelated. */}
      <Panel className="p-5">
        <PanelHead Icon={IconSetup}>What is on your website</PanelHead>
        <p className="mt-1 mb-4 text-sm text-slate-600">
          Each thing you add here becomes its own page, so someone searching for it can
          find your pharmacy.
        </p>

        <ServicesPicker
          profile={profile}
          onSaved={(saved) => { setProfile(saved); onSaved?.(); }}
        />

        <div className="mt-6 border-t border-slate-100 pt-5">
          <HealthTopics site={site} onSaved={() => onSaved?.()} />
        </div>
      </Panel>

      {/* ---- opening hours, read-only on purpose ---- */}
      <Panel className="p-5">
        <PanelHead Icon={IconSetup}>Opening hours</PanelHead>
        <p className="mt-1 mb-3 text-sm text-slate-600">
          Your website shows exactly what your profile says, so it can never fall out of
          step with what the assistant tells customers.
        </p>
        {byDay.size === 0 ? (
          <p className="text-sm text-slate-500">No opening hours set yet.</p>
        ) : (
          <dl className="max-w-sm text-sm">
            {DAY_ORDER.filter((d) => byDay.has(d)).map((d) => {
              const h = byDay.get(d);
              return (
                <div key={d} className="flex justify-between border-b border-slate-100 py-1.5">
                  <dt className="font-medium text-slate-700">{DAY_NAMES[d]}</dt>
                  <dd className="text-slate-500">
                    {h.closed || !h.open || !h.close ? 'Closed' : `${h.open} – ${h.close}`}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        <button
          type="button"
          onClick={() => onNavigate?.('setup')}
          className="mt-4 text-sm font-medium text-teal-700 hover:underline"
        >
          Change opening hours in Setup →
        </button>
      </Panel>

      {/* ---- branding ---- */}
      <Panel className="p-5">
        <PanelHead Icon={IconSetup}>How it looks</PanelHead>
        <p className="mt-1 mb-4 text-sm text-slate-600">
          A small set of combinations, all designed to work. The preview updates as you
          choose.
        </p>

        <p className="mb-2 text-sm font-medium text-slate-700">Colour</p>
        <div className="mb-5 flex flex-wrap gap-2">
          {(contract?.theme.palettes || []).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyTheme({ ...theme, palette: p.id })}
              aria-label={p.id}
              aria-pressed={theme.palette === p.id}
              className={`h-10 w-10 rounded-full ring-offset-2 transition ${
                theme.palette === p.id ? 'ring-2 ring-slate-900' : 'ring-1 ring-slate-200'
              }`}
              style={{ background: p.primary }}
            />
          ))}
        </div>

        <p className="mb-2 text-sm font-medium text-slate-700">Type</p>
        <div className="mb-5 flex flex-wrap gap-2">
          {(contract?.theme.fonts || []).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => applyTheme({ ...theme, font: f.id })}
              aria-pressed={theme.font === f.id}
              className={`rounded-lg border px-3 py-2 text-sm transition ${
                theme.font === f.id
                  ? 'border-teal-700 bg-teal-50 text-teal-800'
                  : 'border-slate-300 text-slate-600 hover:border-slate-400'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <p className="mb-2 text-sm font-medium text-slate-700">Corners</p>
        <div className="flex flex-wrap gap-2">
          {(contract?.theme.corners || []).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => applyTheme({ ...theme, corners: c })}
              aria-pressed={theme.corners === c}
              className={`rounded-lg border px-3 py-2 text-sm capitalize transition ${
                theme.corners === c
                  ? 'border-teal-700 bg-teal-50 text-teal-800'
                  : 'border-slate-300 text-slate-600 hover:border-slate-400'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}
