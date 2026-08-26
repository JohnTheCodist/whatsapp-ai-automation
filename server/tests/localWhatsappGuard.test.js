/**
 * The guard that stops a local server taking the live pharmacy offline.
 *
 * WHY THIS IS TESTED RATHER THAN TRUSTED
 * The failure it prevents is silent and remote: a developer starts a server,
 * WhatsApp knocks the production socket off, and the only symptom is customers
 * being ignored. Nothing throws. So the guard has to be verified by asserting
 * on behaviour rather than by anyone remembering to check.
 *
 * Both directions matter equally. A guard that blocks production would be a
 * far worse bug than the one it fixes — it would take the pharmacy offline on
 * every deploy, permanently — so "production still connects" is asserted just
 * as explicitly as "local does not".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ENV_PATH = path.join(__dirname, '..', 'config', 'env.js');
const MANAGER_PATH = path.join(__dirname, '..', 'services', 'whatsapp', 'sessionManager.js');

/**
 * Load a fresh SessionManager under a given environment.
 *
 * env.js reads process.env once at module load and freezes the result, so the
 * cache has to be dropped between cases — otherwise every test after the first
 * silently asserts against the first one's environment and passes for the
 * wrong reason.
 */
function loadManager({ nodeEnv, allowLocal }) {
  const prevNode = process.env.NODE_ENV;
  const prevAllow = process.env.ALLOW_LOCAL_WHATSAPP;

  process.env.NODE_ENV = nodeEnv;
  if (allowLocal === undefined) delete process.env.ALLOW_LOCAL_WHATSAPP;
  else process.env.ALLOW_LOCAL_WHATSAPP = allowLocal;

  delete require.cache[require.resolve(ENV_PATH)];
  delete require.cache[require.resolve(MANAGER_PATH)];

  const mod = require(MANAGER_PATH);
  const Manager = mod.SessionManager || mod.default?.SessionManager;

  const restore = () => {
    if (prevNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNode;
    if (prevAllow === undefined) delete process.env.ALLOW_LOCAL_WHATSAPP; else process.env.ALLOW_LOCAL_WHATSAPP = prevAllow;
    delete require.cache[require.resolve(ENV_PATH)];
    delete require.cache[require.resolve(MANAGER_PATH)];
  };

  return { Manager, instance: mod.sessionManager, restore };
}

test('a development process refuses to restore sessions at boot', async () => {
  const { instance, restore } = loadManager({ nodeEnv: 'development' });
  try {
    // The db seam is what proves the refusal happened BEFORE any query. If
    // start() reached this, the guard ran too late to be the safe default.
    let queried = false;
    const db = () => { queried = true; return Promise.resolve([]); };

    const restored = await instance.start({ db, retries: 1, staggerMs: 0 });

    assert.equal(restored, 0, 'no sessions may be restored locally');
    assert.equal(queried, false, 'must refuse before touching the database');
  } finally {
    restore();
  }
});

test('a development process refuses an explicit connect, with a reason', async () => {
  const { instance, restore } = loadManager({ nodeEnv: 'development' });
  try {
    await assert.rejects(
      () => instance.connect('11111111-1111-1111-1111-111111111111', 'acct-1'),
      (err) => {
        // The message has to carry the fix, not just the refusal — see the
        // comment on _blockedReason.
        assert.match(err.message, /will not open a WhatsApp socket/i);
        assert.match(err.message, /ALLOW_LOCAL_WHATSAPP/);
        return true;
      },
      'connect must throw rather than hang at "Connecting" forever',
    );
  } finally {
    restore();
  }
});

test('the escape hatch works when somebody genuinely means it', async () => {
  const { instance, restore } = loadManager({ nodeEnv: 'development', allowLocal: 'true' });
  try {
    let queried = false;
    const db = () => { queried = true; return Promise.resolve([]); };

    await instance.start({ db, retries: 1, staggerMs: 0 });
    assert.equal(queried, true, 'ALLOW_LOCAL_WHATSAPP=true must lift the block');
  } finally {
    restore();
  }
});

test('production is never blocked — the guard must not become the outage', async () => {
  const { instance, restore } = loadManager({ nodeEnv: 'production' });
  try {
    let queried = false;
    const db = () => { queried = true; return Promise.resolve([]); };

    await instance.start({ db, retries: 1, staggerMs: 0 });
    assert.equal(queried, true, 'production must restore sessions as before');
  } finally {
    restore();
  }
});

test('the flag alone does not enable anything in production', async () => {
  // Belt and braces: ALLOW_LOCAL_WHATSAPP is meaningless in production, and
  // must not read as "disable the socket" if it is ever set there by accident.
  const { instance, restore } = loadManager({ nodeEnv: 'production', allowLocal: 'false' });
  try {
    let queried = false;
    const db = () => { queried = true; return Promise.resolve([]); };

    await instance.start({ db, retries: 1, staggerMs: 0 });
    assert.equal(queried, true, 'production ignores the local flag entirely');
  } finally {
    restore();
  }
});
