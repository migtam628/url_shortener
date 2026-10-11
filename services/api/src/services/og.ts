import { lookup } from 'node:dns/promises';
import { isPrivateAddress, validateDestination } from '@mtlink/shared';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { prisma } from '../db.js';

/**
 * Open Graph preview fetching.
 *
 * This is the one place the server makes an outbound request to a
 * user-supplied URL, so it gets the second half of the SSRF defence: the
 * literal hostname was checked at write time, but a hostname can resolve to a
 * private address (DNS rebinding, or just an internal CNAME). Here the
 * resolved address is checked too, before any request is made.
 *
 * Redirects are not followed, for the same reason — a 302 to 169.254.169.254
 * would bypass the check entirely.
 */

export interface OgPreview {
  title: string | null;
  description: string | null;
  image: string | null;
}

const EMPTY: OgPreview = { title: null, description: null, image: null };
const MAX_BYTES = 512 * 1024; // metadata lives in <head>; no need for more

async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&apos;|&#39;/g, "'");
}

function metaContent(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1].trim()).slice(0, 500) || null;
  }
  return null;
}

export function parseOg(html: string): OgPreview {
  const head = html.slice(0, 200_000);
  return {
    title:
      metaContent(head, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
        /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
        /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']*)["']/i,
        /<title[^>]*>([\s\S]*?)<\/title>/i,
      ]) ?? null,
    description:
      metaContent(head, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
        /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
      ]) ?? null,
    image:
      metaContent(head, [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i,
        /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']*)["']/i,
      ]) ?? null,
  };
}

export async function fetchOg(destination: string): Promise<OgPreview> {
  const valid = validateDestination(destination, { shortDomains: env.SHORT_DOMAINS });
  if (!valid.ok) return EMPTY;

  const { hostname } = valid.parsed;
  if (!(await resolvesToPublicAddress(hostname))) {
    logger.warn({ hostname }, 'OG fetch refused: hostname resolves to a non-public address');
    return EMPTY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OG_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(valid.url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'user-agent': 'MTLinkBot/1.0 (+https://github.com/migtam628/url_shortener)',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!res.ok || !res.body) return EMPTY;
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return EMPTY;

    // Read at most MAX_BYTES rather than trusting content-length.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return parseOg(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    logger.debug({ err, destination }, 'OG fetch failed');
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and persist the preview, unless a fresh one is already cached. */
export async function refreshOgForLink(linkId: string): Promise<OgPreview> {
  const link = await prisma.link.findUnique({ where: { id: linkId } });
  if (!link) return EMPTY;

  const fresh =
    link.ogFetchedAt &&
    Date.now() - link.ogFetchedAt.getTime() < env.OG_CACHE_TTL_SECONDS * 1000;
  if (fresh) {
    return { title: link.ogTitle, description: link.ogDescription, image: link.ogImage };
  }

  const og = await fetchOg(link.destination);
  await prisma.link
    .update({
      where: { id: linkId },
      data: {
        ogTitle: og.title,
        ogDescription: og.description,
        ogImage: og.image,
        ogFetchedAt: new Date(),
      },
    })
    .catch(() => undefined);
  return og;
}
