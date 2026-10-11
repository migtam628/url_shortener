import { PrismaClient } from '@prisma/client';
import { env, isProd } from './env.js';
import { logger } from './logger.js';

export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: isProd
    ? [{ emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
});

prisma.$on('error', (e) => logger.error({ prisma: e }, 'prisma error'));
if (!isProd) prisma.$on('warn', (e) => logger.warn({ prisma: e }, 'prisma warning'));

/**
 * Prisma serializes BigInt as a BigInt, which JSON.stringify refuses to
 * handle. click_count is a BigInt, so without this every link response throws.
 */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)),
  ) as T;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
