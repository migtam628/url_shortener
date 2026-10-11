#!/usr/bin/env bash
#
# MT Link — Debian 12 VPS bootstrap.
#
# Idempotent: safe to re-run. It never overwrites an existing .env, never
# regenerates secrets that already exist, and never replaces a working
# nginx or Docker install.
#
#   sudo bash scripts/bootstrap-vps.sh --domain go.example.com --email you@example.com
#
# Flags:
#   --domain      short-link hostname (required)
#   --app-domain  dashboard hostname (default: app.<registrable part of --domain>)
#   --email       email for Let's Encrypt (required unless --no-tls)
#   --no-tls      skip certificate issuance (use when behind Cloudflare proxy
#                 with its own origin certificate, or for a dry run)
#   --dir         install directory (default: /opt/mt-link)
#   --dry-run     print what would happen and change nothing
#
set -euo pipefail

DOMAIN=""; APP_DOMAIN=""; EMAIL=""; NO_TLS=0; DRY=0
INSTALL_DIR="/opt/mt-link"
REPO="https://github.com/migtam628/url_shortener.git"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --app-domain) APP_DOMAIN="$2"; shift 2 ;;
    --email)      EMAIL="$2"; shift 2 ;;
    --dir)        INSTALL_DIR="$2"; shift 2 ;;
    --no-tls)     NO_TLS=1; shift ;;
    --dry-run)    DRY=1; shift ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '     would run: %s\n' "$*"; else eval "$@"; fi; }

[ -n "$DOMAIN" ] || die "--domain is required (e.g. --domain go.mttechservices.com)"
[ "$NO_TLS" = 1 ] || [ -n "$EMAIL" ] || die "--email is required unless --no-tls"
[ "$(id -u)" = 0 ] || die "Run with sudo."

if [ -z "$APP_DOMAIN" ]; then
  APP_DOMAIN="app.$(echo "$DOMAIN" | awk -F. '{ if (NF>2) { for(i=NF-1;i<=NF;i++) printf "%s%s", $i, (i<NF?".":"") } else print $0 }')"
fi

cat <<BANNER

  MT Link bootstrap
  -----------------
  short domain : $DOMAIN
  dashboard    : $APP_DOMAIN
  install dir  : $INSTALL_DIR
  TLS          : $([ "$NO_TLS" = 1 ] && echo "skipped" || echo "Let's Encrypt ($EMAIL)")
  mode         : $([ "$DRY" = 1 ] && echo "DRY RUN — nothing will change" || echo "live")

BANNER

# ---------------------------------------------------------------------------
# 0. Preflight — fail before changing anything
# ---------------------------------------------------------------------------
log "Preflight"

. /etc/os-release 2>/dev/null || true
echo "    OS: ${PRETTY_NAME:-unknown}"
case "${ID:-}" in
  debian|ubuntu) ;;
  *) warn "This script targets Debian/Ubuntu. Continuing, but apt steps may fail." ;;
esac

# Port conflicts are the single most common first-run failure on a box that
# is already doing something. Check before installing anything.
CONFLICT=0
for PORT in 80 443; do
  if ss -lntp 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
    OWNER=$(ss -lntp 2>/dev/null | grep -E "[:.]$PORT\s" | head -1 | sed 's/.*users:((//;s/).*//')
    warn "port $PORT is already in use by: ${OWNER:-unknown}"
    CONFLICT=1
  fi
done
if [ "$CONFLICT" = 1 ]; then
  warn "MT Link's nginx needs 80 and 443. Either stop the service holding them,"
  warn "or edit docker-compose.yml to publish different ports and put your"
  warn "existing reverse proxy in front. Re-run when resolved."
  [ "$DRY" = 1 ] || die "Aborting rather than fighting over ports."
fi

# DNS check — a cert request against a domain that does not point here just
# burns Let's Encrypt rate limit.
if [ "$NO_TLS" = 0 ]; then
  PUBIP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo "")
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo "")
  echo "    this host : ${PUBIP:-unknown}"
  echo "    $DOMAIN -> ${RESOLVED:-NXDOMAIN}"
  if [ -n "$PUBIP" ] && [ "$PUBIP" != "$RESOLVED" ]; then
    warn "$DOMAIN does not resolve to this host."
    warn "If you are behind Cloudflare's proxy that is expected — use --no-tls"
    warn "and an origin certificate. Otherwise fix DNS first."
  fi
fi

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
echo "    RAM: ${MEM_MB}MB, CPUs: $(nproc)"
[ "$MEM_MB" -ge 1800 ] || warn "Under 2GB RAM. Postgres + Redis + 3 Node services will be tight."

[ "$DRY" = 1 ] && { log "Dry run complete. Nothing changed."; exit 0; }

# ---------------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------------
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
run "apt-get update -qq"
run "apt-get install -y -qq ca-certificates curl git gnupg ufw postgresql-client jq"

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker already present ($(docker --version))"
else
  log "Installing Docker Engine and the compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

# ---------------------------------------------------------------------------
# 3. Service user and checkout
# ---------------------------------------------------------------------------
if ! id mtlink >/dev/null 2>&1; then
  log "Creating the mtlink service user"
  useradd --system --create-home --home-dir /var/lib/mtlink --shell /usr/sbin/nologin mtlink
fi
usermod -aG docker mtlink 2>/dev/null || true

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating the existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
  log "Cloning into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# 4. Environment — generate real secrets, exactly once
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  log ".env already exists — leaving it alone"
else
  log "Generating .env with fresh secrets"
  PG_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
  SESSION_SECRET=$(openssl rand -base64 48)
  IP_HASH_SECRET=$(openssl rand -base64 32)

  cp .env.example .env
  python3 - "$PG_PASS" "$SESSION_SECRET" "$IP_HASH_SECRET" "$DOMAIN" "$APP_DOMAIN" <<'PYEOF'
import re, sys
pg, sess, iph, domain, app = sys.argv[1:6]
s = open('.env').read()
def setkv(s, k, v):
    return re.sub(rf'(?m)^{re.escape(k)}=.*$', f'{k}={v}', s)
s = setkv(s, 'NODE_ENV', 'production')
s = setkv(s, 'POSTGRES_PASSWORD', pg)
s = setkv(s, 'DATABASE_URL', f'postgresql://mtlink:{pg}@postgres:5432/mtlink?schema=public')
s = setkv(s, 'SESSION_SECRET', sess)
s = setkv(s, 'IP_HASH_SECRET', iph)
s = setkv(s, 'COOKIE_SECURE', 'true')
s = setkv(s, 'ALLOW_REGISTRATION', 'true')   # tightened after the first account
s = setkv(s, 'APP_ORIGIN', f'https://{app}')
s = setkv(s, 'API_PUBLIC_URL', f'https://{app}')
s = setkv(s, 'SHORT_DOMAINS', domain)
s = setkv(s, 'TRUST_PROXY_HOPS', '1')
open('.env','w').write(s)
PYEOF
  chmod 600 .env
  echo "    secrets written to $INSTALL_DIR/.env (mode 600)"
fi

# Point the shipped nginx config at the real hostnames.
log "Configuring nginx server names"
sed -i "s/server_name app\.localhost app\.mt\.lc;/server_name $APP_DOMAIN;/" nginx/conf.d/10-app.conf

# ---------------------------------------------------------------------------
# 5. Certificates
# ---------------------------------------------------------------------------
mkdir -p nginx/certs
if [ "$NO_TLS" = 1 ]; then
  log "Skipping TLS; generating a placeholder so nginx can start"
  bash scripts/dev-certs.sh || true
  warn "Replace nginx/certs/dev-*.pem with your real certificate before going live."
else
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    log "Existing Let's Encrypt certificate found for $DOMAIN"
  else
    log "Requesting certificates for $DOMAIN and $APP_DOMAIN"
    apt-get install -y -qq certbot
    # Standalone needs port 80 free; the stack is not up yet, so it is.
    certbot certonly --standalone --non-interactive --agree-tos \
      --email "$EMAIL" -d "$DOMAIN" -d "$APP_DOMAIN" || \
      warn "certbot failed — check DNS. Continuing with a self-signed placeholder."
  fi
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" nginx/certs/dev-fullchain.pem
    cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   nginx/certs/dev-privkey.pem
  else
    bash scripts/dev-certs.sh || true
  fi
fi
chmod 600 nginx/certs/*.pem 2>/dev/null || true

# ---------------------------------------------------------------------------
# 6. Firewall
# ---------------------------------------------------------------------------
log "Configuring ufw"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
# Postgres and Redis are reachable only inside the Docker network. The dev
# compose file publishes them to the host; production must not.
ufw --force enable >/dev/null
echo "    open: 22, 80, 443 (Postgres and Redis stay internal)"

# ---------------------------------------------------------------------------
# 7. Build and start
# ---------------------------------------------------------------------------
chown -R mtlink:mtlink "$INSTALL_DIR"

log "Building images (first run takes a few minutes)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

log "Starting the stack"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

log "Waiting for the API to become healthy"
for i in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "    healthy after ${i}s"; break
  fi
  [ "$i" = 60 ] && { docker compose logs --tail=40 api; die "API did not become healthy."; }
  sleep 1
done

log "Applying migrations"
docker compose exec -T api npm run migrate

# ---------------------------------------------------------------------------
# 8. Scheduled maintenance
# ---------------------------------------------------------------------------
log "Installing systemd timers for backups and GeoIP refresh"
cat > /etc/systemd/system/mtlink-backup.service <<UNIT
[Unit]
Description=MT Link database backup (dump and verify)
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash $INSTALL_DIR/scripts/backup.sh
UNIT

cat > /etc/systemd/system/mtlink-backup.timer <<'UNIT'
[Unit]
Description=Nightly MT Link backup

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/mtlink-geoip.service <<UNIT
[Unit]
Description=Refresh MaxMind GeoLite2
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash $INSTALL_DIR/scripts/update-geoip.sh
ExecStartPost=/usr/bin/docker compose -f $INSTALL_DIR/docker-compose.yml restart worker
UNIT

cat > /etc/systemd/system/mtlink-geoip.timer <<'UNIT'
[Unit]
Description=Weekly GeoLite2 refresh

[Timer]
OnCalendar=Wed 04:23:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now mtlink-backup.timer mtlink-geoip.timer >/dev/null

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<DONE

  Done.

  Dashboard   https://$APP_DOMAIN
  Short links https://$DOMAIN/<slug>

  Next, in order:

   1. Create your account at https://$APP_DOMAIN  (registration is open)
   2. Lock it down:
        cd $INSTALL_DIR
        sed -i 's/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/' .env
        docker compose restart api
   3. Add $DOMAIN as a domain in the dashboard and make it default.
   4. Optional — enable geo analytics:
        put MAXMIND_LICENSE_KEY in .env, then: bash scripts/update-geoip.sh
   5. Confirm it all works:
        bash scripts/verify-acceptance.sh

  Backups run nightly at ~03:17 and verify themselves by restoring into a
  scratch database. Check with:  systemctl list-timers 'mtlink-*'

  Logs:     docker compose logs -f
  Restart:  docker compose -f docker-compose.yml -f docker-compose.prod.yml restart

DONE
