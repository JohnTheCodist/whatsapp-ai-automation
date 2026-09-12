/**
 * Meta App Review recording mode.
 *
 * WHY THIS EXISTS. While recording the App Review videos, the Settings screen
 * must not show the Baileys pairing panel. Baileys is an unofficial WhatsApp
 * client; putting it on screen in a video submitted to Meta is a risk to the
 * business account, and it is not what the video is about either.
 *
 * WHAT IT DOES NOT DO. It does not strip the app down. Reviewers are asked to
 * judge whether a real product uses the permission, so the navigation, the
 * website builder, inventory and the rest all stay exactly where they are. A
 * hollowed-out shell reads as a mock-up, which is the one thing an App Review
 * video must not look like.
 *
 * BUILD TIME, NOT RUN TIME. Vite inlines VITE_* during `npm run build`, so
 * this is decided when the dashboard is built and cannot be flipped by a
 * request. Unset — which is every normal deploy — everything is visible.
 * Turn it on only for the build you record against, and turn it off after.
 */

export const REVIEW_MODE = import.meta.env.VITE_META_REVIEW_MODE === 'true';

/**
 * Drop every tab marked `reviewHide`, and any area left with no tabs.
 *
 * Pure and exported so the rule can be tested without rendering Settings,
 * which pulls in half the dashboard.
 *
 * @param {object[]} groups    the Settings GROUPS structure
 * @param {boolean} reviewMode
 */
export function visibleGroups(groups, reviewMode = REVIEW_MODE) {
  if (!reviewMode) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .map((item) => ({ ...item, tabs: item.tabs.filter((tab) => !tab.reviewHide) }))
        // An area whose every panel was hidden must go too, or the rail shows
        // a heading that opens nothing.
        .filter((item) => item.tabs.length > 0),
    }))
    .filter((group) => group.items.length > 0);
}
