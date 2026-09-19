/**
 * Home — the app launcher a pharmacy sees first after signing in.
 *
 * The ERPNext desk's home, in this product's terms: no sidebar, a grid of
 * module tiles, one click into each. Five modules, in the order the owner
 * named them.
 *
 * WHAT EACH TILE OPENS (moduleTarget, below — pure and tested)
 *   Stock      Inventory: the catalogue and its upload.
 *   Clinics    Consultations: the pharmacist's clinical queue. Clinic
 *              BOOKINGS are not built yet; this is the clinical side of the
 *              product as it stands.
 *   Patients   Patients, with the refill call list.
 *   Marketing  Not built. The tile says "Soon", and opening it says so in a
 *              sentence rather than showing an invented screen.
 *   Branding   The website builder where it is switched on for this server;
 *              otherwise Setup, where the pharmacy's name, the assistant's
 *              name and its welcome note live.
 *
 * Tab ids are the existing ones. Nothing here routes anywhere the rest of the
 * app does not already go.
 */

import {
  IconModuleStock, IconModuleClinics, IconModulePatients, IconModuleMarketing, IconModuleBranding,
} from './Icons.jsx';

export const MODULES = [
  { id: 'stock', label: 'Stock', Icon: IconModuleStock, hint: 'Your catalogue, prices and stock' },
  { id: 'clinics', label: 'Clinics', Icon: IconModuleClinics, hint: 'People waiting to speak to a pharmacist' },
  { id: 'patients', label: 'Patients', Icon: IconModulePatients, hint: 'Patient records and refills due' },
  { id: 'marketing', label: 'Marketing', Icon: IconModuleMarketing, hint: 'Campaigns to your patients', soon: true },
  { id: 'branding', label: 'Branding', Icon: IconModuleBranding, hint: 'Your website and how the assistant presents you' },
];

/**
 * The tab a module opens. Pure, so the mapping is testable without a DOM.
 *
 * @param {string} moduleId
 * @param {{ websiteEnabled: boolean|null }} ctx  websiteEnabled is null until
 *   the server has answered; Branding falls back to Setup until it says yes.
 * @returns {string} an existing App tab id
 */
export function moduleTarget(moduleId, { websiteEnabled = null } = {}) {
  switch (moduleId) {
    case 'stock': return 'inventory';
    case 'clinics': return 'consultations';
    case 'patients': return 'customers';
    case 'marketing': return 'marketing';
    case 'branding': return websiteEnabled === true ? 'website' : 'setup';
    default: throw new Error(`Unknown module "${moduleId}"`);
  }
}

/**
 * The grid. Each tile is one button: the icon tile and its label together,
 * so the whole thing is the click target and a screen reader hears
 * "Stock, button" rather than an unlabelled picture beside some text. The
 * hint is the button's title: a hover tooltip, and its accessible
 * description.
 */
export default function Launcher({ onOpen, websiteEnabled }) {
  return (
    <section aria-labelledby="launcher-title" className="mx-auto w-full max-w-[880px] pt-4">
      <h1 id="launcher-title" className="sr-only">Home</h1>
      {/* Three across on a phone (3 + 2), five in one row from tablet width up —
          never a lone tile on a row of its own. */}
      <ul className="grid grid-cols-3 gap-x-4 gap-y-10 md:grid-cols-5 md:gap-x-6">
        {MODULES.map(({ id, label, Icon, hint, soon }, i) => (
          <li key={id} className="flex justify-center">
            <button
              type="button"
              onClick={() => onOpen(moduleTarget(id, { websiteEnabled }))}
              // The hint is the button's DESCRIPTION (title), never part of its
              // name: the name stays the module's label, "Marketing", not
              // "Campaigns to your patients".
              title={hint}
              // Stated outright rather than left to computation from the
              // tile's text, so every reader agrees on it.
              aria-label={soon ? `${label}, coming soon` : label}
              style={{ '--i': i }}
              className="ui-app-tile group flex w-full max-w-[140px] flex-col items-center gap-3 rounded-xl px-2 pb-2 pt-1"
            >
              <span className="ui-app-icon" aria-hidden="true">
                <Icon width={28} height={28} strokeWidth={1.75} />
              </span>
              <span className="flex flex-col items-center gap-1">
                <span className="text-[14px] font-semibold text-[var(--ui-ink)]">{label}</span>
                {soon && <span className="ui-app-soon">Soon</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Where Marketing lands until it exists. One honest sentence and a way back;
 * design.md: a screen that can be empty must say why it is empty.
 */
export function MarketingPending({ onHome }) {
  return (
    <div className="ui-card max-w-xl p-5">
      <h2 className="text-[14px] font-semibold text-[var(--ui-ink)]">Not built yet</h2>
      <p className="mt-1 text-sm text-[var(--ui-ink-soft)]">
        Marketing will send campaigns to groups of your patients over WhatsApp and SMS — a free BP
        check day for everyone on blood-pressure medicine, for example. It is the next module to be
        built, so there is nothing here yet.
      </p>
      <button
        type="button"
        onClick={onHome}
        className="mt-4 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
      >
        Back to home
      </button>
    </div>
  );
}
