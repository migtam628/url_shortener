import { env } from './env.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';
import { initCache, closeCache } from './cache.js';
import { initClicks, closeClicks } from './clicks.js';
import { closePg } from './pg.js';

async function main(): Promise<void> {
  initCache();
  initClicks();

  const app = buildServer();
  await app.listen({ port: env.REDIRECT_PORT, host: '0.0.0.0' });
  logger.info({ port: env.REDIRECT_PORT }, 'redirect service listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      // Stop accepting, drain in-flight redirects, then release connections.
      await app.close();
      await closeClicks();
      await closeCache();
      await closePg();
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
  logger.fatal({ err }, 'failed to start redirect service');
  process.exit(1);
});
