import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { env } from './env.js';

export const registry = new Registry();
if (env.METRICS_ENABLED) collectDefaultMetrics({ register: registry, prefix: 'mtlink_redirect_' });

/** The number that matters. Buckets are tight at the low end because the
 *  whole service lives under 20ms on a cache hit. */
export const redirectDuration = new Histogram({
  name: 'mtlink_redirect_duration_seconds',
  help: 'Time to serve a redirect',
  labelNames: ['outcome', 'source'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const redirectTotal = new Counter({
  name: 'mtlink_redirect_total',
  help: 'Redirect requests by outcome',
  labelNames: ['outcome', 'status'] as const,
  registers: [registry],
});

export const cacheLookups = new Counter({
  name: 'mtlink_redirect_cache_lookups_total',
  help: 'Link resolutions by cache layer',
  labelNames: ['source'] as const, // lru | redis | postgres | miss
  registers: [registry],
});

export const cacheHitRatio = new Gauge({
  name: 'mtlink_redirect_cache_hit_ratio',
  help: 'Rolling cache hit ratio (LRU + Redis) over the last 10k lookups',
  registers: [registry],
});

export const invalidationsReceived = new Counter({
  name: 'mtlink_redirect_invalidations_received_total',
  help: 'Invalidation messages consumed',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const clickEnqueued = new Counter({
  name: 'mtlink_redirect_clicks_enqueued_total',
  help: 'Click events pushed to the queue',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const degraded = new Gauge({
  name: 'mtlink_redirect_degraded',
  help: '1 when a dependency is unavailable and the service is running degraded',
  labelNames: ['dependency'] as const,
  registers: [registry],
});

/** Rolling hit-ratio window. A plain counter ratio would be dominated by
 *  history; this reflects the last 10k lookups, which is what you want on a
 *  dashboard during an incident. */
const WINDOW = 10_000;
let hits = 0;
let total = 0;

export function recordLookup(source: 'lru' | 'redis' | 'postgres' | 'miss'): void {
  cacheLookups.inc({ source });
  total += 1;
  if (source === 'lru' || source === 'redis') hits += 1;
  if (total >= WINDOW) {
    cacheHitRatio.set(hits / total);
    hits = 0;
    total = 0;
  } else if (total % 100 === 0) {
    cacheHitRatio.set(hits / total);
  }
}
