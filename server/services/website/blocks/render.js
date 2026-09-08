/**
 * Rendering primitives shared by every block definition.
 *
 * THE RULE THIS FILE ENFORCES
 * A block renderer emits markup it wrote itself, and every value that came
 * from a pharmacy passes through `esc` or a link builder on the way out. No
 * renderer interpolates a raw prop. There is no sanitiser downstream to catch
 * a miss, by design — so the escaping happens here, in shared helpers, rather
 * than being re-implemented eleven times.
 *
 * WHY VALIDATION IS NOT ENOUGH ON ITS OWN
 * types.js already refuses tag-like text and dangerous URL schemes at save
 * time. That is the first line, and it is where an owner gets a useful error.
 * But data can reach a renderer without passing through today's validator —
 * a row written by an older block version, a migration, a future admin tool —
 * so the render path escapes unconditionally rather than trusting that the
 * save path already checked. Belt and braces, where the braces are the ones
 * that actually hold.
 */

const ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escape text for insertion into HTML, in element content or an attribute.
 *
 * `&` is replaced first by virtue of being in the same pass — a two-pass
 * implementation that replaced `<` before `&` would turn `&lt;` into
 * `&amp;lt;` and display the entity instead of the character.
 *
 * Single quotes are escaped as well as double, so the same function is safe
 * for single-quoted attributes. Non-strings become '' rather than "undefined"
 * or "[object Object]", both of which have been published to real websites by
 * template engines that were more relaxed than this.
 */
function esc(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** An attribute, or nothing at all when the value is empty. */
function attr(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return ` ${name}="${esc(value)}"`;
}

/**
 * Re-check a URL at render time and drop it if it is not safe.
 *
 * Returns '' rather than throwing: a bad link in one block should not fail
 * the whole page render, and an anchor with no href degrades to plain text,
 * which is a bad link rather than a broken site.
 */
const RENDER_SAFE_SCHEME = /^(https?|tel|mailto):/i;

function safeHref(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!RENDER_SAFE_SCHEME.test(trimmed)) return '';
  if (trimmed.startsWith('//')) return '';
  return trimmed;
}

/**
 * Build a wa.me link from structured parts — never from a stored URL.
 *
 * This is the whole reason the contract stores a PHONE NUMBER and a MESSAGE
 * rather than a WhatsApp URL. A stored URL is a string an owner could point
 * anywhere; a number and a message can only ever produce a link to WhatsApp,
 * because this function is the only thing that builds one and it hardcodes
 * the host.
 *
 * The number is stripped to digits again here even though validatePhone
 * already did it, for the reason in this file's header: render-time data has
 * not necessarily been through today's validator.
 */
function whatsappUrl(phone, message) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  const base = `https://wa.me/${digits}`;
  const text = String(message ?? '').trim();
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

function telUrl(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '');
  return digits.length >= 7 ? `tel:${digits}` : '';
}

function mailtoUrl(email) {
  const value = String(email ?? '').trim();
  // Deliberately minimal: enough to reject something that is not an address,
  // not an attempt to implement RFC 5322, which is a well-known way to reject
  // valid addresses that real people have.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '';
  return `mailto:${value}`;
}

/**
 * Outbound links, optionally routed through a counting redirect.
 *
 * WHY A REDIRECT AND NOT A SCRIPT. Published pages carry `script-src 'none'`
 * and contain no JavaScript, which is what makes the whole stored-XSS class
 * unreachable rather than merely defended against. That guarantee is worth
 * more than any metric, so the only way left to count a click is to send it
 * through the server first.
 *
 * ONLY THE CANONICAL LINK IS TRACKED, and this is the rule that keeps the
 * redirect safe. `/p/<address>/go/whatsapp` resolves its destination from the
 * pharmacy's OWN record — nothing in the URL says where to go, so it cannot
 * be turned into an open redirect. The consequence is that a block which
 * overrides the number with something other than the pharmacy's published one
 * must NOT be tracked: the redirect would send that customer to the canonical
 * number instead, which is a wrong destination in exchange for a statistic.
 * Those links stay direct and simply are not counted.
 *
 * The message IS carried in the query string, because a prefilled "Hello, I
 * have a question about my medication" is most of the value of the button.
 * It is the only caller-supplied part, it goes into a query parameter of a
 * hardcoded host, and it is already length-capped and tag-checked by the
 * block contract before it could ever get here.
 */
const MAX_TRACKED_MESSAGE = 160;

function trackedHref(kind, directUrl, ctx, { canonical, message } = {}) {
  if (!directUrl) return '';
  // No tracking base: a preview, or a test. Direct link, nothing counted.
  if (!ctx?.trackingBase) return directUrl;
  if (!canonical) return directUrl;

  const text = String(message ?? '').trim().slice(0, MAX_TRACKED_MESSAGE);
  const query = text ? `?m=${encodeURIComponent(text)}` : '';
  return `${ctx.trackingBase}/go/${kind}${query}`;
}

/** Digits-only comparison, so +234… and 234… count as the same number. */
const sameNumber = (a, b) => {
  const x = String(a ?? '').replace(/\D/g, '');
  const y = String(b ?? '').replace(/\D/g, '');
  return x.length > 0 && x === y;
};

/** A WhatsApp link, counted when it points at the pharmacy's published number. */
function waHref(phone, message, ctx) {
  return trackedHref('whatsapp', whatsappUrl(phone, message), ctx, {
    canonical: sameNumber(phone, ctx?.pharmacy?.public_whatsapp_number),
    message,
  });
}

/** A phone link, counted when it is the pharmacy's own number. */
function telHref(phone, ctx) {
  return trackedHref('phone', telUrl(phone), ctx, {
    canonical: sameNumber(phone, ctx?.profile?.phone),
  });
}

/** A directions link, counted when it is the pharmacy's own maps URL. */
function mapsHref(url, ctx) {
  const direct = safeHref(url);
  return trackedHref('directions', direct, ctx, {
    canonical: Boolean(direct) && direct === safeHref(ctx?.profile?.maps_url),
  });
}

/** An email link. Never bound to the profile today, so never canonical. */
function mailHref(email, ctx) {
  return trackedHref('email', mailtoUrl(email), ctx, { canonical: false });
}

/**
 * Resolve one binding path against the pharmacy's own records.
 *
 * Only two roots exist, and both are read-only here. A path that names
 * anything else returns undefined rather than throwing, so a typo in a block
 * definition renders an empty section instead of a 500 on a public page.
 */
function resolveBinding(path, ctx) {
  if (typeof path !== 'string') return undefined;
  const [root, ...rest] = path.split('.');
  const source = root === 'pharmacy' ? ctx.pharmacy : root === 'profile' ? ctx.profile : null;
  if (!source) return undefined;
  return rest.reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), source);
}

/**
 * Merge stored props with inherited values and defaults.
 *
 * ORDER IS THE PRODUCT DECISION, not an implementation detail:
 *
 *   1. an explicitly stored prop      — a deliberate override by the owner
 *   2. the pharmacy profile, via `from` — the single source of truth
 *   3. the block's default             — generic copy, never pharmacy data
 *
 * Step 2 is what stops a website from claiming different opening hours than
 * the profile the assistant answers from. Templates store nothing for a bound
 * prop, so a template-built site inherits everything and cannot drift. An
 * owner who edits the field is making an intentional override, and the stored
 * value is the evidence that they meant it.
 */
function resolveProps(definition, storedProps, ctx) {
  const resolved = {};
  for (const [name, spec] of Object.entries(definition.props)) {
    const stored = storedProps?.[name];
    if (stored !== undefined && stored !== null) {
      resolved[name] = stored;
      continue;
    }
    if (spec.from) {
      const inherited = resolveBinding(spec.from, ctx);
      if (inherited !== undefined && inherited !== null && inherited !== '') {
        resolved[name] = inherited;
        continue;
      }
    }
    if (definition.defaults && definition.defaults[name] !== undefined) {
      resolved[name] = definition.defaults[name];
    }
  }
  return resolved;
}

/** Resolve an asset id to a public URL, scoped to this pharmacy's assets. */
/**
 * Every photo of one kind, in upload order.
 *
 * Returns url, width and height together because a responsive image needs
 * all three: without width and height the browser cannot reserve space, the
 * page reflows as each photo arrives, and that reflow is measured directly
 * as Cumulative Layout Shift.
 *
 * Tenant-safe for the same reason assetUrl is: ctx.assets holds only this
 * pharmacy's rows, so another tenant's photo cannot appear here.
 */
function assetsOfKind(ctx, kind) {
  if (!ctx?.assets) return [];
  const out = [];
  for (const [id, asset] of ctx.assets) {
    if (asset.kind !== kind) continue;
    const url = assetUrl(id, ctx);
    if (!url) continue;
    out.push({ id, url, width: asset.width || null, height: asset.height || null });
  }
  return out;
}
function assetUrl(assetId, ctx) {
  if (!assetId || !ctx.assets) return '';
  // ctx.assets only ever contains rows already filtered by pharmacy_id, so an
  // id belonging to another tenant simply is not here and resolves to ''.
  const asset = ctx.assets.get(String(assetId).toLowerCase());
  if (!asset) return '';
  return `${ctx.assetBaseUrl || ''}/${asset.storage_path}`.replace(/([^:])\/{2,}/g, '$1/');
}

/** A section wrapper, so every block shares one page rhythm and one hook. */
function section(blockId, inner, opts = {}) {
  const cls = ['rx-block', `rx-${blockId.replace(/[.@]/g, '-')}`, opts.className]
    .filter(Boolean).join(' ');
  const tag = opts.tag || 'section';
  return `<${tag} class="${esc(cls)}"${attr('aria-label', opts.ariaLabel)}>${inner}</${tag}>`;
}

module.exports = {
  assetsOfKind,
  esc,
  waHref,
  telHref,
  mapsHref,
  mailHref,
  trackedHref,
  MAX_TRACKED_MESSAGE,
  attr,
  safeHref,
  whatsappUrl,
  telUrl,
  mailtoUrl,
  resolveBinding,
  resolveProps,
  assetUrl,
  section,
};
