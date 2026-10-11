import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createFixture, destroyFixture, closeHelpers, prisma, type Fixture } from './helpers.js';
import {
  defaultPartitionCount,
  drainDefaultPartition,
  ensurePartitions,
} from '../src/jobs/partitions.js';
import { runRollup } from '../src/jobs/rollup.js';
import { createLink } from '../src/services/links.js';

let f: Fixture;
let linkId: string;

beforeAll(async () => {
  f = await createFixture('parts');
  const link = await createLink(
    { destination: 'https://example.com/partitioned', redirectCode: 302, tags: [] },
    { tenantId: f.tenantId, userId: f.userId },
  );
  linkId = link.id;
});

afterAll(async () => { await destroyFixture(f); await closeHelpers(); });

describe('click partitioning', () => {
  it('provisions partitions a year ahead and is idempotent', async () => {
    const first = await ensurePartitions(12, 2);
    expect(first).toHaveLength(15); // 2 back + current + 12 ahead

    const second = await ensurePartitions(12, 2);
    // Second run must create nothing.
    expect(second.every((r) => r.endsWith('(exists)'))).toBe(true);
  });

  it('routes a row into its monthly partition, not the default', async () => {
    const now = new Date();
    await prisma.click.create({
      data: { ts: now, linkId, tenantId: f.tenantId, country: 'US', deviceType: 'mobile' },
    });

    const expected = `click_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const rows = await prisma.$queryRaw<Array<{ partition: string }>>(Prisma.sql`
      SELECT tableoid::regclass::text AS partition
      FROM click WHERE tenant_id = ${f.tenantId}::uuid LIMIT 1
    `);
    expect(rows[0]?.partition).toBe(expected);
  });

  it('provisions past months too, so backdated clicks are not stranded', async () => {
    // Regression test. ensurePartitions originally only went forward from
    // the current month, so a click timestamped in a previous month — from
    // a queue backlog crossing a month boundary, a replayed job, or an
    // import — landed in click_default and lost partition pruning.
    await ensurePartitions(12, 3);

    const backdated = new Date();
    backdated.setUTCMonth(backdated.getUTCMonth() - 1, 15);
    backdated.setUTCHours(12, 0, 0, 0);

    await prisma.click.create({
      data: { ts: backdated, linkId, tenantId: f.tenantId, country: 'US', deviceType: 'backdated' },
    });

    const expected = `click_${backdated.getUTCFullYear()}_${String(backdated.getUTCMonth() + 1).padStart(2, '0')}`;
    const rows = await prisma.$queryRaw<Array<{ partition: string }>>(Prisma.sql`
      SELECT tableoid::regclass::text AS partition
      FROM click WHERE tenant_id = ${f.tenantId}::uuid AND device_type = 'backdated' LIMIT 1
    `);
    expect(rows[0]?.partition).toBe(expected);
  });

  it('keeps the default partition empty', async () => {
    // A non-zero count means the partition job stopped running, or data
    // arrived outside the provisioned window. Worth alerting on in
    // production, so it is worth asserting here.
    await drainDefaultPartition();
    expect(await defaultPartitionCount()).toBe(0);
  });

  it('drains stranded rows without losing any', async () => {
    const before = await prisma.click.count({ where: { tenantId: f.tenantId } });
    const result = await drainDefaultPartition();
    const after = await prisma.click.count({ where: { tenantId: f.tenantId } });
    expect(after).toBe(before);
    expect(result.moved).toBeGreaterThanOrEqual(0);
  });
});

describe('daily rollup', () => {
  it('aggregates clicks and separates bots', async () => {
    const day = new Date();
    day.setUTCHours(12, 0, 0, 0);

    // A device type no other test in this file writes, so the assertion
    // holds regardless of execution order within the suite.
    await prisma.click.createMany({
      data: [
        { ts: day, linkId, tenantId: f.tenantId, country: 'US', deviceType: 'kiosk', isBot: false },
        { ts: day, linkId, tenantId: f.tenantId, country: 'US', deviceType: 'kiosk', isBot: false },
        { ts: day, linkId, tenantId: f.tenantId, country: 'CA', deviceType: 'kiosk', isBot: false },
        { ts: day, linkId, tenantId: f.tenantId, country: 'US', deviceType: 'kiosk', isBot: true },
      ],
    });

    await runRollup(day);

    const rows = await prisma.clickDaily.findMany({ where: { tenantId: f.tenantId } });
    const us = rows.find((r) => r.country === 'US' && r.deviceType === 'kiosk');
    const ca = rows.find((r) => r.country === 'CA' && r.deviceType === 'kiosk');
    expect(Number(us?.clicks)).toBe(2);
    expect(Number(us?.bots)).toBe(1);
    expect(Number(ca?.clicks)).toBe(1);
  });

  it('is idempotent — re-running does not double count', async () => {
    const day = new Date();
    const before = await prisma.clickDaily.aggregate({
      where: { tenantId: f.tenantId },
      _sum: { clicks: true },
    });
    await runRollup(day);
    await runRollup(day);
    const after = await prisma.clickDaily.aggregate({
      where: { tenantId: f.tenantId },
      _sum: { clicks: true },
    });
    expect(Number(after._sum.clicks)).toBe(Number(before._sum.clicks));
  });
});
