import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma } from '@prisma/client';
import type { ClickEvent } from '@mtlink/shared';
import { referrerHost } from '@mtlink/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma, disconnectDb } from './db.js';
import { hashIp } from './lib/iphash.js';
import { parseLanguage, parseUserAgent } from './lib/ua.js';
import { initGeoip, lookupGeo } from './lib/geoip.js';
import { clicksProcessed, clickQueueDepth, workerBatchSize } from './metrics.js';
import { closeQueue, queueDepth } from './queue.js';
import { runRollup } from './jobs/rollup.js';
import { ensurePartitions } from './jobs/partitions.js';
import { pruneExpiredSessions } from './auth/session.js';

/**
 * Click ingestion worker.
 *
 * Clicks arrive one job at a time but are written in batches: at this
 * cardinality a per-row INSERT would spend most of its time on round trips.
 * Rows buffer until CLICK_BATCH_SIZE or CLICK_BATCH_MS, whichever comes
 * first, so a quiet instance still flushes within a second.
 */

interface ClickRow {
  ts: Date;
  linkId: string;
  tenantId: string;
  ipHash: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  deviceType: string;
  os: string | null;
  browser: string | null;
  language: string | null;
  referrerHost: string | null;
  ruleId: string | null;
  isBot: boolean;
}

const buffer: ClickRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

function toRow(event: ClickEvent): ClickRow {
  const ua = parseUserAgent(event.userAgent);
  const geo = lookupGeo(event.ip);
  const ts = new Date(event.ts);

  return {
    ts,
    linkId: event.linkId,
    tenantId: event.tenantId,
    // Raw IP is hashed here and then dropped. It never reaches storage.
    ipHash: hashIp(event.ip, event.tenantId, ts),
    // Prefer MaxMind; fall back to the country the edge already told us.
    country: geo.country ?? (event.edgeCountry || null),
    region: geo.region,
    city: geo.city,
    deviceType: ua.deviceType,
    os: ua.os,
    browser: ua.browser,
    language: parseLanguage(event.acceptLanguage),
    referrerHost: referrerHost(event.referrer),
    ruleId: event.ruleId,
    isBot: ua.isBot,
  };
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);

  try {
    workerBatchSize.observe(batch.length);

    await prisma.$transaction(async (tx) => {
      await tx.click.createMany({
        data: batch.map((r) => ({
          ts: r.ts,
          linkId: r.linkId,
          tenantId: r.tenantId,
          ipHash: r.ipHash,
          country: r.country,
          region: r.region,
          city: r.city,
          deviceType: r.deviceType,
          os: r.os,
          browser: r.browser,
          language: r.language,
          referrerHost: r.referrerHost,
          ruleId: r.ruleId,
          isBot: r.isBot,
        })),
      });

      // Denormalized counter on `link`, so the dashboard list does not have
      // to aggregate the clicks table on every page load. Bots excluded.
      const perLink = new Map<string, number>();
      for (const r of batch) {
        if (r.isBot) continue;
        perLink.set(r.linkId, (perLink.get(r.linkId) ?? 0) + 1);
      }
      for (const [linkId, count] of perLink) {
        await tx.$executeRaw(
          Prisma.sql`UPDATE "link" SET "click_count" = "click_count" + ${count} WHERE "id" = ${linkId}::uuid`,
        );
      }
    });

    clicksProcessed.inc({ result: 'ok' }, batch.length);
    logger.debug({ rows: batch.length }, 'click batch written');
  } catch (err) {
    clicksProcessed.inc({ result: 'error' }, batch.length);
    // The batch is lost. That is the correct trade: analytics are not worth
    // stalling the queue over, and BullMQ has already retried the job.
    logger.error({ err, rows: batch.length }, 'click batch insert failed — rows dropped');
  } finally {
    flushing = false;
  }
}

function scheduleFlush(): void {
  if (buffer.length >= env.CLICK_BATCH_SIZE) {
    void flush();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, env.CLICK_BATCH_MS);
  flushTimer.unref();
}

async function main(): Promise<void> {
  await initGeoip();

  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  connection.on('error', (err: Error) => logger.warn({ err }, 'worker redis error'));

  const worker = new Worker<ClickEvent>(
    env.CLICK_QUEUE_NAME,
    async (job: Job<ClickEvent>) => {
      buffer.push(toRow(job.data));
      scheduleFlush();
    },
    { connection, concurrency: env.CLICK_WORKER_CONCURRENCY },
  );

  worker.on('failed', (job, err) => logger.warn({ err, jobId: job?.id }, 'click job failed'));
  worker.on('error', (err) => logger.warn({ err }, 'click worker error'));

  logger.info({ queue: env.CLICK_QUEUE_NAME, concurrency: env.CLICK_WORKER_CONCURRENCY }, 'click worker started');

  // ---- scheduled maintenance -------------------------------------------
  // In-process intervals rather than a cron container: one fewer moving part,
  // and each job is idempotent so an overlapping run is harmless.
  const hourly = setInterval(() => {
    void (async () => {
      try {
        clickQueueDepth.set(await queueDepth());
        await ensurePartitions();
        const pruned = await pruneExpiredSessions();
        if (pruned > 0) logger.info({ pruned }, 'expired sessions pruned');
      } catch (err) {
        logger.error({ err }, 'hourly maintenance failed');
      }
    })();
  }, 3600_000);
  hourly.unref();

  // Roll up yesterday and today every 15 minutes. Rolling up today as well
  // keeps long-range queries current without waiting for midnight.
  const rollup = setInterval(() => {
    void (async () => {
      try {
        const today = new Date();
        const yesterday = new Date(today.getTime() - 86_400_000);
        await runRollup(yesterday);
        await runRollup(today);
      } catch (err) {
        logger.error({ err }, 'rollup failed');
      }
    })();
  }, 900_000);
  rollup.unref();

  // Run once at boot so a fresh instance is immediately consistent.
  await ensurePartitions().catch((err: unknown) => logger.error({ err }, 'partition bootstrap failed'));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    clearInterval(hourly);
    clearInterval(rollup);
    if (flushTimer) clearTimeout(flushTimer);
    try {
      await worker.close();
      // Drain whatever is still buffered rather than dropping it.
      await flush();
      await closeQueue();
      await disconnectDb();
      await connection.quit();
      logger.info('worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start worker');
  process.exit(1);
});

export const _test = { toRow, flush, buffer };
