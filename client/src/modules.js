/**
 * The five modules, and which existing screens each one holds.
 *
 * THE ONE MAP. The launcher's tiles, each workspace's sidebar, the breadcrumb
 * and the question "which module am I in" all read from this file, so they
 * cannot disagree. See MODULES_PLAN.md for the audit behind every placement.
 *
 * NOTHING HERE IS A NEW SCREEN. Every `tab` is an id App.jsx already renders,
 * or a new id for a screen that already existed nested somewhere else (the
 * stock-sync panel in Setup, the refill list inside Patients). One component
 * per screen, reading one endpoint — a screen reachable from two places is
 * the same component, never a copy, so an order opened from Stock or from a
 * patient's profile is the same `orders` row.
 *
 * ONE OWNER PER TAB. Each tab appears in exactly one module's sidebar, which
 * is what lets moduleOfTab answer without ambiguity and keeps the breadcrumb
 * honest. Cross-links between modules (a patient's order, a consultation's
 * conversation) navigate INTO the owning module rather than duplicating the
 * screen in a second sidebar.
 *
 * NO INVENTED ITEMS. A sidebar entry exists only where a real screen does.
 * Campaigns, reminders, segments, low-stock alerts and the rest of the brief's
 * suggestions that are not built have no entry — an item that opens an empty
 * page teaches staff to stop clicking the sidebar.
 *
 * PURE. No fetching, no state. Everything that depends on the server (is the
 * website builder switched on, how many orders are waiting) is passed in.
 */

import {
  IconModuleStock, IconModuleClinics, IconModulePatients, IconModuleMarketing, IconModuleBranding,
  IconOverview, IconInventory, IconUpload, IconLink, IconOrders, IconRequests, IconDeals,
  IconConsultations, IconCustomers, IconReply, IconHeart, IconInbox, IconStar, IconAi, IconWebsite,
} from './Icons.jsx';

/**
 * Clinical services, as a registry.
 *
 * THE EXTENSION POINT for Clinics. A service with a `tab` gets its own item in
 * the Clinics sidebar; one without runs inside the assistant and has no screen
 * of its own. Every entry below exists today as a protocol the assistant runs
 * (server/services/clinical/protocols). Blood pressure, glucose, malaria RDT,
 * weight management, family planning, cholesterol, vaccination, medication
 * review and online consultation are deliberately ABSENT: they are not built,
 * and listing them would promise a service a pharmacy cannot offer. Adding one
 * later is an entry here plus its screen.
 */
export const CLINIC_SERVICES = Object.freeze([
  { id: 'fever', label: 'Fever assessment', status: 'active' },
  { id: 'malaria', label: 'Malaria assessment', status: 'active' },
  { id: 'cough', label: 'Cough assessment', status: 'active' },
  { id: 'sore-throat', label: 'Sore throat assessment', status: 'active' },
]);

/**
 * `badge` names a key in App's badge counts; `tone` is semantic — red only for
 * a person waiting on a pharmacist, amber for queued work (design.md).
 * `requires: 'website'` hides an item until the server says the builder is on.
 */
export const MODULES = Object.freeze([
  {
    id: 'stock',
    label: 'Stock',
    Icon: IconModuleStock,
    hint: 'Catalogue, orders and stock sync',
    sidebar: [
      { tab: 'overview', label: 'Overview', Icon: IconOverview },
      { tab: 'inventory', label: 'Catalogue', Icon: IconInventory },
      { tab: 'inventory-upload', label: 'Upload', Icon: IconUpload },
      { tab: 'stock-sync', label: 'Stock sync', Icon: IconLink },
      { tab: 'orders', label: 'Orders', Icon: IconOrders, badge: 'orders' },
      { tab: 'requests', label: 'Requests', Icon: IconRequests, badge: 'requests' },
      { tab: 'wholesale', label: 'Wholesale', Icon: IconDeals },
    ],
  },
  {
    id: 'clinics',
    label: 'Clinics',
    Icon: IconModuleClinics,
    hint: 'Consultations and pharmacist triage',
    sidebar: [
      { tab: 'consultations', label: 'Consultations', Icon: IconConsultations, badge: 'consultations', tone: 'red' },
      // Registered services that have a screen of their own. None do yet.
      ...CLINIC_SERVICES.filter((s) => s.tab).map((s) => ({ tab: s.tab, label: s.label, Icon: IconConsultations })),
    ],
  },
  {
    id: 'patients',
    label: 'Patients',
    Icon: IconModulePatients,
    hint: 'Patient records, conditions and refills',
    sidebar: [
      { tab: 'customers', label: 'All patients', Icon: IconCustomers },
      { tab: 'refills', label: 'Refills due', Icon: IconReply },
      { tab: 'conditions', label: 'Conditions', Icon: IconHeart },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    Icon: IconModuleMarketing,
    hint: 'Conversations, templates and the assistant’s results',
    sidebar: [
      { tab: 'inbox', label: 'Inbox', Icon: IconInbox },
      { tab: 'templates', label: 'Templates', Icon: IconStar },
      { tab: 'ai', label: 'AI performance', Icon: IconAi },
    ],
  },
  {
    id: 'branding',
    label: 'Branding',
    Icon: IconModuleBranding,
    hint: 'Your pharmacy’s website',
    sidebar: [
      { tab: 'website', label: 'Website', Icon: IconWebsite, requires: 'website' },
    ],
  },
]);

/** Every tab any module owns. */
export const MODULE_TABS = Object.freeze(MODULES.flatMap((m) => m.sidebar.map((i) => i.tab)));

const OWNER = new Map(MODULES.flatMap((m) => m.sidebar.map((i) => [i.tab, m])));

/** The module a tab belongs to, or null for a global screen (Setup, Billing, Home). */
export function moduleOfTab(tab) {
  return OWNER.get(tab) || null;
}

/** The sidebar item for a tab, or null. */
export function itemOfTab(tab) {
  return moduleOfTab(tab)?.sidebar.find((i) => i.tab === tab) || null;
}

/**
 * A module's sidebar as it should render right now.
 *
 * @param {object} module
 * @param {{ websiteEnabled: boolean|null }} ctx  null = not asked yet, and
 *   hides a gated item exactly as false does: an item that appears and then
 *   vanishes is worse than one that arrives a moment late.
 */
export function sidebarFor(module, { websiteEnabled = null } = {}) {
  return module.sidebar.filter((i) => i.requires !== 'website' || websiteEnabled === true);
}

/**
 * Where a module opens: its first visible screen.
 *
 * Branding's only screen is the website builder, so while that is switched
 * off Branding opens Setup — where the pharmacy's name and public details
 * live — rather than a workspace with an empty sidebar.
 */
export function moduleHome(moduleId, ctx = {}) {
  const module = MODULES.find((m) => m.id === moduleId);
  if (!module) throw new Error(`Unknown module "${moduleId}"`);
  const first = sidebarFor(module, ctx)[0];
  return first ? first.tab : 'setup';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The one live line on a launcher tile.
 *
 * Returns { text, tone } or null while the figure is not known yet — a tile
 * says nothing rather than "0" before it has asked. tone is 'alert' only for
 * someone waiting on a pharmacist, 'work' for queued work, 'quiet' otherwise.
 *
 * @param {string} moduleId
 * @param {object} s  { orders, handoffs, refillsDue, openConversations,
 *   websiteStatus: 'published'|'draft'|'unpublished'|'none'|null,
 *   websiteEnabled }
 */
export function tileStatus(moduleId, s = {}) {
  switch (moduleId) {
    case 'stock':
      if (s.orders == null) return null;
      return s.orders > 0
        ? { text: `${plural(s.orders, 'order', 'orders')} to confirm`, tone: 'work' }
        : { text: 'No orders waiting', tone: 'quiet' };
    case 'clinics':
      if (s.handoffs == null) return null;
      return s.handoffs > 0
        ? { text: `${plural(s.handoffs, 'person', 'people')} waiting`, tone: 'alert' }
        : { text: 'Nobody waiting', tone: 'quiet' };
    case 'patients':
      if (s.refillsDue == null) return null;
      return s.refillsDue > 0
        ? { text: `${plural(s.refillsDue, 'refill', 'refills')} due`, tone: 'work' }
        : { text: 'No refills due', tone: 'quiet' };
    case 'marketing':
      if (s.openConversations == null) return null;
      return { text: `${plural(s.openConversations, 'open conversation', 'open conversations')}`, tone: 'quiet' };
    case 'branding':
      if (s.websiteEnabled !== true || s.websiteStatus == null) return null;
      return {
        published: { text: 'Website live', tone: 'quiet' },
        draft: { text: 'Website not published yet', tone: 'work' },
        unpublished: { text: 'Website taken down', tone: 'work' },
        none: { text: 'No website yet', tone: 'work' },
      }[s.websiteStatus] || null;
    default:
      throw new Error(`Unknown module "${moduleId}"`);
  }
}
