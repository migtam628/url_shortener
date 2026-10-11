# VPS setup — step by step

A sequential walkthrough for getting MT Link live on your own server. It
assumes nothing is installed yet and tells you where the branches are.

Allow about 30 minutes, most of which is DNS propagation and the first
Docker build.

---

## Before you start: three decisions

### 1. Your short domain

This is the hostname that appears in every link, forever. It goes on printed
work orders and QR codes, so it is the one choice here that is genuinely
hard to reverse.

Short is the whole point. Options, roughly in order of how good they look on
a job sheet:

| Option | Example | Notes |
|---|---|---|
| A short dedicated domain | `mtt.link`, `mtsv.co` | Best. ~$10–40/yr. 4–5 characters reads well. |
| A subdomain you already own | `go.mttechservicesllc.com` | Free, works today, but long: `go.mttechservicesllc.com/aB3xK9p` is 30 characters. |
| A short second domain | `mt-tech.link` | Middle ground. |

You already use `mttechservicesllc.com` for `n8n.`, so `go.` on that domain
is the zero-cost path. If these links are going on anything a customer sees,
spend the $15 on something short.

**Write your choice down. You will use it three times below.**

### 2. Dashboard hostname

Separate from the short domain, so the shortener stays uncluttered. The
default is `app.<your registrable domain>` — e.g. `app.mttechservicesllc.com`.

### 3. Cloudflare or direct?

| | Direct | Behind Cloudflare |
|---|---|---|
| TLS | Let's Encrypt, automatic | Cloudflare origin certificate, manual |
| Bootstrap flag | *(none)* | `--no-tls` |
| `TRUST_PROXY_HOPS` | `1` | `2` |
| DDoS / caching | None | Yes |

Direct is simpler and fine to start. You can move behind Cloudflare later
without reinstalling — see the bottom of this guide.

---

## Step 1 — DNS

Create two records pointing at your VPS's public IP. Get the IP with:

```bash
curl -4 ifconfig.me
```

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `go` | your VPS IP | DNS only (grey cloud) for now |
| A | `app` | your VPS IP | DNS only |

Keep the Cloudflare proxy **off** for the initial setup even if you plan to
use it. Let's Encrypt's HTTP challenge needs to reach your server directly.
Turn the proxy on afterwards.

Wait for propagation, then confirm from the VPS:

```bash
getent hosts go.yourdomain.com
```

It must return your VPS IP. If it returns nothing or a different address,
stop here — a certificate request against bad DNS burns Let's Encrypt rate
limit, and you only get a handful per week.

---

## Step 2 — Check what is already on the box

SSH in and look before you install:

```bash
ssh you@your-vps
sudo ss -lntp | grep -E ':80|:443'
```

**Nothing returned** → good, skip to Step 3.

**Something is listening** → you have a choice to make. MT Link ships its
own nginx container that wants 80 and 443. If the box already runs nginx,
Caddy, Traefik or another stack, pick one:

- **Option A — let MT Link own the edge.** Stop the other service.
  Appropriate on a box dedicated to this.
- **Option B — put MT Link behind your existing reverse proxy.** Better if
  the box is already serving other things. See
  [Coexisting with an existing reverse proxy](#coexisting-with-an-existing-reverse-proxy)
  at the end of this guide. Do that section *instead of* Steps 3–4.

---

## Step 3 — Dry run

```bash
cd /tmp
git clone https://github.com/migtam628/url_shortener.git
sudo bash url_shortener/scripts/bootstrap-vps.sh \
  --domain go.yourdomain.com \
  --email you@yourdomain.com \
  --dry-run
```

This changes nothing. It reports the OS, checks ports 80 and 443, resolves
your domain against this host's public IP, and reports RAM and CPU count.

Read the output. Every warning it prints is something that will bite during
the real run.

---

## Step 4 — Install

Same command without `--dry-run`:

```bash
sudo bash url_shortener/scripts/bootstrap-vps.sh \
  --domain go.yourdomain.com \
  --email you@yourdomain.com
```

Behind Cloudflare, add `--no-tls` and supply an origin certificate
afterwards (see the end of this guide).

The first build takes 3–8 minutes. The script:

1. Installs Docker Engine and the compose plugin
2. Creates the `mtlink` service user
3. Clones to `/opt/mt-link`
4. Generates `POSTGRES_PASSWORD`, `SESSION_SECRET` and `IP_HASH_SECRET` with
   `openssl rand`, writes `.env` at mode 600
5. Requests certificates via certbot
6. Configures ufw — 22, 80, 443 in, everything else denied
7. Builds, starts, waits for real health, runs migrations
8. Installs systemd timers for verified nightly backups and weekly GeoIP

It is idempotent. Re-running updates the checkout and restarts; it will not
overwrite `.env` or regenerate secrets.

When it finishes it prints the dashboard URL and the remaining steps.

---

## Step 5 — Create your account, then close the door

Registration is open after install so you can create the first account. It
should not stay that way.

1. Open `https://app.yourdomain.com`
2. Click through to register. Use a real password — this account owns
   everything.
3. Immediately:

```bash
cd /opt/mt-link
sudo sed -i 's/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/' .env
sudo docker compose restart api
```

Verify it took — this should now fail:

```bash
curl -sS -X POST https://app.yourdomain.com/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"nope@example.com","password":"aaaaaaaaaaaa","name":"nope"}'
# expect: {"error":{"code":"forbidden","message":"Registration is disabled..."}}
```

Leaving this open on a public instance means anyone can create a tenant and
start issuing links from your domain. That is how a short domain gets
blacklisted.

---

## Step 6 — Add your domain in the dashboard

The hostname in `.env` tells the SSRF guard what to treat as yours. The
dashboard needs it as an actual domain record before links can exist on it.

Dashboard → **Domains** → **Add domain** → `go.yourdomain.com` → it becomes
the default automatically as the first one.

Then make a test link and confirm the whole path works:

```bash
curl -sI https://go.yourdomain.com/<slug>
# expect: HTTP/2 302 and a Location header
```

---

## Step 7 — Geo analytics (optional)

Clicks are recorded without it; country, region and city just stay empty.

1. Free signup at <https://www.maxmind.com/en/geolite2/signup>
2. Create a licence key
3. On the VPS:

```bash
cd /opt/mt-link
sudo sed -i 's/^MAXMIND_LICENSE_KEY=.*/MAXMIND_LICENSE_KEY=your_key_here/' .env
sudo bash scripts/update-geoip.sh
sudo docker compose restart worker
```

The weekly timer keeps it fresh after that. MaxMind publishes updates every
Tuesday.

---

## Step 8 — Verify the whole thing

```bash
cd /opt/mt-link
sudo bash scripts/verify-acceptance.sh
```

22 checks against the live stack: health, link creation, destination editing
with immediate cache invalidation, slug rename behaviour, SSRF rejection,
reserved slugs, analytics, partition health, version history. It creates a
throwaway tenant and cleans up after itself.

```
Result: 22 passed, 0 failed
```

Anything other than 0 failed, stop and read which check failed before
putting real links on it.

---

## Step 9 — Get backups off the box

The nightly timer dumps to `/opt/mt-link/backups` and verifies each dump by
restoring it. A backup on the same disk as the database is not a backup.

Check the timer is live:

```bash
systemctl list-timers 'mtlink-*'
sudo systemctl start mtlink-backup.service   # run one now
ls -lh /opt/mt-link/backups
```

Then ship them somewhere. With rclone to Backblaze B2 or S3:

```bash
sudo apt install -y rclone
sudo rclone config          # set up a remote called "b2"

sudo tee /etc/systemd/system/mtlink-offsite.service >/dev/null <<'EOF'
[Unit]
Description=Copy MT Link backups off-box
After=mtlink-backup.service

[Service]
Type=oneshot
ExecStart=/usr/bin/rclone sync /opt/mt-link/backups b2:your-bucket/mt-link --min-age 1m
EOF

sudo tee /etc/systemd/system/mtlink-offsite.timer >/dev/null <<'EOF'
[Unit]
Description=Nightly off-box backup copy
[Timer]
OnCalendar=*-*-* 04:05:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mtlink-offsite.timer
```

---

## Step 10 — Wire it into n8n

Create an API key in the dashboard (**API keys** → **New key**, scopes
`links:write` and `analytics:read`). Copy it — it is shown once.

In n8n, an HTTP Request node:

- **Method** `POST`
- **URL** `https://app.yourdomain.com/api/v1/links`
- **Authentication** Generic → Header Auth → name `Authorization`,
  value `Bearer mtl_...`
- **Body** (JSON):

```json
{
  "destination": "{{ $json.url }}",
  "title": "{{ $json.title }}",
  "tags": ["n8n"]
}
```

The response gives `shortUrl`, ready to drop into a Telegram message or a
work-order note.

To repoint an existing link later, `PATCH /api/v1/links/{id}` with a new
`destination`. The short URL and any printed QR keep working.

Full reference: [API.md](API.md).

---

## Coexisting with an existing reverse proxy

Use this instead of Steps 3–4 when something already owns 80 and 443.

MT Link's services bind to localhost only; your existing nginx proxies to
them.

**1. Install without the bundled nginx:**

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/migtam628/url_shortener.git mt-link
cd mt-link
sudo cp .env.example .env
```

Edit `.env`: set `NODE_ENV=production`, `COOKIE_SECURE=true`,
`TRUST_PROXY_HOPS=1`, `SHORT_DOMAINS=go.yourdomain.com`,
`APP_ORIGIN=https://app.yourdomain.com`, and generate the three secrets:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # IP_HASH_SECRET
openssl rand -base64 32   # POSTGRES_PASSWORD (also update DATABASE_URL)
sudo chmod 600 .env
```

**2. Start everything except nginx:**

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --build postgres redis api worker redirect
sudo docker compose exec -T api npm run migrate
```

**3. Publish the service ports to localhost only.** Create
`docker-compose.override.yml`:

```yaml
services:
  api:
    ports: ["127.0.0.1:4000:4000"]
  redirect:
    ports: ["127.0.0.1:4001:4001"]
```

Then `sudo docker compose up -d api redirect`.

**4. Add server blocks to your host nginx** (`/etc/nginx/sites-available/mt-link`):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name go.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/go.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/go.yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # Never cache a redirect decision — destinations are editable.
        proxy_no_cache     1;
        proxy_cache_bypass 1;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name app.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/app.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.yourdomain.com/privkey.pem;

    client_max_body_size 10m;

    location /api/ {
        proxy_pass       http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        root /opt/mt-link/apps/dashboard/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

Build the dashboard assets once:

```bash
cd /opt/mt-link && sudo npm ci && sudo npm -w @mtlink/dashboard run build
```

Then:

```bash
sudo ln -s /etc/nginx/sites-available/mt-link /etc/nginx/sites-enabled/
sudo certbot --nginx -d go.yourdomain.com -d app.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

Continue from Step 5. You will need to install the backup and GeoIP timers
by hand — copy them out of `scripts/bootstrap-vps.sh`.

---

## Moving behind Cloudflare later

1. Turn the proxy on (orange cloud) for both records.
2. Cloudflare SSL/TLS mode → **Full (strict)**.
3. Create an origin certificate (SSL/TLS → Origin Server) and place it at
   `/opt/mt-link/nginx/certs/dev-fullchain.pem` and `dev-privkey.pem`.
4. Set `TRUST_PROXY_HOPS=2` in `.env`.
5. `sudo docker compose restart nginx api redirect`

**Do not enable "Cache Everything" on the short domain.** A cached 302
defeats the entire product — people would keep reaching the old destination
after you change it. The default configuration already sends
`Cache-Control: private, no-store` on every 302, which Cloudflare honours
unless a page rule overrides it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `certbot` fails | DNS not pointing here, or Cloudflare proxy on | Confirm `getent hosts go.yourdomain.com`; set the record to DNS-only and retry |
| Bootstrap aborts on ports | Something else holds 80/443 | `sudo ss -lntp \| grep -E ':80\|:443'`, then stop it or use the coexistence path |
| Short links 404 | Domain not added in the dashboard | Domains → Add domain |
| Dashboard loads, API 502 | API container unhealthy | `sudo docker compose logs api --tail=50` |
| Login works then immediately logs out | `COOKIE_SECURE=true` over plain HTTP | Use HTTPS, or set it false for local testing only |
| Edited destination still goes to the old URL | Cached 301, or a CDN caching the 302 | Check `redirectCode`; 301s are cached by browsers near-permanently. Check for a Cloudflare "Cache Everything" rule |
| Analytics empty | Worker down | `sudo docker compose logs worker --tail=50` |
| No country data | GeoIP database absent | Step 7 |
| Clicks land in `click_default` | Partition job stalled | `sudo docker compose exec -T postgres psql -U mtlink -c "SELECT * FROM mtlink_drain_default_partition();"` |

Useful commands:

```bash
cd /opt/mt-link
sudo docker compose ps
sudo docker compose logs -f --tail=100
sudo docker compose logs -f redirect
sudo docker compose exec postgres psql -U mtlink
sudo docker compose restart api worker redirect
```

---

## Rollback

```bash
cd /opt/mt-link
sudo bash scripts/backup.sh                 # always, before anything
sudo git log --oneline -10
sudo git checkout <previous-sha>
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations are forward-only. Rolling back code across a migration means
restoring the database too:

```bash
sudo bash scripts/restore.sh backups/mtlink-....dump
sudo docker compose restart api worker redirect   # required — drops caches
```

---

## Security checklist before real traffic

- [ ] `ALLOW_REGISTRATION=false`
- [ ] Seeded demo account deleted or its password changed
- [ ] `.env` is mode 600 and not in git
- [ ] ufw active, only 22/80/443 open
- [ ] SSH key-only auth (`PasswordAuthentication no`)
- [ ] Postgres and Redis not published to the host in production
- [ ] Backups verified **and** copied off-box
- [ ] `verify-acceptance.sh` passes 22/22
- [ ] You know that **abuse screening is not implemented** — see the known
      gaps in the README. Do not hand out API keys broadly until it is.
