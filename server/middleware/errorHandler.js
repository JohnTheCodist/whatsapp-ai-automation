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
