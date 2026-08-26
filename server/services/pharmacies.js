/**
 * Pharmacy (tenant) service.
 *
 * Every function that reads or writes tenant data takes pharmacyId as its
 * first argument and calls assertPharmacyId before touching the database.
 * The only exception is createPharmacy, which takes a userId because the
 * tenant does not exist yet — that is the one legitimate case, and it is
 * worth noticing that it is the only one.
 *
 * Validation helpers are exported as pure functions so they can be tested
 * without a database. Opening hours in particular get validated rather
 * than trusted: they are read back to customers by the assistant, and
 * "we're open 25:00–08:00" is a sentence this product must never send.
 */

const { getSql, assertPharmacyId, isRetryableConnectionError } = require('./db');
const { generateTradeCode } = require('./whatsapp/tradeCode');
const { isValidTone, DEFAULT_TONE } = require('./ai/assistantTone');
const { normalizeMsisdn } = require('./whatsapp/senderIdentity');

const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_PHARMACIES_PER_USER = 5;

// ---------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------

/**
 * URL-safe slug from a pharmacy name.
 *
 * Falls back to 'pharmacy' when a name reduces to nothing (all emoji, all
 * punctuation, non-Latin script). A slug is a convenience, not an
 * identifier — uniqueness is the caller's problem, handled by retry in
 * createPharmacy. Never let slug generation be the thing that rejects a
 * legitimate business name.
 */
function slugify(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base || 'pharmacy';
}

/** Short random suffix for slug collision retry. Not security-sensitive. */
function slugSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Validate and normalise a pharmacy name.
 * @returns {{ok:true, value:string} | {ok:false, error:string}}
 */
function normalizeName(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Pharmacy name is required' };
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length < 2) return { ok: false, error: 'Pharmacy name must be at least 2 characters' };
  if (value.length > 120) return { ok: false, error: 'Pharmacy name must be 120 characters or fewer' };
  return { ok: true, value };
}

/**
 * Validate opening hours.
 *
 * Shape: [{ day:'mon', open:'08:00', close:'20:00', closed:false }, ...]
 *
 * Rules, each of which exists because breaking it would make the
 * assistant say something false:
 *   - day must be one of the seven known keys, no duplicates
 *   - times are 24h HH:MM
 *   - a day marked closed needs no times, and any it has are dropped
 *   - close must be after open; overnight spans are NOT supported, and
 *     are rejected rather than silently wrapped. A pharmacy open past
 *     midnight is a real case — when it turns up, model it explicitly
 *     rather than letting an ambiguous row through now.
 *
 * @returns {{ok:true, value:Array} | {ok:false, error:string}}
 */
function normalizeOpeningHours(input) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'opening_hours must be an array' };
  if (input.length > 7) return { ok: false, error: 'opening_hours cannot have more than 7 entries' };

  const seen = new Set();
  const value = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Each opening_hours entry must be an object' };
    }
    const day = String(raw.day || '').toLowerCase().slice(0, 3);
    if (!DAYS.includes(day)) {
      return { ok: false, error: `Unknown day "${raw.day}". Use one of: ${DAYS.join(', ')}` };
    }
    if (seen.has(day)) return { ok: false, error: `Duplicate entry for ${day}` };
    seen.add(day);

    if (raw.closed === true) {
      value.push({ day, closed: true });
      continue;
    }

    const open = String(raw.open || '');
    const close = String(raw.close || '');
    if (!TIME_RE.test(open)) return { ok: false, error: `Invalid open time for ${day}: expected HH:MM` };
    if (!TIME_RE.test(close)) return { ok: false, error: `Invalid close time for ${day}: expected HH:MM` };
    if (close <= open) {
      return {
        ok: false,
        error: `Closing time must be after opening time for ${day}. Overnight hours are not supported yet.`,
      };
    }

    value.push({ day, open, close, closed: false });
  }

  // Stable, predictable order regardless of how the client sent them.
  value.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  return { ok: true, value };
}

// ---------------------------------------------------------------------
// Tenant lifecycle
// ---------------------------------------------------------------------

function isUniqueViolation(err, constraintHint) {
  if (!err || err.code !== '23505') return false;
  if (!constraintHint) return true;
  const text = `${err.constraint_name || ''} ${err.detail || ''} ${err.message || ''}`;
  return text.includes(constraintHint);
}

/**
 * Create a tenant and make the caller its owner.
 *
 * One transaction, three rows: the pharmacy, the owner membership, and an
 * empty profile. A pharmacy without a membership row is unreachable by
 * anyone — its creator included — so these must not be able to land
 * separately.
 *
 * The profile row is created eagerly so every later read can assume it
 * exists, turning "no profile yet" from a case every caller handles into
 * a case that cannot occur.
 */
async function createPharmacy(userId, { name }) {
  if (!userId || typeof userId !== 'string') {
    throw Object.assign(new Error('userId is required'), { status: 400 });
  }

  const checked = normalizeName(name);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { status: 400, code: 'INVALID_NAME' });

  const db = getSql();

  const [{ count }] = await db`
    select count(*)::int as count from pharmacy_members where user_id = ${userId}
  `;
  if (count >= MAX_PHARMACIES_PER_USER) {
    throw Object.assign(
      new Error(`A user can belong to at most ${MAX_PHARMACIES_PER_USER} pharmacies`),
      { status: 409, code: 'TOO_MANY_PHARMACIES' }
    );
  }

  const base = slugify(checked.value);

  // Slug collision is expected — two "City Pharmacy" tenants is normal.
  // Retry the whole transaction rather than pre-checking, because a
  // pre-check races with any concurrent signup.
  //
  // A connection fault (the pool handed this attempt an already-dead pooled
  // socket — see readWithRetry's doc comment in db.js) also retries here,
  // bounded to one extra try, not the full 5. This is safe in the case that
  // actually happens: the fault interrupts the transaction before COMMIT, so
  // Postgres has already rolled it back and nothing was written. It is
  // NOT provably safe in the rarer case where Postgres committed but the
  // acknowledgment itself was lost in the same socket death — that retry
  // would insert a second pharmacy. Accepted deliberately: the alternative
  // (no retry) is "onboarding cannot complete on a flaky pooler" every time,
  // which is worse, and MAX_PHARMACIES_PER_USER plus this being a visible,
  // ownable row bounds the damage if the rare case is ever hit.
  let connectionRetryUsed = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;
    try {
      return await db.begin(async (tx) => {
        // reply_mode SET EXPLICITLY, not left to the column default.
        //
        // The default is 'allowlist' (migration 0003), which with an empty
        // allowlist means the assistant answers NOBODY. A pharmacy signing up
        // is asking for an assistant that talks to their customers, so being
        // born mute is the opposite of what they requested — and it is
        // invisible: the dashboard says Connected, the self-test passes,
        // /api/health is green, and the only evidence is a "reply suppressed
        // — allowlist_empty" line in a log reachable over SSH.
        //
        // That cost a live pharmacy most of a day. The default column value is
        // deliberately left alone, because 'allowlist' is the right thing for a
        // row created by a migration or a script, where nobody has asked for
        // anything. It is wrong for a person who just signed up, and THIS is
        // the place that knows the difference.
        //
        // Changeable afterwards in Settings → Assistant.
        const [pharmacy] = await tx`
          insert into pharmacies (name, slug, status, reply_mode)
          values (${checked.value}, ${slug}, 'onboarding', 'all')
          returning id, name, slug, status, created_at
        `;
        await tx`
          insert into pharmacy_members (pharmacy_id, user_id, role)
          values (${pharmacy.id}, ${userId}, 'owner')
        `;
        await tx`
          insert into pharmacy_profile (pharmacy_id) values (${pharmacy.id})
        `;
        return { ...pharmacy, role: 'owner' };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'slug')) continue;
      if (isRetryableConnectionError(err) && !connectionRetryUsed) {
        connectionRetryUsed = true;
        attempt -= 1; // does not consume a slug attempt
        continue;
      }
      throw err;
    }
  }

  throw Object.assign(
    new Error('Could not allocate a unique slug for that name'),
    { status: 409, code: 'SLUG_EXHAUSTED' }
  );
}

async function getPharmacy(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select id, name, slug, status, bot_name, welcome_note, menu_enabled,
           notify_phone, notify_on_new_order, public_whatsapp_number, wholesale_code,
           -- The UI cannot show a setting it is never sent. Its absence here is
           -- why "the assistant is answering nobody" was invisible in a
           -- dashboard that otherwise reported itself healthy.
           reply_mode,
           reservation_hold_minutes, created_at, updated_at
    from pharmacies where id = ${pharmacyId}
  `;
  return row || null;
}

async function updatePharmacy(pharmacyId, fields = {}) {
  assertPharmacyId(pharmacyId);

  const checked = normalizeName(fields.name);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { status: 400, code: 'INVALID_NAME' });

  const db = getSql();
  const [row] = await db`
    update pharmacies
       set name = ${checked.value}, updated_at = now()
     where id = ${pharmacyId}
    returning id, name, slug, status, created_at, updated_at
  `;
  return row || null;
}

// ---------------------------------------------------------------------
// Assistant identity — what the bot calls itself, and how it greets
// ---------------------------------------------------------------------
//
// Deliberately separate from updatePharmacy. The pharmacy's registered name
// is a tenant fact with its own validation (normalizeName, slug retry); bot
// identity is presentation the owner can change freely, including clearing
// it back to "use the pharmacy name" — which normalizeName's 2-char minimum
// would wrongly reject if this reused that path.

const MAX_BOT_NAME = 40;
const MAX_WELCOME_NOTE = 300;

/**
 * @param {object} fields
 * @param {string|null} [fields.botName]      null/'' clears it — falls back
 *   to the pharmacy's own name, never to a vendor name.
 * @param {string|null} [fields.welcomeNote]
 * @param {boolean}     [fields.menuEnabled]
 */
async function updateAssistantSettings(pharmacyId, fields = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const botName = 'botName' in fields
    ? normaliseShortText(fields.botName, MAX_BOT_NAME, 'Bot name')
    : undefined;
  const welcomeNote = 'welcomeNote' in fields
    ? normaliseShortText(fields.welcomeNote, MAX_WELCOME_NOTE, 'Welcome note')
    : undefined;

  // Where new-order alerts go. Stored as typed rather than normalised here,
  // because the owner should see back exactly what they entered;
  // normalizeMsisdn is applied at send time in staffAlert.js.
  const notifyPhone = 'notifyPhone' in fields
    ? normaliseShortText(fields.notifyPhone, 32, 'Alert number')
    : undefined;

  // The number printed on the customer QR code.
  //
  // Normalised to bare digits on the way IN, unlike notifyPhone above — and
  // the difference is deliberate. An alert number is only ever read by a
  // person and re-normalised at send time, so showing it back exactly as
  // typed is the friendlier behaviour. This one is pasted straight into a
  // wa.me URL that gets printed, where a space or a leading + produces a link
  // that fails silently after the flyers exist.
  // Rejected rather than silently defaulted: an owner who sent a tone we do
  // not have chose SOMETHING, and quietly storing 'warm' instead would show
  // them a setting they did not pick.
  const assistantTone = 'assistantTone' in fields
    ? (isValidTone(fields.assistantTone) ? fields.assistantTone : null)
    : undefined;
  if (assistantTone === null) {
    const err = new Error('Unknown assistant tone');
    err.status = 400; err.code = 'INVALID_TONE';
    throw err;
  }

  const publicWhatsappNumber = 'publicWhatsappNumber' in fields
    ? normalisePublicNumber(fields.publicWhatsappNumber)
    : undefined;

  // Who the assistant is allowed to answer.
  //
  // Until now this existed only as a column — settable by a migration or a
  // hand-written UPDATE, and by nothing a pharmacy could reach. A pharmacy
  // whose assistant was answering nobody had no way to see that, let alone
  // change it, and the state is invisible everywhere else: Connected in the
  // dashboard, self-test passing, health green.
  //
  // Validated against the same three values the column's CHECK allows, so a
  // typo is a 400 here rather than a constraint violation surfacing as a 500.
  const REPLY_MODES = new Set(['off', 'allowlist', 'all']);
  let replyMode;
  if ('replyMode' in fields) {
    replyMode = String(fields.replyMode);
    if (!REPLY_MODES.has(replyMode)) {
      const err = new Error(`Unknown reply mode "${replyMode}".`);
      err.status = 400; err.code = 'INVALID_REPLY_MODE';
      throw err;
    }
  }

  const current = await db`
    select bot_name, assistant_tone, welcome_note, menu_enabled, notify_phone, notify_lid, notify_on_new_order,
           public_whatsapp_number, reply_mode
    from pharmacies where id = ${pharmacyId}
  `;
  if (!current.length) return null;

  // worker.js caches the LID that proved out as this alert number, so a
  // staff reply is still recognised on a message carrying no phone number —
  // see notify_lid's migration comment. That cache is only valid for the
  // number it was learned against: swap the alert number to someone else's
  // phone and the OLD LID must not go on quietly answering as staff.
  const notifyPhoneChanged = notifyPhone !== undefined && notifyPhone !== current[0].notify_phone;

  const [row] = await db`
    update pharmacies set
      bot_name = ${botName !== undefined ? botName : current[0].bot_name},
      assistant_tone = ${assistantTone !== undefined ? assistantTone : current[0].assistant_tone},
      welcome_note = ${welcomeNote !== undefined ? welcomeNote : current[0].welcome_note},
      menu_enabled = ${'menuEnabled' in fields ? Boolean(fields.menuEnabled) : current[0].menu_enabled},
      notify_phone = ${notifyPhone !== undefined ? notifyPhone : current[0].notify_phone},
      notify_lid = ${notifyPhoneChanged ? null : current[0].notify_lid},
      notify_on_new_order = ${'notifyOnNewOrder' in fields ? Boolean(fields.notifyOnNewOrder) : current[0].notify_on_new_order},
      public_whatsapp_number = ${publicWhatsappNumber !== undefined ? publicWhatsappNumber : current[0].public_whatsapp_number},
      reply_mode = ${replyMode !== undefined ? replyMode : current[0].reply_mode},
      updated_at = now()
    where id = ${pharmacyId}
    returning id, name, bot_name, assistant_tone, welcome_note, menu_enabled,
              notify_phone, notify_on_new_order, public_whatsapp_number, wholesale_code,
              reply_mode, updated_at
  `;
  return row;
}

/**
 * Bare digits, international form, no punctuation — the shape wa.me needs.
 *
 * A Nigerian number written the local way (0803…) is the expected input from
 * someone reading it off their own phone, so it is converted rather than
 * rejected: refusing it would send staff away to reformat it by hand, and
 * accepting it verbatim would build a dead link.
 */
function normalisePublicNumber(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const msisdn = digits.startsWith('0') ? `234${digits.slice(1)}` : digits;
  // Loose bound, matching the client. This is a sanity check against a
  // half-typed number, not a validator for every international format.
  if (msisdn.length < 10 || msisdn.length > 15) {
    const err = new Error('That does not look like a full WhatsApp number — include the country code.');
    err.status = 400;
    throw err;
  }
  return msisdn;
}

/** Trims, caps length, and turns empty-ish input into NULL rather than ''. */
function normaliseShortText(input, maxLen, label) {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (value.length > maxLen) {
    throw Object.assign(new Error(`${label} must be ${maxLen} characters or fewer`), { status: 400, code: 'TOO_LONG' });
  }
  return value;
}

// ---------------------------------------------------------------------
// Profile — the facts the assistant is allowed to state
// ---------------------------------------------------------------------

/**
 * A profile is conceptually 1:1 with a pharmacy — it should always "exist"
 * from a caller's point of view, just possibly empty. Callers of this
 * function reach it only through an authenticated route that has already
 * confirmed the pharmacy itself exists (requireAuth + membership), so the
 * one case genuinely worth distinguishing — "does this tenant exist at
 * all" — is already handled upstream. Given that, returning null for a
 * pharmacy that legitimately has no profile YET is the wrong shape: it
 * reads as "not found" for something that plainly is, which is exactly
 * what surfaced live as a 404 on a pharmacy's very first customer-contact
 * save. Self-heals the same way updateProfile does, for the same reason.
 */
async function getProfile(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    insert into pharmacy_profile (pharmacy_id) values (${pharmacyId})
    on conflict (pharmacy_id) do update set pharmacy_id = pharmacy_profile.pharmacy_id
    returning pharmacy_id, address_line, city, state, landmark, phone,
              opening_hours, delivers, delivery_note, extra_info, updated_at
  `;
  return row || null;
}

// `phone` handled separately below — it needs normalisation, not just a
// length cap. Left in this list, "08012345678" and "+2348012345678" would
// store as two different literal strings and the assistant tool that reads
// it back (contact_pharmacy) would have no way to know they are the same
// number.
const TEXT_FIELDS = Object.freeze({
  address_line: 200,
  city: 80,
  state: 80,
  landmark: 200,
  delivery_note: 300,
  extra_info: 2000,
});

/**
 * Partial update. Only keys actually present in `fields` are written, so a
 * client editing one field cannot blank the rest by omission — the most
 * common way a PATCH endpoint quietly destroys data.
 */
async function updateProfile(pharmacyId, fields = {}) {
  assertPharmacyId(pharmacyId);

  const db = getSql();
  const patch = {};

  for (const [key, maxLen] of Object.entries(TEXT_FIELDS)) {
    if (!(key in fields)) continue;
    const raw = fields[key];
    if (raw === null || raw === '') {
      patch[key] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw Object.assign(new Error(`${key} must be a string`), { status: 400, code: 'INVALID_FIELD' });
    }
    const value = raw.trim();
    if (value.length > maxLen) {
      throw Object.assign(
        new Error(`${key} must be ${maxLen} characters or fewer`),
        { status: 400, code: 'INVALID_FIELD' }
      );
    }
    patch[key] = value || null;
  }

  if ('phone' in fields) {
    const raw = fields.phone;
    if (raw === null || raw === '') {
      patch.phone = null;
    } else {
      if (typeof raw !== 'string') {
        throw Object.assign(new Error('phone must be a string'), { status: 400, code: 'INVALID_FIELD' });
      }
      // Same normaliser wa_phone and notify_phone already use — the whole
      // point is "08012345678" and "+2348012345678" collapse to one stored
      // value rather than being treated as two different numbers.
      const normalized = normalizeMsisdn(raw);
      if (!normalized) {
        throw Object.assign(
          new Error('phone does not look like a valid Nigerian phone number'),
          { status: 400, code: 'INVALID_FIELD' }
        );
      }
      patch.phone = normalized;
    }
  }

  if ('delivers' in fields) {
    if (typeof fields.delivers !== 'boolean') {
      throw Object.assign(new Error('delivers must be true or false'), { status: 400, code: 'INVALID_FIELD' });
    }
    patch.delivers = fields.delivers;
  }

  if ('opening_hours' in fields) {
    const hours = normalizeOpeningHours(fields.opening_hours);
    if (!hours.ok) throw Object.assign(new Error(hours.error), { status: 400, code: 'INVALID_HOURS' });
    // jsonb column — must be sent as JSON, not as a Postgres array, which
    // is what the driver would otherwise infer from a JS array.
    patch.opening_hours = db.json(hours.value);
  }

  if (Object.keys(patch).length === 0) return getProfile(pharmacyId);

  // UPSERT, not UPDATE. createPharmacy() inserts an empty profile row
  // alongside every new pharmacy, so in the ordinary case this row always
  // exists — but that is an app-level convention, not something the schema
  // enforces, and it can drift: a pharmacy created before that insert
  // existed, or seeded directly, has no profile row at all. A bare UPDATE
  // against a row that is not there matches zero rows, returns undefined,
  // and the caller sees "Profile not found" on a pharmacy that unmistakably
  // exists — exactly what surfaced live when this pharmacy's first-ever
  // customer-contact save 404'd. ON CONFLICT makes the save work regardless
  // of whether the row happened to be there already.
  //
  // updated_at is set in SQL rather than in the patch object: sql(obj)
  // interpolates values, and now() is a function call, not a value. The
  // column defaults to now() too, so a genuine first INSERT is covered
  // without needing it repeated in insertFields.
  const insertFields = { pharmacy_id: pharmacyId, ...patch };
  const [row] = await db`
    insert into pharmacy_profile ${db(insertFields)}
    on conflict (pharmacy_id) do update set ${db(patch)}, updated_at = now()
    returning pharmacy_id, address_line, city, state, landmark, phone,
              opening_hours, delivers, delivery_note, extra_info, updated_at
  `;
  return row || null;
}

async function listMembers(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  return db`
    select user_id, role, created_at
    from pharmacy_members
    where pharmacy_id = ${pharmacyId}
    order by created_at
  `;
}

/**
 * Issue the trade QR code, or hand back the one already in use.
 *
 * IDEMPOTENT BY DEFAULT, and that is the whole design. This code ends up
 * printed on invoices and delivery notes. Regenerating it on every call would
 * mean a second click silently kills every copy already in customers' hands,
 * and they would land in an ordinary retail chat with nothing to explain why.
 * Rotation therefore has to be asked for.
 *
 * The unique index is what actually guarantees no two pharmacies share a code.
 * The retry loop exists because a collision across a short alphabet is rare
 * rather than impossible, and a 500 on "generate my code" is a poor first
 * impression for a feature this small.
 */
async function ensureTradeCode(pharmacyId, { rotate = false } = {}) {
  assertPharmacyId(pharmacyId);
  const db = getSql();

  const [current] = await db`
    select wholesale_code from pharmacies where id = ${pharmacyId}
  `;
  if (!current) return null;
  if (current.wholesale_code && !rotate) return getPharmacy(pharmacyId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateTradeCode();
    try {
      await db`
        update pharmacies
        set wholesale_code = ${code}, updated_at = now()
        where id = ${pharmacyId}
      `;
      return await getPharmacy(pharmacyId);
    } catch (err) {
      // Only a collision on the unique index is worth retrying. Anything else
      // is a real failure and must not be retried into silence.
      if (!/unique/i.test(err.message)) throw err;
    }
  }
  throw new Error('Could not allocate a unique trade code. Please try again.');
}

module.exports = {
  ensureTradeCode,
  updateAssistantSettings,
  createPharmacy,
  getPharmacy,
  updatePharmacy,
  getProfile,
  updateProfile,
  listMembers,
  // pure, exported for tests
  slugify,
  normalizeName,
  normalizeOpeningHours,
  DAYS,
  MAX_PHARMACIES_PER_USER,
};
