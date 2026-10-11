/**
 * Slug generation and validation.
 *
 * The alphabet deliberately drops visually ambiguous characters. These slugs
 * get printed on QR codes, read aloud over the phone to a tech in the field,
 * and typed in by hand, so `0`/`O` and `1`/`l`/`I` confusion is a real support
 * cost, not a theoretical one.
 */

import { randomInt } from 'node:crypto';

/** Unambiguous base-49 alphabet: no 0, O, 1, l, I. */
export const SLUG_ALPHABET = '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

export const DEFAULT_SLUG_LENGTH = 7;
export const MIN_SLUG_LENGTH = 1;
export const MAX_SLUG_LENGTH = 128;

/**
 * Paths the redirect service and dashboard need for themselves, plus the ones
 * browsers and crawlers request unprompted. Allocating any of these as a slug
 * would shadow real functionality.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'app',
  'admin',
  'dashboard',
  'login',
  'logout',
  'register',
  'signup',
  'signin',
  'static',
  'assets',
  'public',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'ads.txt',
  'security.txt',
  'manifest.json',
  'apple-app-site-association',
  'assetlinks.json',
  '.well-known',
  'health',
  'healthz',
  'metrics',
  'status',
  'settings',
  'account',
  'billing',
  'support',
  'terms',
  'privacy',
  '_next',
  '__mtlink',
]);

/** Slugs may contain alphanumerics, hyphen, underscore and dot only. */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: string };

export function validateSlug(raw: string): SlugValidation {
  const slug = raw.trim();

  if (slug.length < MIN_SLUG_LENGTH) {
    return { ok: false, reason: 'Slug cannot be empty.' };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return { ok: false, reason: `Slug cannot exceed ${MAX_SLUG_LENGTH} characters.` };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      reason:
        'Slug must start with a letter or digit and contain only letters, digits, dots, hyphens and underscores.',
    };
  }
  if (slug.includes('..')) {
    return { ok: false, reason: 'Slug cannot contain consecutive dots.' };
  }
  if (isReservedSlug(slug)) {
    return { ok: false, reason: `"${slug}" is reserved and cannot be used as a slug.` };
  }
  return { ok: true, slug };
}

/**
 * Generate a random slug using crypto randomness.
 *
 * `randomInt` with an explicit upper bound is rejection-sampled by Node, so
 * there is no modulo bias across the 57-character alphabet.
 */
export function generateSlug(length: number = DEFAULT_SLUG_LENGTH): string {
  if (length < MIN_SLUG_LENGTH || length > MAX_SLUG_LENGTH) {
    throw new RangeError(`Slug length must be between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH}.`);
  }
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a slug that passes validation. A random slug can collide with a
 * reserved word (for short lengths), so retry rather than returning one.
 */
export function generateValidSlug(length: number = DEFAULT_SLUG_LENGTH): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const slug = generateSlug(length);
    if (!isReservedSlug(slug)) return slug;
  }
  /* c8 ignore next */
  throw new Error('Unable to generate a non-reserved slug after 10 attempts.');
}
