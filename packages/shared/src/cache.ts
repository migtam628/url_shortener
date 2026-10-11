/**
 * Cache key and pub/sub channel conventions, shared by the API (which
 * invalidates) and the redirect service (which caches).
 *
 * These two services are deployed separately, so an inconsistency here is the
 * single most likely cause of a stale redirect. Keeping the key builders in
 * one module is the cheapest way to make that class of bug impossible.
 */

/** Channel the API publishes invalidation messages on. */
export const INVALIDATION_CHANNEL = 'link:invalidate';

/** Resolved link, keyed by host + slug. */
export function linkCacheKey(hostname: string, slug: string): string {
  return `link:${hostname.toLowerCase()}:${slug}`;
}

/** Domain-level settings (root redirect, 404 redirect), keyed by hostname. */
export function domainCacheKey(hostname: string): string {
  return `domain:${hostname.toLowerCase()}`;
}

/** Negative cache entry — remembers that a slug does NOT exist. */
export function missCacheKey(hostname: string, slug: string): string {
  return `miss:${hostname.toLowerCase()}:${slug}`;
}

export type InvalidationKind = 'link' | 'domain' | 'all';

export interface InvalidationMessage {
  kind: InvalidationKind;
  /** Hostname affected. Omitted when kind is 'all'. */
  hostname?: string;
  /** Slug affected. Omitted for domain-level or global invalidation. */
  slug?: string;
  /**
   * When a link's slug or domain changed, the previous key must be dropped
   * too, or the old address keeps serving the old destination.
   */
  previous?: { hostname: string; slug: string };
  /** Emitting instance, for log tracing. */
  origin?: string;
  at: number;
}

export function encodeInvalidation(msg: InvalidationMessage): string {
  return JSON.stringify(msg);
}

export function decodeInvalidation(raw: string): InvalidationMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const m = parsed as Partial<InvalidationMessage>;
    if (m.kind !== 'link' && m.kind !== 'domain' && m.kind !== 'all') return null;
    return {
      kind: m.kind,
      ...(m.hostname ? { hostname: m.hostname } : {}),
      ...(m.slug ? { slug: m.slug } : {}),
      ...(m.previous ? { previous: m.previous } : {}),
      ...(m.origin ? { origin: m.origin } : {}),
      at: typeof m.at === 'number' ? m.at : Date.now(),
    };
  } catch {
    return null;
  }
}
