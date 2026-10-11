import Fastify from 'fastify';
import { normalizeHostname } from '@mtlink/shared';
import { env, isProd } from './env.js';
import { logger } from './logger.js';
import { resolveDomain, resolveLink, redisHealthy } from './cache.js';
import { pgHealthy } from './pg.js';
import { enqueueClick } from './clicks.js';
import { resolveDestination, checkSecurity, type RequestContext } from './rules.js';
import { redirectDuration, redirectTotal, registry } from './metrics.js';
import { errorPage, notFoundPage, rootPage, unknownHostPage } from './pages.js';
import { RESERVED_SLUGS } from '@mtlink/shared';

/** Requests browsers and crawlers make unprompted. Answered directly so they
 *  never reach the database or pollute click analytics. */
const WELL_KNOWN: Record<string, { body: string; type: string }> = {
  '/robots.txt': { body: 'User-agent: *\nDisallow: /\n', type: 'text/plain; charset=utf-8' },
  '/favicon.ico': { body: '', type: 'image/x-icon' },
};

export function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? String(env.TRUST_PROXY_HOPS) : false,
    disableRequestLogging: isProd, // nginx already logs every redirect
    // A redirect has no body worth reading.
    bodyLimit: 1024,
  });

  // ---- health ------------------------------------------------------------
  // Liveness only. It must NOT check Postgres or Redis: if it did, a database
  // blip would make the orchestrator kill redirect pods that are still
  // serving correctly from cache.
  app.get('/health', async () => ({ status: 'ok', service: 'redirect' }));

  app.get('/ready', async (_req, reply) => {
    const [pg, redis] = await Promise.all([pgHealthy(), redisHealthy()]);
    // Postgres down means cache misses cannot be served; Redis down is only
    // a degradation, so it does not fail readiness.
    return reply.code(pg ? 200 : 503).send({
      status: pg ? 'ready' : 'degraded',
      checks: { postgres: pg ? 'ok' : 'down', redis: redis ? 'ok' : 'degraded' },
    });
  });

  if (env.METRICS_ENABLED) {
    app.get('/metrics', async (req, reply) => {
      if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
        return reply.code(401).send('unauthorized');
      }
      return reply.header('content-type', registry.contentType).send(await registry.metrics());
    });
  }

  // ---- the hot path ------------------------------------------------------
  app.get('/*', async (req, reply) => {
    const end = redirectDuration.startTimer();
    const hostname = normalizeHostname(req.headers.host);

    if (!hostname) {
      redirectTotal.inc({ outcome: 'bad_host', status: '400' });
      end({ outcome: 'bad_host', source: 'none' });
      return reply.code(400).type('text/plain').send('Missing Host header');
    }

    // Strip the leading slash and drop any query string; the slug is the
    // first path segment only.
    const path = req.url.split('?')[0] ?? '/';
    const raw = decodeURIComponent(path.slice(1));

    const wellKnown = WELL_KNOWN[path];
    if (wellKnown) {
      end({ outcome: 'well_known', source: 'none' });
      return reply.type(wellKnown.type).send(wellKnown.body);
    }

    try {
      // ---- domain root -------------------------------------------------
      if (raw === '') {
        const domain = await resolveDomain(hostname);
        if (!domain) {
          redirectTotal.inc({ outcome: 'unknown_host', status: '404' });
          end({ outcome: 'unknown_host', source: 'none' });
          return reply.code(404).type('text/html; charset=utf-8').send(unknownHostPage);
        }
        const target = domain.mainPageRedirect ?? env.DEFAULT_ROOT_REDIRECT;
        if (target) {
          redirectTotal.inc({ outcome: 'root_redirect', status: '302' });
          end({ outcome: 'root_redirect', source: 'none' });
          return reply.code(302).header('location', target).header('cache-control', 'private, max-age=0, no-store').send();
        }
        redirectTotal.inc({ outcome: 'root_no_target', status: '404' });
        end({ outcome: 'root_no_target', source: 'none' });
        return reply.code(404).type('text/html; charset=utf-8').send(rootPage);
      }

      // A reserved path can never be a link, so skip the lookup entirely.
      if (RESERVED_SLUGS.has(raw.toLowerCase())) {
        redirectTotal.inc({ outcome: 'reserved', status: '404' });
        end({ outcome: 'reserved', source: 'none' });
        return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage);
      }

      // ---- link lookup --------------------------------------------------
      const { link, source } = await resolveLink(hostname, raw);

      if (!link) {
        const domain = await resolveDomain(hostname);
        if (!domain) {
          redirectTotal.inc({ outcome: 'unknown_host', status: '404' });
          end({ outcome: 'unknown_host', source });
          return reply.code(404).type('text/html; charset=utf-8').send(unknownHostPage);
        }
        if (domain.notFoundRedirect) {
          redirectTotal.inc({ outcome: 'not_found_redirect', status: '302' });
          end({ outcome: 'not_found_redirect', source });
          return reply
            .code(302)
            .header('location', domain.notFoundRedirect)
            .header('cache-control', 'private, max-age=0, no-store')
            .send();
        }
        redirectTotal.inc({ outcome: 'not_found', status: '404' });
        end({ outcome: 'not_found', source });
        return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage);
      }

      // ---- rule + security seams (Phase 2) -------------------------------
      const ctx: RequestContext = {
        country: (req.headers['cf-ipcountry'] as string | undefined) ?? null,
        region: null,
        deviceType: null,
        os: null,
        language: (req.headers['accept-language'] as string | undefined)?.slice(0, 16) ?? null,
        referrerHost: null,
        abAssignment: null,
      };

      const gate = checkSecurity(link, ctx);
      if (gate) {
        redirectTotal.inc({ outcome: `security_${gate.action}`, status: '302' });
        end({ outcome: `security_${gate.action}`, source });
        if (gate.redirect) {
          return reply.code(302).header('location', gate.redirect).send();
        }
        return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage);
      }

      const outcome = resolveDestination(link, ctx);

      // ---- emit the click, then redirect ---------------------------------
      // enqueueClick never awaits. The response is already on its way.
      enqueueClick({
        linkId: link.id,
        tenantId: link.tenantId,
        ts: Date.now(),
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        referrer: (req.headers['referer'] as string | undefined) ?? null,
        acceptLanguage: (req.headers['accept-language'] as string | undefined) ?? null,
        edgeCountry: ctx.country,
        ruleId: outcome.ruleId,
      });

      const status = link.redirectCode;
      redirectTotal.inc({ outcome: 'redirect', status: String(status) });
      end({ outcome: 'redirect', source });

      reply.header('location', outcome.destination);
      // A 301 is cacheable by definition and we want it cached. A 302/307
      // must never be: the destination is editable, and a cached 302 would
      // keep sending visitors to the old target after an edit.
      reply.header(
        'cache-control',
        status === 301 ? 'public, max-age=86400' : 'private, max-age=0, no-store',
      );
      reply.header('referrer-policy', 'unsafe-url');
      if (!isProd) reply.header('x-mtlink-cache', source);

      return reply.code(status).send();
    } catch (err) {
      req.log.error({ err, hostname, slug: raw }, 'redirect failed');
      redirectTotal.inc({ outcome: 'error', status: '503' });
      end({ outcome: 'error', source: 'none' });
      return reply
        .code(503)
        .type('text/html; charset=utf-8')
        .header('retry-after', '5')
        .send(errorPage);
    }
  });

  return app;
}

export type RedirectServer = ReturnType<typeof buildServer>;
