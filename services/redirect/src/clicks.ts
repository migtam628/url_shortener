import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ClickEvent } from '@mtlink/shared';
import { env } from './env.js';
import { logger } from './logger.js';
import { clickEnqueued, degraded } from './metrics.js';

/**
 * Click emission.
 *
 * Fire-and-forget by construction: `enqueue` returns void and never awaits
 * inside the request handler. If Redis is down the click is dropped and
 * counted, and the visitor still gets their redirect at full speed. Losing
 * analytics is an acceptable failure; delaying a redirect is not.
 */

let queue: Queue<ClickEvent> | null = null;
let connection: Redis | null = null;

export function initClicks(): void {
  connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  connection.on('error', (err: Error) => {
    degraded.set({ dependency: 'click-queue' }, 1);
    logger.warn({ err: err.message }, 'click queue unavailable — clicks will be dropped');
  });
  connection.on('ready', () => degraded.set({ dependency: 'click-queue' }, 0));

  queue = new Queue<ClickEvent>(env.CLICK_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { count: 1_000, age: 3_600 },
      removeOnFail: { count: 5_000, age: 86_400 },
    },
  });
}

export function enqueueClick(event: ClickEvent): void {
  if (!queue) {
    clickEnqueued.inc({ result: 'dropped' });
    return;
  }
  queue
    .add('click', event, { jobId: undefined })
    .then(() => clickEnqueued.inc({ result: 'ok' }))
    .catch(() => clickEnqueued.inc({ result: 'dropped' }));
}

export async function closeClicks(): Promise<void> {
  await Promise.allSettled([queue?.close(), connection?.quit()]);
  queue = null;
  connection = null;
}
