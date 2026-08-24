/**
 * Working out which stock software this computer runs.
 *
 * WHAT IS COLLECTED, AND WHAT IS NOT
 * Program names and database service names. That is the whole list. No file
 * contents, no directory listings of the pharmacy's documents, nothing from
 * inside a POS database, no customer or patient data. The pharmacist is shown
 * exactly what would be sent, and nothing leaves this computer until they say
 * yes — see `pair` in index.js.
 *
 * That sequence is the entire difference between onboarding software and
 * something a pharmacy would be right to be angry about. Software that
 * inventories a business's server and reports home, undisclosed, is malware
 * regardless of intent.
 *
 * WHY THIS DOES NOT TRY TO BE CLEVER
 * It returns candidates and lets a person choose. Fingerprint matching needs a
 * catalogue of fingerprints, and that catalogue does not exist yet — it is
 * built out of what real pharmacies confirm, one install at a time. Guessing
 * confidently from an empty catalogue would produce wrong export instructions,
 * which is worse than asking a question whose answer the pharmacist knows
 * instantly.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

/** Never let a hung registry query hang the whole install. */
const TIMEOUT_MS = 20000;

// Registry uninstall keys. BOTH views matter: most Nigerian pharmacy POS
// packages are 32-bit, and on 64-bit Windows those live only under
// WOW6432Node. Reading one view finds roughly half the software on the
// machine and looks like a detection failure rather than a missing key.
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/**
 * Windows components, drivers and runtimes — noise in a list whose only job is
 * "point at your stock software". A pharmacist scrolling past forty Microsoft
 * redistributables to find their POS is a pharmacist who picks the wrong one.
 */
const NOISE = [
  /^Microsoft /i, /^Windows /i, /Redistributable/i, /^Update for/i, /^Security Update/i,
  /^Google /i, /^Mozilla /i, /^Adobe (Acrobat|Reader)/i, /^Java\b/i, /^Intel\b/i,
  /^NVIDIA/i, /^Realtek/i, /^AMD /i, /Driver$/i, /^\.NET/i, /^MSI /i, /^Visual Studio/i,
  /^Node\.js/i, /^Git\b/i, /^Python/i, /^7-Zip/i, /^WinRAR/i, /^Zoom/i, /^Dropbox/i,
  /^Microsoft Edge/i, /^Office/i, /^Teams/i, /^OneDrive/i,
];

/** Database engines a POS is likely sitting on. A strong hint about storage. */
const DB_SERVICE_HINTS = [
  { match: /firebird/i, engine: 'Firebird' },
  { match: /mysql|mariadb/i, engine: 'MySQL/MariaDB' },
  { match: /mssql|sqlserver|sqlexpress/i, engine: 'SQL Server' },
  { match: /postgres/i, engine: 'PostgreSQL' },
  { match: /interbase/i, engine: 'InterBase' },
  { match: /sybase|sqlanywhere/i, engine: 'SQL Anywhere' },
];

/**
 * Words that make a program worth showing first. Not a fingerprint catalogue —
 * just an ordering hint so the likely answer is near the top of the list the
 * pharmacist reads.
 */
const LIKELY = /pharm|chemist|drug|dispens|stock|invent|pos\b|point of sale|retail|sales|medic|clinic|hospital|store|shop|account|ledger|billing|invoice/i;

function isNoise(name) {
  return NOISE.some((re) => re.test(name));
}

async function installedPrograms() {
  const found = new Map();

  for (const key of UNINSTALL_KEYS) {
    try {
      // reg.exe rather than a registry npm package: it ships with Windows,
      // needs no native build step, and keeps this program dependency-free.
      const { stdout } = await run('reg', ['query', key, '/s', '/v', 'DisplayName'], {
        timeout: TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
      });

      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/DisplayName\s+REG_SZ\s+(.+?)\s*$/i);
        if (!m) continue;
        const name = m[1].trim();
        if (!name || isNoise(name)) continue;
        found.set(name, true);
      }
    } catch {
      // A missing key or a denied read is normal — WOW6432Node does not exist
      // on 32-bit Windows, and HKCU may be empty. Detection degrades to
      // whatever the other keys returned rather than failing the install.
    }
  }

  return [...found.keys()];
}

async function databaseServices() {
  const engines = new Set();
  const names = [];
  try {
    const { stdout } = await run('sc', ['query', 'type=', 'service', 'state=', 'all'], {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^SERVICE_NAME:\s*(.+?)\s*$/i);
      if (!m) continue;
      const svc = m[1].trim();
      for (const hint of DB_SERVICE_HINTS) {
        if (hint.match.test(svc)) {
          engines.add(hint.engine);
          names.push(svc);
        }
      }
    }
  } catch {
    /* not Windows, or sc unavailable — the program list still carries the answer */
  }
  return { engines: [...engines], services: names };
}

/**
 * Everything the pairing step will offer to send, ordered so the likely answer
 * is near the top.
 */
async function detect() {
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      programs: [],
      likely: [],
      dbEngines: [],
      dbServices: [],
      note: 'Detection only runs on Windows. Choose your software by hand.',
    };
  }

  const [programs, db] = await Promise.all([installedPrograms(), databaseServices()]);
  const likely = programs.filter((p) => LIKELY.test(p)).sort();
  const rest = programs.filter((p) => !LIKELY.test(p)).sort();

  return {
    platform: 'win32',
    // Likely candidates first, everything else after — one list, ordered, so
    // a pharmacy whose software is named something unguessable ("Ade Ventures
    // Manager") is still findable rather than filtered out of existence.
    programs: [...likely, ...rest],
    likely,
    dbEngines: db.engines,
    dbServices: db.services,
  };
}

module.exports = { detect, installedPrograms, databaseServices, isNoise, LIKELY };
