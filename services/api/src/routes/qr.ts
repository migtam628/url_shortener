import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { qrQuerySchema } from '@mtlink/shared';
import { z } from 'zod';
import { prisma } from '../db.js';
import { notFound } from '../errors.js';
import { requireScope } from '../auth/guard.js';

const idParam = z.object({ id: z.string().uuid() });

function hex(v: string): string {
  return v.startsWith('#') ? v : `#${v}`;
}

async function shortUrlFor(id: string, tenantId: string): Promise<string> {
  const link = await prisma.link.findFirst({
    where: { id, tenantId },
    include: { domain: { select: { hostname: true } } },
  });
  if (!link) throw notFound('Link not found.');
  return `https://${link.domain.hostname}/${link.slug}`;
}

export const qrRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/qr.png', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = qrQuerySchema.parse(req.query);
    const url = await shortUrlFor(id, req.auth!.tenantId);

    const buffer = await QRCode.toBuffer(url, {
      type: 'png',
      width: q.size,
      margin: q.margin,
      errorCorrectionLevel: q.ecc,
      color: { dark: hex(q.color), light: hex(q.bg) },
    });

    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, max-age=300')
      .header('content-disposition', `inline; filename="qr-${id}.png"`)
      .send(buffer);
  });

  app.get('/:id/qr.svg', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = qrQuerySchema.parse(req.query);
    const url = await shortUrlFor(id, req.auth!.tenantId);

    const svg = await QRCode.toString(url, {
      type: 'svg',
      width: q.size,
      margin: q.margin,
      errorCorrectionLevel: q.ecc,
      color: { dark: hex(q.color), light: hex(q.bg) },
    });

    return reply
      .header('content-type', 'image/svg+xml')
      .header('cache-control', 'private, max-age=300')
      .send(svg);
  });
};
