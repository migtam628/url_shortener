import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Redis connections.
 *
 * Three separate clients, deliberately:
 *  - `redis`    general commands
 *  - `publisher` invalidation publishes
 *  - BullMQ gets its own, created in queue.ts
 *
 * A connection in subscriber mode cannot issue normal commands, and sharing
 * one client between the queue and ordinary use has bitten enough people that
 * BullMQ now warns about it.
 */

function create(name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  client.on('error', (err: Error) => logger.warn({ err, client: name }, 'redis error'));
  client.on('ready', () => logger.debug({ client: name }, 'redis ready'));
  return client;
}

export const redis = create('main');
export const publisher = create('publisher');

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), publisher.quit()]);
}
