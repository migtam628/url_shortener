/** Environment loading and validation.
 *
 *  Parsed once at import time and frozen. A missing or malformed value fails
 *  the process at boot rather than at the first request that needs it. */

import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z.coerce.number().int().optional().transform((v) => (v === undefined ? def : v));

const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PG_POOL_MAX_API: int(20),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  REDIS_LINK_TTL: int(300),

  API_PORT: int(4000),
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  SESSION_TTL_HOURS: int(720),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  IP_HASH_SECRET: z.string().min(8, 'IP_HASH_SECRET must be at least 8 characters'),
  ALLOW_REGISTRATION: bool(true),

  RATE_LIMIT_API_PER_MINUTE: int(600),
  RATE_LIMIT_AUTH_PER_MINUTE: int(10),

  DEFAULT_SLUG_LENGTH: int(7),
  SHORT_DOMAINS: csv([]),

  MAXMIND_LICENSE_KEY: z.string().optional(),
  GEOIP_DB_PATH: z.string().default('/geoip/GeoLite2-City.mmdb'),

  CLICK_QUEUE_NAME: z.string().default('clicks'),
  CLICK_WORKER_CONCURRENCY: int(8),
  CLICK_BATCH_SIZE: int(200),
  CLICK_BATCH_MS: int(1000),

  OG_FETCH_TIMEOUT_MS: int(5000),
  OG_CACHE_TTL_SECONDS: int(86_400),

  METRICS_ENABLED: bool(true),
  METRICS_TOKEN: z.string().optional(),

  TRUST_PROXY_HOPS: int(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately not the logger: the logger reads config that just failed.
  process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example.\n\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
