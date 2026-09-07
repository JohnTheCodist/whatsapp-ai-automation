/**
 * Which commit is this process actually running?
 *
 * WHY THIS EXISTS
 * Answering "is the fix deployed?" used to mean comparing the hashed name of
 * the JavaScript bundle the server was serving against the one a local build
 * produced. That works, and it is a terrible way to find out: it needs a
 * build on the asking machine, it only reflects the CLIENT, and it says
 * nothing at all when the change was server-side. On 2026-09-06 a deploy was
 * diagnosed twice that way — once for a fonts fix and once for a merge — and
 * both times the honest answer was available on the box and simply not
 * exposed.
 *
 * So /api/health and /api/live now carry the commit. It is the cheapest
 * possible observability: one string, resolved once, that turns "I think it
 * deployed" into a fact anyone can curl.
 *
 * RESOLVED ONCE, AT BOOT
 * Same reasoning as env.websiteBuilderEnabled. The answer cannot change while
 * the process runs — a `git pull` under a running service does not migrate it
 * to the new code — so reading per request would spend syscalls to report a
 * number that is, by construction, constant. Worse, it would report the
 * commit on DISK rather than the commit in MEMORY, which during a deploy is
 * exactly the window where the two disagree and exactly when somebody is
 * looking.
 *
 * NEVER THROWS
 * A missing .git is normal, not an error: a container image, a tarball
 * deploy, a CI checkout with --depth=0 stripped. This is a diagnostic string.
 * Failing to determine it must never stop the server booting, so every path
 * ends at 'unknown' rather than an exception.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Turn the contents of .git/HEAD into a commit SHA.
 *
 * HEAD is one of two things:
 *   "ref: refs/heads/main\n"                     — on a branch, the usual case
 *   "9d3d7cba04796d4a2e4485fa364f1fdd7702c9c6\n" — detached, e.g. a CI checkout
 *
 * When it is a ref, the SHA lives either in a loose file at .git/<ref> or,
 * once git has run `gc` or the clone arrived packed, in .git/packed-refs.
 * A fresh `git clone` on a deploy box is frequently packed, so skipping that
 * second lookup would return 'unknown' on precisely the machines this is for.
 *
 * Exported for its own tests: this is the part with branches in it, and the
 * part that silently returns nothing when it is wrong.
 *
 * @param {string} head        raw contents of .git/HEAD
 * @param {(p: string) => string|null} readFile  reads a path under .git, or null
 * @returns {string|null} full 40-character SHA, or null
 */
function resolveHead(head, readFile) {
  const text = String(head || '').trim();
  if (!text) return null;

  // Detached: HEAD is the SHA itself.
  if (/^[0-9a-f]{40}$/i.test(text)) return text.toLowerCase();

  const ref = text.match(/^ref:\s*(.+)$/);
  if (!ref) return null;
  const refName = ref[1].trim();

  // Loose ref.
  const loose = readFile(refName);
  if (loose && /^[0-9a-f]{40}$/i.test(loose.trim())) return loose.trim().toLowerCase();

  // Packed refs. Lines are "<sha> <refname>", with comments and, for annotated
  // tags, a "^<sha>" peel line that must NOT be matched as a ref of its own.
  const packed = readFile('packed-refs');
  if (!packed) return null;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line[0] === '#' || line[0] === '^') continue;
    const m = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (m && m[2].trim() === refName) return m[1].toLowerCase();
  }
  return null;
}

/** Read a path under .git, returning null instead of throwing. */
function readGit(rel) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, '.git', rel), 'utf8');
  } catch {
    return null;
  }
}

function detect() {
  // An explicit value always wins. A platform that builds an image has no .git
  // to read but does know what it built, and it is more trustworthy than
  // anything inferred. RENDER_GIT_COMMIT and SOURCE_VERSION are the names
  // Render and Heroku-style builders set; GIT_COMMIT is ours to set by hand.
  const fromEnv = process.env.GIT_COMMIT
    || process.env.RENDER_GIT_COMMIT
    || process.env.SOURCE_VERSION;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv.trim())) {
    return { commit: fromEnv.trim().toLowerCase(), source: 'env' };
  }

  const head = readGit('HEAD');
  if (head) {
    const sha = resolveHead(head, readGit);
    if (sha) return { commit: sha, source: 'git' };
  }

  return { commit: null, source: 'unknown' };
}

const resolved = detect();

module.exports = {
  /** Full SHA, or null when it could not be determined. */
  commit: resolved.commit,
  /** First 7 characters — what a human compares against `git log --oneline`. */
  shortCommit: resolved.commit ? resolved.commit.slice(0, 7) : null,
  /** 'env' | 'git' | 'unknown' — so a wrong answer can be traced to its origin. */
  source: resolved.source,
  resolveHead,
};
