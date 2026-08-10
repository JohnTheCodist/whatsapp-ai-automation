/**
 * The orchestration loop: message in, reply or handoff out.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE
 *
 *   1. Safety filter      deterministic, BEFORE the model sees anything
 *   2. Tool-calling loop  bounded iterations
 *   3. Reply validation   every number must trace to a tool result
 *   4. Send, or hand off
 *
 * Step 1 cannot move after step 2. The whole point is that hostile text never
 * reaches the model's judgement, and a model asked to evaluate the text that
 * would compromise it is being asked a circular question.
 *
 * Step 3 cannot be dropped because steps 1 and 2 "usually work". It is the
 * only layer that catches the model getting it wrong anyway.
 *
 * EVERY FAILURE PATH ENDS IN A HUMAN. No LLM key, a timeout, a malformed
 * tool call, an unverifiable price, too many iterations — all of them hand
 * the conversation to staff. There is no branch here that ends in guessing.
 */

const { screenMessage } = require('../safety/clinicalFilter');
const { chat, isConfigured, LlmUnavailable } = require('./llmClient');
const { toolSchemas, runTool } = require('./catalogueTools');
const { validateReply } = require('./replyValidator');

/**
 * Bounded so a model that keeps calling tools cannot spend the pharmacy's
 * money in a loop. Three is enough for "find the product, check the
 * pharmacy's hours, answer"; more than that and it is confused, and a
 * confused assistant should be a person.
 */
const MAX_TOOL_ITERATIONS = 3;

/** How much conversation the model sees. Enough for "I want two" to resolve. */
const HISTORY_LIMIT = 10;

function buildSystemPrompt({ pharmacyName, context, botName, menuBriefing }) {
  const lines = [
    botName
      ? `You are ${botName}, the WhatsApp assistant for ${pharmacyName || 'a Nigerian community pharmacy'}, replying to a customer. If asked your name, you are ${botName}.`
      : `You are the WhatsApp assistant for ${pharmacyName || 'a Nigerian community pharmacy'}, replying to a customer.`,
    '',
    'RULES:',
    '- Only state a price, stock level or product detail that a tool returned in this conversation. Never estimate, never recall, never round.',
    '- If a tool returns no match, say the pharmacy does not appear to stock it and offer to check with staff. Do not guess.',
    '- If a price is unknown, say you will confirm it. Do not say it is free and do not invent a figure.',
    '- Never give dosage, medical or clinical advice of any kind. If asked, say a pharmacist will help.',
    // Real traffic produced "Done, I've set aside 3 packs for you." Nothing
    // was set aside. There is now a create_order tool, so the capability is
    // real — but what it does and what it does NOT do have to be stated
    // separately, because the model's instinct is to promise the reassuring
    // version.
    '- You CAN send an order to the pharmacy, using create_order. Only after the customer has said exactly what they want and how many.',
    '- Sending an order does NOT reserve, hold or set aside anything, and does not confirm it. Staff decide. Say "I\'ve sent this to the pharmacy and they\'ll confirm shortly" — never "reserved", "held", "set aside" or "confirmed".',
    '- Always give the customer the order reference that create_order returns.',
    '- If create_order refuses, tell the customer the reason it gave, plainly. Do not retry it and do not pretend it worked.',
    '- Keep replies short. This is WhatsApp, not email. One or two sentences unless listing products.',
    '- Write in plain, warm Nigerian English. Do not use emoji.',
    '- Prices are in naira. Write them as ₦1,250.',
    '- Send ONE message. Do not split your answer into several.',
  ];

  // What the customer picked from the menu. Without this the model receives a
  // bare "3", which tells it nothing — it would ask what they meant, having
  // just been told.
  if (menuBriefing) {
    lines.push('', 'THE CUSTOMER JUST CHOSE A MENU OPTION:', `- ${menuBriefing}`);
  }

  // Conversational memory, passed as FACTS rather than as instructions, so a
  // customer cannot smuggle directives into the prompt through it.
  if (context?.last_product_name) {
    lines.push(
      '',
      'CONTEXT FROM EARLIER IN THIS CONVERSATION:',
      `- The product last discussed was "${context.last_product_name}".`,
      '- If the customer says something like "I want two" or "how much is it", they mean that product.',
    );
  }

  return lines.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.pharmacyId
 * @param {string} args.pharmacyName
 * @param {string} args.text              the customer's message
 * @param {object[]} [args.history]       [{direction, body}] oldest first
 * @param {object} [args.context]         conversations.context
 * @param {string} [args.customerId]      bound server-side; create_order needs it
 * @param {string} [args.conversationId]  bound server-side, never model-supplied
 * @returns {Promise<{action:'reply'|'handoff', text?:string, reason?:string,
 *   category?:string, toolResults:object[], contextUpdate?:object}>}
 */
async function respond({ pharmacyId, pharmacyName, text, history = [], context = {}, customerId = null, conversationId = null, botName = null, menuBriefing = null }) {
  // ---- 1. safety, before anything else ----------------------------------
  const screening = screenMessage(text);
  if (!screening.allow) {
    return {
      action: 'handoff',
      reason: screening.reason,
      category: screening.category,
      matched: screening.matched,
      toolResults: [],
    };
  }

  if (!isConfigured()) {
    return {
      action: 'handoff',
      reason: 'The assistant is not configured, so this needs a person.',
      category: 'assistant_unavailable',
      toolResults: [],
    };
  }

  // ---- 2. tool-calling loop ---------------------------------------------
  const messages = [
    { role: 'system', content: buildSystemPrompt({ pharmacyName, context, botName, menuBriefing }) },
    ...history.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body || '',
    })).filter((m) => m.content),
    { role: 'user', content: text },
  ];

  const toolResults = [];
  let contextUpdate = null;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const turn = await chat({ messages, tools: toolSchemas() });

      if (turn.toolCalls.length === 0) {
        // ---- 3. validation ----------------------------------------------
        // Prices verified earlier in this conversation count as known. They
        // were checked against a tool when first quoted, and requiring a
        // fresh lookup to answer "yes, two please" would mean the assistant
        // could never confirm an order it had just priced.
        const check = validateReply(turn.content, toolResults, {
          knownPrices: Array.isArray(context?.verified_prices) ? context.verified_prices : [],
        });
        if (!check.ok) {
          return {
            action: 'handoff',
            reason: `The assistant's draft could not be verified: ${check.violations.map((v) => v.detail).join(' ')}`,
            category: 'unverified_reply',
            toolResults,
            draft: turn.content,
          };
        }
        return { action: 'reply', text: turn.content.trim(), toolResults, contextUpdate };
      }

      // The assistant message must be echoed back with its tool_calls intact
      // or the provider rejects the follow-up as malformed.
      messages.push(turn.rawMessage);

      for (const call of turn.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // Malformed arguments are the model failing, not the customer.
          // Feed the error back rather than crashing; it usually recovers.
          args = {};
        }

        const result = await runTool({ pharmacyId, customerId, conversationId }, call.function?.name, args);
        toolResults.push(result);

        // Remember the top match so "I want two" resolves next turn, and
        // carry forward the prices we verified. Capped, because conversation
        // context is loaded on every message and must not grow without bound
        // — and a price from fifty messages ago is stale anyway.
        const top = result?.products?.[0];
        if (top?.name) {
          const seen = (result.products || [])
            .map((p) => p.price_naira)
            .filter((p) => typeof p === 'number');
          const carried = [
            ...seen,
            ...(Array.isArray(context?.verified_prices) ? context.verified_prices : []),
          ];
          contextUpdate = {
            last_product_name: top.name,
            last_product_id: top.id,
            verified_prices: [...new Set(carried)].slice(0, 10),
          };
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Out of iterations with no answer.
    return {
      action: 'handoff',
      reason: 'The assistant could not settle on an answer.',
      category: 'max_iterations',
      toolResults,
    };
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return {
        action: 'handoff',
        reason: `The assistant is unavailable (${err.message}).`,
        category: 'assistant_unavailable',
        toolResults,
      };
    }
    // Anything unexpected also goes to a person. There is deliberately no
    // rethrow: a crash here would leave the customer with silence.
    return {
      action: 'handoff',
      reason: `The assistant failed unexpectedly (${err.message}).`,
      category: 'assistant_error',
      toolResults,
    };
  }
}

module.exports = { respond, MAX_TOOL_ITERATIONS, buildSystemPrompt };
