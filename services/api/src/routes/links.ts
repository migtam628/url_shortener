import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  bulkLinkSchema,
  createLinkSchema,
  listLinksQuerySchema,
  updateLinkSchema,
} from '@mtlink/shared';
import { z } from 'zod';
import { prisma, jsonSafe } from '../db.js';
import { notFound } from '../errors.js';
import { requireScope, requireWriter } from '../auth/guard.js';
import {
  createLink,
  createLinksBulk,
  deleteLink,
  updateLink,
} from '../services/links.js';
import { refreshOgForLink } from '../services/og.js';

const idParam = z.object({ id: z.string().uuid() });

/** Cursor is "<ISO timestamp>|<uuid>" — a stable keyset, unlike OFFSET which
 *  skips or repeats rows when the list changes under the reader. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!ts || !id) return null;
    const createdAt = new Date(ts);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export const linkRoutes: FastifyPluginAsync = async (app) => {
  // ---- list -------------------------------------------------------------
  app.get('/', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const q = listLinksQuerySchema.parse(req.query);
    const tenantId = req.auth!.tenantId;

    const where: Prisma.LinkWhereInput = {
      tenantId,
      ...(q.domainId ? { domainId: q.domainId } : {}),
      ...(q.folderId ? { folderId: q.folderId } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.archived === undefined
        ? { archivedAt: null }
        : q.archived
          ? { archivedAt: { not: null } }
          : { archivedAt: null }),
      ...(q.q
        ? {
            OR: [
              { slug: { contains: q.q, mode: 'insensitive' } },
              { title: { contains: q.q, mode: 'insensitive' } },
              { destination: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.LinkOrderByWithRelationInput[] =
      q.sort === 'created_asc'
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : q.sort === 'clicks_desc'
          ? [{ clickCount: 'desc' }, { id: 'desc' }]
          : q.sort === 'updated_desc'
            ? [{ updatedAt: 'desc' }, { id: 'desc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }];

    // Keyset pagination only applies to the created_* sorts, where the cursor
    // columns are in the ORDER BY. Other sorts fall back to a plain first page.
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor && (q.sort === 'created_desc' || q.sort === 'created_asc')) {
      const op = q.sort === 'created_asc' ? 'gt' : 'lt';
      where.AND = [
        {
          OR: [
            { createdAt: { [op]: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { [op]: cursor.id } },
          ],
        },
      ];
    }

    const rows = await prisma.link.findMany({
      where,
      orderBy,
      take: q.limit + 1,
      include: { domain: { select: { hostname: true } } },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items.at(-1);

    return reply.send(
      jsonSafe({
        items: items.map((l) => ({
          id: l.id,
          slug: l.slug,
          shortUrl: `https://${l.domain.hostname}/${l.slug}`,
          destination: l.destination,
          redirectCode: l.redirectCode,
          title: l.title,
          description: l.description,
          tags: l.tags,
          folderId: l.folderId,
          clickCount: l.clickCount,
          og: { title: l.ogTitle, description: l.ogDescription, image: l.ogImage },
          archivedAt: l.archivedAt,
          createdAt: l.createdAt,
          updatedAt: l.updatedAt,
        })),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      }),
    );
  });

  // ---- create -----------------------------------------------------------
  app.post('/', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const body = createLinkSchema.parse(req.body);
    const auth = req.auth!;
    const result = await createLink(body, { tenantId: auth.tenantId, userId: auth.userId }, auth.via === 'session' ? 'dashboard' : 'api');
    return reply.code(201).send(result);
  });

  // ---- bulk create ------------------------------------------------------
  app.post('/bulk', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const body = bulkLinkSchema.parse(req.body);
    const auth = req.auth!;
    const result = await createLinksBulk(
      body.links,
      { tenantId: auth.tenantId, userId: auth.userId },
      body.continueOnError,
    );
    // 207: the batch as a whole succeeded even though rows may have failed.
    return reply.code(result.failed > 0 ? 207 : 201).send(result);
  });

  // ---- read one ---------------------------------------------------------
  app.get('/:id', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const link = await prisma.link.findFirst({
      where: { id, tenantId: req.auth!.tenantId },
      include: {
        domain: { select: { hostname: true } },
        folder: { select: { id: true, name: true } },
        security: true,
        rules: { orderBy: { priority: 'asc' } },
      },
    });
    if (!link) throw notFound('Link not found.');

    return reply.send(
      jsonSafe({
        ...link,
        shortUrl: `https://${link.domain.hostname}/${link.slug}`,
      }),
    );
  });

  // ---- update -----------------------------------------------------------
  app.patch('/:id', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateLinkSchema.parse(req.body);
    const auth = req.auth!;
    await updateLink(id, body, { tenantId: auth.tenantId, userId: auth.userId });

    const updated = await prisma.link.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { domain: { select: { hostname: true } } },
    });
    if (!updated) throw notFound('Link not found.');

    return reply.send(
      jsonSafe({
        id: updated.id,
        slug: updated.slug,
        shortUrl: `https://${updated.domain.hostname}/${updated.slug}`,
        destination: updated.destination,
        redirectCode: updated.redirectCode,
        updatedAt: updated.updatedAt,
      }),
    );
  });

  // ---- delete -----------------------------------------------------------
  app.delete('/:id', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await deleteLink(id, { tenantId: req.auth!.tenantId });
    return reply.code(204).send();
  });

  // ---- version history --------------------------------------------------
  app.get('/:id/versions', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const link = await prisma.link.findFirst({
      where: { id, tenantId: req.auth!.tenantId },
      select: { id: true },
    });
    if (!link) throw notFound('Link not found.');

    const versions = await prisma.linkVersion.findMany({
      where: { linkId: id },
      orderBy: { changedAt: 'desc' },
      take: 200,
      include: { changedBy: { select: { id: true, name: true, email: true } } },
    });

    return reply.send({ items: jsonSafe(versions) });
  });

  // ---- open graph preview ----------------------------------------------
  app.post('/:id/og', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const link = await prisma.link.findFirst({
      where: { id, tenantId: req.auth!.tenantId },
      select: { id: true },
    });
    if (!link) throw notFound('Link not found.');
    return reply.send(await refreshOgForLink(id));
  });
};
