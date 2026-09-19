/**
 * Whether the sidebar is collapsed to its icon strip — remembered per device.
 *
 * PER DEVICE ON PURPOSE, like the alert-sound preference in App.jsx: the
 * counter tablet may want the room for a patient list while the back-office
 * laptop keeps the labels. localStorage, not the server.
 *
 * NO CHOICE YET → DECIDED BY WIDTH. Below AUTO_COLLAPSE_BELOW the expanded
 * sidebar takes a fifth of the screen and squeezes every table beside it,
 * so a first visit on a small screen starts collapsed. Once someone toggles
 * it, their choice wins at any width.
 *
 * NEVER THROWS. Storage can be missing or throw on access (private windows,
 * blocked site data, some embedded webviews). A sidebar preference is a
 * convenience; failing to read or save it must never break the dashboard.
 */

export const SIDEBAR_COLLAPSED_KEY = 'rxSidebarCollapsed';
export const AUTO_COLLAPSE_BELOW = 1024;

/** window.localStorage, or null where touching it would throw. */
export function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {Storage|null} args.storage
 * @param {number} [args.width]  viewport width in CSS pixels
 * @returns {boolean} true when the sidebar should start collapsed
 */
export function readSidebarCollapsed({ storage, width }) {
  try {
    const stored = storage?.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    /* unreadable storage: fall through to the width rule */
  }
  return typeof width === 'number' && width < AUTO_COLLAPSE_BELOW;
}

/** Remember the choice. Silently does nothing where storage is unavailable. */
export function writeSidebarCollapsed(storage, collapsed) {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    /* quota or privacy mode: the choice lasts this session only */
  }
}
