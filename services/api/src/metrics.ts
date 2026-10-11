import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { env } from './env.js';

export const registry = new Registry();

if (env.METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry, prefix: 'mtlink_api_' });
}

export const httpRequests = new Counter({
  name: 'mtlink_api_http_requests_total',
  help: 'HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'mtlink_api_http_duration_seconds',
  help: 'API request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const linksCreated = new Counter({
  name: 'mtlink_api_links_created_total',
  help: 'Links created',
  labelNames: ['source'] as const,
  registers: [registry],
});

export const destinationChanges = new Counter({
  name: 'mtlink_api_destination_changes_total',
  help: 'Destination URL changes applied',
  registers: [registry],
});

export const invalidationsPublished = new Counter({
  name: 'mtlink_api_invalidations_published_total',
  help: 'Cache invalidation messages published',
  labelNames: ['kind', 'result'] as const,
  registers: [registry],
});

export const clicksProcessed = new Counter({
  name: 'mtlink_worker_clicks_processed_total',
  help: 'Click events written by the worker',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const clickQueueDepth = new Gauge({
  name: 'mtlink_worker_queue_depth',
  help: 'Pending jobs in the click queue',
  registers: [registry],
});

export const workerBatchSize = new Histogram({
  name: 'mtlink_worker_batch_size',
  help: 'Rows per click batch insert',
  buckets: [1, 5, 10, 25, 50, 100, 200, 500],
  registers: [registry],
});
