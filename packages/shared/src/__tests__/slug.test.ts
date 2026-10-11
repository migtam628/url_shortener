import { describe, it, expect } from 'vitest';
import {
  SLUG_ALPHABET,
  RESERVED_SLUGS,
  generateSlug,
  generateValidSlug,
  isReservedSlug,
  validateSlug,
} from '../slug.js';

describe('slug alphabet', () => {
  it('excludes every visually ambiguous character', () => {
    for (const ch of ['0', 'O', '1', 'l', 'I']) {
      expect(SLUG_ALPHABET).not.toContain(ch);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(SLUG_ALPHABET).size).toBe(SLUG_ALPHABET.length);
  });
});

describe('generateSlug', () => {
  it('produces the requested length', () => {
    for (const len of [1, 4, 7, 16, 64]) {
      expect(generateSlug(len)).toHaveLength(len);
    }
  });

  it('only emits characters from the alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      for (const ch of generateSlug(12)) {
        expect(SLUG_ALPHABET).toContain(ch);
      }
    }
  });

  it('does not collide across a large sample at default length', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(generateSlug(7));
    expect(seen.size).toBe(5000);
  });

  it('rejects out-of-range lengths', () => {
    expect(() => generateSlug(0)).toThrow(RangeError);
    expect(() => generateSlug(129)).toThrow(RangeError);
  });

  it('never returns a reserved slug from generateValidSlug', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(isReservedSlug(generateValidSlug(5))).toBe(false);
    }
  });
});

describe('validateSlug', () => {
  it('accepts ordinary slugs', () => {
    for (const s of ['abc', 'my-link', 'promo_2026', 'a.b.c', 'Q4campaign', 'x']) {
      expect(validateSlug(s)).toEqual({ ok: true, slug: s });
    }
  });

  it('rejects every reserved slug, case-insensitively', () => {
    for (const reserved of RESERVED_SLUGS) {
      expect(validateSlug(reserved).ok).toBe(false);
      expect(validateSlug(reserved.toUpperCase()).ok).toBe(false);
    }
  });

  it('rejects empty and whitespace-only input', () => {
    expect(validateSlug('').ok).toBe(false);
    expect(validateSlug('   ').ok).toBe(false);
  });

  it('rejects path traversal and separators', () => {
    for (const s of ['../etc', 'a/b', 'a\\b', '..', 'a..b', '%2e%2e']) {
      expect(validateSlug(s).ok).toBe(false);
    }
  });

  it('rejects leading punctuation and spaces', () => {
    for (const s of ['-abc', '.abc', '_abc', 'a b']) {
      expect(validateSlug(s).ok).toBe(false);
    }
  });

  it('rejects slugs over the length limit', () => {
    expect(validateSlug('a'.repeat(129)).ok).toBe(false);
    expect(validateSlug('a'.repeat(128)).ok).toBe(true);
  });
});
