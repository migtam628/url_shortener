import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

const MONTHS_AHEAD = 12;

/**
 * Keep monthly click partitions provisioned a year ahead.
 *
 * If this ever stops running, writes land in `click_default` rather than
 * failing — correct, but it defeats partition pruning, so the default
 * partition being non-empty is worth alerting on.
 */
export async function ensurePartitions(monthsAhead = MONTHS_AHEAD): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ mtlink_ensure_click_partitions: string }>>(
    // Prisma binds a JS number as bigint; the function takes int, and
    // Postgres will not implicitly narrow, so cast explicitly.
    Prisma.sql`SELECT mtlink_ensure_click_partitions(${monthsAhead}::int)`,
  );
  const results = rows.map((r) => r.mtlink_ensure_click_partitions);
  const created = results.filter((r) => r.endsWith('(created)'));
  if (created.length) logger.info({ created }, 'click partitions created');
  return results;
}

/** Rows that missed every range partition. Should always be zero. */
export async function defaultPartitionCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM click_default`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Drop click partitions entirely older than `months`. DETACH then DROP, which
 * is near-instant and takes no long lock, unlike a bulk DELETE.
 */
export async function dropOldPartitions(months: number): Promise<string[]> {
  if (months < 1) throw new Error('months must be >= 1');
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffName = `click_${cutoff.getUTCFullYear()}_${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;

  const parts = await prisma.$queryRaw<Array<{ relname: string }>>(Prisma.sql`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'click' AND c.relname ~ '^click_[0-9]{4}_[0-9]{2}$'
    ORDER BY c.relname
  `);

  const dropped: string[] = [];
  for (const { relname } of parts) {
    if (relname >= cutoffName) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE "click" DETACH PARTITION "${relname}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE "${relname}"`);
    dropped.push(relname);
  }
  if (dropped.length) logger.info({ dropped }, 'old click partitions dropped');
  return dropped;
}
