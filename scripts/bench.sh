#!/usr/bin/env bash
# Benchmark the redirect hot path across a concurrency sweep.
#
# A single number at one concurrency level is not useful: it hides whether
# you are measuring the service or the machine. The sweep shows where
# queueing starts, which is the number that actually tells you when to add
# a replica.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a

HOST="${BENCH_HOST:-go.localhost}"
SLUG="${BENCH_SLUG:-}"
URL_BASE="http://127.0.0.1:${REDIRECT_PORT:-4001}"
DURATION="${BENCH_DURATION:-10}"

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

PG_URL="$(libpq_url "${DATABASE_URL:-}")"

if [ -z "$SLUG" ]; then
  SLUG=$(psql --dbname="$PG_URL" -tAc "
    SELECT l.slug FROM link l JOIN domain d ON d.id = l.domain_id
    WHERE d.hostname = '$HOST' AND l.archived_at IS NULL LIMIT 1;" 2>/dev/null | tr -d ' ')
fi
[ -n "$SLUG" ] || { echo "No slug to benchmark. Run 'make seed' first, or set BENCH_SLUG."; exit 1; }

echo "Benchmarking $URL_BASE/$SLUG (Host: $HOST), ${DURATION}s per level"
echo "CPUs available: $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '?')"
echo

# Warm the cache so this measures the hot path, not a cold start.
for _ in 1 2 3; do curl -sS -o /dev/null -H "Host: $HOST" "$URL_BASE/$SLUG"; done

printf '%-6s %-10s %-10s %-10s %-12s\n' "conn" "p50" "p97.5" "p99" "req/sec"
for C in 1 10 25 50 100; do
  OUT=$(npx -y autocannon -c "$C" -d "$DURATION" -H "Host: $HOST" --json "$URL_BASE/$SLUG" 2>/dev/null)
  printf '%-6s %-10s %-10s %-10s %-12s\n' "$C" \
    "$(echo "$OUT" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["latency"]["p50"])+"ms")')" \
    "$(echo "$OUT" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["latency"]["p97_5"])+"ms")')" \
    "$(echo "$OUT" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["latency"]["p99"])+"ms")')" \
    "$(echo "$OUT" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["requests"]["average"]))')"
done

echo
echo "Note: this enqueues a click per request. Clear the benchmark traffic with:"
echo "  redis-cli --scan --pattern 'bull:clicks:*' | xargs -r redis-cli del"
