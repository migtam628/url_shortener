import { createHmac } from 'node:crypto';
import { env } from '../env.js';

/**
 * One-way IP hash with a daily rotating salt.
 *
 * The rotation is the point: within a day you can count unique visitors, and
 * after the day rolls over the value stops being linkable to anything. Raw IPs
 * are never written to the database, which keeps the clicks table out of the
 * most awkward part of GDPR.
 *
 * The tenant id is mixed in so the same visitor hashes differently per tenant,
 * which stops cross-tenant correlation if the table is ever exported.
 */
export function hashIp(ip: string | null | undefined, tenantId: string, at: Date = new Date()): string | null {
  if (!ip) return null;
  const day = at.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return createHmac('sha256', env.IP_HASH_SECRET)
    .update(day)
    .update('\0')
    .update(tenantId)
    .update('\0')
    .update(ip)
    .digest('base64url')
    .slice(0, 22);
}
