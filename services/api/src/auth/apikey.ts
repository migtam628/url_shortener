import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@mtlink/shared';

/**
 * API key format:  mtl_<prefix>_<secret>
 *
 * The prefix is stored in clear and indexed, so a lookup is one indexed read
 * rather than a scan-and-compare over every key in the table. The secret is
 * stored only as a SHA-256 digest and compared with timingSafeEqual.
 *
 * Two details that are easy to get wrong, both of which bit this file once:
 *
 *  1. The PREFIX is hex, not base64url. base64url's alphabet includes `_`,
 *     which is the field delimiter — a prefix containing one would split
 *     into the wrong fields and the key would fail to authenticate.
 *
 *  2. The SECRET is base64url (denser, so a shorter token for the same
 *     entropy) and therefore MAY contain `_`. Parsing must take everything
 *     after the second delimiter rather than splitting into exactly three
 *     parts. With a plain 3-way split, ~54% of generated keys were rejected.
 */

export const API_KEY_PREFIX = 'mtl';
const PREFIX_BYTES = 6;  // 12 hex chars
const SECRET_BYTES = 32; // 256 bits

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  token: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${API_KEY_PREFIX}_${prefix}_${secret}`;
  return { token, prefix, keyHash: hashApiSecret(secret) };
}

export function hashApiSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface ParsedApiKey {
  prefix: string;
  secret: string;
}

export function parseApiKey(token: string): ParsedApiKey | null {
  if (!token) return null;

  const first = token.indexOf('_');
  if (first === -1) return null;
  const second = token.indexOf('_', first + 1);
  if (second === -1) return null;

  const scheme = token.slice(0, first);
  const prefix = token.slice(first + 1, second);
  // Everything after the second delimiter, underscores included.
  const secret = token.slice(second + 1);

  if (scheme !== API_KEY_PREFIX) return null;
  if (prefix.length !== PREFIX_BYTES * 2 || !/^[0-9a-f]+$/.test(prefix)) return null;
  if (!secret) return null;

  return { prefix, secret };
}

/** Constant-time comparison of two hex digests of equal length. */
export function secretMatches(storedHash: string, presentedSecret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const presented = hashApiSecret(presentedSecret);
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function hasScope(scopes: readonly string[], required: ApiKeyScope): boolean {
  if (scopes.includes(required)) return true;
  // links:write implies links:read, and so on for each resource.
  const [resource, action] = required.split(':');
  if (action === 'read' && resource && scopes.includes(`${resource}:write`)) return true;
  return false;
}
