/** Typed fetch wrapper. Same-origin by design — nginx routes /api to the API
 *  service in production, and Vite proxies it in dev, so the session cookie
 *  is always first-party. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'unknown',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(p: string, body: unknown) =>
    request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface Me {
  user: { id: string; email: string; name: string; role: string } | null;
  tenant: { id: string; name: string; slug: string } | null;
  via: 'session' | 'apikey';
}

export interface LinkRow {
  id: string;
  slug: string;
  shortUrl: string;
  destination: string;
  redirectCode: 301 | 302 | 307;
  title: string | null;
  description: string | null;
  tags: string[];
  folderId: string | null;
  clickCount: number;
  og: { title: string | null; description: string | null; image: string | null };
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkVersion {
  id: string;
  destination: string;
  redirectCode: number;
  slug: string;
  changedAt: string;
  note: string | null;
  changedBy: { id: string; name: string; email: string } | null;
}

export interface DomainRow {
  id: string;
  hostname: string;
  isDefault: boolean;
  mainPageRedirect: string | null;
  notFoundRedirect: string | null;
  certStatus: 'pending' | 'issuing' | 'active' | 'failed';
  certLastError: string | null;
  linkCount: number;
  createdAt: string;
}

export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  linkCount: number;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  clicks: number;
  bots: number;
  uniqueVisitors: number;
}

export interface TimeseriesPoint { t: string; clicks: number }
export interface Timeseries { source: 'raw' | 'rollup'; interval: string; points: TimeseriesPoint[] }
export interface BreakdownItem { value: string; clicks: number }
export interface Breakdown { dimension: string; items: BreakdownItem[] }
export interface TopLink { linkId: string; slug: string; shortUrl: string; destination: string; clicks: number }

export interface BulkResult {
  created: number;
  failed: number;
  rows: Array<{ index: number; ok: boolean; slug?: string; shortUrl?: string; error?: string }>;
}
