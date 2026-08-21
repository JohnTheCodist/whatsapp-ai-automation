#!/usr/bin/env bash
#
# One-time provisioning for a fresh Oracle Cloud Always Free VM
# (Ubuntu 22.04/24.04, ARM Ampere or x86 — both work).
#
# Run as a user with sudo, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/JohnTheCodist/whatsapp-ai-automation/main/deploy/setup.sh | bash
# or, having cloned already:
#   bash deploy/setup.sh
#
# WHAT THIS DOES NOT DO
# It does not write .env.production and it does not start the service. Both
# need secrets, and a script that prompts for a database URL and an encryption
# key leaves them in shell history. The last step prints exactly what to fill
# in by hand.
set -euo pipefail

REPO="https://github.com/JohnTheCodist/whatsapp-ai-automation.git"
APP_DIR="/opt/rxnaija"
APP_USER="rxnaija"
NODE_MAJOR="22" # package.json requires >= 22.12

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- packages --
say "Updating packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg

# ------------------------------------------------------------------- swap ---
# The client build is the only genuinely memory-hungry thing this box does.
# Vite/Rollup routinely peaks past 800MB, and on a 1GB VPS with no swap the
# kernel OOM-kills it — which surfaces as a build that dies with no error
# anyone can act on, rather than as "out of memory".
#
# Runtime is much lighter: Node and Express ~80MB, the NAFDAC indexes ~40MB,
# and roughly 100-150MB per connected WhatsApp socket. A 1GB box runs several
# pharmacies fine. It is only the twice-a-week build that needs the headroom,
# which is exactly what swap is for — slow is fine for something that is not
# in the request path.
#
# Skipped when swap already exists or on a box with plenty of RAM, so this is
# safe to re-run.
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
if [ "$SWAP_MB" -lt 512 ] && [ "$MEM_MB" -lt 3000 ]; then
  say "Adding 2G swap (RAM: ${MEM_MB}MB) so the client build cannot be OOM-killed"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Prefer RAM heavily: swap here is a safety net for build spikes, not a
  # place to page the running app's working set to. The default of 60 would
  # push a live WhatsApp socket's memory to disk and make replies sluggish.
  sudo sysctl -q vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
else
  say "Swap already present or ample RAM — skipping"
fi

# ------------------------------------------------------------------- node ---
# NodeSource rather than apt's node: Ubuntu ships 18/20, and this app requires
# 22.12+. Installing the wrong major fails at startup with a syntax error that
# looks like a code bug rather than an environment one.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  say "Installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
say "Node $(node -v)"

# ------------------------------------------------------------------ caddy ---
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy"
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

# ------------------------------------------------------------------- user ---
# A system account with no login shell. The app has no reason to be a person.
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  say "Creating service user ${APP_USER}"
  sudo useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# ------------------------------------------------------------------- code ---
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin main
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet origin/main
else
  say "Cloning into ${APP_DIR}"
  sudo mkdir -p "$APP_DIR"
  sudo chown "$APP_USER:$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone --quiet "$REPO" "$APP_DIR"
fi

# ---------------------------------------------------------------- firewall --
# Two clouds, two different problems, and getting this wrong looks identical
# in both: Caddy cannot complete the ACME challenge, so TLS never issues and
# the site appears to hang forever rather than erroring.
#
#   Oracle — ships iptables with a default-deny INPUT chain AND blocks 80/443
#            at the cloud Security List. Both layers must be opened.
#   GCP    — leaves the OS firewall open; only the VPC rule matters, and that
#            is the "Allow HTTP/HTTPS traffic" checkbox at instance creation.
#
# So the host-level rule is applied only where something is actually blocking.
# Adding it unconditionally on GCP would be a no-op that still installs
# iptables-persistent for no reason.
if sudo iptables -S INPUT 2>/dev/null | grep -q -- '-P INPUT DROP'; then
  say "Host firewall is default-deny — opening 80/443"
  sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
  if command -v netfilter-persistent >/dev/null 2>&1; then
    sudo netfilter-persistent save || true
  else
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent || true
  fi
else
  say "Host firewall already permits inbound — nothing to open here"
  echo "    (On GCP make sure the instance has the HTTP/HTTPS firewall tags,"
  echo "     or TLS will never issue however correct this box is.)"
fi

# ------------------------------------------------------------------ units ---
say "Installing systemd unit and Caddyfile"
sudo cp "$APP_DIR/deploy/rxnaija.service" /etc/systemd/system/rxnaija.service
sudo cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload

cat <<'NEXT'

──────────────────────────────────────────────────────────────
Provisioning done. Three things left, and they need your keys.

1. Write the environment file (root-owned, service-readable):

     sudo -e /opt/rxnaija/.env.production

   Paste, filling in the values from your local server/.env:

     NODE_ENV=production
     PORT=4000
     DEV_AUTH_BYPASS=false
     DATABASE_URL=...
     SUPABASE_URL=...
     SUPABASE_SERVICE_ROLE_KEY=...
     SESSION_ENCRYPTION_KEY=...
     LLM_API_KEY=...
     VITE_SUPABASE_URL=...
     VITE_SUPABASE_ANON_KEY=...

   Then lock it down:

     sudo chown root:rxnaija /opt/rxnaija/.env.production
     sudo chmod 640 /opt/rxnaija/.env.production

2. Build and migrate (VITE_* must be set — Vite inlines them at build time):

     cd /opt/rxnaija
     sudo -u rxnaija --preserve-env bash -c 'set -a; . ./.env.production; set +a; npm install && npm run build && npm run migrate'

3. Start everything:

     sudo systemctl enable --now rxnaija
     sudo systemctl reload caddy
     sudo systemctl status rxnaija --no-pager

Then point DNS: an A record for app.rxnaija.com at this box's public IP.
Caddy issues TLS on the first request once DNS resolves.

Logs:  sudo journalctl -u rxnaija -f
──────────────────────────────────────────────────────────────
NEXT
