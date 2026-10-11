import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { createFolderSchema } from '@mtlink/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { requireScope, requireWriter } from '../auth/guard.js';

const idParam = z.object({ id: z.string().uuid() });

export const folderRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const folders = await prisma.folder.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { links: true } } },
    });
    return reply.send({
      items: folders.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        linkCount: f._count.links,
      })),
    });
  });

  app.post('/', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const body = createFolderSchema.parse(req.body);
    const tenantId = req.auth!.tenantId;

    if (body.parentId) {
      const parent = await prisma.folder.findFirst({ where: { id: body.parentId, tenantId } });
      if (!parent) throw notFound('Parent folder not found.');
    }

    try {
      const folder = await prisma.folder.create({
        data: { tenantId, name: body.name, parentId: body.parentId ?? null },
      });
      return reply.code(201).send(folder);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(`A folder named "${body.name}" already exists here.`);
      }
      throw err;
    }
  });

  app.delete('/:id', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = await prisma.folder.findFirst({
      where: { id, tenantId: req.auth!.tenantId },
    });
    if (!existing) throw notFound('Folder not found.');

    // Links survive; folderId is set null by the FK rule. Deleting a folder
    // should never delete links.
    await prisma.folder.delete({ where: { id } });
    return reply.code(204).send();
  });
};
