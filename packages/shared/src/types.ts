/** Shared domain types. Kept free of Prisma imports so both services and the
 *  browser bundle can use them. */

export type RedirectCode = 301 | 302 | 307;

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export type CertStatus = 'pending' | 'issuing' | 'active' | 'failed';

export type RuleMatchType =
  | 'country'
  | 'region'
  | 'device'
  | 'os'
  | 'language'
  | 'referrer'
  | 'ab';

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';

/** The shape the redirect service caches and serves from. Deliberately flat
 *  and small — it is serialized into Redis on every cache fill. */
export interface ResolvedLink {
  id: string;
  tenantId: string;
  domainId: string;
  hostname: string;
  slug: string;
  destination: string;
  redirectCode: RedirectCode;
  /** Present only when the link has Phase 2 rules attached. */
  rules?: ResolvedRule[];
  /** Present only when the link has Phase 2 security settings. */
  security?: ResolvedSecurity;
}

export interface ResolvedRule {
  id: string;
  priority: number;
  matchType: RuleMatchType;
  matchValue: unknown;
  destination: string;
  weight: number;
}

export interface ResolvedSecurity {
  hasPassword: boolean;
  expiresAt: string | null;
  expiredRedirect: string | null;
  maxClicks: number | null;
  clickCount: number;
  cloak: boolean;
  hideReferrer: boolean;
}

export interface ResolvedDomain {
  id: string;
  tenantId: string;
  hostname: string;
  mainPageRedirect: string | null;
  notFoundRedirect: string | null;
}

/** Queued click event. Written by the redirect service, read by the worker. */
export interface ClickEvent {
  linkId: string;
  tenantId: string;
  ts: number;
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
  acceptLanguage: string | null;
  /** Country supplied by the edge (CF-IPCountry), used when GeoIP is absent. */
  edgeCountry: string | null;
  ruleId: string | null;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}
