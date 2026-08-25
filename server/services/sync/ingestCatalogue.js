/**
 * Take a catalogue file from an unattended source and decide what happens to
 * it — shared by the connected-computer agent and by email ingestion.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO ROUTES THAT LOOK ALIKE
 * The rule that makes unattended importing safe is subtle and lives in several
 * places at once: nothing reaches products until a human has agreed what the
 * columns mean; a file whose columns have CHANGED does not import at all; an
 * import that rejects more rows than it keeps is not a success however well
 * the headers matched. Two copies of that would agree on the day they were
 * written and diverge on the first bug fixed in one of them — and the failure
 * would be a pharmacy's prices going quietly wrong on a schedule, which is the
 * exact thing all of this exists to prevent.
 *
 * The SOURCE differs (a bearer token from an installed program, versus a
 * message from a POS nobody can log into). What happens to the rows does not.
 */

const { stageUpload, confirmAndImport } = require('../catalogue/catalogueImport');
const { getSavedMapping, mappingMatches, recordSyncResult } = require('./syncDevices');

/**
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.deviceId    the sync_devices row — a computer or an email inbox
 * @param {Buffer} args.buffer
 * @param {string} args.filename
 * @returns {Promise<{status: string, uploadId: string, reason?: string, imported?: number, rejected?: number}>}
 */
async function ingestCatalogue({ pharmacyId, deviceId, buffer, filename }) {
  const staged = await stageUpload(pharmacyId, {
    filename,
    buffer,
    // Always retail. Trade prices are a deliberate, separate act by the owner —
    // an unattended job must never be able to rewrite a pharmacy's wholesale
    // list, whichever door it arrived through.
    priceTier: 'retail',
    syncDeviceId: deviceId,
    uploadedBy: null,
  });

  const incomingColumns = [
    ...(staged.proposals || []).map((p) => p.rawHeader),
    ...(staged.unmapped || []),
    ...(staged.detectedButUnused || []).map((d) => d.rawHeader),
  ].filter(Boolean);

  const saved = await getSavedMapping(pharmacyId);
  const matches = staged.ok && mappingMatches(saved.columns, incomingColumns);

  if (!matches) {
    const reason = !staged.ok
      ? (staged.reason || 'the file could not be read as a catalogue')
      : (saved.columns ? 'the columns in this export have changed' : 'this pharmacy has not confirmed a mapping yet');

    await recordSyncResult(deviceId, { status: 'needs_review', detail: reason, succeeded: false });
    return { status: 'needs_review', uploadId: staged.uploadId, reason };
  }

  const report = await confirmAndImport(pharmacyId, staged.uploadId, saved.mapping, { unattended: true });

  // An import that rejected more rows than it kept is not a success, whatever
  // the columns matched. A POS that starts writing prices as "N1,200" leaves
  // every header untouched and every row unusable; reported as "imported",
  // that is a catalogue going quietly half-stale on a schedule.
  const mostlyRejected = report.rejected > report.imported;

  await recordSyncResult(deviceId, {
    status: mostlyRejected ? 'needs_review' : 'imported',
    detail: mostlyRejected
      ? `${report.rejected} of ${report.rejected + report.imported} rows could not be read — check the file`
      : `${report.imported} products`,
    succeeded: !mostlyRejected,
  });

  return { status: mostlyRejected ? 'needs_review' : 'imported', uploadId: staged.uploadId, ...report };
}

/** Record a failure against the source, so it shows in the dashboard and not only in a log. */
async function recordIngestFailure(deviceId, err) {
  try {
    await recordSyncResult(deviceId, {
      status: 'failed',
      detail: err.message?.slice(0, 300) || 'unknown error',
      succeeded: false,
    });
  } catch { /* the original error matters more than this bookkeeping */ }
}

module.exports = { ingestCatalogue, recordIngestFailure };
