import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { linkCacheKey, missCacheKey } from '@mtlink/shared';
import { createFixture, destroyFixture, closeHelpers, prisma, type Fixture } from './helpers.js';
import { createLink, updateLink, deleteLink } from '../src/services/links.js';

/**
 * ACCEPTANCE CRITERION 4: "Editing a destination is reflected on the very
 * next redirect request."
 *
 * This is the test for that. It asserts on the Redis key directly rather
 * than on a redirect response, because the redirect's correctness is a
 * *consequence* of the key being gone — asserting on the cause catches the
 * bug one layer earlier and does not need the redirect service running.
 *
 * The companion end-to-end check (actual HTTP through the redirect service)
 * lives in services/redirect/tests/redirect.test.ts.
 */

let f: Fixture;
let redis: Redis;

beforeAll(async () => {
  f = await createFixture('inval');
  redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');
});

afterAll(async () => {
  await destroyFixture(f);
  await redis.quit();
  await closeHelpers();
});

/** Stand in for the redirect service having cached this link. */
async function warmCache(hostname: string, slug: string, destination: string): Promise<void> {
  await redis.set(linkCacheKey(hostname, slug), JSON.stringify({ destination }), 'EX', 300);
}

describe('cache invalidation on write', () => {
  it('drops the cached key when the destination changes', async () => {
    const link = await createLink(
      { destination: 'https://example.com/v1', redirectCode: 302, tags: [] },
      { tenantId: f.tenantId, userId: f.userId },
    );
    await warmCache(f.hostname, link.slug, 'https://example.com/v1');
    expect(await redis.get(linkCacheKey(f.hostname, link.slug))).not.toBeNull();

    await updateLink(link.id, { destination: 'https://example.com/v2' }, { tenantId: f.tenantId, userId: f.userId });

    // The key must be GONE, not merely refreshed — a stale value with a live
    // TTL is exactly the failure this product cannot have.
    expect(await redis.get(linkCacheKey(f.hostname, link.slug))).toBeNull();
  });

  it('drops BOTH keys when the slug changes, so the old address stops working', async () => {
    const link = await createLink(
      { destination: 'https://example.com/original', redirectCode: 302, tags: [], slug: `old-${Date.now()}` },
      { tenantId: f.tenantId, userId: f.userId },
    );
    const oldSlug = link.slug;
    const newSlug = `new-${Date.now()}`;

    await warmCache(f.hostname, oldSlug, 'https://example.com/original');

    await updateLink(link.id, { slug: newSlug }, { tenantId: f.tenantId, userId: f.userId });

    // This is the regression that silently keeps an old short URL alive.
    expect(await redis.get(linkCacheKey(f.hostname, oldSlug))).toBeNull();
    expect(await redis.get(linkCacheKey(f.hostname, newSlug))).toBeNull();
  });

  it('clears a negative cache entry when the slug is created', async () => {
    const slug = `ghost-${Date.now()}`;
    await redis.set(missCacheKey(f.hostname, slug), '1', 'EX', 30);

    await createLink(
      { destination: 'https://example.com/now-exists', redirectCode: 302, tags: [], slug },
      { tenantId: f.tenantId, userId: f.userId },
    );

    // Without this, a visitor who hit the 404 first keeps getting it.
    expect(await redis.get(missCacheKey(f.hostname, slug))).toBeNull();
  });

  it('drops the key on delete', async () => {
    const link = await createLink(
      { destination: 'https://example.com/doomed', redirectCode: 302, tags: [] },
      { tenantId: f.tenantId, userId: f.userId },
    );
    await warmCache(f.hostname, link.slug, 'https://example.com/doomed');

    await deleteLink(link.id, { tenantId: f.tenantId });

    expect(await redis.get(linkCacheKey(f.hostname, link.slug))).toBeNull();
  });
});

describe('version history', () => {
  it('records the original destination at creation', async () => {
    const link = await createLink(
      { destination: 'https://example.com/first', redirectCode: 302, tags: [] },
      { tenantId: f.tenantId, userId: f.userId },
    );
    const versions = await prisma.linkVersion.findMany({ where: { linkId: link.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.destination).toBe('https://example.com/first');
  });

  it('appends a version per change and never rewrites history', async () => {
    const link = await createLink(
      { destination: 'https://example.com/a', redirectCode: 302, tags: [] },
      { tenantId: f.tenantId, userId: f.userId },
    );
    await updateLink(link.id, { destination: 'https://example.com/b', note: 'second' }, { tenantId: f.tenantId, userId: f.userId });
    await updateLink(link.id, { destination: 'https://example.com/c', note: 'third' }, { tenantId: f.tenantId, userId: f.userId });

    const versions = await prisma.linkVersion.findMany({
      where: { linkId: link.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(versions.map((v) => v.destination)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('does not create a version for a metadata-only edit', async () => {
    const link = await createLink(
      { destination: 'https://example.com/stable', redirectCode: 302, tags: [] },
      { tenantId: f.tenantId, userId: f.userId },
    );
    await updateLink(link.id, { title: 'Renamed in the UI only' }, { tenantId: f.tenantId, userId: f.userId });

    // History is about where the link POINTED, not what it was called.
    expect(await prisma.linkVersion.count({ where: { linkId: link.id } })).toBe(1);
  });
});
