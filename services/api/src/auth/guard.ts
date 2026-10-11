import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyScope, UserRole } from '@mtlink/shared';
import { prisma } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { SESSION_COOKIE, hashSessionToken } from './session.js';
import { hasScope, parseApiKey, secretMatches } from './apikey.js';

export interface AuthContext {
  tenantId: string;
  /** Absent for API-key auth. */
  userId?: string;
  role: UserRole;
  via: 'session' | 'apikey';
  scopes: readonly string[];
  apiKeyId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Resolve the caller from either a session cookie or a bearer API key.
 * Returns undefined rather than throwing, so routes can be optionally
 * authenticated.
 */
export async function resolveAuth(req: FastifyRequest): Promise<AuthContext | undefined> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return resolveApiKey(header.slice(7).trim());
  }

  const token = req.cookies?.[SESSION_COOKIE];
  if (token) return resolveSession(token);

  return undefined;
}

async function resolveSession(token: string): Promise<AuthContext | undefined> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return undefined;
  if (session.expiresAt.getTime() < Date.now()) {
    // Clean up lazily; the worker also prunes in bulk.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return undefined;
  }
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.user.role,
    via: 'session',
    // A logged-in user is not scope-limited; roles govern instead.
    scopes: ['links:write', 'domains:write', 'analytics:read'],
  };
}

async function resolveApiKey(token: string): Promise<AuthContext | undefined> {
  const parsed = parseApiKey(token);
  if (!parsed) return undefined;

  const key = await prisma.apiKey.findUnique({ where: { prefix: parsed.prefix } });
  if (!key) return undefined;
  if (key.revokedAt) return undefined;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return undefined;
  if (!secretMatches(key.keyHash, parsed.secret)) return undefined;

  // Best-effort last-used stamp; never block the request on it.
  void prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    tenantId: key.tenantId,
    role: 'member',
    via: 'apikey',
    scopes: key.scopes,
    apiKeyId: key.id,
  };
}

/** Fastify preHandler: require any authenticated caller. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = await resolveAuth(req);
  if (!auth) throw unauthorized();
  req.auth = auth;
}

/** Fastify preHandler factory: require a specific API scope. */
export function requireScope(scope: ApiKeyScope) {
  return async function scopeGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.auth) await requireAuth(req, reply);
    const auth = req.auth;
    if (!auth) throw unauthorized();
    if (!hasScope(auth.scopes, scope)) {
      throw forbidden(`This credential is missing the "${scope}" scope.`);
    }
  };
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Fastify preHandler factory: require at least the given role. */
export function requireRole(min: UserRole) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.auth) await requireAuth(req, reply);
    const auth = req.auth;
    if (!auth) throw unauthorized();
    if (ROLE_RANK[auth.role] < ROLE_RANK[min]) {
      throw forbidden(`This action requires the "${min}" role or higher.`);
    }
  };
}

/** Viewers may read but never write. */
export async function requireWriter(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireRole('member')(req, reply);
}
