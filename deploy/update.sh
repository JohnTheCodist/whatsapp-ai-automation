#!/usr/bin/env bash

# SELF-MODIFICATION GUARD — the brace below wraps this ENTIRE script, and it
# is load-bearing rather than cosmetic.
#
# This script runs `git reset --hard origin/main` on the directory it lives
# in, so it REWRITES ITSELF halfway through. Bash does not read a script once
# and run it from memory; it reads incrementally and keeps a byte offset. If
# the file changes size underneath a running shell, the next read returns
# whatever now sits at that old offset — a fragment of a different line. The
# result is not a clean failure. It is a deploy that executes garbage, on the
# box holding every pharmacy's WhatsApp socket.
#
# This was survivable by accident until 2026-09-06: the file was about 7 KB,
# under the ~8 KB bash reads in one go, so it happened to be fully buffered
# before the reset landed. Adding sync_caddy pushed it to ~8.9 KB and over
# that line.
#
# Wrapping everything in `{ ... }` makes it a single compound command, and a
# compound command must be PARSED IN FULL before any of it executes. The
# whole file is therefore read before the reset can touch it. `exit 0` before
# the closing brace means nothing after it is ever reached either.
#
# Do not remove the braces to tidy the indentation.
{
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

# The hostname whose TLS must survive every proxy change. Empty disables the
# post-reload check — right for a box that fronts no dashboard, and a
# deliberate opt-out rather than an accident.
DASHBOARD_HOST="app.rxnaija.com"

# The last Caddy config that was VERIFIED serving the dashboard.
#
# 2026-09-07: a failed deploy rolled back to whatever was in
# /etc/caddy/Caddyfile beforehand — which was itself a broken config from
# the previous deploy. The rollback ran, reported success, and left the
# dashboard down. Restoring the previous file is only a fix when the
# previous file worked, and nothing had ever checked that.
CADDY_GOOD="/var/lib/caddy/last-known-good.Caddyfile"

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

# Run a command as the app user WITHOUT dragging root's environment in.
#
# --preserve-env used to be here and is why the build silently did nothing:
# it keeps root's HOME=/root, so npm — running as rxnaija — tried to use
# /root/.npm as its cache, which that user cannot write. Nothing about that
# reads as "the build did not run"; the deploy just moved on.
#
# It was never needed either. Every block below sources .env.production itself
# on the next line, which is where the build's environment is supposed to come
# from. HOME is set explicitly so npm's cache lands somewhere the app user owns.
as_app() {
  sudo -u "$APP_USER" \
    env -i PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
           HOME="$APP_DIR" \
    bash -c "$1"
}

DIST_INDEX="$APP_DIR/client/dist/index.html"

# When did the RUNNING service actually start?
service_started_at() {
  local ts
  ts="$(systemctl show -p ActiveEnterTimestamp --value rxnaija 2>/dev/null)"
  [ -n "$ts" ] && date -d "$ts" +%s 2>/dev/null || echo 0
}

restart_and_verify() {
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
}

# ---------------------------------------------------------------------
# Caddy config, synced from the repo.
#
# WHY THIS IS HERE INSTEAD OF BEING A SECOND COMMAND SOMEBODY REMEMBERS
# deploy/Caddyfile has been version-controlled all along, but nothing ever
# applied it. Installing it was a separate `sudo cp && systemctl reload caddy`
# that a human had to run after the deploy, and on 2026-09-06 that step was
# missed twice running: once for the health-probe fix, once for the HTTP/3
# fix. Both times git said the fix had shipped, the repo was correct, the box
# was not, and the dashboard stayed broken — with the second one presenting as
# ERR_QUIC_PROTOCOL_ERROR, which looks nothing like "you forgot to copy a
# file".
#
# A config that lives in the repo but is applied by hand is not deployed. It
# is a suggestion.
#
# VALIDATED BEFORE IT IS INSTALLED, which is what makes automating this safe:
# `caddy validate` parses the NEW file while the OLD one is still serving, so
# a syntax error fails this script rather than taking the site down. Only then
# is it copied, and `reload` (not `restart`) swaps config without dropping
# connections.
# Put back the config that was working. Separate from the refused-reload
# path above because that one knows WHY Caddy said no and can print it;
# this one is reached when Caddy said yes and the site broke anyway, where
# there is no error to quote — only a site that stopped answering.
# Regenerate the per-pharmacy site blocks from the database.
#
# Runs as the app user with the production environment, exactly like the
# migration step, because it reads the same database. It writes to a staging
# path that user can actually write and root installs the result — /etc/caddy
# is not writable by rxnaija and should not become so.
#
# A failure here is deliberately NOT fatal. The existing generated file keeps
# serving every pharmacy already published; refusing to deploy the application
# because a config file could not be regenerated would turn a cosmetic problem
# into an outage.
#
# Exit codes from the script: 0 unchanged, 10 written, anything else failed.
PHARMACY_SITES_CHANGED=0
generate_pharmacy_sites() {
  local script="$APP_DIR/scripts/generate-caddy-sites.js"
  local staged="/tmp/rxnaija-pharmacy-sites.conf"
  local out="/etc/caddy/pharmacy-sites.conf"

  [ -f "$script" ] || return 0
  command -v caddy >/dev/null 2>&1 || return 0

  say "Regenerating pharmacy site blocks"
  rm -f "$staged"

  local rc=0
  as_app '
    set -o pipefail
    cd '"$APP_DIR"'
    set -a; . ./.env.production; set +a
    node scripts/generate-caddy-sites.js '"$staged"'
  ' || rc=$?

  if [ "$rc" != "0" ] && [ "$rc" != "10" ]; then
    say "Could not regenerate pharmacy sites — the ones already published stay as they are"
    return 0
  fi

  if [ -f "$staged" ]; then
    if [ ! -f "$out" ] || ! cmp -s "$staged" "$out"; then
      sudo cp "$staged" "$out"
      PHARMACY_SITES_CHANGED=1
    fi
    rm -f "$staged"
  elif [ ! -f "$out" ]; then
    # The import is a glob, so a missing file is survivable. An explicit empty
    # one still reads better: "generated, nothing published" rather than
    # "never ran".
    echo "# no published pharmacy websites" | sudo tee "$out" >/dev/null
    PHARMACY_SITES_CHANGED=1
  fi
}

caddy_restore() {
  local backup="$1" dst="$2"
  # Prefer the last VERIFIED config over the merely previous one.
  if [ -f "$CADDY_GOOD" ]; then
    sudo cp "$CADDY_GOOD" "$dst"
    sudo systemctl reload caddy || true
    say "Restored the last Caddy config VERIFIED to serve the dashboard"
    return 0
  fi
  if [ -n "$backup" ]; then
    sudo cp "$backup" "$dst"
    sudo systemctl reload caddy || true
    say "Restored the previous /etc/caddy/Caddyfile — Caddy is serving what it was before"
  else
    say "There was no previous config to restore"
  fi
}

sync_caddy() {
  local src="$APP_DIR/deploy/Caddyfile"
  local dst="/etc/caddy/Caddyfile"

  # Not every environment fronts this with Caddy — a local box, or a platform
  # that terminates TLS itself. Absent is not a failure.
  command -v caddy >/dev/null 2>&1 || return 0
  [ -f "$src" ] || return 0

  # Before comparing anything: the generated pharmacy blocks are part of the
  # configuration Caddy will load, so they have to be current before we decide
  # whether a reload is needed.
  generate_pharmacy_sites

  # Unchanged means BOTH files. A pharmacy publishing a website changes only
  # the generated one, and skipping the reload then would leave the new site
  # unreachable while every check reported success.
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$PHARMACY_SITES_CHANGED" = "0" ]; then
    say "Caddy config already current"
    return 0
  fi

  say "Caddy config differs — validating before installing"
  if ! sudo caddy validate --config "$src" --adapter caddyfile >/dev/null 2>&1; then
    printf '\n\033[1;31m==> deploy/Caddyfile is INVALID. The live config was left untouched.\033[0m\n'
    sudo caddy validate --config "$src" --adapter caddyfile || true
    exit 1
  fi

  # VALIDATE IS NOT ENOUGH, AND 2026-09-07 proved it. `caddy validate` parses
  # the configuration; it does not open the things the configuration points
  # at. A log file the caddy user could not create passed validation and then
  # failed the reload with HTTP 400 — so Caddy kept serving its previous
  # config while /etc/caddy/Caddyfile on disk held the new one.
  #
  # That split state is the actual danger. It looks deployed, it is not, and
  # the next thing to restart Caddy — a certificate renewal, a reboot — loads
  # the broken file and the site does not come back at all. So a failed
  # reload puts the old file back and reloads again, leaving the box in the
  # state it was in before this function ran.
  local backup=""
  if [ -f "$dst" ]; then
    backup="$(mktemp)"
    sudo cp "$dst" "$backup"
  fi

  sudo cp "$src" "$dst"

  if ! sudo systemctl reload caddy; then
    printf '\n\033[1;31m==> Caddy REFUSED the new config. Rolling back.\033[0m\n'
    if [ -n "$backup" ]; then
      sudo cp "$backup" "$dst"
      sudo systemctl reload caddy || true
      printf '    /etc/caddy/Caddyfile restored; Caddy is serving what it was before.\n'
    else
      printf '    There was no previous config to restore.\n'
    fi
    printf '    The reason it refused:\n\n'
    sudo journalctl -u caddy -n 20 --no-pager | grep -i error || true
    printf '\n    The app is deployed and running; only the proxy config was rejected.\n'
    exit 1
  fi

  # An if, not `[ -n ... ] && rm`. Checked rather than assumed: in THIS
  # position the && form does not trip set -e, because a later command
  # follows it. It would the moment it became the last statement in the
  # function — an empty backup is the normal case on a box with no previous
  # config, and the deploy would then fail after having fully succeeded. The
  # if form does not depend on what comes after it.
  # A SUCCESSFUL RELOAD IS NOT A WORKING SITE. 2026-09-07: adding a
  # *.rxnaija.com block reloaded cleanly, Caddy reported itself healthy, and
  # the dashboard went dark — the wildcard captured app.rxnaija.com and Caddy
  # stopped presenting a certificate for it. Every check this function had
  # was green while the control panel every pharmacy uses was unreachable.
  #
  # So the last check asks the question a person would: can you still open
  # the dashboard over HTTPS?
  #
  # NO --resolve. It pinned this to 127.0.0.1 and that is exactly how the
  # check passed while the dashboard was unreachable: over loopback Caddy
  # served app.rxnaija.com perfectly, and from the public IP the identical
  # request was refused. A check that passes when the site is down is worse
  # than no check, because it launders a broken deploy as a good one. So this
  # now resolves and connects the way a browser does.
  if [ -n "$DASHBOARD_HOST" ]; then
    sleep 2
    if ! curl -fsS --max-time 15 "https://${DASHBOARD_HOST}/api/live" >/dev/null 2>&1; then
      say "ROLLING BACK — Caddy accepted the config but ${DASHBOARD_HOST} no longer serves HTTPS"
      caddy_restore "$backup" "$dst"
      if [ -n "$backup" ]; then rm -f "$backup"; fi
      say "The app is deployed and running. Only the proxy config was reverted."
      exit 1
    fi
  fi

 # Verified serving. Remember it, so a future failure has something known
  # good to fall back to rather than merely something older.
  sudo cp "$dst" "$CADDY_GOOD"

  if [ -n "$backup" ]; then rm -f "$backup"; fi
  say "Caddy config installed and reloaded"
}

say "Fetching main"
$GIT fetch --quiet origin main
BEFORE="$($GIT rev-parse --short HEAD)"
$GIT reset --hard --quiet origin/main
AFTER="$($GIT rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  # "Nothing to deploy" is about the CODE. It is not the same claim as "the
  # running service is on that code", and treating them as one is a trap this
  # script walked somebody into: the build failed, they fixed it by hand, and
  # every re-run then said "nothing to deploy" and refused to restart onto the
  # bundle they had just built. Half an hour of a correct deploy looking like
  # a broken one.
  DIST_MTIME="$( [ -f "$DIST_INDEX" ] && stat -c %Y "$DIST_INDEX" || echo 0 )"
  if [ "$DIST_MTIME" -gt "$(service_started_at)" ]; then
    say "Already at ${AFTER}, but the running service is older than the built dashboard"
    restart_and_verify
    sync_caddy
    exit 0
  fi
  # Caddy config is versioned separately from the code, so a Caddyfile-only
  # commit leaves BEFORE and AFTER equal. Syncing it here as well is the
  # whole point: the first version of this ran only on the code-changed
  # path, which meant a proxy-only fix silently never deployed.
  sync_caddy
  say "Already at ${AFTER} — no code to deploy"
  exit 0
fi
say "${BEFORE} → ${AFTER}"

# VITE_* are read at BUILD time, so the env file has to be sourced here and
# not merely present for the service. Without it the dashboard builds with
# sign-in silently disabled and no error until someone tries to log in.
#
# Recorded BEFORE the build so the check after it can prove vite actually ran.
# See the verification block below for why that is not paranoia.
BUILD_STARTED="$(date +%s)"

say "Installing and building"
# `set -e` INSIDE the subshell, not just on the outer script.
#
# The outer set -euo pipefail does not reach in here: `bash -c` is a new shell
# with its own options, and only the LAST command's exit status escapes back
# out. So a failing `npm --prefix client install` in the middle used to be
# swallowed whole — the subshell carried on to the next line and the deploy
# reported success. The explicit `cd` is the same defence: this used to rely on
# sudo happening to preserve the outer cd, which is a configuration detail of
# the box rather than something this script states.
as_app '
  set -eo pipefail
  cd '"$APP_DIR"'
  set -a; . ./.env.production; set +a
  npm install --omit=dev --no-audit --no-fund
  # --include=dev is REQUIRED here even though this is production.
  # Sourcing .env.production above sets NODE_ENV=production, which makes npm
  # skip devDependencies — and Vite is one. Without this the build dies with
  # '"'"'vite: not found'"'"', which reads as a missing binary rather than as npm
  # quietly obeying an env var set three lines earlier.
  #
  # The tooling is only needed DURING the build; nothing it installs ends up
  # in what actually runs.
  npm --prefix client install --include=dev --no-audit --no-fund
  npm run build
'

# PROVE THE BUILD RAN. This is the check whose absence shipped a stale
# dashboard once already: git advanced to the new commit, migrations ran, the
# service restarted, /api/health returned ok — and client/dist was still the
# PREVIOUS build, because the build step had quietly done nothing. Every
# signal the deploy looked at was green, because a stale bundle serves exactly
# as healthily as a fresh one. Only the browser knew.
#
# vite rewrites dist/index.html on every successful build, so an mtime older
# than this run means it did not run, whatever the exit codes said.
if [ ! -f "$DIST_INDEX" ]; then
  printf '\n\033[1;31m==> client/dist/index.html is missing — the build did not produce a dashboard.\033[0m\n'
  exit 1
fi
if [ "$(stat -c %Y "$DIST_INDEX")" -lt "$BUILD_STARTED" ]; then
  printf '\n\033[1;31m==> client/dist was NOT rebuilt (index.html predates this run).\033[0m\n'
  printf '    The service was left untouched rather than restarted onto a stale bundle.\n'
  printf '    Run the build by hand to see the real error:\n\n'
  printf "      sudo -u %s bash -c 'cd %s && set -a; . ./.env.production; set +a; npm run build'\n\n" \
    "$APP_USER" "$APP_DIR"
  exit 1
fi

# Migrations run BEFORE the restart, so the new code never starts against a
# schema that predates it. These are additive (add column / add table), which
# is what makes this order safe: the running old version tolerates the new
# columns for the few seconds before it is replaced.
say "Migrating"
as_app '
  set -eo pipefail
  cd '"$APP_DIR"'
  set -a; . ./.env.production; set +a
  npm run migrate
'

restart_and_verify

# AFTER the restart, deliberately: this renders published pages with the code
# that is now running, so the ordering is what makes it worth doing at all.
#
# A published page is stored HTML. Without this step a renderer improvement
# reaches nobody — every live site keeps serving the bytes produced by whatever
# version was running the last time its owner pressed Publish, and the deploy
# looks like it did nothing. Renders published_data only, never a draft; see
# scripts/rerender-sites.js.
#
# Not fatal: a pharmacy whose render fails must not fail a deploy that has
# already restarted a healthy service. It is reported and the deploy carries on.
say "Re-rendering published websites"
as_app '
  set -eo pipefail
  cd '"$APP_DIR"'
  set -a; . ./.env.production; set +a
  node scripts/rerender-sites.js
' || say "WARNING: some websites did not re-render — see the output above"

# Install the timer that keeps Caddy in step with what is published.
#
# Here rather than only in setup.sh so an EXISTING box gains it on the next
# deploy — the boxes that need it are precisely the ones already running.
# Every step is idempotent, so this is a no-op on the second deploy onward.
#
# Never fatal. A box that cannot install a timer should still finish its
# deploy; the worst case is the behaviour we had before it existed, which is
# that a newly published site waits for the next deploy for its certificate.
sync_units() {
  local unit_src="$APP_DIR/deploy"
  [ -f "$unit_src/rxnaija-sites.timer" ] || return 0
  command -v caddy >/dev/null 2>&1 || return 0

  # The script is executed by root out of the repo working tree, so its mode
  # has to survive a git checkout that did not preserve one.
  sudo chmod 0755 "$unit_src/sync-pharmacy-sites.sh" 2>/dev/null || true

  local changed=0
  local unit
  for unit in rxnaija-sites.service rxnaija-sites.timer; do
    if ! cmp -s "$unit_src/$unit" "/etc/systemd/system/$unit"; then
      sudo cp "$unit_src/$unit" "/etc/systemd/system/$unit" || return 0
      changed=1
    fi
  done

  if [ "$changed" = "1" ]; then
    say "Installing the pharmacy-site sync timer"
    sudo systemctl daemon-reload || return 0
  fi

  # --now covers the first install; on later runs the timer is already
  # active and this is a no-op that still repairs a disabled one.
  sudo systemctl enable --now rxnaija-sites.timer >/dev/null 2>&1 \
    || say "WARNING: could not enable rxnaija-sites.timer — publishing still works, but a new subdomain will wait for the next deploy"
}

sync_units

sync_caddy

exit 0
}
