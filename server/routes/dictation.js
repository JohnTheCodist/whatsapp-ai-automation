/**
 * POST /api/dictate — a pharmacist speaking their own words into a box.
 *
 * NOT THE SCRIBE, and the distance between them is the whole point. The
 * scribe records a consultation: it is bound to a patient and a note, it is
 * gated on consent recorded under 0071, and what it produces becomes
 * clinical prose. This is a search box you can talk into.
 *
 * WHY IT NEEDS NO CONSENT GATE. Consent exists because somebody ELSE is
 * being recorded. Here the person speaking is the person who pressed the
 * button, saying words they chose, which land in a field they can see and
 * edit. There is no second party to ask.
 *
 * WHAT STOPS IT BECOMING THE OTHER THING is in services/ai/dictation.js and
 * is structural rather than a rule anybody has to follow: a thirty-second
 * cap measured against the provider's own reading of the audio, no
 * diarization ever requested, and nothing stored anywhere.
 *
 * NO PATIENT IN THE ROUTE AT ALL. There is no :id, nothing is looked up, and
 * the handler could not attribute a word to a patient if it wanted to — a
 * request carrying a patient id would simply be ignoring it.
 */

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { dictate, MAX_DICTATION_BYTES, MAX_DICTATION_SECONDS } = require('../services/ai/dictation');
const { isTranscriptionConfigured } = require('../services/ai/scribe');

const router = express.Router();

/** The same list the scribe accepts: what a browser MediaRecorder produces. */
const AUDIO_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/mpga',
  'audio/wav', 'audio/x-wav', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'video/webm', 'video/mp4',
]);

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  // Checked twice deliberately, as the scribe's is: this stops a large body
  // at the door, and the service's holds for any caller that is not this
  // route. Note it is the DICTATION cap, two megabytes, not the scribe's 25.
  limits: { fileSize: MAX_DICTATION_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    // A browser sends a codec suffix: audio/webm;codecs=opus.
    const base = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(base)) {
      return cb(new Error(`${file.mimetype} is not a recording this can read.`));
    }
    cb(null, true);
  },
}).single('audio');

/**
 * Multer reports its own errors; turn them into something a person can act
 * on — and expose ONLY sentences written here.
 *
 * THE REASON THIS IS NOT `err.message`. errorHandler masks every message
 * unless `expose` is set, and `errorHandler.test.js` keeps a closed list of
 * the files allowed to set it, on the rule that each one must be "a literal
 * sentence somebody wrote". Passing multer’s own text through would break
 * that rule the moment multer raised something nobody here anticipated —
 * LIMIT_UNEXPECTED_FILE, LIMIT_PART_COUNT, a storage failure — and the
 * exemption would then be covering text this project did not author.
 *
 * The fileFilter’s message IS written here, so it is named explicitly
 * rather than inferred from the absence of a code.
 */
function handleAudio(req, res, next) {
  uploadAudio(req, res, (err) => {
    if (!err) return next();

    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    // fileFilter rejects by calling back with an Error carrying no multer
    // code, and that message is the one written above.
    const fromFilter = !err.code && /is not a recording this can read/.test(err.message || '');

    const e = new Error(
      tooBig ? 'That is longer than dictation accepts. Type it instead.'
        : fromFilter ? err.message
          : 'That recording could not be read. Try again, or type it.',
    );
    e.status = tooBig ? 413 : 400;
    e.code = 'BAD_AUDIO';
    // Every branch above is a sentence written in this file, which is what
    // the closed list in errorHandler.test.js requires of an `expose`.
    e.expose = true;
    next(e);
  });
}

/**
 * Whether the button should exist at all.
 *
 * A microphone that cannot work is worse than none: somebody speaks a whole
 * sentence into it before finding out. The screen asks first and renders
 * nothing when transcription is unconfigured.
 */
router.get('/capabilities', requireAuth, (req, res) => {
  res.json({
    available: isTranscriptionConfigured(),
    maxSeconds: MAX_DICTATION_SECONDS,
  });
});

router.post('/', requireAuth, handleAudio, async (req, res, next) => {
  try {
    const { text, seconds } = await dictate(req.file?.buffer, {
      mimetype: req.file?.mimetype,
    });

    /* Caught nothing is a SUCCESS with an empty string, not an error. A
       pharmacist who pressed the button in a noisy shop and said nothing
       useful should get their box back unchanged, not a red line. */
    res.json({ text, seconds });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
