/**
 * Where the agent keeps its token and its settings.
 *
 * ProgramData, not the user's profile. This is expected to run as a Windows
 * service under a system account, and a config in C:\Users\Ada\AppData is
 * unreadable to it — the sync would work while Ada is logged in and stop when
 * the shop's night staff log in as someone else, which presents as "it works
 * some days" rather than as a permissions error.
 *
 * ON THE TOKEN SITTING IN A FILE
 * It does, and that is a real limitation worth naming rather than papering
 * over. The mitigations are that the file is permission-restricted, the token
 * is scoped to catalogue upload alone (it cannot read a customer, an order or
 * a message), and it can be revoked from the dashboard without anyone
 * touching this computer. DPAPI would bind it to the machine and is the right
 * upgrade, but it is not what stands between a shop PC and a data breach —
 * the scope is.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function home() {
  if (process.env.RXNAIJA_SYNC_HOME) return process.env.RXNAIJA_SYNC_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'RxNaijaSync');
  }
  return path.join(os.homedir(), '.rxnaija-sync');
}

const CONFIG_PATH = () => path.join(home(), 'config.json');

const DEFAULTS = {
  apiUrl: 'https://app.rxnaija.com',
  token: null,
  deviceId: null,
  // Where the pharmacy's POS drops its export.
  watchPath: null,
  pos: null,
  // Hash of the last file successfully sent, so an unchanged export is not
  // re-uploaded every few hours. The server dedupes too (content_hash), but
  // not sending it at all is cheaper than sending it to be ignored.
  lastHash: null,
  // Minutes between checks. Six hours by default rather than a nightly cron:
  // a pharmacy PC is often switched off at close, and a 2am schedule on a
  // machine that is off at 2am never runs at all. Something that fires a few
  // times during opening hours survives real shop behaviour.
  intervalMinutes: 360,
};

function read() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...read(), ...patch };
  const file = CONFIG_PATH();
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  // chmod is a no-op on Windows; the ACL is what matters there and is set by
  // the installer. Attempted anyway so the POSIX case (a developer's machine,
  // a Linux box in testing) is not left world-readable.
  try { fs.chmodSync(file, 0o600); } catch { /* not supported here */ }
  return next;
}

function isPaired() {
  const c = read();
  return Boolean(c.token && c.deviceId);
}

/**
 * Forget the pairing, keeping everything else.
 *
 * Called when the SERVER says this device is no longer paired — someone
 * disconnected it in the dashboard. Until this existed, revoking a device left
 * the agent still holding a dead token and still reporting "Paired: yes",
 * because being paired was decided by reading a local file rather than by
 * asking. The pharmacist saw a program insisting it was connected to something
 * they had just disconnected it from.
 *
 * watchPath and pos survive on purpose: they are still true about this
 * computer, and re-pairing should not make someone find their export folder
 * again.
 */
function clearPairing() {
  return write({ token: null, deviceId: null, lastHash: null });
}

module.exports = { read, write, isPaired, clearPairing, home, CONFIG_PATH, DEFAULTS };
