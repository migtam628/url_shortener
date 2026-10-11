#!/usr/bin/env bash
# Download or refresh the MaxMind GeoLite2 City database.
#
# The database is not in the repo: MaxMind's licence forbids redistribution
# and it is ~60MB. Without it the worker still runs and clicks are still
# recorded — the country/region/city columns just stay null.
#
# Get a free licence key at https://www.maxmind.com/en/geolite2/signup
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a

TARGET_DIR="${GEOIP_DIR:-$ROOT/geoip}"
TARGET="$TARGET_DIR/GeoLite2-City.mmdb"

if [ -z "${MAXMIND_LICENSE_KEY:-}" ]; then
  cat <<'MSG'
MAXMIND_LICENSE_KEY is not set.

Geo data is optional — everything works without it, clicks simply have no
country, region or city. To enable it:

  1. Sign up free at https://www.maxmind.com/en/geolite2/signup
  2. Create a licence key
  3. Put it in .env as MAXMIND_LICENSE_KEY=...
  4. Run this script again

MSG
  exit 0
fi

mkdir -p "$TARGET_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz"

echo "==> Downloading GeoLite2-City"
curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$TMP/geoip.tar.gz" || {
  echo "Download failed. Check that MAXMIND_LICENSE_KEY is valid."
  exit 1
}

echo "==> Extracting"
tar -xzf "$TMP/geoip.tar.gz" -C "$TMP"
FOUND="$(find "$TMP" -name 'GeoLite2-City.mmdb' -type f | head -1)"
[ -n "$FOUND" ] || { echo "No .mmdb found in the archive."; exit 1; }

# Write to a temp name and move into place, so a reader never sees a
# half-written file.
mv "$FOUND" "$TARGET.new"
mv "$TARGET.new" "$TARGET"

echo "==> Installed $TARGET ($(du -h "$TARGET" | cut -f1))"
echo
echo "Restart the worker to load it:  docker compose restart worker"
echo "Refresh weekly — MaxMind updates GeoLite2 every Tuesday."
