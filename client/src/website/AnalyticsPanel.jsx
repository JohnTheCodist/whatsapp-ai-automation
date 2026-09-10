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
import { Panel } from '../DashboardKit.jsx';
import * as api from './api.js';
import SectionTitle from './SectionTitle.jsx';

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
      <SectionTitle
        title="Last 30 days"
        info="Counted on our server, with no tracking scripts and nothing stored about visitors. Repeat visits served from a cache are not counted, so these are a floor rather than an exact figure."
      />

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

          {/* THE SENTENCE ONLY EARNS ITS PLACE WHEN IT SAYS SOMETHING THE
              TILES DO NOT. "5% of visitors contacted the pharmacy" directly
              under a tile reading "5% — Contact rate" is the same fact twice,
              which is exactly the padding this tab was carrying everywhere.
              So it appears for the two states the tiles cannot express: no
              visits at all, and visits that led nowhere. */}
          {data.totals.view === 0 && (
            <p className="mt-4 text-sm text-slate-600">
              No visits yet. Share your web address on WhatsApp, on your receipts and in
              your shop window.
            </p>
          )}
          {data.totals.view > 0 && data.conversions === 0 && (
            <p className="mt-4 text-sm text-slate-600">
              {data.totals.view} {data.totals.view === 1 ? 'person has' : 'people have'} visited,
              but nobody has got in touch yet.
            </p>
          )}
          {/* Phone taps and directions are detail rather than headline, and
              usually zero. Named here only when they actually happened. */}
          {other > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              Also {data.totals.phone > 0 && `${data.totals.phone} phone ${data.totals.phone === 1 ? 'tap' : 'taps'}`}
              {data.totals.phone > 0 && data.totals.directions > 0 && ' and '}
              {data.totals.directions > 0 && `${data.totals.directions} ${data.totals.directions === 1 ? 'request' : 'requests'} for directions`}.
            </p>
          )}

        </>
      )}
    </Panel>
  );
}
