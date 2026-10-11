# Deployment

Target: a Debian 12 VPS behind Cloudflare. Everything also runs on Apple
Silicon macOS for local work — the images are multi-arch and nothing depends
on x86.

---

## The short version

```bash
ssh you@your-vps
git clone https://github.com/migtam628/url_shortener.git
sudo bash url_shortener/scripts/bootstrap-vps.sh \
  --domain go.yourdomain.com \
  --email you@yourdomain.com
```

Run it with `--dry-run` first. It checks the things that actually break a
first deploy — port 80/443 already in use, DNS not pointing here, not enough
RAM — and exits without touching anything.

The script is idempotent. Re-running it updates the checkout and restarts
the stack; it will not overwrite an existing `.env` or regenerate secrets.

---

## What the bootstrap does

1. **Preflight.** Refuses to continue if something else holds 80 or 443,
   warns if DNS does not resolve here, reports RAM and CPU count.
2. **Packages and Docker.** Docker Engine plus the compose plugin from
   Docker's own repository, not the distro's older packages.
3. **Service user.** A system user `mtlink`, in the `docker` group, owning
   the install directory.
4. **Secrets.** Generates `POSTGRES_PASSWORD`, `SESSION_SECRET` and
   `IP_HASH_SECRET` with `openssl rand`, writes `.env` at mode 600, and sets
   `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`.
5. **Certificates.** certbot standalone for the short domain and the
   dashboard domain, or a self-signed placeholder with `--no-tls`.
6. **Firewall.** ufw: 22, 80, 443 in, everything else denied. Postgres and
   Redis stay on the Docker network.
7. **Build, start, migrate.** Waits for real health rather than sleeping.
8. **Timers.** Nightly verified backup, weekly GeoIP refresh.

---

## Behind Cloudflare

Use `--no-tls` and a Cloudflare **origin certificate**, placed at
`nginx/certs/dev-fullchain.pem` and `dev-privkey.pem`. Set the Cloudflare
SSL mode to **Full (strict)**.

`TRUST_PROXY_HOPS` must be `2` with Cloudflare in front of nginx, and `1`
with nginx alone. Getting this wrong means rate limiting and geo see the
proxy's IP instead of the visitor's, which silently breaks both.

Cloudflare's IP ranges are already in `nginx/nginx.conf` for
`set_real_ip_from`. They change occasionally — refresh from
<https://www.cloudflare.com/ips/>.

**Do not enable Cloudflare caching on the short domain.** A cached 302
defeats the entire product. The shipped nginx config sends
`Cache-Control: private, no-store` on every 302, which Cloudflare honours
by default, but a "Cache Everything" page rule would override it.

---

## Backups

```bash
make backup                               # dump, then verify it restores
make restore FILE=backups/mtlink-....dump # destructive, asks for confirmation
```

`backup.sh` does not just dump. It creates a scratch database, restores the
dump into it, compares row counts for every table, checks the click
partitions came back, and only then reports success. If verification fails
it exits non-zero and says the dump is not trustworthy.

Verified output looks like this:

```
==> Dumping to backups/mtlink-20261011T054121Z.dump
    wrote 120K
==> Verifying by restoring into mtlink_verify_4685
==> Comparing row counts
    tenant                1  ok
    user                  1  ok
    domain                1  ok
    link                 27  ok
    link_version         29  ok
    click               936  ok
    click_daily         901  ok
    api_key               6  ok
    click partitions restored: 20
==> Verified.
```

### Tested restore procedure

This has been run, not just written down.

1. **Take a fresh dump first**, even when restoring. If the restore is
   wrong you want a way back.
   ```bash
   make backup
   ```
2. **Stop the writers** so nothing races the restore.
   ```bash
   docker compose stop api worker
   ```
   Leave `redirect` running if you can tolerate it serving stale cached
   links for a moment; stop it too if correctness matters more than uptime.
3. **Restore.** The script prints what is currently in the database and
   requires you to type the database name.
   ```bash
   make restore FILE=backups/mtlink-20261011T054121Z.dump
   ```
4. **Re-provision partitions and drain the default**, which the script does
   automatically — a dump restored into a fresh database has the partitions
   from the dump's era, not today's.
5. **Restart everything** so the caches are dropped. This step is not
   optional: the redirect service will happily keep serving pre-restore
   destinations from its LRU otherwise.
   ```bash
   docker compose restart api worker redirect
   ```
6. **Verify.**
   ```bash
   bash scripts/verify-acceptance.sh
   ```

Off-box copies are your problem — the timer only writes locally. `rclone`
or `restic` to S3/B2 from `/opt/mt-link/backups` is the usual answer.

---

## Monitoring

Both services expose Prometheus metrics at `/metrics`, not publicly routed.

Worth alerting on:

| Signal | Why |
|---|---|
| `mtlink_redirect_degraded{dependency="postgres"} == 1` | Cache misses cannot be served. Redirects are failing. |
| `mtlink_redirect_cache_hit_ratio < 0.8` | Cache is thrashing or Redis is down. Latency will climb. |
| `rate(mtlink_redirect_total{outcome="error"}[5m]) > 0` | Redirects are 503ing. |
| `mtlink_worker_queue_depth` climbing | The worker is down or falling behind. Analytics only — links still work. |
| `SELECT count(*) FROM click_default > 0` | Partition job has stopped. Analytics lose pruning. |
| Certificate expiry | Nothing renews customer-domain certs automatically yet. |

`mtlink_redirect_degraded{dependency="redis"}` is informational. Redis being
down is a latency event, not an outage.

---

## Scaling

The redirect service is stateless. `docker-compose.prod.yml` runs two
replicas; raise `deploy.replicas` and nginx picks them up through Docker's
DNS without a config change.

From the benchmark (see the README), throughput plateaus around 5,900 req/s
on 2 vCPUs while latency climbs — add CPU or replicas before sustained
concurrency passes about 25.

Postgres is the first thing that will actually hurt, and it will be the
`click` table. When it does:

- Drop old partitions: `dropOldPartitions(months)` in
  `services/api/src/jobs/partitions.ts`.
- Raise the rollup cutover so fewer queries touch raw partitions.
- Then, and only then, consider ClickHouse. Below roughly 10M clicks a
  month, partitioned Postgres is fine and is one fewer thing to operate.

---

## Upgrading

```bash
cd /opt/mt-link
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose exec -T api npm run migrate
bash scripts/verify-acceptance.sh
```

Migrations are forward-only. Take a backup before any upgrade that includes
one.

---

## Notes on nginx

The shipped `nginx:1.27-alpine` image has gzip but **not** brotli. If you
want it, swap to an image built with `nginx-module-brotli` and add the
`brotli on; brotli_types ...;` directives — the config has a comment marking
where.

In production the dashboard should be served as static files rather than
proxied to Vite. `nginx/conf.d/10-app.conf` has that block ready, commented
out, and `docker-compose.prod.yml` already mounts the built assets at
`/var/www/dashboard`. Swap the two `location /` blocks when you deploy.
