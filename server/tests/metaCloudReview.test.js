/**
 * The Meta App Review harness — validation, the Graph calls it makes, how it
 * reports Meta's failures, and that its routes are owner-only.
 *
 * No test here reaches Meta. fetch is injected, so each test asserts the
 * exact request RxNaija would send and feeds back a recorded-shape response.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const review = require('../services/whatsapp/metaCloudReview');

const TOKEN = 'EAAG-secret-system-user-token-do-not-leak';
const SECRET = 'app-secret-do-not-leak';
const CFG = {
  token: TOKEN, appSecret: '', phoneNumberId: '1111111111', wabaId: '2222222222', graphVersion: 'v26.0',
};

/** A fetch stand-in that records the request and answers with `reply`. */
function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    };
  };
  return { impl, calls };
}

/** A logger that captures everything written, so leaks can be searched for. */
function captureLog() {
  const lines = [];
  return { log: { error: (l) => lines.push(String(l)) }, lines };
}

// ---------------------------------------------------------------- input ---

test('a local Nigerian number is normalised to the international digits Meta expects', () => {
  const v = review.validateSend({ to: '0803 123 4567', message: 'Hello from RxNaija' }, '234');
  assert.deepEqual(v, { ok: true, to: '2348031234567', message: 'Hello from RxNaija' });
  assert.equal(review.validateSend({ to: '+234 803 123 4567', message: 'x' }, '234').to, '2348031234567');
});

test('an invalid phone number is refused before anything is sent', () => {
  for (const to of ['', 'abc', '12345', '0803-CALL-ME', '1234567890123456']) {
    const v = review.validateSend({ to, message: 'hi' }, '234');
    assert.equal(v.ok, false, `accepted ${JSON.stringify(to)}`);
  }
});

test('a missing or over-long message is refused', () => {
  assert.match(review.validateSend({ to: '2348031234567', message: '   ' }).error, /Enter a message/);
  assert.match(review.validateSend({ to: '2348031234567' }).error, /Enter a message/);
  const tooLong = 'x'.repeat(review.MAX_TEXT_LENGTH + 1);
  assert.match(review.validateSend({ to: '2348031234567', message: tooLong }).error, /too long/);
});

// ------------------------------------------------------------- sending ---

test('a valid send calls the Graph messages endpoint with the documented body', async () => {
  const { impl, calls } = fakeFetch({
    status: 200,
    body: { messaging_product: 'whatsapp', contacts: [{ wa_id: '2348031234567' }], messages: [{ id: 'wamid.ABC123' }] },
  });

  const result = await review.sendTestMessage(
    { to: '08031234567', message: 'Hello from RxNaija' },
    { cfg: CFG, fetchImpl: impl, log: captureLog().log },
  );

  assert.deepEqual(result, { success: true, status: 200, messageId: 'wamid.ABC123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/1111111111/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '2348031234567',
    type: 'text',
    text: { body: 'Hello from RxNaija' },
  });
});

test('the token travels only in the Authorization header, never in the URL', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { messages: [{ id: 'wamid.X' }] } });
  await review.sendTestMessage({ to: '2348031234567', message: 'hi' }, { cfg: CFG, fetchImpl: impl, log: captureLog().log });
  assert.ok(!calls[0].url.includes(TOKEN));
});

test('with an app secret configured, appsecret_proof is sent and the secret itself is not', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { messages: [{ id: 'wamid.X' }] } });
  await review.sendTestMessage(
    { to: '2348031234567', message: 'hi' },
    { cfg: { ...CFG, appSecret: SECRET }, fetchImpl: impl, log: captureLog().log },
  );
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('appsecret_proof'), review.appSecretProof(TOKEN, SECRET));
  assert.ok(!calls[0].url.includes(SECRET));
});

test('an invalid request never reaches Meta', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  const result = await review.sendTestMessage({ to: 'nope', message: 'hi' }, { cfg: CFG, fetchImpl: impl, log: captureLog().log });
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});

test('an unconfigured harness names the missing variables — and never their values', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  const result = await review.sendTestMessage(
    { to: '2348031234567', message: 'hi' },
    { cfg: { ...CFG, phoneNumberId: '' }, fetchImpl: impl, log: captureLog().log },
  );
  assert.equal(result.status, 503);
  assert.match(result.error, /META_PHONE_NUMBER_ID/);
  assert.ok(!result.error.includes(TOKEN));
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------- Meta errors ---

test('an invalid token becomes a readable error, and the token appears nowhere — not in the result, not in the logs', async () => {
  const { impl } = fakeFetch({
    status: 401,
    body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, fbtrace_id: 'TRACE1' } },
  });
  const { log, lines } = captureLog();

  const result = await review.sendTestMessage({ to: '2348031234567', message: 'hi' }, { cfg: CFG, fetchImpl: impl, log });

  assert.equal(result.success, false);
  assert.match(result.error, /access token is invalid or has expired/);
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'token leaked into the response');
  assert.ok(!lines.join('\n').includes(TOKEN), 'token leaked into the logs');
  // …but the log does carry what is needed to look the failure up with Meta.
  assert.match(lines.join('\n'), /TRACE1/);
});

test('each Meta failure an owner can hit while recording maps to an actionable message', () => {
  const cases = [
    [{ code: 10 }, 403, /permission/],
    [{ code: 131030 }, 400, /allowed list/],
    [{ code: 131047 }, 400, /24 hours/],
    [{ code: 131026 }, 400, /could not deliver/],
    [{ code: 100, error_subcode: 33 }, 400, /phone number ID or WhatsApp Business Account/],
    [{ code: 100, error_user_msg: 'Parameter to is invalid.' }, 400, /Parameter to is invalid/],
    [{ code: 130429 }, 429, /rate-limiting/],
    [{ code: 4 }, 400, /rate-limiting/],
    [{ code: 999999 }, 500, /unexpected error/],
  ];
  for (const [error, httpStatus, pattern] of cases) {
    const safe = review.toSafeError(httpStatus, { error });
    assert.match(safe.message, pattern, `code ${error.code}`);
  }
  assert.equal(review.toSafeError(429, { error: { code: 130429 } }).status, 429);
});

test('Meta being unreachable is reported, not swallowed', async () => {
  const { impl } = fakeFetch(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
  const { log, lines } = captureLog();
  const result = await review.sendTestMessage({ to: '2348031234567', message: 'hi' }, { cfg: CFG, fetchImpl: impl, log });
  assert.equal(result.success, false);
  assert.match(result.error, /Could not reach Meta/);
  assert.equal(lines.length, 1, 'the failure must be logged');
});

test('a success response with no message ID is treated as a failure, not as a send', async () => {
  const { impl } = fakeFetch({ status: 200, body: { messaging_product: 'whatsapp' } });
  const result = await review.sendTestMessage({ to: '2348031234567', message: 'hi' }, { cfg: CFG, fetchImpl: impl, log: captureLog().log });
  assert.equal(result.success, false);
});

// ------------------------------------------------- sending a template ---

test('sending a template posts type=template with the name and language code', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { messages: [{ id: 'wamid.TPL' }] } });

  const result = await review.sendTemplateMessage(
    { to: '08031234567', templateName: 'hello_world', language: 'en_US' },
    { cfg: CFG, fetchImpl: impl, log: captureLog().log },
  );

  assert.deepEqual(result, { success: true, status: 200, messageId: 'wamid.TPL' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/1111111111/messages');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '2348031234567',
    type: 'template',
    template: { name: 'hello_world', language: { code: 'en_US' } },
  });
});

test('a template send validates the recipient exactly as a text send does', () => {
  const good = { to: '08031234567', templateName: 'hello_world', language: 'en_US' };
  assert.equal(review.validateTemplateSend(good).to, '2348031234567');
  assert.equal(review.validateTemplateSend({ ...good, to: 'abc' }).ok, false);
  assert.equal(review.validateTemplateSend({ ...good, to: '' }).ok, false);
});

test('a template send needs a template name and a real language code', () => {
  const good = { to: '08031234567', templateName: 'hello_world', language: 'en_US' };
  assert.match(review.validateTemplateSend({ ...good, templateName: '' }).error, /Choose a template/);
  assert.match(review.validateTemplateSend({ ...good, templateName: 'Not A Name' }).error, /Choose a template/);
  assert.match(review.validateTemplateSend({ ...good, language: 'english' }).error, /language code/);
});

test('the 24-hour-window error is still mapped on a template send, should Meta ever return it', async () => {
  const { impl } = fakeFetch({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } });
  const result = await review.sendTemplateMessage(
    { to: '2348031234567', templateName: 'hello_world', language: 'en_US' },
    { cfg: CFG, fetchImpl: impl, log: captureLog().log },
  );
  assert.equal(result.success, false);
  assert.match(result.error, /24 hours/);
});

test('the route sends a template when kind is "template", and text otherwise', () => {
  // The dispatch is one ternary in routes/metaCloudReview.js; this pins the
  // branch names so a rename cannot quietly turn every template send into a
  // text send — which would fail only outside the 24-hour window, i.e. in
  // exactly the situation the template send exists for.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'routes', 'metaCloudReview.js'), 'utf8',
  );
  assert.match(src, /kind === 'template'/);
  assert.match(src, /sendTemplateMessage/);
  assert.match(src, /sendTestMessage/);
});

// ------------------------------------------------------------ templates ---

test('template input is checked against Meta\'s rules first', () => {
  const good = { name: 'rxnaija_test', category: 'utility', language: 'en', body: 'Your order is ready for collection.' };
  assert.equal(review.validateTemplate(good).ok, true);
  assert.equal(review.validateTemplate(good).category, 'UTILITY');
  assert.equal(review.validateTemplate({ ...good, name: 'Has Spaces' }).ok, false);
  assert.equal(review.validateTemplate({ ...good, category: 'AUTHENTICATION' }).ok, false);
  assert.equal(review.validateTemplate({ ...good, language: 'english' }).ok, false);
  assert.equal(review.validateTemplate({ ...good, body: '' }).ok, false);
  assert.match(review.validateTemplate({ ...good, body: 'Hi {{1}}' }).error, /Variables/);
});

test('creating a template posts the documented body to the WABA\'s message_templates edge', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { id: '9876', status: 'PENDING', category: 'UTILITY' } });
  const result = await review.createTemplate(
    { name: 'rxnaija_test', category: 'UTILITY', language: 'en', body: 'Your order is ready for collection.' },
    { cfg: CFG, fetchImpl: impl, log: captureLog().log },
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.template, { id: '9876', name: 'rxnaija_test', status: 'PENDING', category: 'UTILITY' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/2222222222/message_templates');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: 'rxnaija_test',
    category: 'UTILITY',
    language: 'en',
    components: [{ type: 'BODY', text: 'Your order is ready for collection.' }],
  });
});

test('listing templates returns only the fields the screen shows, never the raw Graph object', async () => {
  const { impl, calls } = fakeFetch({
    status: 200,
    body: { data: [{ id: '1', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US', components: [{}] }] },
  });
  const result = await review.listTemplates({ cfg: CFG, fetchImpl: impl, log: captureLog().log });
  assert.deepEqual(result.templates, [
    { id: '1', name: 'hello_world', status: 'APPROVED', category: 'UTILITY', language: 'en_US' },
  ]);
  assert.equal(new URL(calls[0].url).searchParams.get('fields'), 'name,status,category,language');
});

test('status reports configuration as booleans only', () => {
  const status = review.publicStatus({ ...CFG, appSecret: SECRET });
  assert.deepEqual(status, { messaging: true, templates: true, graphVersion: 'v26.0' });
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

// ------------------------------------------------------------ the routes ---

const router = require('../routes/metaCloudReview');

/** Run a request through the real router, mounted the way index.js mounts it. */
async function call(method, path, { headers = {}, body } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp/cloud', router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('every harness route refuses a request with no session', async () => {
  for (const [method, path] of [
    ['GET', '/api/whatsapp/cloud/status'],
    ['POST', '/api/whatsapp/cloud/test-send'],
    ['GET', '/api/whatsapp/cloud/templates'],
    ['POST', '/api/whatsapp/cloud/templates'],
  ]) {
    const res = await call(method, path, { body: method === 'POST' ? { to: '2348031234567', message: 'hi' } : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.json.code, 'NO_TOKEN');
  }
});

test('every harness route is owner-only — a pharmacist is refused before anything runs', async () => {
  const routes = router.stack.filter((layer) => layer.route);
  assert.equal(routes.length, 4);

  for (const layer of routes) {
    // [requireAuth, requireRole('owner'), handler] — run the role guard with a
    // request that has already passed auth as a non-owner.
    const [, roleGuard, handler] = layer.route.stack.map((s) => s.handle);
    assert.ok(handler, `${layer.route.path} must have auth, role and handler`);

    let statusCode = null;
    let body = null;
    let reachedNext = false;
    const res = { status(c) { statusCode = c; return this; }, json(b) { body = b; return this; } };
    roleGuard({ pharmacyRole: 'pharmacist' }, res, () => { reachedNext = true; });

    assert.equal(reachedNext, false, `${layer.route.path} let a pharmacist through`);
    assert.equal(statusCode, 403);
    assert.equal(body.code, 'FORBIDDEN_ROLE');

    reachedNext = false;
    roleGuard({ pharmacyRole: 'owner' }, res, () => { reachedNext = true; });
    assert.equal(reachedNext, true, `${layer.route.path} refused the owner`);
  }
});
