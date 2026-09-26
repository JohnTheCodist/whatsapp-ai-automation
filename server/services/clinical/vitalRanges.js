/**
 * Vital signs: what each one is called, what it is measured in, what counts
 * as outside the usual adult range, and how BMI is derived.
 *
 * PURE. No database, no clock the caller did not pass. The service
 * (vitals.js) stores readings; this file decides nothing about storage and
 * everything about meaning, so the meaning can be tested without Postgres
 * and shared with the dashboard, which colours a reading using these same
 * bounds.
 *
 * ── WHAT "ABNORMAL" MEANS HERE, AND WHAT IT DOES NOT ─────────────────────
 * These are REFERENCE RANGES FOR ADULTS, the ordinary bounds a reading is
 * expected to fall inside. A value outside them is worth a second look. It
 * is NOT a diagnosis, NOT a severity, and NOT advice: this product records
 * what was measured and shows when a number is unusual, exactly as the
 * printed chart on a counter does.
 *
 * Three rules that follow from that, and that the tests pin:
 *
 *   1. NO RANGE IS APPLIED TO A CHILD. Every bound here is an adult bound;
 *      a child's pulse of 120 is ordinary and would be flagged as abnormal
 *      by these numbers. Where age is unknown or under 18, nothing is
 *      flagged — `abnormalFlags` takes the age and returns nothing rather
 *      than guessing. A red number against a healthy child is how staff
 *      learn to ignore red numbers.
 *
 *   2. NOTHING IS EVER CALLED NORMAL. A reading inside the range gets no
 *      mark at all. "Normal" is a clinical judgement about a person; inside
 *      a reference range is an arithmetic fact about a number.
 *
 *   3. A MISSING READING IS NOT A NORMAL READING. Null is absent, and
 *      absent is never flagged and never plotted.
 *
 * Sources for the bounds are the ordinary adult reference ranges used on
 * observation charts (BP 90/60–140/90 mmHg, pulse 60–100 bpm, respiration
 * 12–20 /min, SpO2 >= 94%, temperature 36.1–37.8 °C). They are written here
 * once so that the table, the chart and the form cannot disagree about when
 * a number turns red.
 */

const ADULT_FROM = 18;

/**
 * The vitals this product records, in the order they are entered and shown.
 * `key` is the storage column in camelCase; `unit` is what the number means
 * and is never inferred from the value.
 */
const VITALS = Object.freeze([
  {
    key: 'systolic', label: 'Systolic', short: 'BP', unit: 'mmHg', group: 'vitals', min: 90, max: 140, step: 1, range: [50, 300],
  },
  {
    key: 'diastolic', label: 'Diastolic', short: 'BP', unit: 'mmHg', group: 'vitals', min: 60, max: 90, step: 1, range: [30, 200],
  },
  {
    key: 'pulse', label: 'Pulse', short: 'Pulse', unit: 'beats/min', group: 'vitals', min: 60, max: 100, step: 1, range: [20, 250],
  },
  {
    key: 'spo2', label: 'SpO2', short: 'SPO2', unit: '%', group: 'vitals', min: 94, max: 100, step: 1, range: [50, 100],
  },
  {
    key: 'respiratoryRate', label: 'Respiration rate', short: 'R. rate', unit: 'breaths/min', group: 'vitals', min: 12, max: 20, step: 1, range: [4, 80],
  },
  {
    key: 'temperature', label: 'Temperature', short: 'Temp', unit: '°C', group: 'vitals', min: 36.1, max: 37.8, step: 0.1, range: [30, 45],
  },
  // Biometrics carry no reference range: a weight is not abnormal, and BMI
  // is a classification rather than a bound (see bmiClass).
  {
    key: 'weight', label: 'Weight', short: 'Weight', unit: 'kg', group: 'biometrics', step: 0.1, range: [0.5, 400],
  },
  {
    key: 'height', label: 'Height', short: 'Height', unit: 'cm', group: 'biometrics', step: 1, range: [30, 250],
  },
  {
    key: 'muac', label: 'MUAC', short: 'MUAC', unit: 'cm', group: 'biometrics', step: 0.1, range: [5, 60],
  },
]);

const BY_KEY = new Map(VITALS.map((v) => [v.key, v]));

/** One vital's definition, or null — never a guess at the nearest name. */
function vital(key) {
  return BY_KEY.get(key) || null;
}

/**
 * Body mass index from weight in kilograms and height in centimetres.
 *
 * DERIVED, NEVER STORED — the same rule as every other status in this
 * system. A stored BMI is wrong the moment either measurement is corrected,
 * and the correction is exactly when someone is looking.
 *
 * @returns {number|null} to one decimal, or null if either input is missing
 */
function bmi(weightKg, heightCm) {
  if (weightKg == null || heightCm == null) return null;
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const metres = h / 100;
  return Math.round((w / (metres * metres)) * 10) / 10;
}

/**
 * The WHO adult classification of a BMI.
 *
 * Adults only, for the same reason as the ranges above: a child's BMI is
 * read against a growth chart for their age and sex, and calling a
 * ten-year-old "underweight" from an adult table is simply wrong.
 */
function bmiClass(value, ageYears) {
  if (value == null || ageYears == null || ageYears < ADULT_FROM) return null;
  if (value < 18.5) return 'underweight';
  if (value < 25) return 'healthy';
  if (value < 30) return 'overweight';
  return 'obese';
}

/**
 * Which readings in a row sit outside the adult reference range.
 *
 * @param {object} reading    a row of readings, keyed as VITALS
 * @param {number|null} ageYears
 * @returns {{[key: string]: 'low'|'high'}}  empty when nothing is outside,
 *          and ALWAYS empty for a child or an unknown age (rule 1 above)
 */
function abnormalFlags(reading, ageYears) {
  if (!reading || ageYears == null || ageYears < ADULT_FROM) return {};
  const flags = {};
  for (const v of VITALS) {
    if (v.min === undefined) continue;             // biometrics have no range
    const value = reading[v.key];
    if (value == null || value === '') continue;   // absent is not abnormal
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (n < v.min) flags[v.key] = 'low';
    else if (n > v.max) flags[v.key] = 'high';
  }
  return flags;
}

/** The words for a flag, for a tooltip or a screen reader. */
function flagLabel(key, flag) {
  const v = vital(key);
  if (!v || !flag) return null;
  return `${flag === 'low' ? 'Below' : 'Above'} the usual adult range (${v.min}–${v.max} ${v.unit})`;
}

module.exports = {
  VITALS, ADULT_FROM, vital, bmi, bmiClass, abnormalFlags, flagLabel,
};
