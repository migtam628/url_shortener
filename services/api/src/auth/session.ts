import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { env, isProd } from '../env.js';
import { prisma } from '../db.js';

export const SESSION_COOKIE = 'mtlink_session';

/**
 * Sessions are opaque random tokens; only the SHA-256 of the token is stored.
 * A database leak therefore does not hand over live sessions. SHA-256 (not
 * argon2) is correct here because the token already has 256 bits of entropy —
 * there is nothing to brute-force.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionArgs {
  userId: string;
  tenantId: string;
  userAgent?: string | null;
  ipHash?: string | null;
}

export async function createSession(args: CreateSessionArgs): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);
  await prisma.session.create({
    data: {
      userId: args.userId,
      tenantId: args.tenantId,
      tokenHash: hashSessionToken(token),
      userAgent: args.userAgent?.slice(0, 500) ?? null,
      ipHash: args.ipHash ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE || isProd,
    expires: expiresAt,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

/** Remove expired rows. Called periodically by the worker. */
export async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
