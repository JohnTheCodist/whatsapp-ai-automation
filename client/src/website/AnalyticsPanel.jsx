/**
 * What the website actually did.
 *
 * THREE FIGURES, NOT FOUR. This showed WhatsApp taps, phone taps, directions
 * and visits at equal weight, and four numbers competing at the same size is
 * four numbers nobody reads. The question an owner is actually asking is
 * "did anyone come, and did any of them get in touch" — so it is visitors,
 * WhatsApp taps, and the contact rate that answers both at once.
 *
 * Phone taps and directions did not become unimportant; they became detail.
 * They are named underneath in a sentence, which is where a figure that is
 * usually zero belongs. A pharmacy whose customers use those will see them
 * there, and one whose customers do not is no longer looking at two zeroes
 * the size of the number that matters.
 *
 * THE NUMBER THIS PANEL EXISTS FOR is still "8 people tapped WhatsApp". That
 * is the pharmacy's return on the whole feature and the difference between
 * renewing and not. Visits alone do not say it — a visit that led nowhere is
 * worth nothing to a pharmacy.
 *
 * ONLY SHOWN ONCE THE SITE IS LIVE. A panel of zeroes above an unpublished
 * site reads as a broken feature rather than as an empty one.
 *
 * There is still no chart. Three numbers and a sentence answer the question;
 * a sparkline would be decoration on a screen a pharmacy opens a few times a
 * year.
 */

import { useEffect, useState } from 'react';
import { Panel, PanelHead } from '../DashboardKit.jsx';
import { IconWebsite } from '../Icons.jsx';
import * as api from './api.js';

function Stat({ value, label }) {
  return (
    <div>
      <p className="font-display text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
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

  // Rounded to a whole number: a pharmacy owner does not need a decimal, and
  // 33.333% reads as precision this figure does not have.
  const rate = data ? Math.round((data.conversionRate ?? 0) * 100) : 0;
  const other = data ? (data.totals.phone || 0) + (data.totals.directions || 0) : 0;

  return (
    <Panel className="p-5">
      <PanelHead Icon={IconWebsite}>Your website, last 30 days</PanelHead>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {!data && !error && <p className="mt-3 text-sm text-slate-500">Loading…</p>}

      {data && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-5">
            <Stat value={data.totals.view} label="Visitors" />
            <Stat value={data.totals.whatsapp} label="WhatsApp taps" />
            {/* Shown as a dash rather than 0% when nobody has visited at all.
                A rate over no visitors is not zero, it is undefined, and
                printing 0% tells an owner their site is failing when in fact
                nothing has happened yet. */}
            <Stat value={data.totals.view === 0 ? '—' : `${rate}%`} label="Contact rate" />
          </div>

          <p className="mt-4 text-sm text-slate-600">
            {data.totals.view === 0
              ? 'No visits yet. Share your web address on WhatsApp, on your receipts and on your shop window.'
              : data.conversions === 0
                ? `${data.totals.view} ${data.totals.view === 1 ? 'person has' : 'people have'} visited, but nobody has got in touch yet.`
                : `${rate}% of visitors contacted the pharmacy.`}
            {other > 0 && (
              <>
                {' '}
                That includes {data.totals.phone > 0 && `${data.totals.phone} phone ${data.totals.phone === 1 ? 'tap' : 'taps'}`}
                {data.totals.phone > 0 && data.totals.directions > 0 && ' and '}
                {data.totals.directions > 0 && `${data.totals.directions} ${data.totals.directions === 1 ? 'request' : 'requests'} for directions`}.
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
