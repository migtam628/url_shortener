import pg from 'pg';
import { env } from './env.js';
import { logger } from './logger.js';
import { degraded } from './metrics.js';
import type { ResolvedDomain, ResolvedLink, RedirectCode } from '@mtlink/shared';

/**
 * Raw `pg`, not Prisma.
 *
 * This is the only database access on the redirect path and it runs on a
 * cache miss, so it is worth the ~1ms and the dependency weight that an ORM
 * would add. Two hand-written statements, both hitting a unique index.
 */

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX_REDIRECT,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
  // A redirect that has not resolved in 2s has already failed from the
  // visitor's point of view; do not hold the connection any longer.
  statement_timeout: 2_000,
  query_timeout: 2_000,
  application_name: 'mtlink-redirect',
});

pool.on('error', (err: Error) => {
  logger.error({ err }, 'postgres pool error');
  degraded.set({ dependency: 'postgres' }, 1);
});

pool.on('connect', () => degraded.set({ dependency: 'postgres' }, 0));

const LINK_SQL = `
  SELECT
    l.id, l.tenant_id, l.domain_id, l.slug, l.destination, l.redirect_code,
    d.hostname
  FROM link l
  JOIN domain d ON d.id = l.domain_id
  WHERE d.hostname = $1 AND l.slug = $2 AND l.archived_at IS NULL
  LIMIT 1
`;

const DOMAIN_SQL = `
  SELECT id, tenant_id, hostname, main_page_redirect, not_found_redirect
  FROM domain
  WHERE hostname = $1
  LIMIT 1
`;

interface LinkRow {
  id: string;
  tenant_id: string;
  domain_id: string;
  slug: string;
  destination: string;
  redirect_code: number;
  hostname: string;
}

interface DomainRow {
  id: string;
  tenant_id: string;
  hostname: string;
  main_page_redirect: string | null;
  not_found_redirect: string | null;
}

export async function fetchLink(hostname: string, slug: string): Promise<ResolvedLink | null> {
  const { rows } = await pool.query<LinkRow>(LINK_SQL, [hostname, slug]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    domainId: row.domain_id,
    hostname: row.hostname,
    slug: row.slug,
    destination: row.destination,
    redirectCode: row.redirect_code as RedirectCode,
  };
}

export async function fetchDomain(hostname: string): Promise<ResolvedDomain | null> {
  const { rows } = await pool.query<DomainRow>(DOMAIN_SQL, [hostname]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    hostname: row.hostname,
    mainPageRedirect: row.main_page_redirect,
    notFoundRedirect: row.not_found_redirect,
  };
}

export async function pgHealthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    degraded.set({ dependency: 'postgres' }, 0);
    return true;
  } catch {
    degraded.set({ dependency: 'postgres' }, 1);
    return false;
  }
}

export async function closePg(): Promise<void> {
  await pool.end();
}
