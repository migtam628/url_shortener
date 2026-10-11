import type { FastifyPluginAsync } from 'fastify';
import { createApiKeySchema } from '@mtlink/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireRole } from '../auth/guard.js';
import { generateApiKey } from '../auth/apikey.js';

const idParam = z.object({ id: z.string().uuid() });

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  // Only a session user may manage keys — a key cannot mint another key.
  app.addHook('preHandler', requireRole('admin'));
  app.addHook('preHandler', async (req) => {
    if (req.auth?.via === 'apikey') {
      const { forbidden } = await import('../errors.js');
      throw forbidden('API keys cannot manage other API keys. Sign in to the dashboard.');
    }
  });

  app.get('/', async (req, reply) => {
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({
      items: keys.map((k) => ({
        id: k.id,
        name: k.name,
        // Never the secret — only the lookup prefix, so the user can tell
        // which key a log line refers to.
        prefix: `mtl_${k.prefix}_…`,
        scopes: k.scopes,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        createdAt: k.createdAt,
      })),
    });
  });

  app.post('/', async (req, reply) => {
    const body = createApiKeySchema.parse(req.body);
    const { token, prefix, keyHash } = generateApiKey();

    const key = await prisma.apiKey.create({
      data: {
        tenantId: req.auth!.tenantId,
        name: body.name,
        prefix,
        keyHash,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });

    return reply.code(201).send({
      id: key.id,
      name: key.name,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      /** Shown once. It is not recoverable afterwards. */
      token,
      warning: 'Copy this token now — it is never shown again.',
    });
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.apiKey.findFirst({
      where: { id, tenantId: req.auth!.tenantId },
    });
    if (!existing) throw notFound('API key not found.');

    // Revoke rather than delete, so audit trails keep resolving the prefix.
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return reply.code(204).send();
  });
};
