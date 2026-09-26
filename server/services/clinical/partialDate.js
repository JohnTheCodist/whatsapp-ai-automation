/**
 * A date a patient may only half-know, read at the precision they gave it.
 *
 *   "2021"        -> { date: '2021-01-01', precision: 'year' }
 *   "2021-03"     -> { date: '2021-03-01', precision: 'month' }
 *   "2021-03-15"  -> { date: '2021-03-15', precision: 'day' }
 *   "" / null     -> { date: null, precision: null }   unknown, a real answer
 *
 * The precision is read from the SHAPE of what was typed, so a form never
 * has to send a second field that can disagree with the first.
 *
 * PURE, and shared by every clinical record that takes such a date
 * (allergies, conditions). Each passes its own `invalid(field, message)` so
 * the error carries that record's code and names the field.
 */

function readPartialDate(field, raw, today, invalid) {
  if (raw === undefined || raw === null) return { date: null, precision: null };
  const s = String(raw).trim();
  if (!s) return { date: null, precision: null };
  if (s.length > 10) throw invalid(field, 'Use a year (2021), a month (2021-03) or a full date.');

  let date;
  let precision;
  if (/^\d{4}$/.test(s)) { date = `${s}-01-01`; precision = 'year'; }
  else if (/^\d{4}-\d{2}$/.test(s)) { date = `${s}-01`; precision = 'month'; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { date = s; precision = 'day'; }
  else throw invalid(field, 'Use a year (2021), a month (2021-03) or a full date.');

  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw invalid(field, 'That is not a date.');
  }
  if (Number(date.slice(0, 4)) < 1900) throw invalid(field, 'That is too long ago to be right.');
  // Compared at the precision given: "2026" is fine in any month of 2026.
  if (today) {
    const cut = { year: 4, month: 7, day: 10 }[precision];
    if (date.slice(0, cut) > today.slice(0, cut)) throw invalid(field, 'That date is in the future.');
  }
  return { date, precision };
}

module.exports = { readPartialDate };
