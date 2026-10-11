import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

const MONTHS_AHEAD = 12;
const MONTHS_BACK = 2;

/**
 * Keep monthly click partitions provisioned a year ahead AND a couple of
 * months back.
 *
 * Backwards matters more than it looks: a click's timestamp is when the
 * redirect happened, not when the worker wrote it. A queue backlog that
 * straddles a month boundary, a replayed dead-letter job, or an imported
 * history all produce rows dated before the current month. Without a
 * partition for that month they land in `click_default` — not lost, but
 * invisible to partition pruning, which is the whole point of partitioning.
 *
 * `click_default` being non-empty is therefore the alert worth having.
 */
export async function ensurePartitions(
  monthsAhead = MONTHS_AHEAD,
  monthsBack = MONTHS_BACK,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ mtlink_ensure_click_partitions: string }>>(
    // Prisma binds a JS number as bigint; the function takes int, and
    // Postgres will not implicitly narrow, so cast explicitly.
    Prisma.sql`SELECT mtlink_ensure_click_partitions(${monthsAhead}::int, ${monthsBack}::int)`,
  );
  const results = rows.map((r) => r.mtlink_ensure_click_partitions);
  const created = results.filter((r) => r.endsWith('(created)'));
  if (created.length) logger.info({ created }, 'click partitions created');
  return results;
}

/**
 * Move any rows stranded in `click_default` into their proper partitions,
 * creating those partitions as needed.
 *
 * Safe to call routinely: it is a no-op when the default is empty, and it
 * runs in a single transaction so a click is never in neither place.
 */
export async function drainDefaultPartition(): Promise<{ moved: number; partitions: string[] }> {
  const rows = await prisma.$queryRaw<Array<{ moved: bigint; partitions: string[] }>>(
    Prisma.sql`SELECT * FROM mtlink_drain_default_partition()`,
  );
  const result = {
    moved: Number(rows[0]?.moved ?? 0),
    partitions: rows[0]?.partitions ?? [],
  };
  if (result.moved > 0) {
    logger.warn(
      result,
      'rows were stranded in click_default and have been moved — check that the partition job is running',
    );
  }
  return result;
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
