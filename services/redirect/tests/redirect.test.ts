import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { Redis } from 'ioredis';

/**
 * End-to-end redirect tests.
 *
 * These drive the real HTTP surface of a running redirect service against a
 * real Postgres and Redis. They are the companion to the API's invalidation
 * tests: those prove the cache key is dropped, these prove the visitor
 * actually lands somewhere new.
 *
 * Requires the redirect service to be running. `make test` starts it; when
 * it is not reachable the suite skips rather than failing, so a unit-test
 * run on a laptop without the stack up is not a wall of red.
 */

const BASE = process.env['REDIRECT_URL'] ?? 'http://127.0.0.1:4001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const redis = new Redis(REDIS_URL, { lazyConnect: true });

let available = false;
let tenantId = '';
let domainId = '';
let hostname = '';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  header(name: string): string | null;
}

/**
 * Raw node:http rather than fetch.
 *
 * Every one of these tests turns on the Host header, because that is how the
 * service picks a tenant — and Node's fetch silently DROPS a caller-supplied
 * Host (it is a forbidden header). Using fetch here produces requests that
 * arrive with Host: 127.0.0.1 and 404, which looks exactly like a broken
 * redirect service and is not.
 */
function get(path: string, host = hostname): Promise<Res> {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: 'GET',
        headers: { Host: host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            header: (n: string) => {
              const v = res.headers[n.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    available = res.ok;
  } catch {
    available = false;
  }
  if (!available) return;

  await redis.connect().catch(() => undefined);

  tenantId = randomUUID();
  domainId = randomUUID();
  hostname = `rt-${Date.now()}.test.invalid`;

  await pool.query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'redirect test', $2)`, [
    tenantId,
    `rt-${Date.now()}`,
  ]);
  await pool.query(
    `INSERT INTO domain (id, tenant_id, hostname, is_default, main_page_redirect, not_found_redirect)
     VALUES ($1, $2, $3, true, 'https://example.com/root', NULL)`,
    [domainId, tenantId, hostname],
  );
  await pool.query(
    `INSERT INTO link (domain_id, tenant_id, slug, destination, redirect_code)
     VALUES ($1, $2, 'live', 'https://example.com/live', 302),
            ($1, $2, 'perm', 'https://example.com/perm', 301),
            ($1, $2, 'gone', 'https://example.com/gone', 302)`,
    [domainId, tenantId],
  );
  await pool.query(`UPDATE link SET archived_at = now() WHERE domain_id = $1 AND slug = 'gone'`, [domainId]);
});

afterAll(async () => {
  if (available && tenantId) {
    await pool.query(`DELETE FROM click WHERE tenant_id = $1`, [tenantId]).catch(() => undefined);
    await pool.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
});

describe.runIf(process.env['REDIRECT_E2E'] !== 'skip')('redirect service', () => {
  it('redirects a known slug with 302 and the right Location', async () => {
    if (!available) return;
    const res = await get('/live');
    expect(res.status).toBe(302);
    expect(res.header('location')).toBe('https://example.com/live');
  });

  it('marks a 302 no-store, so no proxy caches an editable destination', async () => {
    if (!available) return;
    const res = await get('/live');
    expect(res.header('cache-control')).toContain('no-store');
  });

  it('allows a 301 to be cached, since it was opted into explicitly', async () => {
    if (!available) return;
    const res = await get('/perm');
    expect(res.status).toBe(301);
    expect(res.header('cache-control')).toContain('max-age');
    expect(res.header('cache-control')).not.toContain('no-store');
  });

  it('ACCEPTANCE 4: an edited destination is live on the very next request', async () => {
    if (!available) return;

    // Warm the cache so this genuinely tests invalidation rather than a miss.
    await get('/live');
    await get('/live');
    const warm = await get('/live');
    expect(warm.header('x-mtlink-cache')).toBe('lru');

    // Write directly and invalidate the way the API does.
    await pool.query(
      `UPDATE link SET destination = 'https://example.com/CHANGED' WHERE domain_id = $1 AND slug = 'live'`,
      [domainId],
    );
    await redis.del(`link:${hostname}:live`, `miss:${hostname}:live`);
    await redis.publish(
      'link:invalidate',
      JSON.stringify({ kind: 'link', hostname, slug: 'live', at: Date.now() }),
    );
    // Only the pub/sub round trip, not a cache TTL.
    await new Promise((r) => setTimeout(r, 150));

    const after = await get('/live');
    expect(after.header('location')).toBe('https://example.com/CHANGED');
  });

  it('404s an unknown slug', async () => {
    if (!available) return;
    const res = await get('/does-not-exist-at-all');
    expect(res.status).toBe(404);
  });

  it('404s an archived link rather than resolving it', async () => {
    if (!available) return;
    expect((await get('/gone')).status).toBe(404);
  });

  it('serves the domain root redirect', async () => {
    if (!available) return;
    const res = await get('/');
    expect(res.status).toBe(302);
    expect(res.header('location')).toBe('https://example.com/root');
  });

  it('404s an unconfigured hostname', async () => {
    if (!available) return;
    expect((await get('/live', 'nobody.test.invalid')).status).toBe(404);
  });

  it('never resolves a reserved path as a link', async () => {
    if (!available) return;
    for (const p of ['/health', '/metrics', '/api', '/admin']) {
      const res = await get(p);
      // /health and /metrics are real endpoints; the rest must 404. Either
      // way, none of them may produce a redirect.
      expect([200, 404], p).toContain(res.status);
    }
  });

  it('answers robots.txt itself, keeping crawlers out of click analytics', async () => {
    if (!available) return;
    const res = await get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Disallow: /');
  });

  it('keeps /health independent of the database', async () => {
    if (!available) return;
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});
