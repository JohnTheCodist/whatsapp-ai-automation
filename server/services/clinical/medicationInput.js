/**
 * The request body for a patient's medication, and the vocabulary a
 * medication is described with.
 *
 * PURE. No database, no clock the caller did not pass. Exists for the same
 * reason vitalsInput.js and careInput.js do: a form sends strings, an
 * untouched field sends "", and a service that takes them straight to SQL
 * either stores an empty string where a clinical fact belongs or refuses a
 * perfectly good record.
 *
 * AN UNKNOWN VALUE IS A 400 THAT NAMES ITS FIELD, never a silent drop. A
 * frequency that did not save is a medicine the patient is told to take at
 * the wrong time; the refusal belongs on screen while the pharmacist is
 * still looking at it.
 *
 * WHAT IS DELIBERATELY FREE TEXT. Strength ("20 mg/5 mL", "0.05% w/w"),
 * dose, indication and instructions. A closed list would be a prescription
 * this system cannot record, and the pharmacist would write it in the notes
 * where nothing can read it. Form, route, frequency, status and source are
 * closed lists because each one drives display or behaviour and a wrong
 * value there is a typo rather than a clinical nuance.
 */

const FORMS = Object.freeze([
  { value: 'tablet', label: 'Tablet' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'syrup', label: 'Syrup' },
  { value: 'suspension', label: 'Suspension' },
  { value: 'cream', label: 'Cream' },
  { value: 'ointment', label: 'Ointment' },
  { value: 'gel', label: 'Gel' },
  { value: 'injection', label: 'Injection' },
  { value: 'inhaler', label: 'Inhaler' },
  { value: 'drops', label: 'Drops' },
  { value: 'patch', label: 'Patch' },
  { value: 'suppository', label: 'Suppository' },
  { value: 'powder', label: 'Powder' },
  { value: 'other', label: 'Other' },
]);

const ROUTES = Object.freeze([
  { value: 'oral', label: 'Oral' },
  { value: 'topical', label: 'Topical' },
  { value: 'im', label: 'Intramuscular (IM)' },
  { value: 'iv', label: 'Intravenous (IV)' },
  { value: 'sc', label: 'Subcutaneous (SC)' },
  { value: 'inhaled', label: 'Inhaled' },
  { value: 'ophthalmic', label: 'Eye (ophthalmic)' },
  { value: 'otic', label: 'Ear (otic)' },
  { value: 'nasal', label: 'Nasal' },
  { value: 'rectal', label: 'Rectal' },
  { value: 'vaginal', label: 'Vaginal' },
  { value: 'sublingual', label: 'Sublingual' },
  { value: 'other', label: 'Other' },
]);

/**
 * `perDay` is what the refill engine needs: how many doses a day, so a
 * days-supply can be turned into a run-out date. `as_needed` and `other`
 * carry null — a PRN medicine has no schedule, and inventing one would put
 * the patient on a call list for a medicine they may not have taken.
 */
const FREQUENCIES = Object.freeze([
  { value: 'once_daily', label: 'Once daily', perDay: 1 },
  { value: 'twice_daily', label: 'Twice daily', perDay: 2 },
  { value: 'three_times_daily', label: 'Three times daily', perDay: 3 },
  { value: 'four_times_daily', label: 'Four times daily', perDay: 4 },
  { value: 'every_4_hours', label: 'Every 4 hours', perDay: 6 },
  { value: 'every_6_hours', label: 'Every 6 hours', perDay: 4 },
  { value: 'every_8_hours', label: 'Every 8 hours', perDay: 3 },
  { value: 'every_12_hours', label: 'Every 12 hours', perDay: 2 },
  { value: 'weekly', label: 'Weekly', perDay: null },
  { value: 'as_needed', label: 'As needed', perDay: null },
  { value: 'other', label: 'Other', perDay: null },
]);

/**
 * draft      being written up; not yet part of the patient's medication
 * active     the patient is taking it
 * completed  the course finished as intended
 * stopped    ended early — stop_reason says why
 * cancelled  should never have been recorded (a mistake, not an event)
 */
const STATUSES = Object.freeze([
  { value: 'draft', label: 'Draft', ended: false },
  { value: 'active', label: 'Active', ended: false },
  { value: 'completed', label: 'Completed', ended: true },
  { value: 'stopped', label: 'Stopped', ended: true },
  { value: 'cancelled', label: 'Cancelled', ended: true },
]);

/**
 * Where the record came from. The distinction this module exists for: a
 * community pharmacist routinely finds a patient taking something that is in
 * no prescription record at all.
 */
const SOURCES = Object.freeze([
  { value: 'prescribed', label: 'Prescribed' },
  { value: 'patient_reported', label: 'Patient reported' },
  { value: 'pharmacist_added', label: 'Pharmacist added' },
  { value: 'imported', label: 'Imported' },
  { value: 'historical', label: 'Historical' },
]);

const MAX_DURATION_DAYS = 3650;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONDITION_RE = /^[A-Z][A-Z0-9_]{1,59}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_MEDICATION';
  err.field = field;
  return err;
}

/** "" and whitespace mean "not stated", which is not the same as empty. */
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

function day(field, raw) {
  const s = text(field, raw, 32);
  if (s === null) return null;
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw invalid(field, 'That is not a date.');
  }
  return s;
}

/** Doses a day for a frequency, or null where the schedule is not fixed. */
function dosesPerDay(frequency) {
  return FREQUENCIES.find((f) => f.value === frequency)?.perDay ?? null;
}

/** True when a status means the medicine has ended. */
function isEnded(status) {
  return Boolean(STATUSES.find((s) => s.value === status)?.ended);
}

/**
 * A new medication.
 *
 * @param {object} body
 * @param {{ today: string }} opts  Lagos date, injected — never the browser's
 * @returns {object} ready for the service
 */
function readMedicationInput(body = {}, { today } = {}) {
  const medicineName = text('medicineName', body.medicineName, 200);
  if (!medicineName) throw invalid('medicineName', 'Name the medicine.');

  const productId = text('productId', body.productId, 64);
  if (productId && !UUID_RE.test(productId)) throw invalid('productId', 'Unknown medicine.');

  const prescriberId = text('prescriberId', body.prescriberId, 64);
  if (prescriberId && !UUID_RE.test(prescriberId)) throw invalid('prescriberId', 'Unknown prescriber.');
  const prescriberName = text('prescriberName', body.prescriberName, 120);
  // One or the other. A record naming two prescribers cannot say which of
  // them to ring, which is the only reason the field exists.
  if (prescriberId && prescriberName) {
    throw invalid('prescriberName', 'Name the prescriber, or choose one from the pharmacy — not both.');
  }

  const conditionCode = text('conditionCode', body.conditionCode, 60);
  if (conditionCode && !CONDITION_RE.test(conditionCode)) {
    throw invalid('conditionCode', 'Unknown condition.');
  }

  let durationDays = null;
  if (body.durationDays !== undefined && body.durationDays !== null && String(body.durationDays).trim() !== '') {
    const n = Number(body.durationDays);
    // Absent means ONGOING, which is the normal case for the chronic
    // medicines this pharmacy follows — it is not zero and not an error.
    if (!Number.isInteger(n) || n < 1 || n > MAX_DURATION_DAYS) {
      throw invalid('durationDays', `Duration must be a whole number of days, 1 to ${MAX_DURATION_DAYS}.`);
    }
    durationDays = n;
  }

  const startedOn = day('startedOn', body.startedOn) || today || null;
  if (!startedOn) throw invalid('startedOn', 'Say when the patient started it.');
  const endedOn = day('endedOn', body.endedOn);
  if (endedOn && endedOn < startedOn) {
    throw invalid('endedOn', 'The end date cannot be before the start date.');
  }
  // A start date in the future is a plan, not a record of what someone is
  // taking, and it would sit at the wrong end of the history.
  if (today && startedOn > today) throw invalid('startedOn', 'A medicine cannot have started in the future.');

  const status = oneOf('status', body.status, STATUSES) || 'active';
  const stopReason = text('stopReason', body.stopReason, 500);
  // Stopping is the one ending that needs a reason: completed says itself,
  // cancelled says it was never real, but "stopped" without a why is the
  // record that makes the next pharmacist guess.
  if (status === 'stopped' && !stopReason) {
    throw invalid('stopReason', 'Say why it was stopped.');
  }

  return {
    medicineName,
    productId: productId || null,
    genericName: text('genericName', body.genericName, 200),
    brandName: text('brandName', body.brandName, 200),
    strength: text('strength', body.strength, 60),
    form: oneOf('form', body.form, FORMS),
    dose: text('dose', body.dose, 80),
    route: oneOf('route', body.route, ROUTES),
    frequency: oneOf('frequency', body.frequency, FREQUENCIES),
    timing: text('timing', body.timing, 120),
    durationDays,
    startedOn,
    endedOn,
    indication: text('indication', body.indication, 200),
    conditionCode: conditionCode || null,
    prescriberId: prescriberId || null,
    prescriberName,
    instructions: text('instructions', body.instructions, 1000),
    notes: text('notes', body.notes, 2000),
    source: oneOf('source', body.source, SOURCES) || 'prescribed',
    status,
    stopReason,
    // Kept so the service can set units_per_day without re-deriving the rule.
    dosesPerDay: dosesPerDay(oneOf('frequency', body.frequency, FREQUENCIES)),
  };
}

/**
 * An edit. Only the keys present change, so a form that sends three fields
 * cannot blank the other fifteen — the same contract as careInput.js.
 */
function readMedicationPatch(body = {}, { today } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  const simple = {
    medicineName: (v) => {
      const s = text('medicineName', v, 200);
      if (!s) throw invalid('medicineName', 'Name the medicine.');
      return s;
    },
    genericName: (v) => text('genericName', v, 200),
    brandName: (v) => text('brandName', v, 200),
    strength: (v) => text('strength', v, 60),
    dose: (v) => text('dose', v, 80),
    timing: (v) => text('timing', v, 120),
    indication: (v) => text('indication', v, 200),
    instructions: (v) => text('instructions', v, 1000),
    notes: (v) => text('notes', v, 2000),
    prescriberName: (v) => text('prescriberName', v, 120),
    form: (v) => oneOf('form', v, FORMS),
    route: (v) => oneOf('route', v, ROUTES),
    frequency: (v) => oneOf('frequency', v, FREQUENCIES),
    source: (v) => oneOf('source', v, SOURCES),
    stopReason: (v) => text('stopReason', v, 500),
    startedOn: (v) => day('startedOn', v),
    endedOn: (v) => day('endedOn', v),
  };
  for (const [key, read] of Object.entries(simple)) {
    if (has(key)) out[key] = read(body[key]);
  }

  if (has('status')) {
    const status = oneOf('status', body.status, STATUSES);
    if (!status) throw invalid('status', 'Unknown status.');
    out.status = status;
    if (status === 'stopped') {
      const reason = has('stopReason') ? out.stopReason : text('stopReason', body.stopReason, 500);
      if (!reason) throw invalid('stopReason', 'Say why it was stopped.');
      out.stopReason = reason;
    }
  }

  if (has('durationDays')) {
    const raw = body.durationDays;
    if (raw === null || raw === '' || raw === undefined) out.durationDays = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DURATION_DAYS) {
        throw invalid('durationDays', `Duration must be a whole number of days, 1 to ${MAX_DURATION_DAYS}.`);
      }
      out.durationDays = n;
    }
  }

  if (has('prescriberId')) {
    const id = text('prescriberId', body.prescriberId, 64);
    if (id && !UUID_RE.test(id)) throw invalid('prescriberId', 'Unknown prescriber.');
    out.prescriberId = id || null;
  }
  if (out.prescriberId && out.prescriberName) {
    throw invalid('prescriberName', 'Name the prescriber, or choose one from the pharmacy — not both.');
  }

  if (has('conditionCode')) {
    const code = text('conditionCode', body.conditionCode, 60);
    if (code && !CONDITION_RE.test(code)) throw invalid('conditionCode', 'Unknown condition.');
    out.conditionCode = code || null;
  }

  if (out.startedOn && out.endedOn && out.endedOn < out.startedOn) {
    throw invalid('endedOn', 'The end date cannot be before the start date.');
  }
  if (today && out.startedOn && out.startedOn > today) {
    throw invalid('startedOn', 'A medicine cannot have started in the future.');
  }
  if (!Object.keys(out).length) throw invalid('medication', 'Nothing to change.');

  if (has('frequency')) out.dosesPerDay = dosesPerDay(out.frequency);
  return out;
}

/** Everything the form can offer, so the screen cannot show a refused value. */
function medicationOptions() {
  const pick = (list) => list.map(({ value, label }) => ({ value, label }));
  return {
    form: pick(FORMS),
    route: pick(ROUTES),
    frequency: pick(FREQUENCIES),
    status: pick(STATUSES),
    source: pick(SOURCES),
  };
}

module.exports = {
  FORMS, ROUTES, FREQUENCIES, STATUSES, SOURCES, MAX_DURATION_DAYS,
  readMedicationInput, readMedicationPatch, medicationOptions, dosesPerDay, isEnded,
};
