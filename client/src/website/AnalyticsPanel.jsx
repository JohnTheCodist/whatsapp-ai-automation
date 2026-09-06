/**
 * What the website actually did.
 *
 * THE NUMBER THIS PANEL EXISTS FOR is "47 people tapped WhatsApp". That is
 * the pharmacy's return on the whole feature, and it is the difference
 * between renewing and not. Visits alone do not say it — a visit that led
 * nowhere is worth nothing to a pharmacy — so taps are given the prominence
 * and visits are the context.
 *
 * ONLY SHOWN ONCE THE SITE IS LIVE. A panel of zeroes above an unpublished
 * site reads as a broken feature rather than as an empty one.
 *
 * There is no chart. Four numbers and a sentence answer the question; a
 * sparkline would be decoration on a screen a pharmacy opens a few times a
 * year, and this dashboard's own DashboardKit exists precisely so that when a
 * chart IS warranted it is the one the rest of the app uses.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconWebsite } from '../Icons.jsx';
import * as api from './api.js';

function Stat({ value, label, lead = false }) {
  return (
    <div>
      <p className={`font-display font-semibold tabular-nums text-slate-900 ${lead ? 'text-3xl' : 'text-2xl'}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
    </div>
  );
}

export default function AnalyticsPanel({ site }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (site.status !== 'published') return undefined;
    let live = true;
    api.getAnalytics(30)
      .then((res) => live && setData(res))
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, [site.status]);

  if (site.status !== 'published') return null;

  return (
    <Panel className="p-5">
      <PanelHead Icon={IconWebsite}>Your website, last 30 days</PanelHead>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {!data && !error && <p className="mt-3 text-sm text-slate-500">Loading…</p>}

      {data && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat lead value={data.totals.whatsapp} label="WhatsApp taps" />
            <Stat value={data.totals.phone} label="Phone taps" />
            <Stat value={data.totals.directions} label="Directions" />
            <Stat value={data.totals.view} label="Visits" />
          </div>

          <p className="mt-4 text-sm text-slate-600">
            {data.totals.view === 0
              ? 'No visits yet. Share your web address on WhatsApp, on your receipts and on your shop window.'
              : data.conversions === 0
                ? `${data.totals.view} ${data.totals.view === 1 ? 'person has' : 'people have'} visited, but nobody has got in touch yet.`
                : (
                  <>
                    <strong>
                      {data.conversions} of {data.totals.view}
                    </strong>
                    {' '}
                    {data.conversions === 1 ? 'visitor' : 'visitors'} got in touch —{' '}
                    {/* Rounded to a whole number: a pharmacy owner does not need
                        a decimal, and 33.333% reads as precision this figure
                        does not have. */}
                    {Math.round((data.conversionRate ?? 0) * 100)}%.
                  </>
                )}
          </p>

          {/* Said plainly rather than left for someone to wonder about. The
              counts come from the server; a page served from a browser or CDN
              cache never reaches us, so the real figures are a little higher. */}
          <p className="mt-3 text-xs text-slate-400">
            Counted on our server, with no tracking scripts and nothing stored about
            visitors. Repeat visits served from a cache are not counted, so these are a
            floor rather than an exact figure.
          </p>
        </>
      )}
    </Panel>
  );
}
