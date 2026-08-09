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

const { getSql, assertPharmacyId } = require('./db');

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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;
    try {
      return await db.begin(async (tx) => {
        const [pharmacy] = await tx`
          insert into pharmacies (name, slug, status)
          values (${checked.value}, ${slug}, 'onboarding')
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
    select id, name, slug, status, created_at, updated_at
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
// Profile — the facts the assistant is allowed to state
// ---------------------------------------------------------------------

async function getProfile(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const [row] = await db`
    select pharmacy_id, address_line, city, state, landmark, phone,
           opening_hours, delivers, delivery_note, extra_info, updated_at
      from pharmacy_profile
     where pharmacy_id = ${pharmacyId}
  `;
  return row || null;
}

const TEXT_FIELDS = Object.freeze({
  address_line: 200,
  city: 80,
  state: 80,
  landmark: 200,
  phone: 40,
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

  // updated_at is set in SQL rather than in the patch object: sql(obj)
  // interpolates values, and now() is a function call, not a value.
  const [row] = await db`
    update pharmacy_profile
       set ${db(patch)}, updated_at = now()
     where pharmacy_id = ${pharmacyId}
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

module.exports = {
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
