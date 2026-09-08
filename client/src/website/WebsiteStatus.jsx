/**
 * The headline: is my website live, and where.
 *
 * PURELY PRESENTATIONAL, ON PURPOSE. This card makes no network calls and
 * owns no state of its own — every value it shows comes from `site` and
 * `publicDomain`, the same props WebsitePanel already threads through to
 * PublishBar. Publishing and unpublishing stay entirely inside PublishBar's
 * existing state machine (busy/error/note, the address form, the actual
 * api.publish()/api.unpublish() calls); duplicating any of that here would
 * be a second place for "is it live" to disagree with reality. This
 * component only answers the first question an owner has when the tab
 * opens — the address form and the Publish/Take down buttons live further
 * down the page, in Website settings.
 */

import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconWebsite } from '../Icons.jsx';
import * as api from './api.js';

const STATUS = {
  published: {
    dot: 'bg-teal-600',
    label: 'LIVE',
    labelClass: 'text-teal-800',
    copy: 'Your website is live and ready for customers.',
  },
  unpublished: {
    dot: 'bg-amber-500',
    label: 'TAKEN DOWN',
    labelClass: 'text-amber-800',
    copy: 'Your website is taken down right now. Publish again any time — nothing was deleted.',
  },
  draft: {
    dot: 'bg-slate-400',
    label: 'NOT PUBLISHED YET',
    labelClass: 'text-slate-600',
    copy: 'Your website isn’t public yet. Choose your design and publish it further down this page.',
  },
};

function Badge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide ${status.labelClass}`}>
      <span className={`h-2 w-2 rounded-full ${status.dot}`} aria-hidden="true" />
      {status.label}
    </span>
  );
}

export default function WebsiteStatus({ site, publicDomain, onChangeDesign }) {
  const status = STATUS[site.status] || STATUS.draft;
  const url = api.publicUrl(site.subdomain, publicDomain);

  return (
    <Panel className="p-5 sm:p-6">
      <PanelHead Icon={IconWebsite} aside={<Badge status={status} />}>Your pharmacy website</PanelHead>

      {url && <p className="mt-3 break-all font-mono text-sm text-slate-600">{url}</p>}

      <p className="mt-2 text-sm text-slate-600">{status.copy}</p>

      <div className="mt-4 flex flex-wrap gap-3">
        {site.status === 'published' && url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800"
          >
            View website
          </a>
        )}
        <button
          type="button"
          onClick={onChangeDesign}
          className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
        >
          Change design
        </button>
      </div>
    </Panel>
  );
}
