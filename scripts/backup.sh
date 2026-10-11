#!/usr/bin/env bash
# Dump the database AND verify the dump restores.
#
# A backup you have never restored is a hypothesis, not a backup. This script
# restores every dump into a scratch database and checks the row counts match
# before it reports success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/mtlink-$STAMP.dump"

: "${DATABASE_URL:?DATABASE_URL must be set (copy .env.example to .env)}"

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

mkdir -p "$BACKUP_DIR"

echo "==> Dumping to $DUMP"
# -Fc (custom format) so pg_restore can do a selective or parallel restore.
pg_dump --dbname="$PG_URL" --format=custom --compress=6 --file="$DUMP"

SIZE=$(du -h "$DUMP" | cut -f1)
echo "    wrote $SIZE"

# ---------------------------------------------------------------------------
# Verify. This is the part people skip.
# ---------------------------------------------------------------------------
VERIFY_DB="mtlink_verify_$$"
ADMIN_URL="${PG_URL%/*}/postgres"

cleanup() {
  psql --dbname="$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Verifying by restoring into $VERIFY_DB"
psql --dbname="$ADMIN_URL" -q -c "CREATE DATABASE \"$VERIFY_DB\";"
VERIFY_URL="${PG_URL%/*}/$VERIFY_DB"

# A clean dump still emits notices about extensions and ownership; those are
# not failures, so only a non-zero exit from pg_restore --exit-on-error counts.
pg_restore --dbname="$VERIFY_URL" --no-owner --no-privileges --exit-on-error "$DUMP" >/dev/null

echo "==> Comparing row counts"
FAILED=0
for TABLE in tenant "user" domain link link_version click click_daily api_key; do
  SRC=$(psql --dbname="$PG_URL" -tAc "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "ERR")
  DST=$(psql --dbname="$VERIFY_URL"   -tAc "SELECT COUNT(*) FROM \"$TABLE\";" 2>/dev/null || echo "ERR")
  if [ "$SRC" = "$DST" ] && [ "$SRC" != "ERR" ]; then
    printf '    %-14s %8s  ok\n' "$TABLE" "$SRC"
  else
    printf '    %-14s source=%s restored=%s  MISMATCH\n' "$TABLE" "$SRC" "$DST"
    FAILED=1
  fi
done

# The partitioned click table is the one most likely to restore wrong, so
# check its partitions came back too, not just the total.
PARTS=$(psql --dbname="$VERIFY_URL" -tAc "
  SELECT COUNT(*) FROM pg_inherits i
  JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'click';")
echo "    click partitions restored: $PARTS"
[ "$PARTS" -gt 0 ] || { echo "    NO PARTITIONS RESTORED"; FAILED=1; }

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "VERIFICATION FAILED — the dump at $DUMP is not trustworthy."
  exit 1
fi

echo "==> Verified. $DUMP restores cleanly."

echo "==> Pruning dumps older than $RETAIN_DAYS days"
find "$BACKUP_DIR" -name 'mtlink-*.dump' -type f -mtime "+$RETAIN_DAYS" -print -delete || true

echo "Done."
