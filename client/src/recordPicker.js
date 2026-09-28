/**
 * How a screen lists a patient's existing records so one can be pointed at.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED
 * Two screens now point at records they do not own — a care programme attaches
 * related records, and a consultation problem names the record it is about —
 * and both must offer the SAME four kinds, read from the SAME endpoints. A
 * second copy of this map would drift: one screen would gain a kind the other
 * lacked, or keep reading a route that had moved, and the symptom would be a
 * picker that silently lists nothing.
 *
 * Every list is read from the section that OWNS those records. Nothing can be
 * pointed at that is not already on this patient's record, and the server
 * checks the id again before storing it (`clinicalRefs.assertRecord`).
 *
 * NOTHING HERE IS STORED. These labels are what the record says TODAY, read on
 * every load; what gets saved is a kind and an id. That is the whole point —
 * a dose changed in Medications shows here next time, and a pointer can never
 * display a value that has stopped being true.
 *
 * `rows` takes the formatter its caller uses for dates, because the two
 * screens date things differently on purpose: a care programme's dates are
 * date-only strings and a consultation's are timestamps in the pharmacy's
 * Lagos day. Passing it in keeps each screen reading exactly as it did.
 */

export const RECORD_PICKERS = Object.freeze({
  condition: {
    url: (id) => `/api/customers/${id}/problems`,
    rows: (j) => (j.conditions || []).map((c) => ({ id: c.id, label: c.conditionName, detail: c.clinicalStatus })),
  },
  medication: {
    url: (id) => `/api/customers/${id}/medications?status=current`,
    rows: (j) => (j.medications || []).map((m) => ({
      id: m.id, label: [m.medicineName, m.strength].filter(Boolean).join(' '), detail: m.status,
    })),
  },
  test: {
    url: (id) => `/api/customers/${id}/tests`,
    rows: (j) => (j.tests || []).map((t) => ({ id: t.id, label: t.testName, detail: t.status })),
  },
  vitals: {
    url: (id) => `/api/customers/${id}/vitals?limit=10`,
    rows: (j, dayLabel) => (j.readings || []).map((v) => ({
      id: v.id,
      label: dayLabel(v.recordedAt) || 'Reading',
      detail: [v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic} mmHg` : null, v.pulse ? `${v.pulse} bpm` : null]
        .filter(Boolean).join(' · '),
    })),
  },
  encounter: {
    url: (id) => `/api/customers/${id}/tests/encounters`,
    rows: (j, dayLabel) => (j.encounters || []).map((e) => ({
      id: e.id, label: dayLabel(e.startedAt) || 'Consultation', detail: e.presentingComplaint || e.complaint || null,
    })),
  },
});

/** Every kind this module can list. A screen must not offer one that is absent. */
export const PICKER_KINDS = Object.freeze(Object.keys(RECORD_PICKERS));

/**
 * Read one kind's list, mapped to `{ id, label, detail }`.
 *
 * A read that fails answers with an empty list rather than throwing: the
 * picker then says "no records of that kind", which is what a pharmacist can
 * act on. It never renders as though the records do not exist elsewhere.
 */
export async function readRecords(kind, customerId, dayLabel = () => null) {
  const picker = RECORD_PICKERS[kind];
  if (!picker) return [];
  try {
    const res = await fetch(picker.url(customerId));
    if (!res.ok) return [];
    return picker.rows(await res.json(), dayLabel) || [];
  } catch {
    return [];
  }
}
