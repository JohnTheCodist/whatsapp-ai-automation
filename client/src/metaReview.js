/**
 * Calls behind the Meta App Review Test screen.
 *
 * Plain fetch: window.fetch is already patched to attach the session token
 * (see auth.js), exactly as ConnectWhatsApp relies on. No Meta credential
 * ever exists in the browser — every one of these goes to our own server,
 * which holds the token.
 *
 * Each function resolves to `{ ok: true, ... }` or `{ ok: false, error }`,
 * never throws, so the screen has one shape to render.
 */

async function request(path, { method = 'GET', body } = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`/api/whatsapp/cloud${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (!res.ok || json?.success === false) {
      if (res.status === 403) return { ok: false, error: 'Only the pharmacy owner can use the Meta App Review Test.' };
      return { ok: false, error: json?.error || `The request failed (${res.status}).` };
    }
    return { ok: true, ...json };
  } catch {
    return { ok: false, error: 'Could not reach the RxNaija server. Check your connection and try again.' };
  }
}

export function getStatus(fetchImpl) {
  return request('/status', {}, fetchImpl);
}

export function sendTestMessage({ to, message }, fetchImpl) {
  return request('/test-send', { method: 'POST', body: { to, message } }, fetchImpl);
}

export function listTemplates(fetchImpl) {
  return request('/templates', {}, fetchImpl);
}

export function createTemplate({ name, category, language, body }, fetchImpl) {
  return request('/templates', { method: 'POST', body: { name, category, language, body } }, fetchImpl);
}
