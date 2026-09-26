/**
 * The request-body contract for PATCH /api/customers/:id/care.
 *
 * Pure and separate from patientCare.js for the same reason as
 * refills/refillInput.js: dashboard forms send "45" and "", the service
 * wants 45 and null, and that contract has to be testable on a machine with
 * no database. Only keys PRESENT in the body are returned, so the service's
 * partial-update rule ("only the keys present change") holds end to end.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEXES = new Set(['male', 'female']);

function invalid(field, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_FIELD';
  err.field = field;
  return err;
}

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function readCareInput(body = {}) {
  const out = {};

  if ('assignedPharmacistId' in body) {
    const v = body.assignedPharmacistId;
    if (blank(v)) out.assignedPharmacistId = null;
    else if (typeof v === 'string' && UUID_RE.test(v.trim())) out.assignedPharmacistId = v.trim();
    else throw invalid('assignedPharmacistId', 'Choose a pharmacist from the list.');
  }

  if ('ageYears' in body) {
    const v = body.ageYears;
    if (blank(v)) {
      out.ageYears = null;
    } else {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isInteger(n) || n < 0 || n > 130) {
        throw invalid('ageYears', 'Age must be a whole number of years, from 0 to 130.');
      }
      out.ageYears = n;
    }
  }

  if ('sex' in body) {
    const v = blank(body.sex) ? null : String(body.sex).trim().toLowerCase();
    if (v !== null && !SEXES.has(v)) throw invalid('sex', 'Gender must be female or male, or left blank.');
    out.sex = v;
  }

  return out;
}

module.exports = { readCareInput };
