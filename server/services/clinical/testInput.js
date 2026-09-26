/**
 * The vocabulary of a diagnostic test, and the contract for recording one.
 *
 * PURE. One place for the lists, so the form, the validator and the screen
 * cannot drift; the CHECKs in 0060 hold the same lists.
 *
 * A VALUE IS NOT A VERDICT. Entering a result never makes a test FINAL by
 * itself — it becomes 'preliminary' until a pharmacist says otherwise (brief
 * §5). And nothing here turns a result into a diagnosis.
 *
 * THE ONE PIECE OF ARITHMETIC: `suggestInterpretation` compares a number to
 * the range that was typed beside it. The form uses it to PRE-FILL an
 * editable field; the server stores what was sent. It never returns a
 * critical flag — "critical" is a judgement a person makes (§23).
 */

const { readPartialDate } = require('./partialDate');

const CATEGORIES = Object.freeze([
  { value: 'laboratory', label: 'Laboratory' },
  { value: 'rapid_test', label: 'Rapid test' },
  { value: 'microbiology', label: 'Microbiology' },
  { value: 'haematology', label: 'Haematology' },
  { value: 'chemistry', label: 'Chemistry' },
  { value: 'serology', label: 'Serology' },
  { value: 'imaging', label: 'Imaging' },
  { value: 'other', label: 'Other' },
]);

/** The lifecycle. FHIR's names; 'final' is written "Completed" on screen. */
const STATUSES = Object.freeze([
  { value: 'ordered', label: 'Ordered' },
  { value: 'pending', label: 'Pending' },
  { value: 'preliminary', label: 'Preliminary' },
  { value: 'final', label: 'Completed' },
  { value: 'amended', label: 'Amended' },
  { value: 'corrected', label: 'Corrected' },
  { value: 'cancelled', label: 'Cancelled' },
]);

/** Statuses where a result exists and someone may act on it. */
const REPORTED = Object.freeze(['preliminary', 'final', 'amended', 'corrected']);
/** Statuses that state a change to a report, and must say why. */
const NEEDS_REASON = Object.freeze(['cancelled', 'amended', 'corrected']);
/** Only a pharmacist or owner may put a report into one of these. */
const PHARMACIST_STATUSES = Object.freeze(['final', 'amended', 'corrected', 'cancelled']);
const CLINICAL_ROLES = Object.freeze(['owner', 'pharmacist']);

const PRIORITIES = Object.freeze([
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
]);

const SPECIMENS = Object.freeze([
  { value: 'blood', label: 'Blood' },
  { value: 'urine', label: 'Urine' },
  { value: 'stool', label: 'Stool' },
  { value: 'saliva', label: 'Saliva' },
  { value: 'swab', label: 'Swab' },
  { value: 'other', label: 'Other' },
  { value: 'not_applicable', label: 'Not applicable' },
]);

/** Where the test was done — the community pharmacy's whole point (§20). */
const SOURCES = Object.freeze([
  { value: 'rxmax_clinic', label: 'This pharmacy' },
  { value: 'external_lab', label: 'External laboratory' },
  { value: 'hospital', label: 'Hospital' },
  { value: 'patient_reported', label: 'Patient reported' },
  { value: 'imported', label: 'Imported' },
  { value: 'other', label: 'Other' },
]);

const INTERPRETATIONS = Object.freeze([
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'critical_high', label: 'Critically high' },
  { value: 'critical_low', label: 'Critically low' },
  { value: 'positive', label: 'Positive' },
  { value: 'negative', label: 'Negative' },
  { value: 'abnormal', label: 'Abnormal' },
  { value: 'indeterminate', label: 'Indeterminate' },
  { value: 'not_interpretable', label: 'Not interpretable' },
]);

/** Which readings mean "look at this". Critical is its own, louder, case. */
const ABNORMAL = Object.freeze(['high', 'low', 'abnormal', 'positive', 'critical_high', 'critical_low']);
const CRITICAL = Object.freeze(['critical_high', 'critical_low']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 30;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_TEST';
  err.field = field;
  return err;
}

function text(field, raw, max) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > max) throw invalid(field, `${field} cannot be longer than ${max} characters.`);
  return s;
}

function oneOf(field, raw, list) {
  const s = text(field, raw, 60);
  if (s === null) return null;
  if (!list.some((o) => o.value === s)) throw invalid(field, `Unknown ${field} "${s}".`);
  return s;
}

function number(field, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw invalid(field, 'That is not a number.');
  if (Math.abs(n) > 1e9) throw invalid(field, 'That number is too large to be a result.');
  return n;
}

function optionalId(field, raw) {
  const s = text(field, raw, 64);
  if (s === null) return null;
  if (!UUID_RE.test(s)) throw invalid(field, `Unknown ${field}.`);
  return s;
}

/**
 * What a number means against the range beside it. Arithmetic, not
 * diagnosis: the form pre-fills this and the pharmacist may change it.
 * Returns null when there is nothing to compare against.
 */
function suggestInterpretation(value, low, high) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  const lo = low === null || low === undefined || low === '' ? null : Number(low);
  const hi = high === null || high === undefined || high === '' ? null : Number(high);
  if (lo === null && hi === null) return null;
  if (lo !== null && n < lo) return 'low';
  if (hi !== null && n > hi) return 'high';
  return 'normal';
}

/**
 * The values. One row per analyte, EXACTLY ONE KIND of value each: a number,
 * a code, or words. A row with both a number and a code is two claims with
 * no way to say which the lab made.
 */
function readResults(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('results', 'Results must be a list.');
  if (raw.length > MAX_RESULTS) throw invalid('results', `No more than ${MAX_RESULTS} results on one test.`);

  return raw.map((r, i) => {
    const item = r || {};
    const analyteName = text('analyteName', item.analyteName, 120);
    if (!analyteName) throw invalid('results', `Result ${i + 1} has no name.`);

    const valueNumber = number('value', item.valueNumber);
    const valueCode = text('value', item.valueCode, 40);
    const valueText = text('value', item.valueText, 2000);
    const kinds = [valueNumber, valueCode, valueText].filter((v) => v !== null).length;
    if (kinds === 0) throw invalid('results', `${analyteName} has no result.`);
    if (kinds > 1) throw invalid('results', `${analyteName} has more than one kind of result.`);

    const referenceLow = number('referenceLow', item.referenceLow);
    const referenceHigh = number('referenceHigh', item.referenceHigh);
    if (referenceLow !== null && referenceHigh !== null && referenceLow > referenceHigh) {
      throw invalid('referenceLow', 'The low end of the range is above the high end.');
    }
    if ((referenceLow !== null || referenceHigh !== null) && valueNumber === null) {
      throw invalid('referenceLow', 'A reference range belongs to a number.');
    }

    return {
      analyteName,
      analyteCode: text('analyteCode', item.analyteCode, 40),
      valueNumber,
      unit: valueNumber === null ? null : text('unit', item.unit, 20),
      valueCode,
      valueDisplay: valueCode === null ? null : (text('valueDisplay', item.valueDisplay, 120) || valueCode),
      valueText,
      referenceLow,
      referenceHigh,
      referenceText: text('referenceText', item.referenceText, 120),
      interpretation: oneOf('interpretation', item.interpretation, INTERPRETATIONS),
      notes: text('notes', item.notes, 1000),
    };
  });
}

/**
 * The rules that hold for any complete test, create or edit. One function,
 * so an edit cannot reach a state a create could not.
 */
function checkTest(rec) {
  // A value has been entered, so the test is no longer merely ordered. It
  // becomes PRELIMINARY, never final by itself (brief §5).
  if (rec.results.length > 0 && ['ordered', 'pending'].includes(rec.status)) {
    rec.status = 'preliminary';
  }
  if (REPORTED.includes(rec.status) && rec.results.length === 0 && !rec.reportSummary) {
    throw invalid('results', 'A reported test needs a result, or a report summary.');
  }
  if (REPORTED.includes(rec.status) && !rec.performedAt) {
    throw invalid('performed', 'Say when the test was performed.');
  }
  if (NEEDS_REASON.includes(rec.status) && !rec.statusReason) {
    throw invalid('statusReason', rec.status === 'cancelled'
      ? 'Say why the test was cancelled.'
      : `Say why the result was ${rec.status}.`);
  }
  return rec;
}

/**
 * A new test — ordered, or recorded complete in one go.
 *
 * @param {object} body
 * @param {{ today: string }} opts  Lagos date, injected
 */
function readTestInput(body = {}, { today } = {}) {
  const testName = text('testName', body.testName, 120);
  if (!testName) throw invalid('testName', 'Say which test this is.');

  // The day it was performed, at the precision known: a result a patient
  // brings from last year is often just "Jun 2026". Stored as that day; the
  // clock time of a test is not a fact this product needs.
  const performed = readPartialDate('performed', body.performed, today, invalid);
  const orderedOn = readPartialDate('orderedOn', body.orderedOn, today, invalid);

  return checkTest({
    definitionId: optionalId('definitionId', body.definitionId),
    testCode: text('testCode', body.testCode, 40),
    testName,
    category: oneOf('category', body.category, CATEGORIES) || 'laboratory',
    status: oneOf('status', body.status, STATUSES) || 'ordered',
    priority: oneOf('priority', body.priority, PRIORITIES) || 'routine',
    reason: text('reason', body.reason, 300),
    specimen: oneOf('specimen', body.specimen, SPECIMENS),
    orderedOn: orderedOn.date,
    ordererName: text('ordererName', body.ordererName, 200),
    performedAt: performed.date,
    performedPrecision: performed.precision,
    performedByName: text('performedByName', body.performedByName, 200),
    source: oneOf('source', body.source, SOURCES) || 'rxmax_clinic',
    sourceName: text('sourceName', body.sourceName, 200),
    historical: body.historical === true,
    encounterId: optionalId('encounterId', body.encounterId),
    reportSummary: text('reportSummary', body.reportSummary, 2000),
    notes: text('notes', body.notes, 2000),
    statusReason: text('statusReason', body.statusReason, 500),
    results: readResults(body.results),
  });
}

const PATCHABLE = Object.freeze({
  testName: (v) => {
    const s = text('testName', v, 120);
    if (!s) throw invalid('testName', 'Say which test this is.');
    return s;
  },
  testCode: (v) => text('testCode', v, 40),
  category: (v) => oneOf('category', v, CATEGORIES) || 'laboratory',
  status: (v) => oneOf('status', v, STATUSES) || 'ordered',
  priority: (v) => oneOf('priority', v, PRIORITIES) || 'routine',
  reason: (v) => text('reason', v, 300),
  specimen: (v) => oneOf('specimen', v, SPECIMENS),
  ordererName: (v) => text('ordererName', v, 200),
  performedByName: (v) => text('performedByName', v, 200),
  source: (v) => oneOf('source', v, SOURCES) || 'rxmax_clinic',
  sourceName: (v) => text('sourceName', v, 200),
  historical: (v) => v === true,
  encounterId: (v) => optionalId('encounterId', v),
  reportSummary: (v) => text('reportSummary', v, 2000),
  notes: (v) => text('notes', v, 2000),
  statusReason: (v) => text('statusReason', v, 500),
  results: readResults,
});

function readTestPatch(body = {}, { today } = {}) {
  const patch = {};
  for (const [key, read] of Object.entries(PATCHABLE)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = read(body[key]);
  }
  for (const [key, field] of [['performed', 'performedAt'], ['orderedOn', 'orderedOn']]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const d = readPartialDate(key, body[key], today, invalid);
      patch[field] = d.date;
      if (key === 'performed') patch.performedPrecision = d.precision;
    }
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'Nothing to change.');
  return patch;
}

/**
 * The stored test with the patch applied, through the same rules as a
 * create. `before.results` is the stored list, so a patch that only changes
 * the status is judged against the results that already exist.
 */
function mergeForCheck(before, patch) {
  const next = checkTest({ ...before, ...patch, results: patch.results || before.results || [] });
  const adjusted = { ...patch, status: next.status };
  // Correcting a report back out of a state that needed a reason clears the
  // reason that no longer applies.
  if (!NEEDS_REASON.includes(next.status) && NEEDS_REASON.includes(before.status)
      && !Object.prototype.hasOwnProperty.call(patch, 'statusReason')) {
    adjusted.statusReason = null;
  }
  return adjusted;
}

function needsClinicalRole(next, before = null) {
  const s = next.status;
  if (!s) return false;
  if (before && before.status === s) return false;
  return PHARMACIST_STATUSES.includes(s);
}

const hasClinicalRole = (role) => CLINICAL_ROLES.includes(role);

/** Is there something here a pharmacist should look at? */
const isAbnormal = (interpretation) => ABNORMAL.includes(interpretation);
const isCritical = (interpretation) => CRITICAL.includes(interpretation);

function testOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    categories: pick(CATEGORIES),
    statuses: pick(STATUSES),
    priorities: pick(PRIORITIES),
    specimens: pick(SPECIMENS),
    sources: pick(SOURCES),
    interpretations: pick(INTERPRETATIONS),
  };
}

module.exports = {
  CATEGORIES, STATUSES, REPORTED, NEEDS_REASON, PRIORITIES, SPECIMENS, SOURCES,
  INTERPRETATIONS, ABNORMAL, CRITICAL, CLINICAL_ROLES,
  readTestInput, readTestPatch, readResults, mergeForCheck, needsClinicalRole,
  hasClinicalRole, suggestInterpretation, isAbnormal, isCritical, testOptions,
};
