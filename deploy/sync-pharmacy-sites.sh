#!/usr/bin/env bash
#
# Bring /etc/caddy/pharmacy-sites.conf in line with what is published, and
# reload Caddy if it changed.
#
# WHY THIS EXISTS SEPARATELY FROM update.sh
# The generator used to run only as part of a deploy. So an owner who
# published between deploys got working /p/<address> URLs immediately and a
# subdomain that stayed dark — no Caddy block, therefore no certificate —
# until somebody happened to deploy. The gap was invisible from the dashboard,
# which reports the site as published, because it is.
#
# This is the same generator on a two-minute timer. Nothing about publishing
# changes; the configuration simply catches up on its own.
#
# WHY NOT JUST CALL update.sh's generate_pharmacy_sites()
# That function is one step of a deploy that also swaps the Caddyfile itself,
# verifies the dashboard's TLS afterwards and rolls back the whole config if
# it broke. This does the narrower job and keeps its own rollback, so the two
# cannot half-apply each other's recovery. They write identical content —
# both read the same rows through the same script — so whichever runs second
# finds nothing to do.
#
# SAFE TO RUN AT ANY MOMENT. It writes nothing when the content is unchanged,
# which is almost every run, and a flock means two copies cannot overlap.
#
# Usage:  sudo /opt/rxnaija/deploy/sync-pharmacy-sites.sh
set -euo pipefail

APP_DIR="/opt/rxnaija"
APP_USER="rxnaija"
OUT="/etc/caddy/pharmacy-sites.conf"
# Beside Caddy's own state, not in /tmp: this is the file we restore to if a
# reload fails, and it has to survive a reboot that happens in between.
BACKUP="/var/lib/caddy/pharmacy-sites.last-good.conf"
LOCK="/var/lock/rxnaija-sync-sites.lock"

# Re-exec under flock so a slow run cannot be overtaken by the next tick.
# -n: if another copy holds it, this one exits rather than queueing, because a
# queue of identical regenerations has no value.
if [ "${SYNC_SITES_LOCKED:-}" != "1" ]; then
  export SYNC_SITES_LOCKED=1
  exec flock -n "$LOCK" "$0" "$@"
fi

log() { printf 'sync-pharmacy-sites: %s\n' "$1"; }

[ -f "$APP_DIR/.env.production" ] || { log "no .env.production - nothing to do"; exit 0; }
command -v caddy >/dev/null 2>&1 || { log "caddy not installed - nothing to do"; exit 0; }

STAGED="$(mktemp)"
# The generator runs as the app user, which is the only account that may read
# the environment file and reach the database. Root writes the config; it does
# not query Postgres.
chown "$APP_USER" "$STAGED"
trap 'rm -f "$STAGED"' EXIT

rc=0
sudo -u "$APP_USER" bash -c '
  set -o pipefail
  cd '"$APP_DIR"'
  set -a; . ./.env.production; set +a
  node scripts/generate-caddy-sites.js "$1"
' _ "$STAGED" || rc=$?

# 0 unchanged, 10 written. Anything else failed, and a failure here must leave
# the sites that are already serving exactly as they are.
if [ "$rc" != "0" ] && [ "$rc" != "10" ]; then
  log "generator failed (exit $rc) - leaving the current configuration alone"
  exit 1
fi

# PUBLIC_SITE_DOMAIN unset makes the generator a no-op that writes no file.
# Treated as "this box does not do subdomains" rather than as an error, the
# same way the generator itself treats it.
[ -s "$STAGED" ] || { log "nothing generated - subdomains not configured on this box"; exit 0; }

if [ -f "$OUT" ] && cmp -s "$STAGED" "$OUT"; then
  exit 0
fi

log "published sites changed - installing and reloading"
[ -f "$OUT" ] && cp "$OUT" "$BACKUP"
install -m 0644 -o root -g root "$STAGED" "$OUT"

# Validate BEFORE reloading. Caddy refuses a whole configuration over one bad
# block, and a refused reload while the new file is already on disk would put
# the box one unrelated restart away from serving nothing at all.
if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  log "the resulting configuration does not validate - rolling back"
  if [ -f "$BACKUP" ]; then cp "$BACKUP" "$OUT"; else rm -f "$OUT"; fi
  exit 1
fi

if ! systemctl reload caddy; then
  log "reload failed - restoring the last configuration that worked"
  if [ -f "$BACKUP" ]; then cp "$BACKUP" "$OUT"; else rm -f "$OUT"; fi
  systemctl reload caddy || true
  exit 1
fi

log "done"
