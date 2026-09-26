/**
 * Central error handling.
 *
 * Two jobs, both about not leaking:
 *   - Clients get a stable shape ({ error, code }) and never a stack trace
 *     or a database message. `relation "products" does not exist` tells an
 *     attacker your schema; "Something went wrong" tells them nothing.
 *   - The server logs the full error with a request id, so support can tie
 *     a customer's "it broke" to an actual line.
 */

const crypto = require('crypto');
const { env } = require('../config/env');

function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error
// middleware by arity; dropping `next` silently turns this into a normal
// handler and every error becomes an unhandled hang.
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  console.error(JSON.stringify({
    level: 'error',
    requestId: req.id,
    method: req.method,
    path: req.path,
    pharmacyId: req.pharmacyId || null,
    status,
    message: err.message,
    stack: env.isProduction ? undefined : err.stack,
  }));

  // Client errors we raised deliberately carry a safe message. Anything
  // else is assumed to be an internal detail and is replaced.
  const safe = status < 500;
  res.status(status).json({
    error: safe ? err.message : 'Something went wrong',
    code: err.code || (safe ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
    // WHICH FIELD WAS WRONG, when the error named one.
    //
    // Added 2026-09-21. Every input contract in this codebase — careInput,
    // vitalsInput, patientFilters, medicationInput — sets `err.field` so the
    // form can mark the box that is wrong, and this handler was dropping it.
    // The forms were reading `body.field` and quietly highlighting nothing:
    // the message said "Pulse must be a number" while the pulse box looked
    // exactly like the other eight.
    //
    // Only on a client error. A 500's field would be an internal detail, and
    // the message is already replaced for the same reason.
    ...(safe && err.field ? { field: err.field } : {}),
    // WHICH RECORD A 409 CONFLICTED WITH, so the screen can offer "View
    // existing" (added 2026-09-22 for the conditions duplicate check). Only
    // the id and a display name — a service sets it deliberately, and only
    // on a conflict it raised itself.
    //
    // `label` added 2026-09-24 for the care-programme duplicate check, which
    // conflicts with a programme rather than a condition. Only the key the
    // caller actually set is copied — "nothing more" is the rule this block is
    // here for, and a `label: undefined` beside a condition's name is one more
    // thing than the caller said.
    ...(status === 409 && err.existing && typeof err.existing === 'object'
      ? {
        existing: {
          id: err.existing.id,
          ...(err.existing.conditionName !== undefined ? { conditionName: err.existing.conditionName } : {}),
          ...(err.existing.label !== undefined ? { label: err.existing.label } : {}),
        },
      }
      : {}),
    requestId: req.id,
  });
}

/** Wraps an async route so a rejected promise reaches errorHandler. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { requestId, notFound, errorHandler, asyncRoute, HttpError };
