/**
 * The prop type system for website blocks.
 *
 * THIS FILE IS THE SECURITY BOUNDARY, and it works by omission.
 *
 * There is no `html` type. There is no `richtext` type. There is no way to
 * declare a prop that accepts markup, so there is no route by which an owner
 * can put HTML or JavaScript into a published page — not because a sanitiser
 * removed it, but because nothing in the contract can carry it in the first
 * place. Adding such a type would undo the whole design of the renderer, and
 * that is the change to argue about, loudly, rather than a helper to add
 * quietly.
 *
 * Every validator is PURE: value in, {ok, value} or {ok, error} out. No IO, no
 * database, no clock. That is what lets the whole contract be tested on a
 * laptop with nothing configured, which matters in a repository where 403
 * tests skip without a database.
 *
 * Validators NORMALISE as well as check. A phone number comes back as digits,
 * a text value comes back trimmed. Storing the normalised form means the
 * renderer never has to re-clean anything, and two spellings of the same
 * number cannot become two different stored values.
 */

// ---------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------

/**
 * Anything that looks like a tag. Deliberately narrow: `<` followed by a
 * letter or a closing slash.
 *
 * WHY REJECT AT ALL, GIVEN EVERYTHING IS ESCAPED AT RENDER
 * Escaping is the actual guarantee and it is tested separately. This check is
 * a second, earlier line: it tells an owner who pasted markup out of a Word
 * document that their text will not do what they expect, instead of silently
 * publishing a literal `<b>Open late</b>` on their homepage. A clear error
 * beats a confusing page.
 *
 * WHY NOT REJECT EVERY `<`
 * "Pain relief <500 naira" is ordinary pharmacy copy and must go through. So
 * the pattern requires a letter or slash after the bracket, which no numeric
 * comparison produces. "a<b" is a false positive; it is rare enough in this
 * domain to be worth the far more common case working.
 */
const TAG_LIKE = /<\s*\/?\s*[a-z]/i;

/** Protocol handlers that execute rather than navigate. Never allowed. */
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file|blob)\s*:/i;

function validateText(value, spec, path) {
  if (typeof value !== 'string') {
    return { ok: false, error: `${path} must be a string` };
  }
  const trimmed = value.trim();
  const max = spec.max ?? 300;
  if (trimmed.length > max) {
    return { ok: false, error: `${path} must be ${max} characters or fewer` };
  }
  if (spec.min && trimmed.length < spec.min) {
    return { ok: false, error: `${path} must be at least ${spec.min} characters` };
  }
  if (TAG_LIKE.test(trimmed)) {
    return {
      ok: false,
      error: `${path} looks like HTML. Website text is published as plain text — remove the tags.`,
    };
  }
  if (DANGEROUS_SCHEME.test(trimmed)) {
    return { ok: false, error: `${path} may not contain a script or data URL` };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------

/**
 * Schemes a published pharmacy page has any business linking to.
 *
 * An allowlist, not a denylist. A denylist of dangerous schemes is a list
 * somebody has to keep current against every browser; this is a list of the
 * four things a brochure site actually needs, and everything else — including
 * schemes that do not exist yet — is refused without anyone updating it.
 */
const ALLOWED_SCHEMES = Object.freeze(['http:', 'https:', 'tel:', 'mailto:']);

function validateUrl(value, spec, path) {
  if (typeof value !== 'string') return { ok: false, error: `${path} must be a string` };
  const raw = value.trim();
  if (raw.length === 0) return { ok: false, error: `${path} must not be empty` };
  if (raw.length > 2000) return { ok: false, error: `${path} is too long to be a URL` };

  // Checked BEFORE parsing. `new URL('javascript:alert(1)')` parses happily —
  // it is a perfectly valid URL, and that is exactly the problem.
  if (DANGEROUS_SCHEME.test(raw)) {
    return { ok: false, error: `${path} uses a scheme that is not allowed` };
  }

  // Protocol-relative. Parses as nothing on its own and inherits whatever
  // scheme the page is served over, which is a way to smuggle a destination
  // past a naive scheme check.
  if (raw.startsWith('//')) {
    return { ok: false, error: `${path} must start with https://` };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `${path} is not a valid URL` };
  }

  const allowed = spec.schemes ?? ALLOWED_SCHEMES;
  if (!allowed.includes(parsed.protocol)) {
    return {
      ok: false,
      error: `${path} must use one of: ${allowed.map((s) => s.replace(':', '')).join(', ')}`,
    };
  }
  return { ok: true, value: parsed.toString() };
}

// ---------------------------------------------------------------------
// Phone / WhatsApp
// ---------------------------------------------------------------------

/**
 * A published phone number, stored the way pharmacies.public_whatsapp_number
 * already stores one: digits only, international, NO leading plus.
 *
 * That column's comment fixes this format, and matching it means the
 * inherited value and an explicitly overridden one are the same shape — so
 * the renderer builds a wa.me link the same way regardless of which it got.
 *
 * Accepts the forms a person actually types (+234…, 0803…, spaces, dashes,
 * parentheses) and normalises. Rejecting "+234 803 123 4567" for having
 * spaces would be a validator that is technically right and useless.
 */
function validatePhone(value, spec, path) {
  if (typeof value !== 'string') return { ok: false, error: `${path} must be a string` };

  const digits = value.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) {
    return { ok: false, error: `${path} must contain only digits, spaces, +, - and ()` };
  }
  // E.164 allows at most 15 digits; 7 is shorter than any real international
  // number. Both ends refuse a value that would build a broken wa.me link.
  if (digits.length < 7 || digits.length > 15) {
    return { ok: false, error: `${path} must be between 7 and 15 digits` };
  }
  return { ok: true, value: digits };
}

// ---------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------

/**
 * An email address, checked just enough to be a usable mailto: target.
 *
 * DELIBERATELY NOT RFC 5322. A full implementation of that grammar is famous
 * for rejecting addresses real people have, and the cost of being slightly
 * permissive here is a mailto link that bounces — annoying, and entirely the
 * owner's own address to fix. The cost of being strict is refusing a pharmacy
 * their real email, which they cannot fix at all.
 *
 * The tag and scheme checks still apply: an address is text on a public page
 * before it is a link.
 */
function validateEmail(value, spec, path) {
  if (typeof value !== 'string') return { ok: false, error: `${path} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length > 254) return { ok: false, error: `${path} is too long to be an email address` };
  if (TAG_LIKE.test(trimmed) || DANGEROUS_SCHEME.test(trimmed)) {
    return { ok: false, error: `${path} is not a valid email address` };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { ok: false, error: `${path} is not a valid email address` };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

function validateEnum(value, spec, path) {
  if (!spec.values.includes(value)) {
    return { ok: false, error: `${path} must be one of: ${spec.values.join(', ')}` };
  }
  return { ok: true, value };
}

function validateBoolean(value, spec, path) {
  if (typeof value !== 'boolean') return { ok: false, error: `${path} must be true or false` };
  return { ok: true, value };
}

function validateInteger(value, spec, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: `${path} must be a whole number` };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { ok: false, error: `${path} must be at least ${spec.min}` };
  }
  if (spec.max !== undefined && value > spec.max) {
    return { ok: false, error: `${path} must be at most ${spec.max}` };
  }
  return { ok: true, value };
}

/**
 * A reference to a row in pharmacy_assets — never a URL.
 *
 * The block stores an id; the renderer resolves it to a storage path for the
 * pharmacy that owns it. That indirection is what stops a block prop from
 * pointing at an arbitrary external image, and it means an asset id belonging
 * to another tenant resolves to nothing rather than to their file.
 */
function validateAsset(value, spec, path) {
  if (typeof value !== 'string') return { ok: false, error: `${path} must be an asset id` };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return { ok: false, error: `${path} must be an asset id` };
  }
  return { ok: true, value: value.toLowerCase() };
}

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------

/**
 * A bounded list of structured items — services, reviews, nav links.
 *
 * `of` is a prop schema in its own right, so an item's fields are validated
 * by exactly the same code as a block's props, including the unknown-key
 * rejection. One rule, applied at every depth.
 *
 * ALWAYS BOUNDED. An unbounded list is an unbounded page and an unbounded
 * jsonb column; `max` is required on every list in the registry and asserted
 * by the registry's own integrity test.
 */
function validateList(value, spec, path, validateShape) {
  if (!Array.isArray(value)) return { ok: false, error: `${path} must be a list` };
  if (value.length > spec.max) {
    return { ok: false, error: `${path} cannot have more than ${spec.max} items` };
  }

  const out = [];
  for (const [i, item] of value.entries()) {
    const result = validateShape(spec.of, item, `${path}[${i}]`);
    if (!result.ok) return result;
    out.push(result.value);
  }
  return { ok: true, value: out };
}

const VALIDATORS = Object.freeze({
  text: validateText,
  url: validateUrl,
  phone: validatePhone,
  email: validateEmail,
  enum: validateEnum,
  boolean: validateBoolean,
  integer: validateInteger,
  asset: validateAsset,
  list: validateList,
});

/**
 * Validate one object against a schema of {name: spec}.
 *
 * UNKNOWN KEYS ARE REJECTED, not dropped. Dropping is friendlier in the
 * moment and worse afterwards: a client that misspells `heading` as `header`
 * would save successfully, publish a page with a missing title, and get no
 * indication anywhere that it had done so. The error names the key.
 *
 * A prop that declares `from` is inherently optional — absent means "inherit
 * from the pharmacy profile at render time", which is the mechanism that
 * keeps a website from disagreeing with the profile it was built from.
 */
function validateShape(schema, input, path) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: `${path} must be an object` };
  }

  const known = new Set(Object.keys(schema));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      return { ok: false, error: `${path}.${key} is not a known property` };
    }
  }

  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = input[name];

    if (value === undefined || value === null) {
      if (spec.required && !spec.from) {
        return { ok: false, error: `${path}.${name} is required` };
      }
      continue;
    }

    const validator = VALIDATORS[spec.type];
    if (!validator) {
      // A registry bug, not a caller bug — worth failing loudly in tests.
      return { ok: false, error: `${path}.${name} has unknown prop type ${spec.type}` };
    }

    const result = spec.type === 'list'
      ? validator(value, spec, `${path}.${name}`, validateShape)
      : validator(value, spec, `${path}.${name}`);

    if (!result.ok) return result;
    out[name] = result.value;
  }

  return { ok: true, value: out };
}

module.exports = {
  validateShape,
  VALIDATORS,
  ALLOWED_SCHEMES,
  TAG_LIKE,
  DANGEROUS_SCHEME,
  // exported individually for focused tests
  validateText,
  validateUrl,
  validatePhone,
  validateEmail,
  validateAsset,
};
