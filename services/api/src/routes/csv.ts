import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { badRequest } from '../errors.js';
import { requireScope, requireWriter } from '../auth/guard.js';
import { createLinksBulk } from '../services/links.js';

/** Minimal RFC 4180 parser — quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const importSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  domainId: z.string().uuid().optional(),
  continueOnError: z.boolean().default(true),
});

export const csvRoutes: FastifyPluginAsync = async (app) => {
  // ---- export -----------------------------------------------------------
  app.get('/export', { preHandler: requireScope('links:read') }, async (req, reply) => {
    const links = await prisma.link.findMany({
      where: { tenantId: req.auth!.tenantId },
      orderBy: { createdAt: 'desc' },
      include: { domain: { select: { hostname: true } }, folder: { select: { name: true } } },
    });

    const header = [
      'short_url', 'hostname', 'slug', 'destination', 'redirect_code',
      'title', 'description', 'tags', 'folder', 'clicks', 'created_at', 'archived_at',
    ];

    const lines = [header.join(',')];
    for (const l of links) {
      lines.push([
        `https://${l.domain.hostname}/${l.slug}`,
        l.domain.hostname,
        l.slug,
        l.destination,
        l.redirectCode,
        l.title,
        l.description,
        l.tags.join('|'),
        l.folder?.name,
        Number(l.clickCount),
        l.createdAt.toISOString(),
        l.archivedAt?.toISOString(),
      ].map(csvEscape).join(','));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="mtlink-links-${stamp}.csv"`)
      .send(lines.join('\n'));
  });

  // ---- import -----------------------------------------------------------
  app.post('/import', { preHandler: [requireScope('links:write'), requireWriter] }, async (req, reply) => {
    const body = importSchema.parse(req.body);
    const rows = parseCsv(body.csv);
    if (rows.length < 2) throw badRequest('CSV must contain a header row and at least one data row.');

    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const col = (name: string) => header.indexOf(name);

    const iDest = col('destination') !== -1 ? col('destination') : col('url');
    const iSlug = col('slug');
    const iTitle = col('title');
    const iTags = col('tags');
    const iCode = col('redirect_code');

    if (iDest === -1) {
      throw badRequest('CSV must include a "destination" (or "url") column. Found: ' + header.join(', '));
    }
    if (rows.length - 1 > 1000) {
      throw badRequest(`CSV has ${rows.length - 1} rows; the limit is 1000 per import.`);
    }

    const inputs = rows.slice(1).map((r) => {
      const rawCode = iCode !== -1 ? Number(r[iCode]) : 302;
      const redirectCode = rawCode === 301 || rawCode === 307 ? rawCode : 302;
      const slug = iSlug !== -1 ? r[iSlug]?.trim() : undefined;
      const title = iTitle !== -1 ? r[iTitle]?.trim() : undefined;
      const tags = iTags !== -1 ? (r[iTags] ?? '').split(/[|;]/).map((t) => t.trim()).filter(Boolean) : [];
      return {
        destination: r[iDest] ?? '',
        redirectCode: redirectCode as 301 | 302 | 307,
        tags,
        ...(body.domainId ? { domainId: body.domainId } : {}),
        ...(slug ? { slug } : {}),
        ...(title ? { title } : {}),
      };
    });

    const auth = req.auth!;
    const result = await createLinksBulk(
      inputs,
      { tenantId: auth.tenantId, userId: auth.userId },
      body.continueOnError,
    );
    return reply.code(result.failed > 0 ? 207 : 201).send(result);
  });
};
