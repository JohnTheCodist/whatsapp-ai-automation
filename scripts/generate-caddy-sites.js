#!/usr/bin/env node
/**
 * Write one Caddy site block per published pharmacy website.
 *
 * WHY NOT A WILDCARD
 * `*.rxnaija.com { tls { on_demand } }` is the obvious way to serve an
 * unbounded set of hostnames, and on 2026-09-07 it took the dashboard off the
 * internet three times running. The wildcard matches app.rxnaija.com too, so
 * Caddy served that hostname through the wildcard's on-demand policy instead
 * of the certificate it had held for months, and answered every handshake
 * with `tlsv1 alert internal error`. Pharmacy subdomains worked perfectly
 * throughout, which is what made it so hard to see: the feature looked like a
 * success and the outage looked unrelated.
 *
 * Neither allowing app.rxnaija.com through the certificate gate nor giving it
 * an explicit TLS connection policy changed anything.
 *
 * So: no wildcard. Every hostname Caddy serves is named explicitly, gets an
 * ordinary managed certificate, and cannot capture a sibling. It is more
 * machinery than a wildcard and it cannot fail in that shape.
 *
 * WHAT MAKES THIS SAFE TO GENERATE
 * These hostnames come out of a database column that pharmacy owners choose,
 * and they are written into a CONFIGURATION FILE. A value containing a brace
 * or a newline would not be a bad hostname — it would be new Caddy
 * directives, authored by whoever signed up. normalizeWebAddress is applied
 * again here, on the way out, and anything that does not survive it verbatim
 * is dropped and reported rather than written.
 *
 * That check is redundant with the one on input, and deliberately so: input
 * validation protects the value going in, and this protects the file being
 * written. The day someone adds a bulk import, a data migration, or an admin
 * override, only one of those two is still standing.
 *
 * USAGE
 *   node scripts/generate-caddy-sites.js [outfile]
 *
 * Writes nothing and exits 0 when the content is unchanged, so a caller can
 * decide whether a reload is needed by checking the exit status:
 *   0 = unchanged   10 = written (reload Caddy)   1 = failed
 */

const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });

const { getSql, closeSql } = require('../server/services/db');
const { normalizeWebAddress } = require('../server/services/website/webAddress');

const OUT = process.argv[2] || '/etc/caddy/pharmacy-sites.conf';
const UPSTREAM = process.env.CADDY_UPSTREAM || 'localhost:4000';
const DOMAIN = (process.env.PUBLIC_SITE_DOMAIN || '').trim().toLowerCase();

const EXIT_UNCHANGED = 0;
const EXIT_WRITTEN = 10;

/**
 * One site block.
 *
 * No `log` directive. The dashboard block's own log file could not be created
 * by the caddy user on 2026-09-07 and that single permission error made Caddy
 * refuse the ENTIRE configuration — every site, not just the one that named
 * the file. Generated blocks stay off that ground and log to the default.
 */
function block(address) {
  return [
    `${address}.${DOMAIN} {`,
    `\treverse_proxy ${UPSTREAM}`,
    '',
    '\tencode gzip zstd',
    '',
    '\theader {',
    // The PAGE sets its own Content-Security-Policy — script-src 'none' is
    // what makes stored XSS unreachable on a published site. Caddy must not
    // add or override one here, or that guarantee moves out of the code that
    // reasons about it and into a generated file.
    '\t\tStrict-Transport-Security "max-age=31536000"',
    '\t\t-Server',
    '\t}',
    '}',
  ].join('\n');
}

/**
 * Split candidate addresses into those safe to write and those refused.
 *
 * Exported so the refusal can be tested directly. This is the only thing
 * standing between a database column a pharmacy owner controls and the
 * contents of a Caddy configuration file, and a value carrying a brace or a
 * newline would not be a bad hostname — it would be new directives.
 *
 * An address must survive normalizeWebAddress UNCHANGED. Merely normalising
 * to something valid is not enough: the normalised form is a hostname nobody
 * was told about, so Caddy would serve a name the pharmacy never printed
 * while the one on its flyer answers nothing.
 */
function partition(subdomains) {
  const good = [];
  const rejected = [];
  for (const subdomain of subdomains) {
    const check = normalizeWebAddress(subdomain);
    if (!check.ok || check.value !== subdomain) rejected.push(subdomain);
    else good.push(subdomain);
  }
  return { good, rejected };
}

async function main() {
  // Not an error. A deployment that has not configured subdomains has nothing
  // to generate, and failing the deploy over it would make this script
  // mandatory on boxes that do not want the feature at all.
  if (!DOMAIN) {
    process.stdout.write('PUBLIC_SITE_DOMAIN is not set - nothing to generate.\n');
    return EXIT_UNCHANGED;
  }

  const sql = getSql();
  const rows = await sql`
    select subdomain
      from pharmacy_websites
     where status = 'published'
       and subdomain is not null
     order by subdomain
  `;

  const { good, rejected } = partition(rows.map((r) => r.subdomain));

  const body = [
    '# GENERATED — do not edit.',
    '#',
    '# scripts/generate-caddy-sites.js writes this from the published rows in',
    '# pharmacy_websites. Edits are lost on the next deploy. To add a hostname,',
    '# publish the website; to remove one, unpublish it.',
    `# ${good.length} published site${good.length === 1 ? '' : 's'}.`,
    '',
    ...good.map(block),
    '',
  ].join('\n');

  let current = null;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch {
    current = null;
  }

  for (const bad of rejected) {
    process.stderr.write(`REJECTED as a hostname, not written: ${JSON.stringify(bad)}\n`);
  }

  if (current === body) {
    process.stdout.write(`unchanged (${good.length} site(s))\n`);
    return EXIT_UNCHANGED;
  }

  fs.writeFileSync(OUT, body);
  process.stdout.write(`written: ${OUT} (${good.length} site(s))\n`);
  return EXIT_WRITTEN;
}

module.exports = { partition, block };

// Only when run directly. Requiring this file for its exports must not open a
// database connection or call process.exit.
if (require.main === module) {
  main()
    .then(async (code) => {
      await closeSql();
      process.exit(code);
    })
    .catch(async (err) => {
      process.stderr.write((err.stack || err.message) + String.fromCharCode(10));
      try { await closeSql(); } catch { /* already closing */ }
      process.exit(1);
    });
}
