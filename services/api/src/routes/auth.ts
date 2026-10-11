import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { loginSchema, registerSchema } from '@mtlink/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, forbidden, unauthorized } from '../errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from '../auth/session.js';
import { requireAuth } from '../auth/guard.js';
import { hashIp } from '../lib/iphash.js';

function slugifyTenant(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/register', { config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!env.ALLOW_REGISTRATION) {
      throw forbidden('Registration is disabled on this instance.');
    }

    const body = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw conflict('An account with that email already exists.');

    const passwordHash = await hashPassword(body.password);
    const tenantName = body.tenantName ?? `${body.name}'s workspace`;

    // The first user of a new tenant owns it.
    let slug = slugifyTenant(tenantName);
    for (let i = 0; i < 5; i += 1) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({ data: { name: tenantName, slug } });
          const user = await tx.user.create({
            data: {
              tenantId: tenant.id,
              email: body.email,
              passwordHash,
              name: body.name,
              role: 'owner',
            },
          });
          return { tenant, user };
        });

        const { token, expiresAt } = await createSession({
          userId: result.user.id,
          tenantId: result.tenant.id,
          userAgent: req.headers['user-agent'],
          ipHash: hashIp(req.ip, result.tenant.id),
        });
        setSessionCookie(reply, token, expiresAt);

        return reply.code(201).send({
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
            role: result.user.role,
          },
          tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const target = (err.meta?.['target'] as string[] | undefined) ?? [];
          if (target.includes('email')) throw conflict('An account with that email already exists.');
          slug = `${slugifyTenant(tenantName)}-${Math.random().toString(36).slice(2, 7)}`;
          continue;
        }
        throw err;
      }
    }
    throw badRequest('Could not allocate a workspace slug. Try a different workspace name.');
  });

  app.post('/login', { config: { rateLimit: { max: env.RATE_LIMIT_AUTH_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // Hash even when the user does not exist, so the response time does not
    // reveal which emails are registered.
    const ok = user
      ? await verifyPassword(user.passwordHash, body.password)
      : await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
          body.password,
        );

    if (!user || !ok) throw unauthorized('Incorrect email or password.');

    const { token, expiresAt } = await createSession({
      userId: user.id,
      tenantId: user.tenantId,
      userAgent: req.headers['user-agent'],
      ipHash: hashIp(req.ip, user.tenantId),
    });
    setSessionCookie(reply, token, expiresAt);

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.auth!;
    const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId } });

    if (!auth.userId) {
      // API-key callers have a tenant but no user.
      return reply.send({
        user: null,
        tenant: tenant && { id: tenant.id, name: tenant.name, slug: tenant.slug },
        via: auth.via,
        scopes: auth.scopes,
      });
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId } });
    if (!user) throw unauthorized();

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: tenant && { id: tenant.id, name: tenant.name, slug: tenant.slug },
      via: auth.via,
    });
  });
};
