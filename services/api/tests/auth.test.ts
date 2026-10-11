import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiSecret,
  hasScope,
  parseApiKey,
  secretMatches,
} from '../src/auth/apikey.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { hashIp } from '../src/lib/iphash.js';

describe('API keys', () => {
  it('round-trips a generated key', () => {
    const { token, prefix, keyHash } = generateApiKey();
    const parsed = parseApiKey(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(prefix);
    expect(secretMatches(keyHash, parsed!.secret)).toBe(true);
  });

  it('round-trips 500 keys — REGRESSION: base64url secrets contain "_"', () => {
    // The delimiter is "_" and base64url's alphabet includes it. A naive
    // 3-way split rejected ~54% of valid keys. Parsing must take the
    // secret as everything after the second delimiter.
    let withUnderscore = 0;
    for (let i = 0; i < 500; i += 1) {
      const { token, prefix, keyHash } = generateApiKey();
      const parsed = parseApiKey(token);
      expect(parsed, token).not.toBeNull();
      expect(parsed!.prefix).toBe(prefix);
      expect(secretMatches(keyHash, parsed!.secret)).toBe(true);
      if (parsed!.secret.includes('_')) withUnderscore += 1;
    }
    // Sanity check that the sample actually exercised the failure mode.
    expect(withUnderscore).toBeGreaterThan(50);
  });

  it('uses a hex prefix, so the prefix itself can never contain the delimiter', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateApiKey().prefix).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('never stores the secret in recoverable form', () => {
    const { token, keyHash } = generateApiKey();
    const secret = parseApiKey(token)!.secret;
    expect(keyHash).not.toContain(secret);
    expect(keyHash).toHaveLength(64); // sha256 hex
  });

  it('rejects a wrong secret and a tampered prefix', () => {
    const { token, keyHash } = generateApiKey();
    const parsed = parseApiKey(token)!;
    expect(secretMatches(keyHash, `${parsed.secret}x`)).toBe(false);
    expect(secretMatches(hashApiSecret('other'), parsed.secret)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    // Note: 'mtl_a_b' IS structurally valid (three parts) — it just will
    // not match any stored key. Structural parsing and authentication are
    // separate concerns, and conflating them is how timing leaks appear.
    for (const t of [
      '',
      'nope',
      'mtl_onlytwo',
      'xxx_aaaaaaaaaaaa_b',  // wrong scheme
      'mtl__b',               // empty prefix
      'mtl_aaaaaaaaaaaa_',    // empty secret
      'mtl_notahexprefix_b',  // non-hex prefix
      'mtl_abc_b',            // prefix wrong length
    ]) {
      expect(parseApiKey(t)).toBeNull();
    }
  });

  it('does not crash on a non-hex stored hash', () => {
    expect(secretMatches('not-hex-at-all', 'whatever')).toBe(false);
    expect(secretMatches('', 'whatever')).toBe(false);
  });

  it('treats write scope as implying read', () => {
    expect(hasScope(['links:write'], 'links:read')).toBe(true);
    expect(hasScope(['links:read'], 'links:write')).toBe(false);
    expect(hasScope(['domains:write'], 'links:read')).toBe(false);
  });
});

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'wrong')).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    expect(a.startsWith('$argon2id$')).toBe(true);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('garbage', 'anything')).toBe(false);
  });
});

describe('IP hashing', () => {
  const tenant = '11111111-1111-1111-1111-111111111111';

  it('is stable within a day and changes across days', () => {
    const d1 = new Date('2026-06-01T10:00:00Z');
    const d1late = new Date('2026-06-01T23:59:00Z');
    const d2 = new Date('2026-06-02T00:01:00Z');

    expect(hashIp('203.0.113.9', tenant, d1)).toBe(hashIp('203.0.113.9', tenant, d1late));
    // Rotation is the privacy property: yesterday's hash cannot be joined
    // to today's.
    expect(hashIp('203.0.113.9', tenant, d1)).not.toBe(hashIp('203.0.113.9', tenant, d2));
  });

  it('differs per tenant for the same IP', () => {
    const other = '22222222-2222-2222-2222-222222222222';
    const at = new Date('2026-06-01T10:00:00Z');
    expect(hashIp('203.0.113.9', tenant, at)).not.toBe(hashIp('203.0.113.9', other, at));
  });

  it('never returns the raw IP and handles null', () => {
    const h = hashIp('203.0.113.9', tenant);
    expect(h).not.toContain('203.0.113');
    expect(hashIp(null, tenant)).toBeNull();
    expect(hashIp(undefined, tenant)).toBeNull();
  });
});
