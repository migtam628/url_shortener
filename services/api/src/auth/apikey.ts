import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '@mtlink/shared';

/**
 * API key format:  mtl_<prefix>_<secret>
 *
 * The prefix is stored in clear and indexed, so a lookup is one indexed read
 * rather than a scan-and-compare over every key in the table. The secret is
 * stored only as a SHA-256 digest and compared with timingSafeEqual.
 */

export const API_KEY_PREFIX = 'mtl';
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

export interface GeneratedApiKey {
  /** Shown to the user exactly once. */
  token: string;
  prefix: string;
  keyHash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('base64url');
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
  const parts = token.split('_');
  if (parts.length !== 3) return null;
  const [scheme, prefix, secret] = parts as [string, string, string];
  if (scheme !== API_KEY_PREFIX || !prefix || !secret) return null;
  return { prefix, secret };
}

/** Constant-time comparison of two hex digests of equal length. */
export function secretMatches(storedHash: string, presentedSecret: string): boolean {
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
