/**
 * A rejected draft gets handed back to the model, not straight to a person.
 *
 * WHY THIS MATTERS ENOUGH TO TEST
 * validateReply is the guard that stops an invented price reaching a
 * customer. It used to be a one-strike tripwire: any violation became a
 * pharmacist handoff immediately. Measured on real traffic that made
 * `unverified_reply` the single largest source of handoffs — 17 of 39, more
 * than every genuine clinical reason combined — and the most common cause
 * was the model returning an EMPTY message, which tells you nothing about
 * whether a pharmacist is needed.
 *
 * These tests pin the behaviour in BOTH directions, because loosening this
 * carelessly would delete the hallucination guard the validator exists to be:
 *
 *   - a fixable draft is corrected and sent          (no human involved)
 *   - a draft that stays wrong still escalates       (guard intact)
 *   - a persistently empty model is a TECHNICAL fault, retried by the queue,
 *     not a clinical one paged to a pharmacist
 *
 * The LLM and the tools are stubbed. This is about the control flow around
 * the model, so a real model would make the test non-deterministic without
 * testing anything extra.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AI_DIR = path.join(__dirname, '..', 'services', 'ai');

// Stubs installed into the module cache BEFORE assistant.js is required, so
// it binds to these rather than the real client/tools/filter.
const llmPath = require.resolve(path.join(AI_DIR, 'llmClient.js'));
const toolsPath = require.resolve(path.join(AI_DIR, 'catalogueTools.js'));
const filterPath = require.resolve(path.join(__dirname, '..', 'services', 'safety', 'clinicalFilter.js'));

let scripted = [];
let lastMessages = [];

const stub = (p, exports) => {
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
};

stub(llmPath, {
  isConfigured: () => true,
  LlmUnavailable: class LlmUnavailable extends Error {},
  chat: async ({ messages }) => {
    lastMessages = messages;
    if (scripted.length === 0) throw new Error('test ran out of scripted model turns');
    return scripted.shift();
  },
});
stub(toolsPath, { runTool: async () => ({}), toolSchemas: () => [] });
// `allow`, not `allowed` — respond() checks `screening.allow`, so the wrong
// key here silently short-circuits every call into a clinical handoff and the
// tests below would pass or fail for reasons that have nothing to do with
// self-correction.
stub(filterPath, { screenMessage: () => ({ allow: true }) });

const { respond } = require(path.join(AI_DIR, 'assistant.js'));

const BASE = {
  pharmacyId: '4ad43ebf-c0c2-4659-8315-38ab6431414f',
  pharmacyName: 'Test Pharmacy',
  history: [],
  context: {},
};

/** A model turn with no tool calls — i.e. a final draft reply. */
const draft = (content) => ({
  toolCalls: [],
  content,
  rawMessage: { role: 'assistant', content },
});

const lastUserMessage = () => [...lastMessages].reverse().find((m) => m.role === 'user');

test('an empty draft is corrected and answered, never escalated', async () => {
  scripted = [draft(''), draft('We close at 6pm today.')];
  const r = await respond({ ...BASE, text: 'what time do you close?' });

  assert.equal(r.action, 'reply', `expected a reply, got ${r.action}: ${r.reason || ''}`);
  assert.match(r.text, /6pm/);
  assert.match(lastUserMessage().content, /rejected/i, 'the second attempt must carry the correction');
});

test('an unverified price is handed back with the offending figure named', async () => {
  scripted = [draft('That will be ₦9,999.'), draft('Let me confirm the exact price for you.')];
  const r = await respond({ ...BASE, text: 'how much is it?' });

  assert.equal(r.action, 'reply', `expected a reply, got ${r.action}`);
  assert.match(
    lastUserMessage().content,
    /9,?999/,
    'a correction the model cannot act on is no better than a handoff',
  );
});

test('a draft that stays unverifiable STILL reaches a person', async () => {
  // The guard must survive the retries. Three bad drafts: initial + 2 retries.
  scripted = [draft('That will be ₦9,999.'), draft('It is ₦9,999.'), draft('₦9,999 exactly.')];
  const r = await respond({ ...BASE, text: 'how much is it?' });

  assert.equal(r.action, 'handoff', 'a persistent invented price must not be sent to a customer');
  assert.equal(r.category, 'unverified_reply');
});

test('a persistently empty model is a technical fault, not a pharmacist one', async () => {
  // Category matters: assistant_error is in worker.js's TRANSIENT_CATEGORIES,
  // so the queue retries it with backoff instead of muting the conversation
  // behind a pharmacist who has nothing to act on.
  scripted = [draft(''), draft(''), draft('')];
  const r = await respond({ ...BASE, text: 'hello' });

  assert.equal(r.action, 'handoff');
  assert.equal(r.category, 'assistant_error', 'an empty model reply is not a clinical escalation');
});

test('a good first draft is sent immediately, with no extra model calls', async () => {
  // The correction path must not cost a round trip when nothing is wrong.
  scripted = [draft('We are open until 6pm.')];
  const r = await respond({ ...BASE, text: 'are you open?' });

  assert.equal(r.action, 'reply');
  assert.equal(scripted.length, 0, 'exactly one model call for a clean draft');
});
