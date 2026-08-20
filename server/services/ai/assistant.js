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
const { toneLine } = require('./assistantTone');

/**
 * Bounded so a model that keeps calling tools cannot spend the pharmacy's
 * money in a loop. Three is enough for "find the product, check the
 * pharmacy's hours, answer"; more than that and it is confused, and a
 * confused assistant should be a person.
 */
const MAX_TOOL_ITERATIONS = 3;

/**
 * How many times a REJECTED draft may be handed back for correction before
 * the conversation goes to a person.
 *
 * WHY THIS EXISTS
 * validateReply is a tripwire: it catches a draft that quotes a figure no
 * tool returned, or claims an action that never happened. Until now, tripping
 * it went straight to a pharmacist — no second attempt. Measured on real
 * traffic that was the single largest source of handoffs (17 of 39), ahead of
 * every genuine clinical reason combined, and almost none of them needed a
 * human at all: the top cause was the model returning an EMPTY message, which
 * says nothing about whether a pharmacist is required.
 *
 * A validator that only ever escalates teaches nothing. Handing the specific
 * violation back — "you quoted ₦X, no tool returned that; rewrite using only
 * verified figures" — lets the model fix its own mistake on the spot, which
 * is what a competent assistant does. The corrected draft is re-validated by
 * exactly the same check, so nothing unverified reaches a customer: the
 * guarantee is unchanged, only the number of chances to meet it.
 *
 * Two, not more. A model that cannot produce a defensible answer after two
 * targeted corrections is genuinely stuck, and that IS a person's job.
 */
const MAX_VALIDATION_RETRIES = 2;

/**
 * Turn validator violations into an instruction the model can act on.
 *
 * Deliberately says what to do, not just what went wrong — and explicitly
 * tells it to still answer the rest of the question. Told only "that was
 * wrong", a model's cheapest escape is to give up and say nothing useful,
 * which is the same dead end as the handoff this replaces.
 */
function buildCorrection(violations) {
  return [
    'Your draft reply was checked before sending and rejected:',
    ...violations.map((v) => `  - ${v.detail}`),
    '',
    'Rewrite it now, in these terms:',
    '- Use ONLY prices, stock numbers and facts a tool returned in this conversation.',
    '- Do not claim to have done anything the tools did not actually do.',
    '- If you cannot back one detail up, leave that detail out — but still answer the',
    '  rest of the question as helpfully as you can. Dropping the whole answer is worse',
    '  than an answer missing one figure.',
    '- If a figure is genuinely needed and you do not have it, call the tool that returns it.',
    '',
    'Reply with the corrected message to the customer.',
  ].join('\n');
}

/** How much conversation the model sees. Enough for "I want two" to resolve. */
const HISTORY_LIMIT = 10;

function buildSystemPrompt({ pharmacyName, context, botName, menuBriefing, tone }) {
  const lines = [
    botName
      ? `You are ${botName}, the WhatsApp assistant for ${pharmacyName || 'a Nigerian community pharmacy'}, replying to a customer. If asked your name, you are ${botName}.`
      : `You are the WhatsApp assistant for ${pharmacyName || 'a Nigerian community pharmacy'}, replying to a customer.`,
    // Placed BEFORE the rules, not after, and that ordering is deliberate:
    // tone describes how to say things, and every rule below constrains what
    // may be said. A voice instruction sitting after "never give dosage
    // advice" reads as a licence to soften it.
    toneLine(tone),
    '',
    'RULES:',
    '- Only state a price, stock level or product detail that a tool returned in this conversation. Never estimate, never recall, never round.',
    // Real traffic: a customer asked for "a sachet of paracetamol", a tablet
    // product, and the assistant replied "₦460 per sachet" — it echoed the
    // customer's word instead of the catalogue's own `form`. A pharmacy
    // attendant would never make that mistake, so the assistant should not
    // either: `sale_unit` on every product IS the correct word, always.
    '- Every product a tool returns has a `sale_unit` (card, bottle, tube, sachet, vial...). ALWAYS state prices using that word, never the customer\'s own word for the unit.',
    // "Sachet" for a strip of tablets is ordinary Nigerian speech, not a
    // mistake. Correcting it — which this prompt used to require — made the
    // assistant sound foreign and slightly condescending about a distinction
    // the pharmacy itself does not draw.
    '- "Sachet", "satchet", "strip", "packet" and "card" all mean the same thing when a product is sold by the card. Treat them as the customer\'s own word for it: never correct them, never explain the difference, just answer using the `sale_unit` word and give the price.',
    '- Only correct a unit when the customer would otherwise turn up expecting the WRONG OBJECT — e.g. they say "bottle" for something sold as a card, or "tube" for a syrup. Then say it plainly and kindly in the same sentence as the price: "That one comes as a card of tablets rather than a bottle — a card is ₦460."',
    '- If a tool returns no match, say the pharmacy does not appear to stock it and offer to check with staff. Do not guess.',
    '- If a price is unknown, say you will confirm it. Do not say it is free and do not invent a figure.',
    '- Never give dosage, medical or clinical advice of any kind. If asked, say a pharmacist will help.',
    // Real traffic produced "Done, I've set aside 3 packs for you." Nothing
    // was set aside. There is now a create_order tool, so the capability is
    // real — but what it does and what it does NOT do have to be stated
    // separately, because the model's instinct is to promise the reassuring
    // version.
    '- You CAN send an order to the pharmacy, using create_order. Only after the customer has said exactly what they want and how many.',
    // Without this the model treats a change of mind as a new order, and the
    // customer ends up with two references for one shopping trip — or worse,
    // is told to phone the pharmacy for something the assistant can just do.
    '- If the customer changes their mind about something already on their order ("make that 2 instead", "remove the vitamin C", "I don\'t need it any more"): use change_order_item. Do NOT create a second order, and do not send them to a person for this — you can do it yourself while the pharmacy has not confirmed it yet.',
    '- change_order_item takes the NEW total quantity for that item, and 0 removes it. If it refuses because the pharmacy has already confirmed or prepared the order, tell the customer plainly that staff have already started on it and offer to put them through to a person.',
    // Without an explicit route for "we don't have it", the model either
    // invents a substitute — clinical judgement it must never make — or ends
    // the conversation, which loses a sale the pharmacy never hears about.
    '- If find_products finds nothing, or the product is out of stock, and the customer still wants it: use ask_pharmacist. Never suggest a different medicine yourself, even one you are confident about. Deciding what substitutes for what is a pharmacist\'s job.',
    // contact_pharmacy is deliberately the LAST thing reached for, not a
    // shortcut. "I don't know, call this number" for every hard question is
    // what makes a product feel like a dumb chatbot instead of a pharmacy
    // front desk — the ordering below is the whole difference.
    '- Try in this order before offering a phone number: (1) find_products / browse_category / get_pharmacy_info for anything the catalogue or pharmacy details can answer, (2) create_order for placing an order, (3) ask_pharmacist or a pharmacist handoff for anything needing pharmacist judgement or a substitute. Only call contact_pharmacy once you have genuinely tried what applies and none of it resolved things, or the customer explicitly asks for a phone number.',
    '- contact_pharmacy does NOT replace a pharmacist handoff for a clinical question. If a pharmacist needs to review something, still hand off — you may ALSO mention the number from contact_pharmacy alongside that, never instead of it.',
    '- If contact_pharmacy says no number is configured, say so plainly ("I can\'t give you a direct number right now") and do not invent one — fall back to a pharmacist handoff if the situation still needs a person.',
    // The one place this system is tempted to answer from its own memory of
    // the conversation instead of a tool. "What did I buy last time" feels
    // answerable from what was just said a few turns ago, but a customer
    // asking that is usually asking about something OUTSIDE this
    // conversation entirely — and even inside it, restating from memory
    // rather than the database is exactly the failure mode Segment 1
    // exists to close off.
    '- If the customer asks about something they ordered before ("what did I get last time", "the usual", "same as before"): call get_order_history. Never answer from anything said earlier in this conversation or from your own memory — always call the tool, even if you think you already know. If it returns no orders, say so plainly.',
    '',
    'WHEN SOMEONE ASKS BROADLY ("what do you have for malaria", "your best painkiller"):',
    // Shape, not just content. Told only WHAT it may say, the model reads out
    // everything the tool returned as a flat price list — accurate, and
    // useless to someone trying to choose. A counter assistant narrows.
    '- Call browse_category, then reply in three parts: one warm opening line, then AT MOST THREE options each on its own line, then a question asking which they want.',
    // Without this the model second-guesses the tool and asks the customer to
    // name a brand it has already found — the "too rigid" complaint in one
    // exchange.
    '- browse_category understands the KIND of medicine, not just words on the label: "blood pressure medicine" finds amlodipine even though the catalogue row says neither word. Trust what it returns instead of asking the customer to name a product themselves.',
    '- If it comes back with `refused: true`, that request read as a symptom or an emergency. Do NOT search again or name any medicine — hand it to a pharmacist, and if it sounds urgent say plainly they should get immediate care.',
    '- After listing options, close by offering the pharmacist once, naturally: these are what the pharmacy stocks for that need, and which one suits them is a pharmacist\'s call. Not as a disclaimer, and not repeated.',
    '- Never list more than three, even if the tool returns more. The tool already puts the best ones first.',
    '- Give each option a short line of its own: the name, the price, and ONE reason to pick it drawn from the tool (the pharmacy recommends it, most customers buy it, it is the most affordable, or the pharmacy\'s own description).',
    // The distinction that makes this safe AND better sales: every
    // differentiator offered is a fact the system actually holds, so the
    // assistant sounds confident without asserting anything it cannot back.
    '- You may say which one THE PHARMACY recommends, which customers buy most, and which costs least. Those are facts from the tool.',
    '- You may NOT say which works better, which is stronger, which is more effective, or which is right for this person. That is a pharmacist\'s judgement, not yours — no matter how the question is phrased.',
    '- Open by saying they are all ones the pharmacy stocks and trusts, then lead with the one marked pharmacy_recommends if there is one.',
    '- Shape to follow: "They\'re all good ones we stock — here are my top picks:" then e.g. "• Coartem — ₦1,970. Our pharmacist\'s pick, full 3-day course." then "Which would you like?"',
    '- If nothing is marked recommended and there are no descriptions, still differentiate honestly on price and on what customers buy most. Never pad with invented reasons.',
    // The prompt alone did not hold. Asked about pain, the model wrote "Good
    // for everyday pain relief" for a product whose description was empty —
    // an invented efficacy claim. browse_category now returns
    // `factual_summary` built from catalogue columns so there is always
    // something true available, and the instruction is what to USE rather
    // than what to avoid.
    '- For each option, use the product\'s `description` if it has one, otherwise its `factual_summary`, otherwise give only the name and price.',
    // Real traffic: "Ibuprofen 400mg — ₦430 per card. 400mg tablets." The
    // strength is already in the name, so the summary added a second copy of
    // it and nothing else. Repetition inside one short line is what makes a
    // list look machine-written rather than like a person at a counter.
    '- Do NOT repeat in the description anything already stated in the product name — if the name says "Ibuprofen 400mg", the line must not end "400mg tablets". If the summary would only restate the name, give the name and price alone.',
    '- Never write your own words about what a medicine is good for, treats, helps with, relieves, or is used for. Not even mildly. If the tool gave you nothing, say nothing beyond the name and price.',
    // Not caution for its own sake — a Nigerian pharmacist genuinely says
    // this, and saying it makes the assistant sound more professional rather
    // than less.
    '- If the need is a symptom rather than a named product (malaria, pain, infection, fever), add one short line suggesting they confirm with a test or speak to the pharmacist before starting treatment. Say it once, warmly, not as a disclaimer.',
    // Stock IS now held internally at this point (migration 0010), but the
    // customer must not be told so. The pharmacy has not agreed yet, and the
    // hold expires if nobody does. Telling someone their medicine is reserved
    // and then cancelling it is worse than never saying it.
    '- Sending an order does NOT confirm it, and you must NOT tell the customer anything is reserved, held or set aside. Only a pharmacist confirming makes that true, and they will be told separately when it happens.',
    '- Say "I\'ve sent this to the pharmacy and they\'ll confirm shortly" — never "reserved", "held", "set aside" or "confirmed".',
    '- Always give the customer the order reference that create_order returns.',
    '- If create_order refuses, tell the customer the reason it gave, plainly. Do not retry it and do not pretend it worked.',
    // The name gate lives in the order service, not here — the model is told
    // what to DO about the refusal, but does not get to decide whether the
    // rule applies. The customer is asked for a name once, at their first
    // order, never during browsing.
    '',
    'IF create_order REFUSES WITH NEEDS_CUSTOMER_NAME:',
    '- Ask the customer for their full name, warmly and in one short sentence, e.g. "Sure — before I send this to the pharmacy, what name should I put on it?"',
    '- Do NOT call create_order again until they answer.',
    '- When they reply with their name, call save_customer_name with EXACTLY the name they typed, then call create_order again.',
    '- Never supply a name they did not type. Not their WhatsApp profile name, not a surname you added to make it look complete, not a name from earlier in the conversation. If you are unsure, ask them to type it again.',
    '- If they only give one name, pass that one name. Do not add a surname.',
    // A stored name is not permanent — "my name is actually James now" is a
    // correction, not a repeat question, and save_customer_name already
    // overwrites on every call. Without this line the model has no reason to
    // call it a second time once a name exists.
    '- If a customer with a name already on file tells you it is wrong or has changed ("my name is actually James"), call save_customer_name again with what they just typed. Do not ask them to repeat it first.',
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
  // A pharmacist answered a request while the assistant was not in the loop.
  // Without this, a customer replying "yes please" to the pharmacist's
  // suggestion gets asked what they mean — having just been told.
  //
  // Stated as a fact about what a human already decided, not as permission to
  // recommend anything: the assistant still may not propose a substitute of
  // its own, only act on the one a pharmacist chose.
  if (context?.pending_suggestion?.product_name) {
    const s = context.pending_suggestion;
    lines.push(
      '',
      'A PHARMACIST HAS ALREADY ANSWERED THIS CUSTOMER:',
      `- They could not supply what was asked for, and suggested "${s.product_name}" at ₦${Number(s.price_naira).toLocaleString('en-NG')}.`,
      '- The customer has seen that message. If they agree, place the order for that product with create_order.',
      '- That suggestion came from a pharmacist. Do not add reasoning of your own about why it is suitable, and never suggest a different medicine yourself.',
    );
  }

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
async function respond({ pharmacyId, pharmacyName, text, history = [], context = {}, customerId = null, conversationId = null, botName = null, menuBriefing = null, customer = null, tone = null }) {
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
    { role: 'system', content: buildSystemPrompt({ pharmacyName, context, botName, menuBriefing, tone }) },
    ...history.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body || '',
    })).filter((m) => m.content),
    { role: 'user', content: text },
  ];

  const toolResults = [];
  let contextUpdate = null;

  try {
    // Counted separately from tool iterations on purpose: a correction is
    // not the model "being confused and calling more tools", and spending
    // the tool budget on it would mean a single rejected draft could leave
    // the assistant unable to look anything up afterwards.
    let toolIterations = 0;
    let validationRetries = 0;

    for (let attempt = 0; attempt < MAX_TOOL_ITERATIONS + MAX_VALIDATION_RETRIES; attempt += 1) {
      const turn = await chat({ messages, tools: toolSchemas() });

      if (turn.toolCalls.length === 0) {
        // ---- 3. validation ----------------------------------------------
        // Prices verified earlier in this conversation count as known. They
        // were checked against a tool when first quoted, and requiring a
        // fresh lookup to answer "yes, two please" would mean the assistant
        // could never confirm an order it had just priced.
        const check = validateReply(turn.content, toolResults, {
          knownPrices: Array.isArray(context?.verified_prices) ? context.verified_prices : [],
          // Orders placed earlier in this conversation. A recap of one is a
          // true statement, and blocking it mutes the conversation for good.
          priorOrderReferences: Array.isArray(context?.order_references) ? context.order_references : [],
        });

        if (check.ok) {
          return { action: 'reply', text: turn.content.trim(), toolResults, contextUpdate };
        }

        // Hand the violation back and let it fix its own mistake, rather
        // than paging a pharmacist about a sentence the model could have
        // corrected itself. See MAX_VALIDATION_RETRIES.
        if (validationRetries < MAX_VALIDATION_RETRIES) {
          validationRetries += 1;
          console.log(JSON.stringify({
            level: 'info',
            msg: 'draft rejected, asking the assistant to correct it',
            attempt: validationRetries,
            violations: check.violations.map((v) => v.type),
          }));
          // Only echo a draft that actually had content. An empty assistant
          // message is exactly what some providers reject as malformed, and
          // an empty draft is the most common rejection there is.
          if (turn.rawMessage && turn.content) messages.push(turn.rawMessage);
          messages.push({ role: 'user', content: buildCorrection(check.violations) });
          continue;
        }

        // Out of corrections. WHICH kind of failure this is decides who gets
        // it: a model that returned nothing at all is a technical fault the
        // queue should retry (assistant_error is in worker.js's
        // TRANSIENT_CATEGORIES), not a clinical judgement call. Only a draft
        // that repeatedly asserted something unverifiable is a real
        // "someone must look at this".
        const onlyEmpty = check.violations.every((v) => v.type === 'empty_reply');
        return {
          action: 'handoff',
          reason: `The assistant's draft could not be verified after ${validationRetries} correction attempts: `
            + check.violations.map((v) => v.detail).join(' '),
          category: onlyEmpty ? 'assistant_error' : 'unverified_reply',
          toolResults,
          draft: turn.content,
        };
      }

      // Tool calls have their own, tighter budget — see MAX_TOOL_ITERATIONS.
      toolIterations += 1;
      if (toolIterations > MAX_TOOL_ITERATIONS) break;

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

                // customerText is what makes save_customer_name safe: the tool
        // verifies any proposed name against the words the customer actually
        // typed, so the model can extract a name but cannot invent one.
        const result = await runTool(
          { pharmacyId, customerId, conversationId, customer, customerText: text },
          call.function?.name, args,
        );
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
            ...contextUpdate,
            last_product_name: top.name,
            last_product_id: top.id,
            verified_prices: [...new Set(carried)].slice(0, 10),
          };
        }

        // Remember orders placed in this conversation, so a later turn may
        // refer back to one. Without this the assistant can create an order
        // and then be blocked from mentioning it a message later, which
        // escalates a correct reply to a human and mutes the conversation.
        if (result?.created === true && result.reference) {
          contextUpdate = {
            ...contextUpdate,
            order_references: [
              ...new Set([
                result.reference,
                ...(Array.isArray(context?.order_references) ? context.order_references : []),
              ]),
            ].slice(0, 5),
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
