#!/usr/bin/env bash
# Restore a dump over the live database.
#
# Destructive and deliberately awkward: it names the target, shows what is
# about to be destroyed, and requires the operator to type the database name.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a

DUMP="${1:-}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# Prisma's DATABASE_URL carries a `?schema=` parameter that libpq does not
# understand, so pg_dump/pg_restore/psql reject it outright. Strip Prisma-only
# parameters before handing the URL to any Postgres client tool.
libpq_url() {
  python3 - "$1" <<'PYEOF'
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
u = urlsplit(sys.argv[1])
PRISMA_ONLY = {"schema", "connection_limit", "pool_timeout", "pgbouncer",
               "socket_timeout", "connect_timeout_ms", "statement_cache_size"}
q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
     if k not in PRISMA_ONLY]
print(urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), "")))
PYEOF
}

PG_URL="$(libpq_url "$DATABASE_URL")"

if [ -z "$DUMP" ]; then
  echo "Usage: scripts/restore.sh <dump-file>"
  echo
  echo "Available dumps:"
  ls -1t "${BACKUP_DIR:-$ROOT/backups}"/mtlink-*.dump 2>/dev/null | head -20 || echo "  (none)"
  exit 1
fi

[ -f "$DUMP" ] || { echo "No such dump: $DUMP"; exit 1; }

DB_NAME="${PG_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"

echo "About to restore:"
echo "  from : $DUMP ($(du -h "$DUMP" | cut -f1), $(date -r "$DUMP" '+%Y-%m-%d %H:%M'))"
echo "  into : $DB_NAME"
echo
echo "Currently in $DB_NAME:"
psql --dbname="$PG_URL" -tAc "
  SELECT '  links: ' || (SELECT COUNT(*) FROM link)
      || ', clicks: ' || (SELECT COUNT(*) FROM click)
      || ', domains: ' || (SELECT COUNT(*) FROM domain);" 2>/dev/null || echo "  (empty or unreachable)"
echo
echo "ALL OF THAT WILL BE REPLACED. Every short link not in the dump stops resolving."
echo
read -r -p "Type the database name ($DB_NAME) to continue: " CONFIRM
[ "$CONFIRM" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }

echo "==> Restoring"
# --clean --if-exists drops existing objects first; without it the restore
# collides with the live schema.
pg_restore --dbname="$PG_URL" --clean --if-exists --no-owner --no-privileges --exit-on-error "$DUMP"

echo "==> Post-restore state"
psql --dbname="$PG_URL" -c "
  SELECT (SELECT COUNT(*) FROM link) AS links,
         (SELECT COUNT(*) FROM click) AS clicks,
         (SELECT COUNT(*) FROM domain) AS domains;"

echo "==> Ensuring click partitions and draining the default partition"
psql --dbname="$PG_URL" -tAc "SELECT mtlink_ensure_click_partitions(12, 6);" >/dev/null
psql --dbname="$PG_URL" -tAc "SELECT * FROM mtlink_drain_default_partition();" >/dev/null

echo
echo "Restored. Restart the services so they drop their caches:"
echo "  docker compose restart api redirect worker"
