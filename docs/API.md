# API

Base path `/api/v1`. JSON in, JSON out.

## Authentication

Two mechanisms:

**Session cookie** — for the dashboard. `POST /auth/login` sets an httpOnly
`mtlink_session` cookie.

**API key** — for everything else.

```
Authorization: Bearer mtl_<prefix>_<secret>
```

Keys are created in the dashboard, shown once, and stored only as a hash.
The prefix is hex and indexed; the secret is base64url and may contain
underscores, so parse on the *first two* delimiters, not by splitting on all
of them.

### Scopes

| Scope | Grants |
|---|---|
| `links:read` | List and read links, versions, QR codes, CSV export |
| `links:write` | Create, update, delete, bulk create, CSV import |
| `domains:read` | List domains |
| `domains:write` | Create, update, delete domains |
| `analytics:read` | All analytics endpoints |

`*:write` implies `*:read` for the same resource. API keys can never manage
other API keys — that needs a signed-in admin.

## Errors

```json
{ "error": { "code": "unprocessable", "message": "…", "details": [] } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed request |
| 401 | `unauthorized` | Missing or invalid credentials |
| 403 | `forbidden` | Authenticated but not permitted |
| 404 | `not_found` | No such resource in your tenant |
| 409 | `conflict` | Slug or hostname already taken |
| 422 | `unprocessable` / `validation_failed` | Failed validation, SSRF guard, or reserved slug |
| 429 | `rate_limited` | Includes `Retry-After` |

Rate limits are per API key where one is present, otherwise per IP.

---

## Links

### `GET /links`

Query: `q`, `domainId`, `folderId`, `tag`, `archived`, `sort`
(`created_desc` | `created_asc` | `clicks_desc` | `updated_desc`), `limit`
(≤100), `cursor`.

Keyset pagination — pass `nextCursor` back as `cursor`. Offset pagination
skips or repeats rows when the list changes under the reader; this does not.

```json
{
  "items": [{
    "id": "…", "slug": "mqFD9cd",
    "shortUrl": "https://go.example.com/mqFD9cd",
    "destination": "https://example.com/page",
    "redirectCode": 302, "title": "…", "tags": ["marketing"],
    "clickCount": 115, "createdAt": "2026-10-09T17:12:15.014Z"
  }],
  "nextCursor": null
}
```

### `POST /links`

```json
{
  "destination": "https://example.com/page",
  "slug": "optional",
  "domainId": "optional — defaults to your default domain",
  "redirectCode": 302,
  "title": "optional",
  "folderId": null,
  "tags": ["marketing"],
  "utm": { "source": "qr", "medium": "print", "campaign": "fall" }
}
```

Omit `slug` and one is generated from an alphabet with no `0/O/1/l/I`.

`redirectCode` defaults to 302 and should stay there. A 301 is cached by
browsers effectively forever, so people who have already used the link may
keep reaching the old destination after you change it.

`utm` parameters are merged into the stored destination, preserving existing
query parameters.

→ `201 { "id", "slug", "shortUrl" }`

### `POST /links/bulk`

```json
{ "links": [ /* up to 1000 */ ], "continueOnError": true }
```

→ `201`, or `207` when some rows failed:

```json
{ "created": 98, "failed": 2,
  "rows": [{ "index": 1, "ok": false, "error": "…is a private or reserved address." }] }
```

### `GET /links/:id` · `PATCH /links/:id` · `DELETE /links/:id`

`PATCH` accepts `destination`, `slug`, `domainId`, `redirectCode`, `title`,
`description`, `folderId`, `tags`, `archived`, and `note` (stored on the
resulting version row).

A changed destination, slug, domain or redirect code writes a new
`linkVersion` and invalidates the cache — the next redirect uses the new
value, with no TTL wait.

Prefer `archived: true` over `DELETE`. Deleting makes every existing use of
that short URL — including printed QR codes — return 404.

### `GET /links/:id/versions`

Newest first. The creation entry is included, so history is complete.

```json
{ "items": [{
  "destination": "https://example.com/new", "slug": "mqFD9cd",
  "redirectCode": 302, "changedAt": "…", "note": "Q4 campaign",
  "changedBy": { "name": "Miguel", "email": "…" }
}]}
```

### `POST /links/:id/og`

Fetches and caches the destination's Open Graph metadata. The fetcher
re-checks the resolved IP, does not follow redirects, and reads at most
512KB.

### `GET /links/:id/qr.png` · `.svg`

Query: `size` (64–2048), `color`, `bg` (hex), `ecc` (`L|M|Q|H`), `margin`.

### `GET /links/export` · `POST /links/import`

Export returns CSV. Import takes `{ "csv": "...", "domainId": "...",
"continueOnError": true }`, requires a `destination` (or `url`) column,
optionally `slug`, `title`, `tags`, `redirect_code`, and caps at 1000 rows.

---

## Domains

`GET /domains` · `POST /domains` · `PATCH /domains/:id` · `DELETE /domains/:id`

A hostname is globally unique across the instance. Deleting a domain with
links attached returns 409 rather than cascading — removing it would break
every short URL on it.

---

## Folders

`GET /folders` · `POST /folders` · `DELETE /folders/:id`

Deleting a folder does not delete its links; their `folderId` becomes null.

---

## API keys

`GET /api-keys` · `POST /api-keys` · `DELETE /api-keys/:id`

Session auth and the `admin` role required. `POST` returns `token` exactly
once. `DELETE` revokes rather than deletes, so audit trails keep resolving
the prefix.

---

## Analytics

All accept `from`, `to` (ISO 8601), and `linkId`.

| Endpoint | Returns |
|---|---|
| `GET /analytics/summary` | `clicks`, `bots`, `uniqueVisitors` |
| `GET /analytics/timeseries` | Points per `interval` (`hour`\|`day`), plus `source` |
| `GET /analytics/breakdown/:dimension` | `country`, `device`, `os`, `browser`, `referrer`, `language` |
| `GET /analytics/top-links` | Top 20 by clicks |

`source` on the timeseries is `raw` for ranges of 30 days or less (live to
the second) and `rollup` for longer ranges (served from the daily
pre-aggregate).

`uniqueVisitors` counts distinct daily-rotating IP hashes. It is accurate
within a day and deliberately not comparable across days — that is the
privacy design, not a bug.

---

## Health

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness. Process only; never touches the database. |
| `GET /ready` | Readiness. Checks Postgres and Redis; 503 when not ready. |
| `GET /metrics` | Prometheus. Optional `METRICS_TOKEN` bearer. |

Use `/health` for liveness probes. Pointing a liveness probe at `/ready`
means a brief database blip restarts services that are still serving
correctly from cache.

---

## Example

```bash
KEY="mtl_…"
API="https://app.yourdomain.com/api/v1"

curl -sS -X POST "$API/links" \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"destination":"https://example.com/work-order/4471","tags":["fieldnation"]}'

# Repoint it later; the short URL and any printed QR are unaffected.
curl -sS -X PATCH "$API/links/$ID" \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"destination":"https://example.com/work-order/4471/closeout","note":"job closed"}'
```
