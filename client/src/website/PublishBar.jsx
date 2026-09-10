/**
 * Choosing an address, and putting the page on the internet.
 *
 * TWO IRREVERSIBLE-FEELING ACTIONS, TREATED DIFFERENTLY.
 *
 * The web address is effectively permanent — it goes on flyers and into
 * Google — so it is confirmed once and then shown as settled rather than left
 * sitting in an editable box inviting a change that would break every printed
 * copy. Publishing is not permanent at all: it can be undone in one click,
 * and the copy says so, because an owner who is nervous about the button will
 * not press it and the whole product depends on them pressing it.
 *
 * The status here is derived from the record, never from local state. An
 * optimistic "Published!" that the server did not agree with would be the one
 * lie this screen must not tell.
 *
 * THE PUBLISH MACHINE IS NO LONGER OWNED HERE. Publishing is reachable from
 * the action bar at the top of the tab as well as from this panel, so the
 * busy/error/note state and the api calls moved to usePublishing, which
 * WebsitePanel creates once and hands to both. Two components each holding
 * their own copy would mean pressing Publish at the top and watching this
 * panel report nothing.
 *
 * THE WEB ADDRESS IS STILL OWNED HERE, and deliberately: it is a set-once
 * decision that belongs beside the other settings, not next to the button an
 * owner presses every week.
 */

import { useState } from 'react';
import { Panel } from '../DashboardKit.jsx';
import SectionTitle from './SectionTitle.jsx';
import InfoTip from './InfoTip.jsx';
import * as api from './api.js';

const inputClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 '
  + 'focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600';

function Badge({ status }) {
  const styles = {
    published: 'bg-teal-50 text-teal-800 ring-teal-600/20',
    draft: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    unpublished: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  }[status] || 'bg-slate-100 text-slate-600 ring-slate-500/20';

  const label = { published: 'Live', draft: 'Not published yet', unpublished: 'Taken down' }[status] || status;
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles}`}>{label}</span>;
}

export default function PublishBar({ site, publicDomain = null, publishing }) {
  const [address, setAddress] = useState(site.subdomain || '');
  const { busy, error, note, publish, unpublish, saveAddress } = publishing;

  const url = api.publicUrl(site.subdomain, publicDomain);
  const isPublished = site.status === 'published';

  return (
    <Panel className="p-5">
      <SectionTitle
        title="Publishing"
        info="Your details stay in step automatically — changing your phone number or address in Setup updates the live page without republishing. Layout and wording changes need a publish."
        aside={<Badge status={site.status} />}
      />

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {note && <p className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">{note}</p>}

      {/* ---- the address ---- */}
      {site.subdomain ? (
        <div className="mt-4 mb-4">
          <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
            Web address
            <InfoTip label="About your web address">
              Fixed once chosen — customers and search engines rely on it, and you will be
              printing it.
            </InfoTip>
          </p>
          <p className="mt-1 break-all font-mono text-sm text-slate-600">{url}</p>
        </div>
      ) : (
        <div className="mt-4 mb-4">
          <label className="block">
            <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
              Choose your web address
              <InfoTip label="About your web address">
                This is what customers will type. Choose carefully — it is meant to last, and
                you will be printing it.
              </InfoTip>
            </span>
            {/* The fixed part changes SIDES with the shape, which is the whole
                reason this is not a single string. As a path the address comes
                last (app.rxnaija.com/p/ikeja); as a subdomain it comes first
                (ikeja.rxnaija.com). Showing the wrong one here is not a display
                bug — it is a pharmacy printing an address that does not exist. */}
            <div className="mt-1.5 flex items-center gap-2">
              {!publicDomain && (
                <span className="shrink-0 font-mono text-sm text-slate-400">
                  {window.location.host}/p/
                </span>
              )}
              <input
                className={inputClass}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="ikeja-family-pharmacy"
                autoComplete="off"
                spellCheck={false}
              />
              {publicDomain && (
                <span className="shrink-0 font-mono text-sm text-slate-400">
                  .{publicDomain}
                </span>
              )}
            </div>
          </label>
          <button
            type="button"
            disabled={busy !== null || address.trim().length < 3}
            onClick={() => saveAddress(address)}
            className="mt-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-40"
          >
            {busy === 'address' ? 'Checking…' : 'Confirm address'}
          </button>
        </div>
      )}

      {/* ---- publish / unpublish ---- */}
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="button"
          disabled={busy !== null || !site.subdomain}
          onClick={publish}
          className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-40"
        >
          {busy === 'publish' ? 'Publishing…' : isPublished ? 'Publish changes' : 'Publish my website'}
        </button>

        {isPublished && (
          <>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-teal-700 hover:underline"
            >
              View live site →
            </a>
            <button
              type="button"
              disabled={busy !== null}
              onClick={unpublish}
              className="ml-auto text-sm font-medium text-slate-500 transition hover:text-red-700 disabled:opacity-40"
            >
              {busy === 'unpublish' ? 'Taking down…' : 'Take it down'}
            </button>
          </>
        )}
      </div>

      {!site.subdomain && (
        <p className="mt-3 text-xs text-slate-500">Choose an address before publishing.</p>
      )}
    </Panel>
  );
}
