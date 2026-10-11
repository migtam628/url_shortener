import type { FastifyPluginAsync } from 'fastify';
import { analyticsQuerySchema } from '@mtlink/shared';
import { Prisma } from '@prisma/client';
import { prisma, jsonSafe } from '../db.js';
import { requireScope } from '../auth/guard.js';

/**
 * Analytics.
 *
 * Two read paths on purpose:
 *  - ranges of 30 days or less hit the raw `click` partitions, so today's
 *    numbers are live to the second;
 *  - longer ranges read `click_daily`, so a year-long query touches a few
 *    thousand pre-aggregated rows instead of tens of millions of raw ones.
 *
 * The cutover is the only reason an analytics page stays fast as the instance
 * ages, and it is invisible to the caller apart from `source` in the response.
 */
const RAW_WINDOW_DAYS = 30;

function range(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86_400_000);
  return { from: start, to: end };
}

function useRollup(from: Date, to: Date): boolean {
  return (to.getTime() - from.getTime()) / 86_400_000 > RAW_WINDOW_DAYS;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireScope('analytics:read'));

  // ---- summary ----------------------------------------------------------
  app.get('/summary', async (req, reply) => {
    const q = analyticsQuerySchema.parse(req.query);
    const tenantId = req.auth!.tenantId;
    const { from, to } = range(q.from, q.to);

    const linkFilter = q.linkId ? Prisma.sql`AND c.link_id = ${q.linkId}::uuid` : Prisma.empty;

    const rows = await prisma.$queryRaw<Array<{ clicks: bigint; bots: bigint; uniques: bigint }>>(
      Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE NOT c.is_bot)        AS clicks,
          COUNT(*) FILTER (WHERE c.is_bot)            AS bots,
          COUNT(DISTINCT c.ip_hash) FILTER (WHERE NOT c.is_bot) AS uniques
        FROM click c
        WHERE c.tenant_id = ${tenantId}::uuid
          AND c.ts >= ${from} AND c.ts < ${to}
          ${linkFilter}
      `,
    );

    const r = rows[0] ?? { clicks: 0n, bots: 0n, uniques: 0n };
    return reply.send(
      jsonSafe({
        from,
        to,
        clicks: Number(r.clicks),
        bots: Number(r.bots),
        uniqueVisitors: Number(r.uniques),
      }),
    );
  });

  // ---- time series ------------------------------------------------------
  app.get('/timeseries', async (req, reply) => {
    const q = analyticsQuerySchema.parse(req.query);
    const tenantId = req.auth!.tenantId;
    const { from, to } = range(q.from, q.to);
    const rollup = useRollup(from, to);

    const linkFilter = q.linkId ? Prisma.sql`AND link_id = ${q.linkId}::uuid` : Prisma.empty;

    const rows = rollup
      ? await prisma.$queryRaw<Array<{ bucket: Date; clicks: bigint }>>(Prisma.sql`
          SELECT day::timestamptz AS bucket, SUM(clicks)::bigint AS clicks
          FROM click_daily
          WHERE tenant_id = ${tenantId}::uuid
            AND day >= ${from}::date AND day <= ${to}::date
            ${linkFilter}
          GROUP BY day ORDER BY day
        `)
      : await prisma.$queryRaw<Array<{ bucket: Date; clicks: bigint }>>(Prisma.sql`
          SELECT date_trunc(${q.interval}, ts AT TIME ZONE ${q.tz}) AT TIME ZONE ${q.tz} AS bucket,
                 COUNT(*)::bigint AS clicks
          FROM click
          WHERE tenant_id = ${tenantId}::uuid
            AND ts >= ${from} AND ts < ${to}
            AND NOT is_bot
            ${linkFilter}
          GROUP BY 1 ORDER BY 1
        `);

    return reply.send(
      jsonSafe({
        source: rollup ? 'rollup' : 'raw',
        interval: rollup ? 'day' : q.interval,
        points: rows.map((r) => ({ t: r.bucket, clicks: Number(r.clicks) })),
      }),
    );
  });

  // ---- breakdowns -------------------------------------------------------
  const DIMENSIONS = {
    country: 'country',
    device: 'device_type',
    os: 'os',
    browser: 'browser',
    referrer: 'referrer_host',
    language: 'language',
  } as const;

  app.get('/breakdown/:dimension', async (req, reply) => {
    const { dimension } = req.params as { dimension: string };
    const column = DIMENSIONS[dimension as keyof typeof DIMENSIONS];
    if (!column) {
      const { badRequest } = await import('../errors.js');
      throw badRequest(`Unknown dimension "${dimension}". Valid: ${Object.keys(DIMENSIONS).join(', ')}.`);
    }

    const q = analyticsQuerySchema.parse(req.query);
    const tenantId = req.auth!.tenantId;
    const { from, to } = range(q.from, q.to);
    const linkFilter = q.linkId ? Prisma.sql`AND link_id = ${q.linkId}::uuid` : Prisma.empty;

    // Column name comes from the DIMENSIONS allowlist above, never from input.
    const rows = await prisma.$queryRaw<Array<{ value: string | null; clicks: bigint }>>(
      Prisma.sql`
        SELECT ${Prisma.raw(`"${column}"`)} AS value, COUNT(*)::bigint AS clicks
        FROM click
        WHERE tenant_id = ${tenantId}::uuid
          AND ts >= ${from} AND ts < ${to}
          AND NOT is_bot
          ${linkFilter}
        GROUP BY 1
        ORDER BY clicks DESC
        LIMIT 50
      `,
    );

    return reply.send(
      jsonSafe({
        dimension,
        items: rows.map((r) => ({ value: r.value ?? 'unknown', clicks: Number(r.clicks) })),
      }),
    );
  });

  // ---- top links --------------------------------------------------------
  app.get('/top-links', async (req, reply) => {
    const q = analyticsQuerySchema.parse(req.query);
    const tenantId = req.auth!.tenantId;
    const { from, to } = range(q.from, q.to);

    const rows = await prisma.$queryRaw<
      Array<{ link_id: string; slug: string; hostname: string; destination: string; clicks: bigint }>
    >(Prisma.sql`
      SELECT c.link_id, l.slug, d.hostname, l.destination, COUNT(*)::bigint AS clicks
      FROM click c
      JOIN link l   ON l.id = c.link_id
      JOIN domain d ON d.id = l.domain_id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND c.ts >= ${from} AND c.ts < ${to}
        AND NOT c.is_bot
      GROUP BY c.link_id, l.slug, d.hostname, l.destination
      ORDER BY clicks DESC
      LIMIT 20
    `);

    return reply.send(
      jsonSafe({
        items: rows.map((r) => ({
          linkId: r.link_id,
          slug: r.slug,
          shortUrl: `https://${r.hostname}/${r.slug}`,
          destination: r.destination,
          clicks: Number(r.clicks),
        })),
      }),
    );
  });
};
