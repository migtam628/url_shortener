import { describe, it, expect } from 'vitest';
import {
  decodeInvalidation,
  encodeInvalidation,
  linkCacheKey,
  domainCacheKey,
  missCacheKey,
  INVALIDATION_CHANNEL,
} from '../cache.js';

describe('cache keys', () => {
  it('are case-insensitive on hostname', () => {
    expect(linkCacheKey('GO.MT.LC', 'abc')).toBe(linkCacheKey('go.mt.lc', 'abc'));
    expect(domainCacheKey('Go.MT.LC')).toBe('domain:go.mt.lc');
  });

  it('are case-sensitive on slug, because slugs are', () => {
    expect(linkCacheKey('go.mt.lc', 'ABC')).not.toBe(linkCacheKey('go.mt.lc', 'abc'));
  });

  it('keep namespaces distinct', () => {
    expect(linkCacheKey('h', 's')).not.toBe(missCacheKey('h', 's'));
  });
});

describe('invalidation messages', () => {
  it('round-trips', () => {
    const msg = {
      kind: 'link' as const,
      hostname: 'go.mt.lc',
      slug: 'new',
      previous: { hostname: 'go.mt.lc', slug: 'old' },
      origin: 'api-1',
      at: 1760000000000,
    };
    expect(decodeInvalidation(encodeInvalidation(msg))).toEqual(msg);
  });

  it('rejects malformed payloads rather than throwing', () => {
    for (const raw of ['', 'not json', '{}', '[]', 'null', '{"kind":"bogus"}']) {
      expect(decodeInvalidation(raw)).toBeNull();
    }
  });

  it('exposes a stable channel name', () => {
    expect(INVALIDATION_CHANNEL).toBe('link:invalidate');
  });
});
