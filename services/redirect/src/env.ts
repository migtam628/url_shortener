import { z } from 'zod';

const bool = (def: boolean) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z.coerce.number().int().optional().transform((v) => (v === undefined ? def : v));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX_REDIRECT: int(10),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  REDIS_LINK_TTL: int(300),
  LRU_MAX: int(1000),
  LRU_TTL_MS: int(60_000),

  REDIRECT_PORT: int(4001),
  CLICK_QUEUE_NAME: z.string().default('clicks'),
  DEFAULT_ROOT_REDIRECT: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),

  METRICS_ENABLED: bool(true),
  METRICS_TOKEN: z.string().optional(),
  TRUST_PROXY_HOPS: int(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isProd = env.NODE_ENV === 'production';
