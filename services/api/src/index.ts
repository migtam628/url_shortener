import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma, disconnectDb } from './db.js';
import { disconnectRedis } from './redis.js';
import { closeQueue } from './queue.js';

async function main(): Promise<void> {
  // Make sure the click table always has partitions ahead of it. Cheap,
  // idempotent, and it means a fresh deployment is never one month away from
  // writing everything into click_default.
  try {
    await prisma.$queryRaw`SELECT mtlink_ensure_click_partitions(12)`;
    logger.info('click partitions ensured');
  } catch (err) {
    logger.error({ err }, 'could not ensure click partitions — run migrations?');
  }

  const app = await buildApp();
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  logger.info({ port: env.API_PORT }, 'API listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Order matters: stop accepting new work, let in-flight requests finish,
    // then release the connections they were using.
    try {
      await app.close();
      await closeQueue();
      await disconnectDb();
      await disconnectRedis();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start API');
  process.exit(1);
});
