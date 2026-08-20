/**
 * Turn what a patient typed into a structured value — WITHOUT ever throwing
 * the original words away.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * Normalisation is a best-effort reading of a sentence, and it can be wrong.
 * "Since Monday" means something different on a Tuesday than on a Sunday;
 * "a couple of days" is not a number. So every function here returns BOTH
 * the parsed value and a status, and the caller stores the raw text
 * alongside it (encounter_answers.raw_response). When the parse fails the
 * answer is recorded as `unparsable` WITH the original text, never dropped
 * and never guessed at — spec §8: preserve ambiguity rather than inventing
 * certainty.
 *
 * NO CLINICAL JUDGEMENT LIVES HERE. This module knows how to read "3 days"
 * and "yes". It does not know what a fever is, what counts as severe, or
 * what any of it means. That is deliberate and must stay true.
 *
 * Pure. No database, no clock of its own — `now` is passed in so a duration
 * that depends on today's date is testable on any day.
 */

const YES = /^(y|yes|yeah|yep|yh|correct|true|sure|ok|okay|of course|na so|e be like say|abi)\b/i;
const NO = /^(n|no|nope|nah|not at all|false|never|no o|e no be so)\b/i;
const UNKNOWN = /^(i don'?t know|dont know|idk|not sure|unsure|no idea|can'?t say|maybe|i no know)\b/i;
const DECLINED = /^(prefer not|rather not|skip|pass|no comment|i no wan talk|private)\b/i;

/** Result shape shared by every parser below. */
function result(status, { value = null, number = null, unit = null } = {}) {
  return { status, value, number, unit };
}

/**
 * Checked BEFORE any type-specific parsing. "I don't know" is a real,
 * clinically meaningful answer to "how long have you had this" — it is not a
 * failed number parse, and recording it as one would lose the distinction
 * between "unanswered" and "answered: unknown".
 */
function detectNonAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return result('unparsable');
  if (UNKNOWN.test(t)) return result('unknown');
  if (DECLINED.test(t)) return result('declined');
  return null;
}

function parseBoolean(text) {
  const t = String(text || '').trim();
  if (YES.test(t)) return result('answered', { value: 'true', number: 1 });
  if (NO.test(t)) return result('answered', { value: 'false', number: 0 });
  return result('unparsable');
}

function parseNumber(text) {
  const t = String(text || '').trim();
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return result('unparsable');
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return result('unparsable');
  return result('answered', { value: String(n), number: n });
}

/**
 * A 1-10 self-reported gauge.
 *
 * WHY A GAUGE AND NOT A THERMOMETER READING
 * Asking a customer for degrees Celsius assumes a thermometer most people
 * messaging a pharmacy do not have. What comes back is an estimate, and an
 * estimate stored in a `temperature` field with a `measured` source is worse
 * than no reading: it looks like data. A 1-10 gauge is honest about being
 * subjective, and a pharmacist reading "7/10, self-reported" knows exactly
 * how much weight to give it.
 *
 * Accepts "7", "7/10", "about 7". Rejects out-of-range rather than clamping —
 * silently turning 15 into 10 would be the kind of quiet "fix" spec §8
 * forbids.
 */
function parseScale(text, { min = 1, max = 10 } = {}) {
  const t = String(text || '').trim();
  const slash = t.match(/(\d+)\s*\/\s*(\d+)/);
  const raw = slash ? Number(slash[1]) : (t.match(/\d+(?:\.\d+)?/) || [])[0];
  if (raw === undefined) return result('unparsable');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return result('unparsable');
  return result('answered', { value: String(n), number: n, unit: `scale_${min}_${max}` });
}

const DURATION_UNITS = [
  { re: /\b(hour|hr|hrs|hours)\b/i, days: 1 / 24 },
  { re: /\b(day|days)\b/i, days: 1 },
  { re: /\b(week|weeks|wk|wks)\b/i, days: 7 },
  { re: /\b(month|months)\b/i, days: 30 },
];
// Checked in THIS ORDER, and the order is load-bearing: "a couple of days"
// contains the word "a", so if the articles were tried first every "a
// couple" would silently become 1 instead of 2. Articles are the weakest
// possible quantity signal and are therefore the last resort.
const QUANTITY_WORDS = [
  ['couple', 2], ['few', 3],
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['an', 1], ['a', 1],
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * "3 days", "since Monday", "a couple of weeks" -> days.
 *
 * `now` is injected so "since Monday" resolves against a known date rather
 * than whatever day the test happens to run. Returns days as a number; the
 * raw sentence is kept by the caller regardless of what this returns.
 */
function parseDuration(text, { now = new Date() } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return result('unparsable');

  // "since <weekday>" — count back to the most recent occurrence.
  const since = t.match(/\bsince\s+(\w+)/);
  if (since) {
    const idx = WEEKDAYS.indexOf(since[1]);
    if (idx >= 0) {
      const today = now.getDay();
      // Same weekday means a full week ago, not zero days — "since Monday"
      // said on a Monday means seven days, not today.
      let days = today - idx;
      if (days <= 0) days += 7;
      return result('answered', { value: `${days}`, number: days, unit: 'days' });
    }
    if (/yesterday/.test(since[1])) return result('answered', { value: '1', number: 1, unit: 'days' });
    if (/today/.test(since[1])) return result('answered', { value: '0', number: 0, unit: 'days' });
  }

  if (/\byesterday\b/.test(t)) return result('answered', { value: '1', number: 1, unit: 'days' });
  if (/\btoday\b|\bthis morning\b|\bjust now\b/.test(t)) {
    return result('answered', { value: '0', number: 0, unit: 'days' });
  }

  const numMatch = t.match(/\d+(?:\.\d+)?/);
  let qty = numMatch ? Number(numMatch[0]) : null;
  if (qty === null) {
    const hit = QUANTITY_WORDS.find(([w]) => new RegExp(`\\b${w}\\b`).test(t));
    if (hit) [, qty] = hit;
  }
  if (qty === null || !Number.isFinite(qty)) return result('unparsable');

  const unit = DURATION_UNITS.find((u) => u.re.test(t));
  if (!unit) return result('unparsable');

  const days = Math.round(qty * unit.days * 100) / 100;
  return result('answered', { value: String(days), number: days, unit: 'days' });
}

/**
 * Filler that carries no choice-distinguishing meaning.
 *
 * People answer "Is this for you, or for someone else?" with "Me", not "For
 * me". Stripping these from BOTH sides before comparing is what lets the
 * short, natural answer match the longer presented label.
 *
 * Deliberately tiny and non-clinical: only articles, copulas and the
 * question's own carrier words. Nothing here can turn one clinical choice
 * into a different one — "someone else" and "me" remain distinct after
 * stripping, which is the property that matters.
 */
const CHOICE_FILLER = /\b(it'?s|its|is|for|the|a|an|i|am|my|to|of|this|that|yes|please)\b/g;

function stripFiller(s) {
  return String(s).trim().toLowerCase()
    .replace(CHOICE_FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChoice(text, choices = [], { multi = false } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return result('unparsable');
  const norm = (s) => String(s).trim().toLowerCase();

  const tCore = stripFiller(t);

  const matched = choices.filter((c) => {
    const label = norm(c.label ?? c);
    const value = norm(c.value ?? c);
    // Exact, on the raw text.
    if (t === label || t === value) return true;
    // The label appears inside a longer answer ("it's for someone else").
    if (new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) return true;

    // Author-declared synonyms, checked LITERALLY (raw, unstripped) before
    // any filler-stripping. Some of the words CHOICE_FILLER strips — "yes"
    // above all — are themselves the entire answer for SOME questions
    // ("do you have a reading, or does it just feel hot" answered "yes")
    // even though they carry no distinguishing signal for others ("is this
    // for you" answered "yes it's for me"). Stripping "yes" globally before
    // checking aliases meant tCore came back empty and this exact case
    // failed the `!tCore` guard below — an alias that could never match.
    const rawAliases = Array.isArray(c.aliases) ? c.aliases.map(norm) : [];
    if (rawAliases.includes(t)) return true;

    // THE CASE THAT WAS MISSING: the answer is SHORTER than the label.
    // "Me" against "For me" failed every check above, so the question was
    // re-asked verbatim — three times, which tripped the repeat-detection
    // circuit breaker in conductPolicy and silenced the whole pharmacy.
    // Comparing the filler-stripped cores makes "Me" == "For me".
    const labelCore = stripFiller(label);
    const valueCore = stripFiller(value.replace(/_/g, ' '));
    if (!tCore) return false;
    if (tCore === labelCore || tCore === valueCore) return true;
    // The same synonyms again, now filler-stripped, for phrasing that
    // varies around a declared alias ("my child" said as "for my child").
    const strippedAliases = rawAliases.map(stripFiller).filter(Boolean);
    return strippedAliases.includes(tCore);
  });

  // A numbered pick ("2") against a presented list.
  if (matched.length === 0) {
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      const c = choices[n - 1];
      const v = String(c.value ?? c);
      return result('answered', { value: v });
    }
    return result('unparsable');
  }

  if (!multi && matched.length > 1) {
    // Two answers to a single-choice question is ambiguity, not a value to
    // pick from. Preserve it as unparsable so a human sees the raw text.
    return result('unparsable');
  }

  const values = matched.map((c) => String(c.value ?? c));
  return result('answered', { value: multi ? values.join(',') : values[0] });
}

function parseDate(text) {
  const t = String(text || '').trim();
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return result('unparsable');
  return result('answered', { value: d.toISOString().slice(0, 10) });
}

/**
 * The single entry point. Dispatches on the question's declared answer_type.
 *
 * @returns {{status:'answered'|'unknown'|'declined'|'unparsable', value, number, unit}}
 */
function normaliseAnswer(answerType, rawText, { choices = [], now = new Date(), validation = {} } = {}) {
  const nonAnswer = detectNonAnswer(rawText);
  if (nonAnswer) return nonAnswer;

  switch (answerType) {
    case 'boolean': return parseBoolean(rawText);
    case 'number': return parseNumber(rawText);
    case 'scale': return parseScale(rawText, { min: validation.min ?? 1, max: validation.max ?? 10 });
    case 'duration': return parseDuration(rawText, { now });
    case 'date': return parseDate(rawText);
    case 'single_choice': return parseChoice(rawText, choices, { multi: false });
    case 'multi_choice': return parseChoice(rawText, choices, { multi: true });
    case 'text': {
      const t = String(rawText || '').trim();
      return t ? result('answered', { value: t.slice(0, 1000) }) : result('unparsable');
    }
    default:
      return result('unparsable');
  }
}

/**
 * Range/length rules declared on the question. Applied AFTER parsing, and
 * returns a reason rather than throwing so the caller can record the answer
 * as unparsable with its original text intact.
 */
function validateParsed(parsed, validation = {}) {
  if (parsed.status !== 'answered') return { ok: true };
  if (parsed.number !== null) {
    if (validation.min !== undefined && parsed.number < validation.min) {
      return { ok: false, reason: `below_min_${validation.min}` };
    }
    if (validation.max !== undefined && parsed.number > validation.max) {
      return { ok: false, reason: `above_max_${validation.max}` };
    }
  }
  if (validation.maxLength && String(parsed.value || '').length > validation.maxLength) {
    return { ok: false, reason: `above_max_length_${validation.maxLength}` };
  }
  return { ok: true };
}

module.exports = {
  normaliseAnswer, validateParsed, detectNonAnswer,
  parseBoolean, parseNumber, parseScale, parseDuration, parseChoice, parseDate,
};
