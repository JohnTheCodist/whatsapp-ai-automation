/**
 * The first thing on the Website tab: what my site is, whether it is live,
 * and the three things I came here to do.
 *
 * REPLACES WebsiteStatus AND CurrentDesign. Those two rendered a "Change
 * design" button each, about two hundred pixels apart, on either side of a
 * preview that already showed the owner what their design looked like. The
 * template's name belongs as a caption on that preview, not as a card of its
 * own, so CurrentDesign is gone and this card carries the actions.
 *
 * PUBLISH IS HERE, AT THE TOP. It used to be the last control on a long
 * page, which meant the state an owner most needs to see — am I live, and is
 * there a button I have not pressed — was the one thing they had to scroll
 * for. The address form and the take-down stay in the Publishing panel at
 * the bottom: those are set-once decisions, and this is the recurring one.
 *
 * IT OWNS NO PUBLISHING STATE. Everything comes from the usePublishing
 * object WebsitePanel created, so this button and the one at the bottom of
 * the page are the same button in two places rather than two buttons that
 * could disagree about whether a request is in flight.
 *
 * NO "UNPUBLISHED CHANGES" BADGE, and it is not an oversight — see the note
 * in WebsitePanel above lastPublished. The data to compute one honestly does
 * not exist yet.
 */

import * as api from './api.js';

const STATUS = {
  published: { dot: 'bg-teal-600', label: 'Live', text: 'text-teal-800' },
  unpublished: { dot: 'bg-amber-500', label: 'Taken down', text: 'text-amber-800' },
  draft: { dot: 'bg-slate-400', label: 'Not published yet', text: 'text-slate-600' },
};

/** "Today", "Yesterday", or a plain date. Never a relative "3 days ago". */
function lastPublishedLabel(publishedAt) {
  if (!publishedAt) return null;
  const then = new Date(publishedAt);
  if (Number.isNaN(then.getTime())) return null;

  // Compared by calendar day rather than by elapsed hours: something
  // published at 11pm is "Today" until midnight, which is what somebody
  // looking at this actually means by the word.
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function WebsiteHeader({
  site, pharmacy, publicDomain, publishing, onEdit,
}) {
  const status = STATUS[site.status] || STATUS.draft;
  const url = api.publicUrl(site.subdomain, publicDomain);
  const isPublished = site.status === 'published';
  const lastPublished = lastPublishedLabel(site.published_at);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold text-slate-900">
            {pharmacy?.name || 'Your pharmacy website'}
          </h2>
          {url && (
            <p className="mt-1 break-all font-mono text-sm text-slate-600">{url}</p>
          )}
        </div>

        <span className={`inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold ${status.text}`}>
          <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden="true" />
          {status.label}
        </span>
      </div>

      {/* The publish machine's own messages, at the surface that triggered
          them most recently. Shown here as well as in the Publishing panel
          because either button can start the request. */}
      {publishing.error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{publishing.error}</p>
      )}
      {publishing.note && (
        <p className="mt-4 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">{publishing.note}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {/* Only when there is somewhere to go. A "View website" button on a
            site that is not published is a broken promise, not a shortcut. */}
        {isPublished && url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            View website
          </a>
        )}

        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
        >
          Edit website
        </button>

        <button
          type="button"
          disabled={publishing.busy !== null || !site.subdomain}
          onClick={publishing.publish}
          className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-40"
        >
          {publishing.busy === 'publish'
            ? 'Publishing…'
            : isPublished ? 'Publish changes' : 'Publish my website'}
        </button>

        {lastPublished && (
          <p className="text-sm text-slate-500">Last published: {lastPublished}</p>
        )}
      </div>

      {/* The one case where the top action cannot work. Said here rather than
          left as a disabled button with no explanation. */}
      {!site.subdomain && (
        <p className="mt-3 text-sm text-slate-500">
          Choose your web address in Publishing, further down, before publishing.
        </p>
      )}
    </div>
  );
}
