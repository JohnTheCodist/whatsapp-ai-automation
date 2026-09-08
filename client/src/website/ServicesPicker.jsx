/**
 * What this pharmacy offers.
 *
 * THIS LIST IS THE SITE MAP. Each service becomes a page at its own URL —
 * /services/blood-pressure-check/ — with its own title, description and
 * structured data, listed in the sitemap and linked from the services index.
 * Removing one removes all of that.
 *
 * The owner is never told any of that, and this screen contains no SEO
 * vocabulary at all. They tick what their pharmacy does. A pharmacist should
 * not have to understand canonical URLs to have a website that works, and a
 * form that asked them to would get worse answers, not better ones.
 *
 * COMMON SERVICES ARE OFFERED AS TOGGLES, not typed. Owners write "Refills",
 * "Prescription refill" and "Repeat prescriptions" meaning one thing, and
 * although the page generator collapses those onto one URL, a toggle avoids
 * the ambiguity entirely and takes one tap instead of a sentence. Anything
 * else can still be typed, because no fixed list describes every pharmacy.
 *
 * NOTHING IS PRE-TICKED. A default set would put services on a real
 * pharmacy's public website that it may not offer, and a customer arriving
 * for a blood glucose test that was never available is a worse outcome than
 * an empty list.
 */

import { useState } from 'react';
import * as api from './api.js';

/**
 * The services common enough to be worth offering directly.
 *
 * Order is roughly by how often a Nigerian community pharmacy offers them.
 * The label is what appears on the website, so it is written the way a
 * customer would read it rather than the way a form would label it.
 */
const COMMON = [
  { label: 'Prescription Refills', hint: 'Dispensing repeat prescriptions' },
  { label: 'Blood Pressure Checks', hint: 'Measuring blood pressure in the pharmacy' },
  { label: 'Blood Glucose Testing', hint: 'Finger-prick blood sugar testing' },
  { label: 'Medication Counselling', hint: 'Talking through medicines with a pharmacist' },
  { label: 'Health Screening', hint: 'Routine checks carried out in the pharmacy' },
  { label: 'Medication Reviews', hint: 'Going through everything a patient takes' },
  { label: 'Minor Ailment Support', hint: 'Advice and treatment for everyday complaints' },
  { label: 'Vaccination Services', hint: 'Vaccines given at the pharmacy' },
  { label: 'Home Delivery', hint: 'Delivering to a customer’s address' },
];

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

export default function ServicesPicker({ profile, onSaved }) {
  const [services, setServices] = useState(() =>
    (Array.isArray(profile?.services) ? profile.services : []).map((s) => ({ ...s })));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const names = new Set(services.map((s) => s.name.trim().toLowerCase()));

  async function persist(next) {
    setServices(next);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // The profile is the single source of truth for the whole site, so this
      // writes there rather than to anything the website owns.
      const updated = await api.saveProfile({ services: next });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.(updated);
    } catch (err) {
      setError(err.message);
      // Put the list back. Leaving the toggle showing a state the server
      // rejected is how an owner ends up believing a service is published
      // when it is not.
      setServices(Array.isArray(profile?.services) ? profile.services : []);
    } finally {
      setBusy(false);
    }
  }

  function toggle(label) {
    const key = label.trim().toLowerCase();
    const next = names.has(key)
      ? services.filter((s) => s.name.trim().toLowerCase() !== key)
      : [...services, { name: label }];
    persist(next);
  }

  function addCustom(event) {
    event.preventDefault();
    const name = custom.trim();
    if (!name) return;
    if (names.has(name.toLowerCase())) { setCustom(''); return; }
    if (services.length >= 12) {
      setError('You can list up to 12 services.');
      return;
    }
    persist([...services, { name }]);
    setCustom('');
  }

  function describe(index, description) {
    const next = services.map((s, i) => (i === index ? { ...s, description } : s));
    setServices(next);
  }

  const customServices = services.filter(
    (s) => !COMMON.some((c) => c.label.toLowerCase() === s.name.trim().toLowerCase()),
  );

  return (
    <section>
      <h3 className="text-sm font-medium text-slate-800">What your pharmacy offers</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        Each one gets its own page on your website, so customers searching for it can find you.
        Only tick what you actually offer.
      </p>

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {COMMON.map((item) => {
          const on = names.has(item.label.toLowerCase());
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => toggle(item.label)}
              disabled={busy}
              aria-pressed={on}
              className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${
                on
                  ? 'border-teal-400 bg-teal-50'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    on ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'
                  }`}
                >
                  {on ? '✓' : ''}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                  <span className="block text-xs text-slate-500">{item.hint}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {customServices.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Your own
          </p>
          <ul className="mt-2 space-y-2">
            {customServices.map((service) => {
              const index = services.indexOf(service);
              return (
                <li key={service.name} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-slate-800">{service.name}</span>
                    <button
                      type="button"
                      onClick={() => persist(services.filter((s) => s !== service))}
                      disabled={busy}
                      className="text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                  {/* Optional, and the owner's words are used verbatim on the
                      page. Left blank, the page says only what we can say
                      truthfully about a service we cannot identify. */}
                  <input
                    className={`${inputClass} mt-2 text-xs`}
                    value={service.description || ''}
                    onChange={(e) => describe(index, e.target.value.slice(0, 300))}
                    onBlur={() => persist(services)}
                    placeholder="Optional: one line about how you do this"
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <form onSubmit={addCustom} className="mt-4 flex gap-2">
        <input
          className={inputClass}
          value={custom}
          onChange={(e) => setCustom(e.target.value.slice(0, 80))}
          placeholder="Something else you offer"
          aria-label="Add another service"
        />
        <button
          type="submit"
          disabled={busy || !custom.trim()}
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Add
        </button>
      </form>

      <p className="mt-2 text-xs text-slate-500">
        {services.length === 0
          ? 'No services yet. Your website will not have a services section.'
          : `${services.length} service${services.length === 1 ? '' : 's'}, ${services.length} page${services.length === 1 ? '' : 's'}.`}
        {saved && <span className="ml-2 text-teal-700">Saved.</span>}
      </p>
    </section>
  );
}
