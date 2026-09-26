/**
 * Vitals and biometrics, as the dashboard shows them.
 *
 * PURE — columns, formatting, and the shape of a chart series. No React, no
 * fetch, so the wording and the arithmetic can be tested without a browser.
 *
 * THE RANGES LIVE ON THE SERVER. Whether a number is outside the usual adult
 * range is decided once, in services/clinical/vitalRanges.js, and travels
 * with each reading as `abnormal`. This file colours what the server flagged
 * and never re-decides it — two copies of a clinical bound is two answers to
 * "is this red", and the one on screen would be the one nobody tested.
 *
 * What IS duplicated here is the label and the unit of each column, because
 * a table header is a dashboard concern. `vitalsFormat.test.js` pins those
 * against the server's list so the two cannot drift.
 */

/** The table's columns, in the order the reference screen shows them. */
export const VITALS_COLUMNS = Object.freeze([
  { key: 'bp', label: 'BP', unit: 'mmHg', pair: ['systolic', 'diastolic'] },
  { key: 'respiratoryRate', label: 'R. Rate', unit: 'breaths/min' },
  { key: 'pulse', label: 'Pulse', unit: 'beats/min' },
  { key: 'spo2', label: 'SPO2', unit: '%' },
  { key: 'temperature', label: 'Temp', unit: 'DEG C' },
]);

export const BIOMETRICS_COLUMNS = Object.freeze([
  { key: 'weight', label: 'Weight', unit: 'kg' },
  { key: 'height', label: 'Height', unit: 'cm' },
  { key: 'bmi', label: 'BMI', unit: 'kg / m²' },
  { key: 'muac', label: 'MUAC', unit: 'cm' },
]);

/** What the chart can plot, one at a time. BP is the one pair. */
export const CHART_SIGNS = Object.freeze([
  { key: 'bp', label: 'BP', unit: 'mmHg', series: ['systolic', 'diastolic'] },
  { key: 'spo2', label: 'SPO2', unit: '%', series: ['spo2'] },
  { key: 'temperature', label: 'Temp', unit: 'DEG C', series: ['temperature'] },
  { key: 'respiratoryRate', label: 'R. Rate', unit: 'breaths/min', series: ['respiratoryRate'] },
  { key: 'pulse', label: 'Pulse', unit: 'beats/min', series: ['pulse'] },
]);

/**
 * Two hues, validated for colour-vision deficiency (deutan ΔE 19.7, tritan
 * 13.0 against each other on this surface) rather than chosen by eye. Only
 * blood pressure ever uses both; every other sign is a single line and takes
 * the first, with no legend — the chart's own title names it.
 */
export const SERIES_COLOURS = Object.freeze(['#0f7a5a', '#8a4bd6']);

/** A reading's value for a column — the pair joined for blood pressure. */
export function cellValue(reading, column) {
  if (!reading) return null;
  if (column.pair) {
    const [a, b] = column.pair.map((k) => reading[k]);
    return a == null || b == null ? null : `${a} / ${b}`;
  }
  const value = reading[column.key];
  return value == null ? null : value;
}

/**
 * Which flag applies to a cell — for a pair, whichever half is flagged.
 * Returns null when the server flagged nothing, which includes every child
 * and every patient whose age is unknown.
 */
export function cellFlag(reading, column) {
  const flags = reading?.abnormal || {};
  if (column.pair) return flags[column.pair[0]] || flags[column.pair[1]] || null;
  return flags[column.key] || null;
}

const DATE = { day: '2-digit', month: 'short', year: 'numeric' };
const TIME = { hour: '2-digit', minute: '2-digit', hour12: false };

/** "03 - Dec - 2021, 05:28", the reference screen's stamp. */
export function readingStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const [day, month, year] = d.toLocaleDateString('en-GB', DATE).split(' ');
  return `${day} - ${month} - ${year}, ${d.toLocaleTimeString('en-GB', TIME)}`;
}

/** "03 - Dec - 2021" for the header's "Last recorded". */
export function shortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const [day, month, year] = d.toLocaleDateString('en-GB', DATE).split(' ');
  return `${day} - ${month} - ${year}`;
}

/** "3 / 12 items" under the table. */
export function itemsLabel(shown, total) {
  return `${shown} / ${total} item${total === 1 ? '' : 's'}`;
}

/**
 * The points for one sign, oldest first, with every reading that did not
 * record that sign dropped.
 *
 * A GAP IS NOT A ZERO. A visit where nobody took a temperature is absent
 * from the temperature series entirely; plotting it at zero would draw a
 * line down to the floor and back, which reads as a collapse.
 */
export function chartSeries(readings, sign) {
  if (!sign) return [];
  return sign.series.map((key) => ({
    key,
    label: sign.series.length > 1 ? (key === 'systolic' ? 'Systolic' : 'Diastolic') : sign.label,
    points: (readings || [])
      .filter((r) => r[key] != null)
      .map((r) => ({ at: r.recordedAt, value: Number(r[key]) })),
  })).filter((s) => s.points.length > 0);
}

/**
 * The y-axis bounds for a set of series: the data's own range, padded, and
 * never forced to include zero.
 *
 * A TEMPERATURE CHART STARTING AT ZERO is a flat line at the top of the
 * frame — every real change disappears. Zero is meaningless for temperature,
 * SpO2 and blood pressure alike, so the axis starts where the data does and
 * says so by being labelled.
 */
export function chartBounds(series) {
  const values = series.flatMap((s) => s.points.map((p) => p.value));
  if (!values.length) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (low === high) return { min: low - 1, max: high + 1 };
  const pad = (high - low) * 0.15;
  return { min: low - pad, max: high + pad };
}

/** Axis ticks: a handful of round numbers inside the bounds. */
export function axisTicks({ min, max }, count = 4) {
  const span = max - min;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || magnitude * 10;
  const first = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = first; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/**
 * The band a chart shades as "the usual range" for the sign on screen.
 *
 * The bounds come from the SERVER, with the readings, and are absent for a
 * child or an unknown age — so this returns null and nothing is drawn. The
 * dashboard deliberately holds no clinical range of its own: one copy here
 * and one on the server is two answers to "is this normal", and the one a
 * pharmacist believes would be whichever they happened to look at.
 *
 * For blood pressure the band is the systolic one, because that is the line
 * the eye follows; the diastolic has its own bounds and shading both would
 * put two overlapping boxes behind two lines.
 */
export function referenceBand(ranges, sign) {
  if (!ranges || !sign) return null;
  const band = ranges[sign.series[0]];
  return band ? { ...band, label: `Usual adult range` } : null;
}
