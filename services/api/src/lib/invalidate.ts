import { hostname as osHostname } from 'node:os';
import {
  INVALIDATION_CHANNEL,
  domainCacheKey,
  encodeInvalidation,
  linkCacheKey,
  missCacheKey,
  type InvalidationMessage,
} from '@mtlink/shared';
import { publisher, redis } from '../redis.js';
import { logger } from '../logger.js';
import { invalidationsPublished } from '../metrics.js';

const ORIGIN = `api@${osHostname()}`;

/**
 * Invalidate a cached link everywhere.
 *
 * Two steps, and the order matters:
 *
 *   1. DEL the Redis keys. This is authoritative — any redirect instance that
 *      misses the pub/sub message still gets a cache miss and re-reads from
 *      Postgres.
 *   2. PUBLISH so each instance drops its in-process LRU entry immediately,
 *      rather than waiting out LRU_TTL_MS.
 *
 * Redis pub/sub is fire-and-forget with no delivery guarantee, which is
 * exactly why step 1 cannot be skipped: the LRU TTL is the worst-case
 * staleness bound if a message is dropped, and the Redis DEL means a dropped
 * message can never produce staleness longer than that.
 *
 * `previous` must be supplied whenever a slug or domain changed, or the old
 * address keeps serving the old destination out of cache.
 */
export async function invalidateLink(args: {
  hostname: string;
  slug: string;
  previous?: { hostname: string; slug: string };
}): Promise<void> {
  const keys = [
    linkCacheKey(args.hostname, args.slug),
    missCacheKey(args.hostname, args.slug),
  ];
  if (args.previous) {
    keys.push(
      linkCacheKey(args.previous.hostname, args.previous.slug),
      missCacheKey(args.previous.hostname, args.previous.slug),
    );
  }

  const msg: InvalidationMessage = {
    kind: 'link',
    hostname: args.hostname,
    slug: args.slug,
    ...(args.previous ? { previous: args.previous } : {}),
    origin: ORIGIN,
    at: Date.now(),
  };

  await publish(keys, msg);
}

export async function invalidateDomain(hostname: string): Promise<void> {
  const msg: InvalidationMessage = {
    kind: 'domain',
    hostname,
    origin: ORIGIN,
    at: Date.now(),
  };
  await publish([domainCacheKey(hostname)], msg);
}

/** Nuclear option: drop every cached entry on every instance. */
export async function invalidateAll(): Promise<void> {
  const msg: InvalidationMessage = { kind: 'all', origin: ORIGIN, at: Date.now() };
  try {
    const keys = await redis.keys('link:*');
    const misses = await redis.keys('miss:*');
    const domains = await redis.keys('domain:*');
    const all = [...keys, ...misses, ...domains];
    if (all.length) await redis.del(...all);
  } catch (err) {
    logger.warn({ err }, 'invalidateAll: failed to clear Redis keys');
  }
  await publish([], msg);
}

async function publish(keys: string[], msg: InvalidationMessage): Promise<void> {
  try {
    if (keys.length) await redis.del(...keys);
    await publisher.publish(INVALIDATION_CHANNEL, encodeInvalidation(msg));
    invalidationsPublished.inc({ kind: msg.kind, result: 'ok' });
    logger.debug({ msg, keys }, 'cache invalidated');
  } catch (err) {
    invalidationsPublished.inc({ kind: msg.kind, result: 'error' });
    // A failed invalidation is serious but must not fail the user's write.
    // The LRU TTL bounds the resulting staleness; log loudly and move on.
    logger.error(
      { err, msg, keys },
      'CACHE INVALIDATION FAILED — redirects may serve a stale destination until the LRU entry expires',
    );
  }
}
