/**
 * The Website tab's calls into the API.
 *
 * NO AUTH CODE HERE, deliberately. installAuthFetch() in auth.js patches the
 * global fetch before React mounts, so every `/api/...` request already
 * carries the bearer token. A helper that added an Authorization header
 * itself would be a second place for that logic to drift.
 *
 * Every function returns parsed JSON or throws an Error carrying the server's
 * own message. The server writes those messages for people — "theme.palette
 * must be one of: teal, green, …" — so passing them straight through gives a
 * better error than anything this file could invent.
 */

async function call(path, options = {}) {
  const res = await fetch(`/api/website${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  if (res.status === 204) return null;

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // A non-JSON body from an API route means something upstream failed —
    // a proxy, a crash, the SPA fallback. Say that rather than "unexpected
    // token < in JSON", which sends people looking in the wrong place.
    if (!res.ok) throw new Error(`The server returned ${res.status}.`);
    return null;
  }

  if (!res.ok) {
    const error = new Error(payload?.error || `The server returned ${res.status}.`);
    error.code = payload?.code;
    error.status = res.status;
    throw error;
  }
  return payload;
}

/**
 * Is the builder switched on for this deployment?
 *
 * The flag lives on the server (WEBSITE_BUILDER_ENABLED) and, when off, the
 * routes are not mounted at all — so a 404 here is the feature being absent
 * rather than an error. That is why this returns a boolean instead of
 * throwing: the dashboard hides the tab and nothing is reported to the user,
 * which is the correct behaviour for a feature they were never offered.
 */
export async function isWebsiteBuilderEnabled() {
  try {
    await call('');
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    // Any other failure — a 500, a network drop — is a real problem, and
    // hiding the tab would disguise it as a missing feature. Show the tab and
    // let the panel report what went wrong.
    return true;
  }
}

export const getWebsite = () => call('');
export const listTemplates = () => call('/templates');
export const getBlockContract = () => call('/blocks');

/**
 * Render an unsaved arrangement for the editor canvas.
 *
 * The one call that sends site_data to be rendered rather than stored. What
 * comes back goes into the canvas and nowhere else — publishing still renders
 * from the server's own stored copy, so this cannot put anything in front of
 * a customer. The server validates the input against the block contract
 * regardless, so the editor cannot preview something it could not save.
 */
export const renderBlocks = (siteData) =>
  call('/render-blocks', { method: 'POST', body: JSON.stringify({ site_data: siteData }) });

export const createWebsite = (templateId) =>
  call('', { method: 'POST', body: JSON.stringify({ template_id: templateId }) });

export const saveSiteData = (siteData) =>
  call('/site', { method: 'PUT', body: JSON.stringify({ site_data: siteData }) });

/**
 * The health articles this pharmacy may publish.
 *
 * Approved-and-reviewed only — the server decides, not the browser. A toggle
 * for an article that would then refuse to render would look like a bug to
 * the owner rather than like the safety rule it is.
 */
export const getHealthArticles = () => call('/health-articles');

/**
 * Save the guided flow's stored answers.
 *
 * REPLACES content wholesale, which is why callers pass the whole object.
 * Sending only the changed key would silently discard every other answer —
 * and the theme is a separate field, so it is not disturbed either way.
 */
export const saveContent = (content) =>
  call('/content', { method: 'PATCH', body: JSON.stringify({ content }) });
export const saveTheme = (theme) =>
  call('/content', { method: 'PATCH', body: JSON.stringify({ theme }) });

/**
 * The pharmacy's own record, which the guided flow edits directly.
 *
 * NOT under /api/website, and that is the point. Opening hours, the address
 * and the services list belong to the pharmacy, not to its website — the
 * website inherits them at render time. Writing them here means changing them
 * in Settings and changing them in the guided flow are the same act, reaching
 * the same row, and the two can never disagree.
 */
export async function getProfile() {
  const res = await fetch('/api/pharmacies/me/profile');
  if (!res.ok) throw new Error('Could not load your pharmacy details.');
  return (await res.json()).profile;
}

export async function saveProfile(fields) {
  const res = await fetch('/api/pharmacies/me/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || 'Could not save your pharmacy details.');
  return payload.profile;
}

export async function getPharmacy() {
  const res = await fetch('/api/pharmacies/me');
  if (!res.ok) throw new Error('Could not load your pharmacy.');
  return (await res.json()).pharmacy;
}

/**
 * The published WhatsApp number.
 *
 * Lives on `pharmacies`, not on the profile, and is written through the
 * assistant settings endpoint — because it is the number on the printed QR
 * code as well as the one on the website. Migration 0038 is explicit that it
 * is set deliberately and is NOT the number the live socket happens to be
 * paired as. The website builder publishes it; it does not own it.
 */
export async function savePublicWhatsappNumber(number) {
  const res = await fetch('/api/pharmacies/me/assistant', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_whatsapp_number: number }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || 'Could not save your WhatsApp number.');
  return payload;
}

/** Cache-busted so the iframe re-fetches after every save. */
export const previewUrl = (nonce) => `/api/website/preview.html?v=${nonce}`;

// ---------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------

/**
 * Upload an image.
 *
 * NO Content-Type HEADER, deliberately. `fetch` sets multipart/form-data with
 * the boundary token itself when the body is a FormData; setting it by hand
 * omits the boundary and the server parses nothing. That is a a well-known
 * hour to lose, so it is written down rather than rediscovered.
 *
 * The server ignores whatever type the browser attaches to the file and
 * identifies it from its bytes, so nothing here needs to be trusted.
 */
export async function uploadAsset(file, kind) {
  const body = new FormData();
  body.append('file', file);
  body.append('kind', kind);

  const res = await fetch('/api/website/assets', { method: 'POST', body });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(payload?.error || 'Could not upload that image.');
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export const listAssets = (kind) =>
  call(`/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);

export const deleteAsset = (id) =>
  call(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Where an uploaded image is actually served from. */
export const assetSrc = (baseUrl, storagePath) =>
  (baseUrl && storagePath ? `${baseUrl}/${storagePath}` : null);

// ---------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------

export const setWebAddress = (address) =>
  call('/address', { method: 'PUT', body: JSON.stringify({ address }) });

/**
 * Publish. NO BODY, and that is deliberate on this side too.
 *
 * The server renders the page from stored structured data. If this function
 * ever grows a payload, the guarantee that a browser cannot put markup on a
 * public pharmacy website goes with it.
 */
export const publish = () => call('/publish', { method: 'POST' });

export const unpublish = () => call('/unpublish', { method: 'POST' });

export const listRevisions = () => call('/revisions');

/** What the website did — views and taps, by day. */
export const getAnalytics = (days = 30) => call(`/analytics?days=${days}`);

export const restoreRevision = (id) =>
  call(`/revisions/${encodeURIComponent(id)}/restore`, { method: 'POST' });

/**
 * The address a customer would type.
 *
 * TWO SHAPES, AND THE BROWSER CANNOT TELL WHICH ONE IS LIVE.
 *
 *   <address>.rxnaija.com    once wildcard DNS and a certificate exist
 *   app.rxnaija.com/p/<address>   always
 *
 * The dashboard is served from app.rxnaija.com in both cases, so deriving this
 * from window.location silently yields the path form even when subdomains are
 * configured. That is not a cosmetic error: this string is what a pharmacy
 * prints on a flyer and puts in a shop window. Only the server knows, because
 * only the server reads PUBLIC_SITE_DOMAIN — so it tells us.
 *
 * Falling back to the origin is correct rather than merely safe: with no
 * wildcard DNS, the path form IS the real address.
 */
export function publicUrl(address, publicDomain = null) {
  if (!address) return null;
  if (publicDomain) return `https://${address}.${publicDomain}`;
  return `${window.location.origin}/p/${address}`;
}
