#!/usr/bin/env bash
# Check the project's acceptance criteria against a RUNNING stack.
#
# The point of this script is that the claims in the README are
# re-verifiable rather than a one-time assertion in a commit message. CI
# runs it on every push.
#
# Assumes: migrations applied, API on :4000, redirect on :4001, Postgres and
# Redis reachable. It seeds and cleans up its own data.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && set -a && . ./.env && set +a

API="${API_URL:-http://127.0.0.1:4000}"
RDR="${REDIRECT_URL:-http://127.0.0.1:4001}"

libpq_url() {
  python3 - "$1" <<'PYEOF'
import sys
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
u = urlsplit(sys.argv[1])
PRISMA_ONLY = {"schema", "connection_limit", "pool_timeout", "pgbouncer"}
q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k not in PRISMA_ONLY]
print(urlunsplit((u.scheme, u.netloc, u.path, urlencode(q), "")))
PYEOF
}
PG_URL="$(libpq_url "$DATABASE_URL")"
psqlq() { psql --dbname="$PG_URL" -tAc "$1" 2>/dev/null | tr -d ' '; }

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

EMAIL="acceptance-$$@test.invalid"
PASSWORD="acceptance-password-123456"
HOSTNAME_="acc-$$.test.invalid"
COOKIE="$(mktemp)"
cleanup() {
  rm -f "$COOKIE"
  psqlq "DELETE FROM click WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE 'acceptance-%');" >/dev/null
  psqlq "DELETE FROM tenant WHERE slug LIKE 'acceptance-%';" >/dev/null
}
trap cleanup EXIT

head_ "Setup"
REG=$(curl -sS -c "$COOKIE" -X POST "$API/api/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Acceptance\",\"tenantName\":\"acceptance-$$\"}")
echo "$REG" | grep -q '"tenant"' && ok "registered a tenant and owner" || { bad "registration failed: $REG"; exit 1; }

DOM=$(curl -sS -b "$COOKIE" -X POST "$API/api/v1/domains" -H 'content-type: application/json' \
  -d "{\"hostname\":\"$HOSTNAME_\",\"isDefault\":true}")
echo "$DOM" | grep -q '"hostname"' && ok "added domain $HOSTNAME_" || bad "domain creation failed: $DOM"

# ---------------------------------------------------------------------------
head_ "1. Services healthy"
for pair in "api $API" "redirect $RDR"; do
  set -- $pair
  C=$(curl -sS -o /dev/null -w '%{http_code}' "$2/health")
  [ "$C" = "200" ] && ok "$1 /health returns 200" || bad "$1 /health returned $C"
done
R=$(curl -sS "$API/api/v1/../../ready" 2>/dev/null || curl -sS "$API/ready")
echo "$R" | grep -q '"postgres":"ok"' && ok "api readiness reports Postgres ok" || bad "api readiness: $R"
echo "$R" | grep -q '"redis":"ok"'    && ok "api readiness reports Redis ok"    || bad "api readiness: $R"

# ---------------------------------------------------------------------------
head_ "2. Seed data present"
LINKS=$(psqlq "SELECT count(*) FROM link;")
[ "${LINKS:-0}" -ge 1 ] && ok "database holds $LINKS link(s)" || bad "no links found"

# ---------------------------------------------------------------------------
head_ "3. Dashboard and API agree on creation"
A=$(curl -sS -b "$COOKIE" -X POST "$API/api/v1/links" -H 'content-type: application/json' \
  -d '{"slug":"via-api","destination":"https://example.com/api-created"}')
AID=$(echo "$A" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$AID" ] && ok "created a link over the REST API" || bad "API creation failed: $A"

GOT=$(curl -sS -b "$COOKIE" "$API/api/v1/links/$AID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["destination"])' 2>/dev/null)
[ "$GOT" = "https://example.com/api-created" ] && ok "read back the same destination" || bad "read back '$GOT'"

# ---------------------------------------------------------------------------
head_ "4. A destination edit is live on the very next redirect"
curl -sS -o /dev/null -H "Host: $HOSTNAME_" "$RDR/via-api"
curl -sS -o /dev/null -H "Host: $HOSTNAME_" "$RDR/via-api"
WARM=$(curl -sS -o /dev/null -D- -H "Host: $HOSTNAME_" "$RDR/via-api" | grep -i '^x-mtlink-cache' | tr -d '\r' | awk '{print $2}')
note "cache layer before the edit: ${WARM:-n/a}"

curl -sS -o /dev/null -b "$COOKIE" -X PATCH "$API/api/v1/links/$AID" -H 'content-type: application/json' \
  -d '{"destination":"https://example.com/EDITED"}'

LOC=$(curl -sS -o /dev/null -D- -H "Host: $HOSTNAME_" "$RDR/via-api" | grep -i '^location' | tr -d '\r' | awk '{print $2}')
[ "$LOC" = "https://example.com/EDITED" ] \
  && ok "next request served the new destination (no sleep, no TTL wait)" \
  || bad "next request served '$LOC'"

# A slug rename must stop the OLD address resolving.
curl -sS -o /dev/null -H "Host: $HOSTNAME_" "$RDR/via-api"
curl -sS -o /dev/null -b "$COOKIE" -X PATCH "$API/api/v1/links/$AID" -H 'content-type: application/json' -d '{"slug":"renamed-api"}'
OLDC=$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: $HOSTNAME_" "$RDR/via-api")
NEWC=$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: $HOSTNAME_" "$RDR/renamed-api")
[ "$OLDC" = "404" ] && ok "the old slug 404s after a rename" || bad "old slug returned $OLDC"
[ "$NEWC" = "302" ] && ok "the new slug resolves"            || bad "new slug returned $NEWC"

# ---------------------------------------------------------------------------
head_ "5. Redirect latency (cache hit)"
if command -v npx >/dev/null 2>&1; then
  J=$(npx -y autocannon -c 10 -d 5 -H "Host: $HOSTNAME_" --json "$RDR/renamed-api" 2>/dev/null)
  if [ -n "$J" ]; then
    P99=$(echo "$J" | python3 -c 'import json,sys;print(json.load(sys.stdin)["latency"]["p99"])')
    RPS=$(echo "$J" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["requests"]["average"]))')
    note "p99 ${P99}ms at 10 connections, ${RPS} req/s (CPUs: $(nproc 2>/dev/null || echo '?'))"
    python3 -c "import sys; sys.exit(0 if $P99 < 20 else 1)" \
      && ok "p99 under 20ms at 10 connections" \
      || bad "p99 was ${P99}ms at 10 connections"
  else
    note "autocannon unavailable, skipping"
  fi
fi

# ---------------------------------------------------------------------------
head_ "6. Degradation"
if command -v redis-cli >/dev/null 2>&1 && [ "${SKIP_REDIS_KILL:-}" != "1" ]; then
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  sleep 2
  DOWN_OK=0
  for _ in 1 2 3 4 5; do
    C=$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: $HOSTNAME_" "$RDR/renamed-api")
    [ "$C" = "302" ] && DOWN_OK=$((DOWN_OK+1))
  done
  [ "$DOWN_OK" = "5" ] && ok "redirects keep working with Redis down (5/5)" || bad "only $DOWN_OK/5 succeeded with Redis down"
  redis-server --daemonize yes --port 6379 --bind 127.0.0.1 --save '' --appendonly no >/dev/null 2>&1 || true
  sleep 2
  redis-cli ping >/dev/null 2>&1 && note "Redis restarted" || note "Redis did not restart — later checks may be affected"
else
  note "skipping the Redis-down check (SKIP_REDIS_KILL=1 or redis-cli missing)"
fi

# ---------------------------------------------------------------------------
head_ "7. SSRF guard"
SSRF_FAIL=0
for u in "http://127.0.0.1" "http://169.254.169.254/latest/meta-data/" "http://localhost" \
         "http://10.0.0.1/" "http://db.internal" "file:///etc/passwd"; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE" -X POST "$API/api/v1/links" \
      -H 'content-type: application/json' -d "{\"destination\":\"$u\"}")
  [ "$C" = "422" ] || { bad "accepted $u (HTTP $C)"; SSRF_FAIL=1; }
done
[ "$SSRF_FAIL" = "0" ] && ok "all SSRF probes rejected with 422"

# ---------------------------------------------------------------------------
head_ "8. Analytics"
S=$(curl -sS -b "$COOKIE" "$API/api/v1/analytics/summary")
echo "$S" | grep -q '"clicks"' && ok "analytics summary responds" || bad "summary: $S"
for d in country device browser; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE" "$API/api/v1/analytics/breakdown/$d")
  [ "$C" = "200" ] && ok "breakdown/$d responds" || bad "breakdown/$d returned $C"
done

# ---------------------------------------------------------------------------
head_ "9. Reserved slugs"
RES_FAIL=0
for s in api admin health metrics robots.txt login; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE" -X POST "$API/api/v1/links" \
      -H 'content-type: application/json' -d "{\"slug\":\"$s\",\"destination\":\"https://example.com\"}")
  [ "$C" = "422" ] || { bad "allowed reserved slug '$s' (HTTP $C)"; RES_FAIL=1; }
done
[ "$RES_FAIL" = "0" ] && ok "all reserved slugs rejected"

# ---------------------------------------------------------------------------
head_ "10. Data integrity"
DEF=$(psqlq "SELECT count(*) FROM click_default;")
[ "${DEF:-0}" = "0" ] && ok "click_default is empty (partition routing healthy)" || bad "$DEF rows stranded in click_default"

VERS=$(psqlq "SELECT count(*) FROM link_version WHERE link_id = '$AID';")
[ "${VERS:-0}" -ge 3 ] && ok "version history recorded $VERS entries for the edited link" || bad "only $VERS version rows"

# ---------------------------------------------------------------------------
printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
