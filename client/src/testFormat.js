/**
 * A patient's diagnostic tests, as the dashboard writes them.
 *
 * PURE — no React, no fetch. The line that matters most on this screen is
 * the RESULT ITSELF: "108 mg/dL · High" has to be readable in the row,
 * without opening anything (brief §30). These helpers are what write it.
 *
 * THE VOCABULARY IS THE SERVER'S (GET /tests/options). What is here is how
 * it is written, grouped and toned.
 *
 * AN ABNORMAL RESULT IS AMBER; A CRITICAL ONE IS RED. design.md reserves red
 * for "a person is waiting" — a critical result is exactly that, and it is
 * the only place on a patient record where red is used. Colour is never
 * alone: the interpretation is always written out beside it.
 */

/** The filters across the top, the brief's list. */
export const TEST_FILTERS = Object.freeze([
  { value: '', label: 'All', count: 'all' },
  { value: 'ordered', label: 'Ordered', count: 'ordered' },
  { value: 'pending', label: 'Pending', count: 'pending' },
  { value: 'completed', label: 'Completed', count: 'completed' },
  { value: 'abnormal', label: 'Abnormal', count: 'abnormal' },
  { value: 'historical', label: 'Historical', count: 'historical' },
]);

/** How a status is shown. Only a completed test wears the settled tone. */
export const STATUS_TONE = Object.freeze({
  ordered: 'ui-med-draft',
  pending: 'ui-med-draft',
  preliminary: 'ui-tone-1',
  final: 'ui-med-active',
  amended: 'ui-tone-1',
  corrected: 'ui-tone-1',
  cancelled: 'ui-tone-quiet',
});

/** How a reading is shown. Critical is the loud one, and says so in words. */
export const INTERPRETATION_TONE = Object.freeze({
  normal: 'ui-tone-quiet',
  negative: 'ui-tone-quiet',
  high: 'ui-tone-3',
  low: 'ui-tone-3',
  abnormal: 'ui-tone-3',
  positive: 'ui-tone-3',
  critical_high: 'ui-test-critical',
  critical_low: 'ui-test-critical',
  indeterminate: 'ui-tone-quiet',
  not_interpretable: 'ui-tone-quiet',
});

const ARROW = Object.freeze({ high: '▲', critical_high: '▲', low: '▼', critical_low: '▼' });
export const interpretationArrow = (v) => ARROW[v] || null;

export const isCritical = (v) => v === 'critical_high' || v === 'critical_low';

export function labelFor(list, value) {
  if (!value) return null;
  const hit = (list || []).find((o) => o.value === value);
  return hit ? hit.label : value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When it was performed, at the precision recorded: "22 Sep 2026",
 * "Jun 2026", "~2019". A test only ordered has no date, and says so
 * elsewhere rather than showing a guess.
 */
export function performedLabel(test) {
  const at = test?.performed?.at;
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (test.performed.precision === 'year') return `~${y}`;
  if (test.performed.precision === 'month') return `${MONTHS[d.getUTCMonth()]} ${y}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${y}`;
}

/** Back to the form's shape: "2026", "2026-06", "2026-09-22", or "". */
export function performedInput(test) {
  const at = test?.performed?.at;
  if (!at) return '';
  const iso = new Date(at).toISOString().slice(0, 10);
  if (test.performed.precision === 'year') return iso.slice(0, 4);
  if (test.performed.precision === 'month') return iso.slice(0, 7);
  return iso;
}

export function dayLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * One value, written: "108 mg/dL", "Positive", or the first words of a
 * report. This is the thing a pharmacist came to read.
 */
export function resultValue(result) {
  if (!result) return null;
  if (result.valueNumber !== null && result.valueNumber !== undefined) {
    return [result.valueNumber, result.unit].filter(Boolean).join(' ');
  }
  if (result.valueDisplay) return result.valueDisplay;
  if (result.valueCode) return result.valueCode;
  if (result.valueText) return result.valueText;
  return null;
}

/**
 * The result AS THE ROW SHOWS IT. One value is written out; a panel says how
 * many there are, because four numbers do not fit in a column.
 */
export function rowResult(test) {
  const results = test?.results || [];
  if (results.length === 0) return null;
  if (results.length === 1) return resultValue(results[0]);
  const abnormal = results.filter((r) => ['high', 'low', 'abnormal', 'positive', 'critical_high', 'critical_low'].includes(r.interpretation)).length;
  return `${results.length} values${abnormal ? `, ${abnormal} abnormal` : ''}`;
}

/** The reading the row shows: one result's, or the worst of a panel's. */
export function rowInterpretation(test) {
  const results = test?.results || [];
  if (results.length === 0) return null;
  if (results.length === 1) return results[0].interpretation;
  const order = ['critical_high', 'critical_low', 'high', 'low', 'abnormal', 'positive'];
  for (const key of order) {
    if (results.some((r) => r.interpretation === key)) return key;
  }
  return results.every((r) => r.interpretation === 'normal' || r.interpretation === 'negative')
    ? results[0].interpretation
    : null;
}

/** "70–99 mg/dL", or the lab's own words, or nothing. */
export function referenceLabel(result) {
  if (!result) return null;
  if (result.referenceText) return result.referenceText;
  const { referenceLow: lo, referenceHigh: hi, unit } = result;
  if (lo === null && hi === null) return null;
  const range = lo !== null && hi !== null ? `${lo}–${hi}` : lo !== null ? `≥ ${lo}` : `≤ ${hi}`;
  return [range, unit].filter(Boolean).join(' ');
}

/** Where it came from, and its reference: "Synlab · 2026-0918-441". */
export function sourceLabel(test, sources) {
  return [labelFor(sources, test?.source), test?.sourceName].filter(Boolean).join(' · ') || null;
}

/** "Consultation — 22 Sep 2026", when it was done at one. */
export function encounterLabel(test) {
  if (!test?.encounter) return null;
  const when = dayLabel(test.encounter.startedAt);
  return when ? `Consultation — ${when}` : 'Consultation';
}

/** What an ordered test says where a result would be (brief §31). */
export function pendingLine(test) {
  if (!test) return null;
  if (test.status === 'ordered') return 'Test ordered — result pending';
  if (test.status === 'pending') return 'Sample with the laboratory — result pending';
  if (test.status === 'cancelled') return 'Cancelled';
  return null;
}

/** Who recorded it and who last changed it. */
export function byLine(test) {
  const recorded = test?.recordedBy?.email || null;
  const updated = test?.updatedBy?.email || null;
  const parts = [recorded ? `Recorded by ${recorded}` : 'Recorded'];
  if (updated && updated !== recorded) parts.push(`last changed by ${updated}`);
  return parts.join(', ');
}

/**
 * A trend is only drawn when there is one. Two points is a line between two
 * dots and tells a pharmacist nothing they cannot read from the rows.
 */
export const MIN_TREND_POINTS = 3;
export function canTrend(trend) {
  return Boolean(trend && trend.points && trend.points.length >= MIN_TREND_POINTS);
}

/** The shape VitalsChart takes, so the trend reuses the app's own chart. */
export function trendSeries(trend) {
  if (!canTrend(trend)) return null;
  return {
    series: [{ label: trend.analyte, points: trend.points.map((p) => ({ at: p.at, value: p.value })) }],
    unit: trend.unit || '',
    ranges: trend.ranges && (trend.ranges.min !== null || trend.ranges.max !== null) ? trend.ranges : null,
  };
}

/** Why the form cannot save yet — mirrors the server, never replaces it. */
export function formProblems(form) {
  const out = [];
  if (!String(form?.testName || '').trim()) out.push('Say which test this is.');
  const results = form?.results || [];
  const reported = ['preliminary', 'final', 'amended', 'corrected'].includes(form?.status);
  if (reported && !form?.performed) out.push('Say when the test was performed.');
  if (reported && results.length === 0 && !String(form?.reportSummary || '').trim()) {
    out.push('Record a result, or the report\'s own words.');
  }
  if (['cancelled', 'amended', 'corrected'].includes(form?.status) && !String(form?.statusReason || '').trim()) {
    out.push(form.status === 'cancelled' ? 'Say why it was cancelled.' : 'Say why the result changed.');
  }
  for (const r of results) {
    const filled = [r.valueNumber, r.valueCode, r.valueText].filter((v) => v !== '' && v !== null && v !== undefined);
    if (String(r.analyteName || '').trim() && filled.length === 0) {
      out.push(`${r.analyteName} has no result.`);
      break;
    }
  }
  return out;
}
