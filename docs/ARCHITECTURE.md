# Architecture

How MT Link is put together, why, and where the unbuilt parts attach.

---

## 1. Why two services

The redirect path and the management API have opposite shapes. A redirect is
one indexed read and a 302, served thousands of times a second, and its
worst failure is latency. The API is a handful of writes a minute, and its
worst failure is corrupting a link.

Running them in one process means a slow analytics query, a large CSV
import, or an Open Graph fetch holding the event loop while someone's QR
code is being scanned. They are split so the redirect service can be scaled,
restarted and reasoned about on its own.

The split is visible in the images: the redirect container has no Prisma
engine, no argon2 binary and no QR renderer.

---

## 2. The redirect hot path

```
GET /<slug>  Host: <hostname>
     │
     ├─ reserved path?  ──▶ 404 (no database touched)
     │
     ├─ in-process LRU  ──▶ hit: ~0.1ms
     │
     ├─ Redis           ──▶ hit: ~0.5ms, fills the LRU
     │
     └─ Postgres        ──▶ ~1-2ms, fills both
                              │
                              ├─ enqueue click (never awaited)
                              └─ 302 + Location
```

### Why three layers

The LRU gets p99 under a millisecond and survives Redis being down. Redis
shares cache fills between replicas, so a newly started instance is not cold
for every slug. Postgres is the truth.

Both cache layers are strictly optional. This is the single most important
property of `services/redirect/src/cache.ts`: every Redis call is wrapped so
a failure falls through to Postgres. The Redis client is configured with
`enableOfflineQueue: false` and a 250ms command timeout precisely so a
reconnecting Redis fails fast instead of making redirects wait.

Verified: killing Redis entirely leaves redirects working, including for
slugs that were never in the local LRU.

### Negative caching

A missing slug is cached too, for 30 seconds. Without it, a mistyped or
retired link that gets hammered becomes a steady stream of Postgres reads.
The TTL is short because a slug that does not exist now very often exists in
a minute — somebody is in the middle of creating it.

### Click emission

`enqueueClick` returns `void` and is never awaited. The reply is already on
its way when the job is pushed. If the queue is unreachable the click is
counted as dropped and nothing else happens.

Verified: with the worker stopped, 20 redirects succeeded and exactly 20
jobs accumulated in the queue; restarting the worker drained all 20 with
none lost.

---

## 3. Cache invalidation

The correctness story of the whole product. The sequence on any write:

1. **`DEL` the Redis keys** — authoritative. Any instance that misses the
   next step still gets a cache miss and re-reads from Postgres.
2. **`PUBLISH` on `link:invalidate`** — fast. Each redirect instance drops
   its in-process LRU entry immediately.

Order matters, and so does the fact that step 1 cannot be skipped. Redis
pub/sub has no delivery guarantee. Because the keys are already gone, the
worst case from a dropped message is bounded by `LRU_TTL_MS` (60s default)
on one instance, instead of `REDIS_LINK_TTL` (300s) across all of them.

Invalidation happens **after** the transaction commits. Invalidating first
would let a concurrent redirect re-populate the cache from the pre-commit
row — a subtle bug that looks like random staleness.

### The rename case

When a slug or domain changes, **both** keys must be dropped. Miss the old
one and the old short URL keeps serving the old destination out of cache
until its TTL expires. That is what the `previous` field on the
invalidation message is for, and there is a dedicated test for it.

### What the API does when invalidation fails

Logs loudly and lets the write succeed. A failed invalidation must not fail
the user's edit; the LRU TTL bounds the damage.

---

## 4. Data model notes

### Click partitioning

`click` is `PARTITION BY RANGE (ts)`, monthly. The primary key is
`(id, ts)` because a partitioned table's key must contain the partition key.

- `mtlink_create_click_partition(date)` — idempotent, creates one month.
- `mtlink_ensure_click_partitions(ahead, back)` — provisions a window.
- `mtlink_drain_default_partition()` — rescues stranded rows.
- `click_default` — catches anything outside the window so a row is never
  lost.

**Provision backwards as well as forwards.** A click's `ts` is when the
redirect happened, not when the worker wrote it. A queue backlog crossing a
month boundary, a replayed dead-letter job, or an imported history all
produce rows dated in a previous month. The original implementation only
went forward, and 537 of 936 seeded clicks ended up in `click_default` —
not lost, but invisible to partition pruning.

Postgres refuses to create a partition whose range overlaps rows held by the
default, so `mtlink_drain_default_partition` lifts the rows out first,
creates the partitions, then re-inserts — all in one transaction, so a click
is never in neither place.

**Alert on `click_default` being non-empty.** It means the partition job has
stopped or data arrived outside the window.

### Rollups

`click_daily` is a pre-aggregate by day, link, country and device. Analytics
ranges of 30 days or less read raw partitions (live to the second); longer
ranges read the rollup. The cutover is invisible to the caller except for a
`source` field in the response.

`mtlink_rollup_day(date)` deletes and reinserts that day, so running it
twice is a no-op rather than a double count. That property is what makes
backfill after an outage completely safe.

### Why `link.click_count` is denormalized

So the dashboard list does not aggregate the clicks table on every page
load. The worker increments it per batch, excluding bots. It is a
convenience counter, not the source of truth — analytics always read
`click`.

---

## 5. Privacy

Raw IPs never reach storage. The worker computes:

```
ipHash = HMAC-SHA256(IP_HASH_SECRET, "YYYY-MM-DD" ‖ tenantId ‖ ip)[:22]
```

The daily rotation is the point: within a day you can count unique
visitors; after midnight UTC the value stops being linkable to anything.
Mixing in the tenant id stops cross-tenant correlation if the table is ever
exported.

---

## 6. Phase 2 seams

Each of these has an interface on the hot path with a pass-through
implementation. They are deliberately not half-written: a partially-correct
rule engine serving live redirects is worse than none.

### 6.1 Rules engine — `services/redirect/src/rules.ts`

`resolveDestination(link, ctx)` is already called on every request and
currently returns `link.destination`.

To implement:

- Load `link_rule` rows into the cached `ResolvedLink` (one extra join on
  cache fill — it must not add a query per request).
- Evaluate in ascending `priority`; first match wins; no match falls through
  to `link.destination`.
- `country` / `region` need GeoIP **on the redirect path**, which it does
  not have today. Prefer the CDN's country header (`CF-IPCountry` is already
  read into `ctx`) over loading a 60MB mmdb into every redirect replica.
- `device` / `os` need UA parsing on the hot path. Benchmark first:
  `ua-parser-js` is not free at 6k req/s. A cheap substring pre-filter that
  only falls back to the full parser on a miss is likely the right shape.
- **A/B is the one with a trap.** A returning visitor must get the same
  variant or the test measures nothing. Weighted random for a visitor with
  no assignment, then set a sticky cookie; honour `ctx.abAssignment` when
  present. `RuleOutcome.setAbCookie` already exists for this.
- Record the matching rule in `click.rule_id` — the column is there and the
  redirect service already passes `ruleId` through.

### 6.2 Security gate — `checkSecurity(link, ctx)`

The `link_security` table exists and is already cached on `ResolvedLink`.

- **Password**: serve an interstitial; on success set a signed cookie scoped
  to that link. Never put the password in a query parameter.
- **Expiry / click limit**: check `expiresAt` and `maxClicks`, redirect to
  `expiredRedirect` or 404. The click counter here is best-effort under
  concurrency; do not promise an exact cap.
- **Cloaking**: an iframe wrapper. Document that it breaks on any site
  sending `X-Frame-Options` or `frame-ancestors`, which is most of them now.
- **Referrer hiding**: a `<meta name="referrer">` interstitial.

### 6.3 Automatic TLS per customer domain

The hard part of the whole product, and the reason `domain.certStatus`,
`certLastError` and `certRenewAt` already exist.

Sketch:

- A small issuer process watches for `certStatus = 'pending'` with
  `verifiedAt` set.
- Verify the CNAME actually points here before asking Let's Encrypt for
  anything — a failed challenge burns rate limit.
- `lego` with HTTP-01. nginx already serves `/.well-known/acme-challenge/`
  from a shared volume (`nginx/conf.d/00-common.conf`).
- Write the cert pair to the shared `nginx/certs` volume, then reload nginx
  on a debounce — never once per domain.
- Drive `certStatus` as a state machine with backoff on failure.
- **Respect the limits**: 50 certificates per registered domain per week,
  and 5 duplicate certificates per week. Exceeding them locks you out for
  days. Use the staging endpoint while developing this.
- nginx needs `ssl_certificate` chosen per SNI. Either generate one server
  block per domain from a template, or use `ssl_certificate_by_lua` with
  OpenResty. The catch-all block in `20-short.conf` is where this plugs in.

Until then: issue manually and drop the pair into `nginx/certs`.

```bash
lego --email you@example.com --domains go.customer.com \
     --path ./nginx/certs --http --http.webroot /var/www/acme run
```

### 6.4 Abuse screening

A hook on link creation, before the row is written. Google Safe Browsing
Update API, a domain blocklist, and per-key rate limits.

This is not optional for a publicly reachable instance. A short domain that
gets flagged stops resolving in Chrome and Gmail **for every link you have
ever issued**, including the printed ones.

---

## 7. Things deliberately not done

- **No ORM on the redirect path.** Two hand-written statements against a
  unique index. Prisma's client would add startup cost and an engine binary
  to an image whose whole job is to be small and fast.
- **No charting library in the dashboard.** One series of daily counts does
  not justify 90KB on a page that should load instantly.
- **No `/metrics` authentication by default.** It is not routed publicly by
  the shipped nginx config. `METRICS_TOKEN` exists if you expose it.
- **Liveness does not check dependencies.** `/health` reports process
  health only; `/ready` checks Postgres and Redis. If liveness checked the
  database, a brief Postgres blip would make the orchestrator kill redirect
  pods that were still serving correctly from cache.
