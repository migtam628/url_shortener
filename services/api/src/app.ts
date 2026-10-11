import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { env, isProd } from './env.js';
import { logger } from './logger.js';
import { ApiError } from './errors.js';
import { httpDuration, httpRequests, registry } from './metrics.js';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { authRoutes } from './routes/auth.js';
import { linkRoutes } from './routes/links.js';
import { domainRoutes } from './routes/domains.js';
import { folderRoutes } from './routes/folders.js';
import { apiKeyRoutes } from './routes/apikeys.js';
import { analyticsRoutes } from './routes/analytics.js';
import { qrRoutes } from './routes/qr.js';
import { csvRoutes } from './routes/csv.js';

/** The concrete Fastify instance type, inferred from the factory so the
 *  registered plugin decorations stay visible to callers. */
export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Fastify accepts a hop count only as a string; a number is not in the
    // accepted union. 0 means 'do not trust any proxy'.
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? String(env.TRUST_PROXY_HOPS) : false,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    bodyLimit: 10 * 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // the SPA is served by nginx, not here
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: env.APP_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_API_PER_MINUTE,
    timeWindow: '1 minute',
    // Rate limit per API key where there is one, otherwise per IP. Without
    // this a single shared NAT egress would throttle every client behind it.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) return `key:${auth.slice(7, 40)}`;
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      error: { code: 'rate_limited', message: `Rate limit exceeded. Retry in ${ctx.after}.` },
    }),
  });

  // ---- metrics ----------------------------------------------------------
  app.addHook('onResponse', async (req, reply) => {
    if (!env.METRICS_ENABLED) return;
    const route = (req.routeOptions?.url ?? 'unknown').replace(/\/$/, '') || '/';
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // ---- errors -----------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: 'validation_failed',
          message: 'Request validation failed.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    if (err instanceof ApiError) {
      // 4xx is the caller's problem and does not deserve an error-level log.
      const level = err.statusCode >= 500 ? 'error' : 'info';
      req.log[level]({ err, code: err.code }, err.message);
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }

    const asError = err as { statusCode?: number; message?: string };
    if (asError.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'rate_limited', message: asError.message ?? 'Rate limit exceeded.' } });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        message: isProd ? 'An unexpected error occurred.' : (asError.message ?? 'Unknown error'),
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url}.` },
    }),
  );

  // ---- health and metrics ----------------------------------------------
  // Liveness: is the process up? Deliberately does NOT touch the database,
  // so an orchestrator does not restart a healthy API during a DB blip.
  app.get('/health', async () => ({ status: 'ok', service: 'api', ts: new Date().toISOString() }));

  // Readiness: can it actually serve? This one does check dependencies.
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks['postgres'] = 'ok';
    } catch {
      checks['postgres'] = 'down';
      ok = false;
    }
    try {
      await redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'down';
      ok = false;
    }
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  if (env.METRICS_ENABLED) {
    app.get('/metrics', async (req, reply) => {
      if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
        return reply.code(401).send('unauthorized');
      }
      return reply.header('content-type', registry.contentType).send(await registry.metrics());
    });
  }

  // ---- routes -----------------------------------------------------------
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(linkRoutes, { prefix: '/links' });
      await v1.register(qrRoutes, { prefix: '/links' });
      await v1.register(domainRoutes, { prefix: '/domains' });
      await v1.register(folderRoutes, { prefix: '/folders' });
      await v1.register(apiKeyRoutes, { prefix: '/api-keys' });
      await v1.register(analyticsRoutes, { prefix: '/analytics' });
      await v1.register(csvRoutes, { prefix: '/links' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
