import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Argon2id parameters.
 *
 * 19 MiB / t=2 / p=1 is the OWASP-recommended baseline. @node-rs/argon2 ships
 * prebuilt binaries for linux-x64, linux-arm64 and darwin-arm64, so this
 * builds on the VPS and on an Apple Silicon Mac without a toolchain.
 */
const OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain, OPTS);
  } catch {
    // A malformed hash in the database must read as "wrong password", never
    // as a 500 that tells an attacker something interesting.
    return false;
  }
}
