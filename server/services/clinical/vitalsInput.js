/**
 * The request body for recording a vitals reading.
 *
 * PURE. Exists for the same reason careInput.js and refillInput.js do: a
 * form sends strings ("120", "", "36.8"), and a service that takes them
 * straight to SQL either stores a string where a number belongs or refuses
 * a perfectly good reading. This layer is where "" becomes absent and "120"
 * becomes 120, once, before anything touches the database.
 *
 * A BAD NUMBER IS A 400 THAT NAMES ITS FIELD, never a silently dropped
 * reading. A pulse that did not save is worse than one that was refused:
 * the refusal is on screen while the patient is still at the counter.
 *
 * AT LEAST ONE READING IS REQUIRED. An empty form is a mis-click, and
 * storing it would put a date with no numbers on the chart.
 */

const { VITALS, vital } = require('./vitalRanges');

const MAX_NOTES = 1000;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_READING';
  err.field = field;
  return err;
}

/**
 * One measurement: a number inside the column's plausibility bounds, or
 * absent. Absent and empty-string both mean "not taken" — which is NOT the
 * same as zero, and a form that posts "" for an untouched box must never
 * store a zero pulse.
 */
function reading(key, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const spec = vital(key);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(key, `${spec.label} must be a number.`);
  const [low, high] = spec.range;
  // The bound refused here is PLAUSIBILITY, not the reference range: a
  // systolic of 190 is alarming and stores fine; a systolic of 19 is a typo.
  if (n < low || n > high) {
    throw invalid(key, `${spec.label} must be between ${low} and ${high} ${spec.unit}.`);
  }
  // Whole numbers where the column is smallint, one decimal where it is
  // numeric(_,1) — rounded here rather than letting Postgres do it, so what
  // comes back is what was sent.
  return spec.step === 1 ? Math.round(n) : Math.round(n * 10) / 10;
}

/**
 * @param {object} body
 * @returns {{ systolic: number|null, ..., notes: string|null, recordedAt: string|null }}
 */
function readVitalsInput(body = {}) {
  const out = {};
  for (const v of VITALS) out[v.key] = reading(v.key, body[v.key]);

  // A blood pressure is one measurement written as two numbers. Half of one
  // is not a reading, and the pair is what the chart plots — so it is
  // refused here rather than stored as a line with one end.
  if ((out.systolic == null) !== (out.diastolic == null)) {
    throw invalid(
      out.systolic == null ? 'systolic' : 'diastolic',
      'A blood pressure needs both the systolic and the diastolic number.',
    );
  }
  if (out.systolic != null && out.diastolic != null && out.diastolic >= out.systolic) {
    throw invalid('diastolic', 'The diastolic number must be lower than the systolic one.');
  }

  if (!VITALS.some((v) => out[v.key] != null)) {
    throw invalid('reading', 'Record at least one measurement.');
  }

  const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim() || null;
  if (notes && notes.length > MAX_NOTES) {
    throw invalid('notes', `Notes cannot be longer than ${MAX_NOTES} characters.`);
  }

  let recordedAt = null;
  if (body.recordedAt) {
    const when = new Date(body.recordedAt);
    if (Number.isNaN(when.getTime())) throw invalid('recordedAt', 'That is not a date and time.');
    // A reading taken in the future is a clock or a typo, not an
    // observation, and it would sit on the right-hand edge of every chart.
    if (when.getTime() > Date.now() + 60_000) {
      throw invalid('recordedAt', 'A reading cannot be taken in the future.');
    }
    recordedAt = when.toISOString();
  }

  return { ...out, notes, recordedAt };
}

module.exports = { readVitalsInput, MAX_NOTES };
