/**
 * Per-column mapping memory for one pharmacy.
 *
 * columnMapper's saveMapping/loadMapping already remember a mapping, but keyed
 * on a fingerprint of the entire header set — so they only hit when a file's
 * headers match exactly, and one added or renamed column throws away every
 * answer the owner previously gave. This remembers one column at a time, which
 * is what lets a question be asked once and stay answered as the file evolves.
 *
 * Nothing here decides a mapping on its own. Aliases are returned to the
 * caller as overrides for the normalizer, where they sit alongside the rule
 * detector and the LLM rather than replacing them — a header the pharmacy
 * confirmed last month is strong evidence, not a fact about this file.
 */

const { getSql, assertPharmacyId } = require('../db');

/**
 * Same normalization the alias key is stored under. Deliberately gentler than
 * schemaDetector's normalizeHeader: this is an exact-match lookup key, so it
 * only removes differences that are certainly meaningless (case, surrounding
 * space, repeated internal space, trailing punctuation).
 */
function aliasKey(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .replace(/[:.]+$/, '')
    .trim();
}

/**
 * Every alias this pharmacy has recorded, as a Map keyed by aliasKey.
 * One query — callers look up many headers against it.
 */
async function loadAliases(pharmacyId) {
  assertPharmacyId(pharmacyId);
  const db = getSql();
  const rows = await db`
    select normalized_header, category, times_confirmed, times_overridden
    from column_alias where pharmacy_id = ${pharmacyId}
  `;
  const map = new Map();
  for (const r of rows) {
    map.set(r.normalized_header, {
      category: r.category,
      timesConfirmed: r.times_confirmed,
      timesOverridden: r.times_overridden,
    });
  }
  return map;
}

/**
 * Resolve raw headers against this pharmacy's memory.
 *
 * @returns {Record<string, string>} rawHeader -> category, ready to be handed
 *          to the normalizer as userMapping.
 */
async function resolveKnownColumns(pharmacyId, rawHeaders) {
  if (!pharmacyId || !rawHeaders || rawHeaders.length === 0) return {};
  const aliases = await loadAliases(pharmacyId);
  if (aliases.size === 0) return {};

  const out = {};
  for (const header of rawHeaders) {
    const hit = aliases.get(aliasKey(header));
    if (hit) out[header] = hit.category;
  }
  return out;
}

/**
 * Record what a column means.
 *
 * `overridden` distinguishes "the human agreed with the guess" from "the human
 * replaced it". Both are worth remembering; only the second says the detector
 * was wrong, so they are counted separately rather than summed.
 */
async function recordAlias(pharmacyId, rawHeader, category, { overridden = false, source = 'user' } = {}) {
  assertPharmacyId(pharmacyId);
  if (!rawHeader || !category) return;
  const db = getSql();
  const key = aliasKey(rawHeader);
  if (!key) return;

  await db`
    insert into column_alias
      (pharmacy_id, normalized_header, category, times_confirmed, times_overridden, source, last_seen)
    values (
      ${pharmacyId}, ${key}, ${category},
      ${overridden ? 0 : 1}, ${overridden ? 1 : 0}, ${source}, now()
    )
    on conflict (pharmacy_id, normalized_header) do update set
      -- A later answer always wins: the owner is telling us the column means
      -- something different now, and the counts below record how settled that
      -- answer is, not which one to use.
      category = excluded.category,
      times_confirmed = case
        when column_alias.category = excluded.category
          then column_alias.times_confirmed + excluded.times_confirmed
        else excluded.times_confirmed
      end,
      times_overridden = case
        when column_alias.category = excluded.category
          then column_alias.times_overridden + excluded.times_overridden
        else excluded.times_overridden
      end,
      source = excluded.source,
      last_seen = now()
  `;
}

/**
 * Record a whole confirmed mapping at once.
 * @param {Record<string, string>} mapping rawHeader -> category
 * @param {Record<string, boolean>} [overrides] rawHeader -> was it a correction
 */
async function recordMapping(pharmacyId, mapping, overrides = {}, source = 'web') {
  for (const [rawHeader, category] of Object.entries(mapping || {})) {
    if (!category) continue;
    await recordAlias(pharmacyId, rawHeader, category, {
      overridden: overrides[rawHeader] === true,
      source,
    });
  }
}

module.exports = { aliasKey, loadAliases, resolveKnownColumns, recordAlias, recordMapping };
