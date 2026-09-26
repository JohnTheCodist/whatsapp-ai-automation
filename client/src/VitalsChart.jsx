/**
 * One vital sign over time.
 *
 * WHY A LINE, AND WHY ONE SIGN AT A TIME. The job is change over time, which
 * is a line. Two signs of different units on one pair of axes is the
 * commonest chart mistake there is — a temperature and a pulse share no
 * scale, and reading one against the other is meaningless — so the sign is
 * chosen from the list beside the chart and the axis belongs to it alone.
 * Blood pressure is the single exception and is not an exception at all:
 * systolic and diastolic are two numbers in the SAME unit, on one axis.
 *
 * DRAWN AS SVG, not with a chart library. It is two paths, some ticks and a
 * crosshair; a charting dependency would be larger than the dashboard's own
 * main bundle for this.
 *
 * THE AXIS DOES NOT START AT ZERO, on purpose — see chartBounds(). A
 * temperature axis from zero is a flat line at the top of the frame.
 *
 * COLOUR CARRIES NO MEANING OF ITS OWN HERE. A single series takes one hue
 * and is named by the chart's title, so there is no legend to read; blood
 * pressure's two are a validated pair and are direct-labelled at the end of
 * each line, so identity never rests on colour alone.
 */

import { useId, useState } from 'react';
import { chartBounds, axisTicks, readingStamp, referenceBand, SERIES_COLOURS } from './vitalsFormat.js';

const PAD = { top: 16, right: 54, bottom: 30, left: 44 };

export default function VitalsChart({
  series, unit, ranges = null, sign = null, width = 560, height = 260,
}) {
  const [hover, setHover] = useState(null);
  const clipId = useId().replace(/:/g, '');

  const band = referenceBand(ranges, sign);
  // The band is part of what the axis has to fit. Without this a patient
  // whose readings are all well above normal gets a chart with the band
  // pushed off the bottom — and the one thing the band is for is showing how
  // far outside they are.
  const bounds = chartBounds(band
    ? [...series, { points: [{ value: band.min }, { value: band.max }] }]
    : series);
  if (!bounds) {
    return (
      <p className="ui-chart-empty">
        Nothing recorded for this sign yet.
      </p>
    );
  }

  // Every point in time order, so the x scale spans the whole record even
  // when one series is shorter than the other.
  const times = series.flatMap((s) => s.points.map((p) => new Date(p.at).getTime()));
  const from = Math.min(...times);
  const to = Math.max(...times);
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;

  const x = (at) => (to === from ? PAD.left + plotW / 2
    : PAD.left + ((new Date(at).getTime() - from) / (to - from)) * plotW);
  const y = (value) => PAD.top + plotH - ((value - bounds.min) / (bounds.max - bounds.min)) * plotH;

  const ticks = axisTicks(bounds);
  // One label per reading would collide on anything past a handful, so the
  // axis shows the ends and the middle and the crosshair says the rest.
  const dateTicks = [...new Set([from, ...(times.length > 2 ? [times[Math.floor(times.length / 2)]] : []), to])];

  // The crosshair follows the nearest reading in time, not the nearest pixel
  // in any direction: a chart of five readings should snap to a reading.
  const nearest = (clientX, rect) => {
    const px = clientX - rect.left;
    let best = null;
    for (const s of series) {
      for (const p of s.points) {
        const d = Math.abs(x(p.at) - px);
        if (!best || d < best.d) best = { d, at: p.at };
      }
    }
    return best && best.d < plotW ? best.at : null;
  };

  const atHover = hover && series
    .map((s) => ({ label: s.label, value: s.points.find((p) => p.at === hover)?.value }))
    .filter((v) => v.value != null);

  return (
    <div className="ui-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="ui-chart-svg"
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} over time, in ${unit}`}
        onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`${clipId}-plot`}>
            <rect x={PAD.left} y={PAD.top - 6} width={plotW} height={plotH + 12} />
          </clipPath>
          {/* A wash under the line, so the eye reads the shape rather than
              hunting a 2px stroke. Only under a SINGLE series — two filled
              areas overlapping is a different chart, and a worse one. */}
          <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_COLOURS[0]} stopOpacity="0.20" />
            <stop offset="100%" stopColor={SERIES_COLOURS[0]} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* ---- the usual range ----
            The single biggest thing that makes this chart readable: "is this
            patient where they should be" stops being arithmetic and becomes
            a glance. Drawn first, underneath everything, in a grey that
            carries no alarm of its own — it marks ordinary, and the reading
            is what the eye should land on. Absent entirely for a child or an
            unknown age, because the server sends no bounds for them. */}
        {band && (
          <g className="ui-chart-band">
            <rect
              x={PAD.left}
              y={y(band.max)}
              width={plotW}
              height={Math.max(0, y(band.min) - y(band.max))}
            />
            <text x={PAD.left + 6} y={y(band.max) + 12} className="ui-chart-band-label">
              {band.label}
            </text>
          </g>
        )}

        {/* Grid and axes stay recessive: they are the ruler, not the reading. */}
        <g className="ui-chart-grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="ui-chart-tick">{t}</text>
            </g>
          ))}
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} className="ui-chart-axis" />
        </g>

        {dateTicks.map((t) => (
          <text key={t} x={x(new Date(t).toISOString())} y={height - 10} textAnchor="middle" className="ui-chart-tick">
            {new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
          </text>
        ))}

        <g clipPath={`url(#${clipId}-plot)`}>
          {hover && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="ui-chart-crosshair" />
          )}

          {series.map((s, i) => {
            const colour = SERIES_COLOURS[i % SERIES_COLOURS.length];
            const d = s.points.map((p, n) => `${n ? 'L' : 'M'}${x(p.at)},${y(p.value)}`).join(' ');
            const first = s.points[0];
            const last = s.points[s.points.length - 1];
            const floor = PAD.top + plotH;
            return (
              <g key={s.key}>
                {/* The wash, under a single series only. */}
                {series.length === 1 && (
                  <path
                    d={`${d} L${x(last.at)},${floor} L${x(first.at)},${floor} Z`}
                    fill={`url(#${clipId}-fill)`}
                    className="ui-chart-area"
                  />
                )}
                {/* The line draws itself in, left to right, once. A chart
                    that arrives finished is a chart the eye has to search;
                    one that draws shows the reader where to start and which
                    way time runs. It is a dash offset, so nothing re-layouts
                    while it happens — and `key` on the path restarts it when
                    the sign changes, which is the moment it is worth seeing
                    again. */}
                <path
                  key={`${s.key}-${d.length}`}
                  d={d}
                  fill="none"
                  stroke={colour}
                  strokeWidth="2.25"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  pathLength="1"
                  className="ui-chart-line"
                />
                {s.points.map((p, n) => (
                  <circle
                    key={p.at}
                    cx={x(p.at)}
                    cy={y(p.value)}
                    r={hover === p.at ? 5.5 : 4}
                    fill={colour}
                    // A 2px ring of the surface, so two points that land on
                    // top of each other still read as two.
                    stroke="var(--ui-surface)"
                    strokeWidth="2"
                    className="ui-chart-dot"
                    // Each dot arrives as the line reaches it.
                    style={{ '--dot-delay': `${160 + n * (620 / Math.max(1, s.points.length))}ms` }}
                  />
                ))}
              </g>
            );
          })}
        </g>

        {/* The end-of-line labels sit OUTSIDE the clip, in the right-hand
            gutter the padding reserves for them. Inside it they were cut off
            at the plot edge — which left two lines telling themselves apart
            by colour alone, the one thing a chart may not do. */}
        {series.length > 1 && series.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <text
              key={s.key}
              x={Math.min(x(last.at) + 9, width - 4)}
              y={y(last.value)}
              dy="0.32em"
              className="ui-chart-label"
              fill={SERIES_COLOURS[i % SERIES_COLOURS.length]}
            >
              {s.label}
            </text>
          );
        })}
      </svg>

      {/* The tooltip is HTML rather than SVG so it wraps and inherits type. */}
      {hover && atHover.length > 0 && (
        <div className="ui-chart-tip" style={{ left: `${(x(hover) / width) * 100}%` }}>
          <span className="ui-chart-tip-when">{readingStamp(hover)}</span>
          {atHover.map((v) => (
            <span key={v.label} className="ui-chart-tip-row">
              {v.label}
              <strong>{v.value} {unit}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
