#!/usr/bin/env bash
#
# Deploy the latest main. Run on the box:  bash /opt/rxnaija/deploy/update.sh
#
# WHY THE BUILD HAPPENS BEFORE THE RESTART
# npm run build takes a minute or two. Building first means the service is
# only down for the seconds of an actual restart, rather than for the whole
# build — and if the build fails, the old version is still running and serving
# customers instead of being replaced by a broken one.
set -euo pipefail

APP_DIR="/opt/rxnaija"
APP_USER="rxnaija"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

cd "$APP_DIR"

# EVERY git call runs as the owning user, including the read-only ones.
#
# git refuses to operate on a repository owned by another user — "detected
# dubious ownership". Running the fetch through sudo but leaving `git
# rev-parse` bare meant the fetch succeeded as rxnaija and the very next line
# failed as root, which reads like a corrupt repository rather than a uid
# mismatch two lines apart.
GIT="sudo -u $APP_USER git"

say "Fetching main"
$GIT fetch --quiet origin main
BEFORE="$($GIT rev-parse --short HEAD)"
$GIT reset --hard --quiet origin/main
AFTER="$($GIT rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already at ${AFTER} — nothing to deploy"
  exit 0
fi
say "${BEFORE} → ${AFTER}"

# VITE_* are read at BUILD time, so the env file has to be sourced here and
# not merely present for the service. Without it the dashboard builds with
# sign-in silently disabled and no error until someone tries to log in.
say "Installing and building"
sudo -u "$APP_USER" --preserve-env bash -c '
  set -a; . '"$APP_DIR"'/.env.production; set +a
  npm install --omit=dev --no-audit --no-fund
  # --include=dev is REQUIRED here even though this is production.
  # Sourcing .env.production above sets NODE_ENV=production, which makes npm
  # skip devDependencies — and Vite is one. Without this the build dies with
  # 'vite: not found', which reads as a missing binary rather than as npm
  # quietly obeying an env var set three lines earlier.
  #
  # The tooling is only needed DURING the build; nothing it installs ends up
  # in what actually runs.
  npm --prefix client install --include=dev --no-audit --no-fund
  npm run build
'

# Migrations run BEFORE the restart, so the new code never starts against a
# schema that predates it. These are additive (add column / add table), which
# is what makes this order safe: the running old version tolerates the new
# columns for the few seconds before it is replaced.
say "Migrating"
sudo -u "$APP_USER" --preserve-env bash -c '
  set -a; . '"$APP_DIR"'/.env.production; set +a
  npm run migrate
'

say "Restarting"
sudo systemctl restart rxnaija

# Confirm it actually came back rather than assuming. A deploy that reports
# success while the service is crash-looping is worse than one that fails
# loudly — the WhatsApp socket is down either way, but only one tells you.
sleep 6
if curl -fsS -m 10 http://localhost:4000/api/health >/dev/null; then
  say "Healthy at ${AFTER}"
else
  printf '\n\033[1;31m==> Service did not come back healthy. Recent logs:\033[0m\n'
  sudo journalctl -u rxnaija -n 40 --no-pager
  exit 1
fi
