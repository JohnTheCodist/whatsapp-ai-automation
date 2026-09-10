/**
 * The facts about the pharmacy: who you are, where you are, when you are
 * open, what you do, what it looks like.
 *
 * WHY THIS IS SEPARATE FROM WebsiteContent, AND WHY THE SPLIT IS REAL.
 * These two panels were one list of seven rows, and it conflated two
 * different things. Everything here writes to `pharmacy_profile` and
 * `pharmacies` through the same endpoints Settings uses — the website holds
 * no copy of any of it, because the blocks declare `from` bindings and
 * inherit these values at render time. Everything in WebsiteContent writes to
 * the website's own `content` column and exists only to change how these
 * facts are worded on the page.
 *
 * So the boundary is not a visual grouping imposed on the list. It is the one
 * the data already has, which is what lets this panel honestly say that
 * changing something here changes it everywhere — including what the
 * assistant tells customers on WhatsApp — while the other panel cannot say
 * that about anything it owns.
 *
 * COLLAPSED BY DEFAULT, one row open at a time. An owner opens this tab a
 * handful of times a year; every field of every panel on screen at once is
 * how a confirm-and-glance screen becomes an admin form.
 *
 * OPENING HOURS HAS NO PANEL HERE, DELIBERATELY. It has a real seven-day
 * editor with real validation in Setup, and a second one would be the fastest
 * route to a website that says 8pm while the assistant says 7pm. That row is
 * a link.
 */

import { useEffect, useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import * as api from './api.js';
import Row from './Row.jsx';
import SectionTitle from './SectionTitle.jsx';
import LogoUpload from './LogoUpload.jsx';
import PhotoUpload from './PhotoUpload.jsx';
import ServicesPicker from './ServicesPicker.jsx';

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

export default function BusinessInfo({ onSaved, onNavigate }) {
  const [profile, setProfile] = useState(null);
  const [pharmacy, setPharmacy] = useState(null);
  const [status, setStatus] = useState({ state: 'loading' });
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.getProfile(), api.getPharmacy()])
      .then(([p, ph]) => {
        if (!live) return;
        setProfile(p);
        setPharmacy(ph);
        setStatus({ state: 'idle' });
      })
      .catch((err) => live && setStatus({ state: 'error', message: err.message }));
    return () => { live = false; };
  }, []);

  const set = (key) => (e) => setProfile((p) => ({ ...p, [key]: e.target.value }));
  const toggle = (key) => setOpen((current) => (current === key ? null : key));

  async function saveDetails() {
    setStatus({ state: 'saving' });
    try {
      // Only the fields this panel owns. A PATCH carrying the whole profile
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

  if (status.state === 'loading') {
    return (
      <Panel className="p-5 sm:p-6">
        <p className="text-sm text-slate-500">Loading your pharmacy details…</p>
      </Panel>
    );
  }
  if (!profile) {
    return (
      <Panel className="p-5 sm:p-6">
        <p className="text-sm text-red-700">{status.message}</p>
      </Panel>
    );
  }

  const hours = Array.isArray(profile.opening_hours) ? profile.opening_hours : [];
  const daysSet = new Set(hours.filter((h) => h?.day).map((h) => h.day)).size;
  const hoursSummary = daysSet === 0 ? 'Not set yet' : `${daysSet} day${daysSet === 1 ? '' : 's'} set`;
  const serviceCount = Array.isArray(profile.services) ? profile.services.length : 0;

  return (
    <Panel className="p-5 sm:p-6">
      <SectionTitle
        title="Business information"
        info="The facts about your pharmacy. Your website uses these automatically, and changing them here changes them everywhere — including what the assistant tells customers on WhatsApp."
      />

      {status.state === 'error' && (
        <p className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>
      )}

      <div className="mt-2">
        <Row
          label="Pharmacy information"
          summary={[pharmacy?.name, profile.phone].filter(Boolean).join(' · ') || 'Name, address and contact details'}
          actionLabel="Edit →"
          expanded={open === 'info'}
          onToggle={() => toggle('info')}
        >
          <div className="mb-5 border-b border-slate-100 pb-5">
            <LogoUpload profile={profile} onChanged={(saved) => { setProfile(saved); onSaved?.(); }} />
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
        </Row>

        {/* A link, not a disclosure. The seven-day editor lives in Setup and
            must stay the only one — see the file header. */}
        <Row
          label="Opening hours"
          summary={hoursSummary}
          actionLabel="Edit →"
          expanded={false}
          onToggle={() => onNavigate?.('setup')}
        />

        <Row
          label="Services"
          summary={serviceCount ? `${serviceCount} service${serviceCount === 1 ? '' : 's'} listed` : 'None added yet'}
          actionLabel="Edit →"
          expanded={open === 'services'}
          onToggle={() => toggle('services')}
        >
          <ServicesPicker profile={profile} onSaved={(saved) => { setProfile(saved); onSaved?.(); }} />
        </Row>

        <Row
          label="Photos"
          summary="Shown on your About and Location pages"
          actionLabel="Edit →"
          expanded={open === 'photos'}
          onToggle={() => toggle('photos')}
        >
          <PhotoUpload />
        </Row>
      </div>
    </Panel>
  );
}
