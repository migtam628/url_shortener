/**
 * Destination URL validation.
 *
 * Two distinct jobs here, and it is worth keeping them straight:
 *
 *  1. SSRF guard. The API fetches destinations for Open Graph previews, so a
 *     destination pointing at 169.254.169.254 or 127.0.0.1 would turn this
 *     service into a confused deputy against its own host network. The guard
 *     is applied at *write* time so the bad value never reaches storage.
 *
 *  2. Redirect-loop guard. A short link whose destination is another link on
 *     one of our own short domains produces a loop that we would serve
 *     ourselves, at our own expense.
 *
 * Hostname checks here are literal, not DNS-resolving. A hostname that resolves
 * to a private address at fetch time still gets through; the OG fetcher applies
 * a second check against the resolved address. See `isPrivateAddress`.
 */

export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that always mean "this machine" or "this network". */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** Suffixes that never route to the public internet. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.onion'];

export type UrlValidationResult =
  | { ok: true; url: string; parsed: URL }
  | { ok: false; reason: string };

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * True for loopback, private, link-local, CGNAT, multicast and reserved space,
 * in both IPv4 and IPv6 (including IPv4-mapped IPv6).
 */
export function isPrivateAddress(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  const v4 = parseIPv4(bare);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return true;                                  // 0.0.0.0/8
    if (a === 10) return true;                                 // private
    if (a === 127) return true;                                // loopback
    if (a === 169 && b === 254) return true;                   // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;          // private
    if (a === 192 && b === 168) return true;                   // private
    if (a === 192 && b === 0) return true;                     // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;      // benchmarking
    if (a >= 224) return true;                                 // multicast + reserved
    return false;
  }

  if (bare.includes(':')) {
    const lower = bare.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1
    const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (lower.startsWith('fe80')) return true;                 // link-local
    if (/^f[cd]/.test(lower)) return true;                     // unique local fc00::/7
    if (lower.startsWith('ff')) return true;                   // multicast
    return false;
  }

  return false;
}

export interface ValidateDestinationOptions {
  /** Short hostnames this instance serves; destinations pointing here loop. */
  shortDomains?: readonly string[];
  /** Allow private/loopback destinations. Only ever true in tests. */
  allowPrivate?: boolean;
  maxLength?: number;
}

/**
 * Validate and normalize a destination URL.
 *
 * Normalization is deliberately conservative: the protocol and hostname are
 * lowercased and a default port is dropped, but the path, query and fragment
 * are left exactly as given. Rewriting a query string would silently break
 * links whose targets are signature- or order-sensitive.
 */
export function validateDestination(
  raw: string,
  opts: ValidateDestinationOptions = {},
): UrlValidationResult {
  const { shortDomains = [], allowPrivate = false, maxLength = 2048 } = opts;

  const input = raw.trim();
  if (!input) return { ok: false, reason: 'Destination URL is required.' };
  if (input.length > maxLength) {
    return { ok: false, reason: `Destination URL cannot exceed ${maxLength} characters.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'Destination must be a valid absolute URL (including http:// or https://).' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `Protocol "${parsed.protocol}" is not allowed. Use http or https.` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { ok: false, reason: 'Destination URL must include a hostname.' };

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Destination URL cannot contain embedded credentials.' };
  }

  if (!allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { ok: false, reason: `Destination host "${hostname}" is not routable.` };
    }
    if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
      return { ok: false, reason: `Destination host "${hostname}" is not a public internet address.` };
    }
    if (isPrivateAddress(hostname)) {
      return { ok: false, reason: `Destination host "${hostname}" is a private or reserved address.` };
    }
    // A bare single-label hostname ("intranet") resolves only on a local
    // search domain, so treat it as internal.
    if (!hostname.includes('.') && !hostname.includes(':')) {
      return { ok: false, reason: `Destination host "${hostname}" is not a fully qualified domain name.` };
    }
  }

  for (const domain of shortDomains) {
    const d = domain.trim().toLowerCase();
    if (!d) continue;
    if (hostname === d || hostname.endsWith(`.${d}`)) {
      return { ok: false, reason: `Destination cannot point back at the short domain "${d}" — that would create a redirect loop.` };
    }
  }

  // Normalize: lowercase scheme+host, drop a default port. Nothing else.
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = hostname;
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  return { ok: true, url: parsed.toString(), parsed };
}

/** Extract the registrable host of a referrer, or null when unusable. */
export function referrerHost(referrer: string | undefined | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface UtmParams {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/**
 * Apply UTM parameters to a destination.
 *
 * Existing utm_* keys are replaced, every other query parameter is preserved
 * in place, and an empty value removes that parameter.
 */
export function applyUtm(destination: string, utm: UtmParams): string {
  const url = new URL(destination);
  const mapping: Array<[keyof UtmParams, string]> = [
    ['source', 'utm_source'],
    ['medium', 'utm_medium'],
    ['campaign', 'utm_campaign'],
    ['term', 'utm_term'],
    ['content', 'utm_content'],
  ];
  for (const [key, param] of mapping) {
    const value = utm[key];
    if (value === undefined) continue;
    if (value === '') url.searchParams.delete(param);
    else url.searchParams.set(param, value);
  }
  return url.toString();
}

/** Read UTM parameters back out of a destination, for round-tripping the form. */
export function extractUtm(destination: string): UtmParams {
  try {
    const q = new URL(destination).searchParams;
    const out: UtmParams = {};
    const source = q.get('utm_source');
    const medium = q.get('utm_medium');
    const campaign = q.get('utm_campaign');
    const term = q.get('utm_term');
    const content = q.get('utm_content');
    if (source) out.source = source;
    if (medium) out.medium = medium;
    if (campaign) out.campaign = campaign;
    if (term) out.term = term;
    if (content) out.content = content;
    return out;
  } catch {
    return {};
  }
}

/** Normalize a Host header into a comparable hostname (strip port, lowercase). */
export function normalizeHostname(host: string | undefined | null): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close === -1) return null;
    return h.slice(0, close + 1);
  }
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  return h || null;
}
