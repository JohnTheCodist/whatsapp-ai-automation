/**
 * The LLM provider, behind an adapter.
 *
 * The provider name appears here and nowhere above this file. Everything else
 * talks in messages and tool calls, so swapping vendors is one file — which
 * matters because this one is being pointed at DeepSeek today and the
 * economics of that will change.
 *
 * The wire format is OpenAI-compatible chat completions, which DeepSeek,
 * OpenAI, Together and most others speak. That is the reason to target it,
 * not any allegiance to a vendor.
 *
 * UNAVAILABLE IS A NORMAL STATE, NOT AN OUTAGE.
 * No key, a timeout, a 500 — all resolve to "the assistant cannot answer",
 * which routes the conversation to a human. A pharmacy whose assistant is
 * quietly down still has staff; a pharmacy whose assistant guesses does not
 * have a safe product.
 */

const { env } = require('../../config/env');

class LlmUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LlmUnavailable';
    this.cause = cause;
  }
}

function isConfigured() {
  return Boolean(env.llm.apiKey);
}

/**
 * One completion.
 *
 * @param {object} args
 * @param {object[]} args.messages
 * @param {object[]} [args.tools]
 * @param {number}  [args.maxTokens]
 * @param {number}  [args.temperature]  low by default: this is a lookup
 *   assistant, and creativity here means invention
 * @returns {Promise<{content: string, toolCalls: object[], finishReason: string, usage: object}>}
 */
async function chat({ messages, tools, maxTokens = 500, temperature = 0.2 }) {
  if (!isConfigured()) {
    throw new LlmUnavailable('No LLM API key is configured.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.llm.timeoutMs);

  let response;
  try {
    response = await fetch(env.llm.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: env.llm.model,
        messages,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // An abort is a timeout; anything else is the network. Both mean the same
    // thing to the caller, but the message should say which so a slow
    // provider is not mistaken for a broken one.
    throw new LlmUnavailable(
      err.name === 'AbortError'
        ? `LLM did not respond within ${env.llm.timeoutMs}ms.`
        : `Could not reach the LLM: ${err.message}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmUnavailable(`LLM returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = await response.json().catch((err) => {
    throw new LlmUnavailable(`LLM returned unparseable JSON: ${err.message}`);
  });

  const choice = json.choices?.[0];
  if (!choice) {
    throw new LlmUnavailable('LLM response contained no choices.');
  }

  return {
    content: choice.message?.content || '',
    // Normalised to an array so callers never branch on undefined.
    toolCalls: choice.message?.tool_calls || [],
    finishReason: choice.finish_reason || 'stop',
    usage: json.usage || {},
    // Passed through verbatim: the protocol requires echoing the assistant
    // message back with its tool_calls intact, and reconstructing it loses
    // provider-specific fields.
    rawMessage: choice.message,
  };
}

module.exports = { chat, isConfigured, LlmUnavailable };
