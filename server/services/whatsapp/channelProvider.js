/**
 * Channel provider boundary.
 *
 * Everything above this file talks about "a message to a customer". Only
 * the adapters below it know that Twilio exists. That boundary is the
 * whole point: Twilio is the fastest way to ship WhatsApp today, and it is
 * also a per-message markup on top of Meta that stops making sense at
 * volume. Migrating should be writing one new adapter, not touching the
 * conversation engine.
 *
 * An adapter must implement:
 *
 *   name: string
 *
 *   verifyWebhook(req) -> boolean
 *     Authenticate the request as genuinely from the provider. Signature
 *     check, not an IP allowlist and not a shared secret in a query string.
 *
 *   parseInbound(req) -> NormalizedInbound | null
 *     Provider payload -> our shape. Returns null for payloads that are
 *     not customer messages (status callbacks, acks) so the caller can
 *     route them without knowing provider-specific event names.
 *       { providerMessageId, from, to, body, mediaUrl, receivedAt }
 *
 *   parseStatus(req) -> NormalizedStatus | null
 *     Delivery receipt -> { providerMessageId, status, error }
 *
 *   sendText({ from, to, body }) -> { providerMessageId, status }
 *     Throws SendError with `retryable` set, so the job runner can tell a
 *     transient 503 from a permanently invalid number.
 *
 * NOTE — UNVERIFIED. The exact request shape, signature header, and status
 * vocabulary of each provider must be confirmed against current official
 * documentation before an adapter is written. Nothing here should be taken
 * as a description of a real API; it is the contract WE require of one.
 */

class SendError extends Error {
  constructor(message, { retryable = false, providerCode = null } = {}) {
    super(message);
    this.name = 'SendError';
    this.retryable = retryable;
    this.providerCode = providerCode;
  }
}

/** Provider-agnostic delivery states. Adapters map their vocabulary onto this. */
const DELIVERY_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  UNDELIVERED: 'undelivered',
});

const registry = new Map();

function registerProvider(adapter) {
  for (const method of ['verifyWebhook', 'parseInbound', 'parseStatus', 'sendText']) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Channel adapter "${adapter.name}" is missing ${method}()`);
    }
  }
  registry.set(adapter.name, adapter);
}

function getProvider(name) {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(
      `No channel adapter registered for "${name}". ` +
      `Registered: ${[...registry.keys()].join(', ') || '(none)'}`
    );
  }
  return adapter;
}

module.exports = { registerProvider, getProvider, SendError, DELIVERY_STATUS };
