import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { createDomainSchema, updateDomainSchema, validateDestination } from '@mtlink/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { requireScope, requireWriter } from '../auth/guard.js';
import { invalidateDomain } from '../lib/invalidate.js';

const idParam = z.object({ id: z.string().uuid() });

function checkRedirect(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const r = validateDestination(value, { shortDomains: env.SHORT_DOMAINS });
  if (!r.ok) throw unprocessable(`${field}: ${r.reason}`);
  return r.url;
}

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireScope('domains:read') }, async (req, reply) => {
    const domains = await prisma.domain.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { links: true } } },
    });
    return reply.send({
      items: domains.map((d) => ({
        id: d.id,
        hostname: d.hostname,
        isDefault: d.isDefault,
        mainPageRedirect: d.mainPageRedirect,
        notFoundRedirect: d.notFoundRedirect,
        certStatus: d.certStatus,
        certLastError: d.certLastError,
        verifiedAt: d.verifiedAt,
        linkCount: d._count.links,
        createdAt: d.createdAt,
      })),
    });
  });

  app.post('/', { preHandler: [requireScope('domains:write'), requireWriter] }, async (req, reply) => {
    const body = createDomainSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const mainPageRedirect = checkRedirect(body.mainPageRedirect, 'mainPageRedirect');
    const notFoundRedirect = checkRedirect(body.notFoundRedirect, 'notFoundRedirect');

    try {
      const domain = await prisma.$transaction(async (tx) => {
        if (body.isDefault) {
          await tx.domain.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
        }
        const count = await tx.domain.count({ where: { tenantId } });
        return tx.domain.create({
          data: {
            tenantId,
            hostname: body.hostname,
            // The first domain a tenant adds is their default, whatever they asked for.
            isDefault: body.isDefault || count === 0,
            mainPageRedirect,
            notFoundRedirect,
          },
        });
      });
      await invalidateDomain(domain.hostname);
      return reply.code(201).send(domain);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(
          `The hostname "${body.hostname}" is already registered on this instance. A hostname can only belong to one tenant.`,
        );
      }
      throw err;
    }
  });

  app.patch('/:id', { preHandler: [requireScope('domains:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateDomainSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    const existing = await prisma.domain.findFirst({ where: { id, tenantId } });
    if (!existing) throw notFound('Domain not found.');

    const data: Prisma.DomainUpdateInput = {};
    if (body.mainPageRedirect !== undefined) {
      data.mainPageRedirect = checkRedirect(body.mainPageRedirect, 'mainPageRedirect');
    }
    if (body.notFoundRedirect !== undefined) {
      data.notFoundRedirect = checkRedirect(body.notFoundRedirect, 'notFoundRedirect');
    }
    if (body.isDefault !== undefined) data.isDefault = body.isDefault;

    const updated = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.domain.updateMany({
          where: { tenantId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.domain.update({ where: { id }, data });
    });

    await invalidateDomain(updated.hostname);
    return reply.send(updated);
  });

  app.delete('/:id', { preHandler: [requireScope('domains:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const tenantId = req.auth!.tenantId;

    const existing = await prisma.domain.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { links: true } } },
    });
    if (!existing) throw notFound('Domain not found.');

    // Deleting a domain cascades to its links, which silently kills every
    // short URL on it. Make the caller empty it first.
    if (existing._count.links > 0) {
      throw conflict(
        `This domain still has ${existing._count.links} link(s). Delete or move them before removing the domain — removing it would break every one of those short URLs.`,
      );
    }

    await prisma.domain.delete({ where: { id } });
    await invalidateDomain(existing.hostname);
    return reply.code(204).send();
  });
};
