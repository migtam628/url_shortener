import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

/**
 * Recompute the daily rollup for one day.
 *
 * `mtlink_rollup_day` deletes and reinserts that day, so running it twice is
 * a no-op rather than a double count. That property is what makes backfill
 * and catch-up after downtime completely safe.
 */
export async function runRollup(day: Date): Promise<number> {
  const date = day.toISOString().slice(0, 10);
  const rows = await prisma.$queryRaw<Array<{ mtlink_rollup_day: bigint }>>(
    Prisma.sql`SELECT mtlink_rollup_day(${date}::date)`,
  );
  const count = Number(rows[0]?.mtlink_rollup_day ?? 0);
  logger.debug({ day: date, rows: count }, 'rollup complete');
  return count;
}

/** Backfill a range, oldest first. Used after an outage or a schema change. */
export async function backfillRollups(from: Date, to: Date): Promise<number> {
  let total = 0;
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
    total += await runRollup(d);
  }
  return total;
}
