import { LRUCache } from 'lru-cache';
import { Redis } from 'ioredis';
import {
  INVALIDATION_CHANNEL,
  decodeInvalidation,
  domainCacheKey,
  linkCacheKey,
  missCacheKey,
  type ResolvedDomain,
  type ResolvedLink,
} from '@mtlink/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { degraded, invalidationsReceived, recordLookup } from './metrics.js';
import { fetchDomain, fetchLink } from './pg.js';

/**
 * Three-layer link resolution: in-process LRU -> Redis -> Postgres.
 *
 * The LRU is what gets the p99 under a millisecond; Redis keeps a cold
 * process warm and shares fills across replicas; Postgres is the truth.
 *
 * Both cache layers are strictly optional. If Redis is unreachable every
 * lookup falls through to Postgres and redirects keep working — slower, but
 * correct. That is the single most important property of this file.
 */

type CacheEntry = { kind: 'link'; link: ResolvedLink } | { kind: 'miss' };

const lru = new LRUCache<string, CacheEntry>({
  max: env.LRU_MAX,
  ttl: env.LRU_TTL_MS,
  ttlAutopurge: false,
});

/** LRUCache values must be non-nullable, so a 'domain does not exist'
 *  result is wrapped rather than stored as null — negative lookups need
 *  caching too, or an unconfigured hostname hits Postgres every request. */
type DomainEntry = { domain: ResolvedDomain | null };

const domainLru = new LRUCache<string, DomainEntry>({
  max: 256,
  ttl: env.LRU_TTL_MS,
});

let redis: Redis | null = null;
let subscriber: Redis | null = null;

export function initCache(): void {
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    // Fail fast rather than queueing: a redirect must not wait on a
    // reconnecting Redis, it must fall through to Postgres.
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    commandTimeout: 250,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  redis.on('error', (err: Error) => {
    degraded.set({ dependency: 'redis' }, 1);
    logger.warn({ err: err.message }, 'redis unavailable — serving from Postgres');
  });
  redis.on('ready', () => {
    degraded.set({ dependency: 'redis' }, 0);
    logger.info('redis ready');
  });

  // A subscriber connection cannot issue normal commands, so it is separate.
  subscriber = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  subscriber.on('error', (err: Error) =>
    logger.warn({ err: err.message }, 'invalidation subscriber error'),
  );

  void subscriber.subscribe(INVALIDATION_CHANNEL, (err) => {
    if (err) logger.error({ err }, 'failed to subscribe to invalidation channel');
    else logger.info({ channel: INVALIDATION_CHANNEL }, 'subscribed to invalidations');
  });

  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== INVALIDATION_CHANNEL) return;
    const msg = decodeInvalidation(raw);
    if (!msg) {
      logger.warn({ raw }, 'undecodable invalidation message');
      return;
    }
    invalidationsReceived.inc({ kind: msg.kind });

    if (msg.kind === 'all') {
      lru.clear();
      domainLru.clear();
      logger.info('all caches cleared by invalidation');
      return;
    }

    if (msg.kind === 'domain' && msg.hostname) {
      domainLru.delete(msg.hostname.toLowerCase());
      // A domain change can affect any slug on it, so drop those too.
      const prefix = `${msg.hostname.toLowerCase()}:`;
      for (const key of lru.keys()) {
        if (key.startsWith(prefix)) lru.delete(key);
      }
      return;
    }

    if (msg.kind === 'link' && msg.hostname && msg.slug) {
      lru.delete(localKey(msg.hostname, msg.slug));
      // A renamed slug leaves the OLD address cached. Without this, the old
      // short URL keeps serving the old destination until its TTL expires.
      if (msg.previous) lru.delete(localKey(msg.previous.hostname, msg.previous.slug));
      logger.debug({ msg }, 'link invalidated locally');
    }
  });
}

function localKey(hostname: string, slug: string): string {
  return `${hostname.toLowerCase()}:${slug}`;
}

/**
 * Resolve a short link. Returns null when the slug does not exist.
 *
 * `source` reports which layer answered, for metrics and for the
 * X-Cache debug header in non-production builds.
 */
export async function resolveLink(
  hostname: string,
  slug: string,
): Promise<{ link: ResolvedLink | null; source: 'lru' | 'redis' | 'postgres' | 'miss' }> {
  const key = localKey(hostname, slug);

  const local = lru.get(key);
  if (local) {
    recordLookup('lru');
    return { link: local.kind === 'link' ? local.link : null, source: 'lru' };
  }

  if (redis) {
    try {
      const [cached, miss] = await Promise.all([
        redis.get(linkCacheKey(hostname, slug)),
        redis.get(missCacheKey(hostname, slug)),
      ]);
      if (miss) {
        lru.set(key, { kind: 'miss' });
        recordLookup('redis');
        return { link: null, source: 'redis' };
      }
      if (cached) {
        const link = JSON.parse(cached) as ResolvedLink;
        lru.set(key, { kind: 'link', link });
        recordLookup('redis');
        return { link, source: 'redis' };
      }
    } catch {
      // Swallow and fall through to Postgres. Already logged by the error
      // handler; a per-request log line here would be deafening.
    }
  }

  const link = await fetchLink(hostname, slug);
  recordLookup(link ? 'postgres' : 'miss');

  if (link) {
    lru.set(key, { kind: 'link', link });
    void setRedis(linkCacheKey(hostname, slug), JSON.stringify(link), env.REDIS_LINK_TTL);
  } else {
    lru.set(key, { kind: 'miss' });
    // Negative caching is short: a slug that does not exist today very often
    // exists in a minute, because someone is in the middle of creating it.
    void setRedis(missCacheKey(hostname, slug), '1', 30);
  }

  return { link, source: link ? 'postgres' : 'miss' };
}

export async function resolveDomain(hostname: string): Promise<ResolvedDomain | null> {
  const key = hostname.toLowerCase();
  const local = domainLru.get(key);
  if (local !== undefined) return local.domain;

  if (redis) {
    try {
      const cached = await redis.get(domainCacheKey(hostname));
      if (cached) {
        const parsed = cached === 'null' ? null : (JSON.parse(cached) as ResolvedDomain);
        domainLru.set(key, { domain: parsed });
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }

  const domain = await fetchDomain(hostname);
  domainLru.set(key, { domain });
  void setRedis(domainCacheKey(hostname), domain ? JSON.stringify(domain) : 'null', 300);
  return domain;
}

async function setRedis(key: string, value: string, ttl: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, value, 'EX', ttl);
  } catch {
    /* cache fill is best effort */
  }
}

export async function redisHealthy(): Promise<boolean> {
  if (!redis) return false;
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeCache(): Promise<void> {
  await Promise.allSettled([redis?.quit(), subscriber?.quit()]);
  redis = null;
  subscriber = null;
}

/** Test seams. */
export const _test = { lru, domainLru, localKey };
