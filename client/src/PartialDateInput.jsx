/**
 * A date at whatever precision the patient knows it: unknown, a year, a
 * month, or an exact day.
 *
 * Shared by every clinical record that takes such a date (allergies,
 * conditions). The value it hands back is the shape the server reads the
 * precision from — "2021", "2021-03" or "2021-03-15", or "" for unknown —
 * see server/services/clinical/partialDate.js.
 */

import { useState } from 'react';

export default function PartialDateInput({ label, value, onChange, wrong = '' }) {
  const precision = !value ? '' : value.length === 4 ? 'year' : value.length === 7 ? 'month' : 'day';
  const [mode, setMode] = useState(precision);
  const thisYear = new Date().getFullYear();

  const changeMode = (m) => {
    setMode(m);
    // Keep what can be kept when narrowing or widening the precision.
    if (!m) onChange('');
    else if (m === 'year') onChange(value ? value.slice(0, 4) : '');
    else if (m === 'month') onChange(value && value.length >= 7 ? value.slice(0, 7) : '');
    else onChange(value && value.length === 10 ? value : '');
  };

  return (
    <div className="ui-med-field">
      <span className="ui-vital-label">{label}</span>
      <div className="ui-allergy-date">
        <select value={mode} onChange={(e) => changeMode(e.target.value)} className="ui-vital-input" aria-label={`${label}: how precisely it is known`}>
          <option value="">Unknown</option>
          <option value="year">Year only</option>
          <option value="month">Month</option>
          <option value="day">Exact date</option>
        </select>
        {mode === 'year' && (
          <input type="number" min="1900" max={thisYear} value={value || ''} placeholder={String(thisYear - 5)}
            onChange={(e) => onChange(e.target.value)} className={`ui-vital-input ${wrong}`} aria-label={`${label} year`} />
        )}
        {mode === 'month' && (
          <input type="month" value={value || ''} onChange={(e) => onChange(e.target.value)}
            className={`ui-vital-input ${wrong}`} aria-label={`${label} month`} />
        )}
        {mode === 'day' && (
          <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)}
            className={`ui-vital-input ${wrong}`} aria-label={`${label} date`} />
        )}
      </div>
    </div>
  );
}
