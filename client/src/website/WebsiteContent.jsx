/**
 * What is on the website, as a short list rather than a form on screen.
 *
 * EVERY ROW EDITS THE PHARMACY, NOT THE WEBSITE. Pharmacy information writes
 * to `pharmacy_profile`/`pharmacies` through the same endpoints Settings
 * uses; services, photos and health guides are the same. The website has no
 * copy of any of it — the blocks declare `from` bindings and inherit these
 * values at render time (see the block registry). That is why saving here
 * says "Changing your pharmacy information updates it across your RxNaija
 * profile and website" rather than "saved to your website".
 *
 * COLLAPSED BY DEFAULT. An owner opens this tab a handful of times a year;
 * showing every field of every panel at once is how a confirm-and-glance
 * screen turns into an admin form. One row is open at a time — see Row below
 * — so the page reads as five short questions rather than one long one.
 *
 * OPENING HOURS HAS NO PANEL HERE, DELIBERATELY. It has a real seven-day
 * editor with real validation in Settings, and building a second one would
 * be the fastest route to a website that says 8pm while the assistant says
 * 7pm. "Edit →" on that row goes straight there.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconSetup } from '../Icons.jsx';
import * as api from './api.js';
import LogoUpload from './LogoUpload.jsx';
import PhotoUpload from './PhotoUpload.jsx';
import ServicesPicker from './ServicesPicker.jsx';
import HealthTopics from './HealthTopics.jsx';
import PageText from './PageText.jsx';
import HomeContent from './HomeContent.jsx';

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

/** One collapsible line: a summary, and its panel when open. */
function Row({ label, summary, actionLabel, expanded, onToggle, children }) {
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-900">{label}</span>
          {summary && <span className="mt-0.5 block truncate text-xs text-slate-500">{summary}</span>}
        </span>
        <span className="shrink-0 text-sm font-medium text-teal-700">
          {expanded ? 'Close' : actionLabel}
        </span>
      </button>
      {expanded && <div className="pb-5">{children}</div>}
    </div>
  );
}

export default function WebsiteContent({ site, pages, onSaved, onNavigate }) {
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
        <p className="text-sm text-slate-500">Loading your website content…</p>
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
      <PanelHead Icon={IconSetup}>Website content</PanelHead>
      <p className="mt-1 text-sm text-slate-600">
        Your website automatically uses information from your pharmacy profile. Changing
        it here changes it everywhere — including what the assistant tells customers.
      </p>

      {status.state === 'error' && (
        <p className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{status.message}</p>
      )}

      <div className="mt-2">
        <Row
          label="Pharmacy information"
          summary={[pharmacy?.name, profile.phone].filter(Boolean).join(' · ')}
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

        <Row
          label="Opening hours"
          summary={hoursSummary}
          actionLabel="Edit →"
          expanded={false}
          onToggle={() => onNavigate?.('setup')}
        />

        <Row
          label="Health guides"
          summary="Reviewed articles you can add to your website"
          actionLabel="Manage →"
          expanded={open === 'health'}
          onToggle={() => toggle('health')}
        >
          <HealthTopics site={site} onSaved={() => onSaved?.()} />
        </Row>

        <Row
          label="Homepage content"
          summary="Rewrite the heading, subheading and button text on your homepage"
          actionLabel="Edit →"
          expanded={open === 'homeContent'}
          onToggle={() => toggle('homeContent')}
        >
          <HomeContent site={site} onSaved={() => onSaved?.()} />
        </Row>

        <Row
          label="Website page text"
          summary="Rewrite the heading and opening line on any page"
          actionLabel="Edit →"
          expanded={open === 'pageText'}
          onToggle={() => toggle('pageText')}
        >
          <PageText site={site} pages={pages} onSaved={() => onSaved?.()} />
        </Row>
      </div>
    </Panel>
  );
}
