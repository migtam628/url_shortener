import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';
import type { ClickEvent } from '@mtlink/shared';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});
connection.on('error', (err: Error) => logger.warn({ err }, 'queue redis error'));

export const clickQueue = new Queue<ClickEvent>(env.CLICK_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // A click is worth retrying a couple of times but is not worth blocking
    // anything over; analytics are lossy by nature.
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000, age: 3600 },
    removeOnFail: { count: 5000, age: 86_400 },
  },
});

export async function queueDepth(): Promise<number> {
  try {
    const counts = await clickQueue.getJobCounts('waiting', 'active', 'delayed');
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  } catch {
    return -1;
  }
}

export async function closeQueue(): Promise<void> {
  await clickQueue.close();
  await connection.quit();
}
