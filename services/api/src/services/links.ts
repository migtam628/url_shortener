import { Prisma } from '@prisma/client';
import {
  applyUtm,
  generateValidSlug,
  validateDestination,
  validateSlug,
  type CreateLinkInput,
  type RedirectCode,
  type UpdateLinkInput,
} from '@mtlink/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { invalidateLink } from '../lib/invalidate.js';
import { destinationChanges, linksCreated } from '../metrics.js';

const SLUG_COLLISION_RETRIES = 5;

export interface LinkActor {
  tenantId: string;
  userId?: string | undefined;
}

/** Validate a destination against this instance's short domains. */
export function checkDestination(raw: string): string {
  const result = validateDestination(raw, { shortDomains: env.SHORT_DOMAINS });
  if (!result.ok) throw unprocessable(result.reason);
  return result.url;
}

async function resolveDomain(tenantId: string, domainId?: string) {
  const domain = domainId
    ? await prisma.domain.findFirst({ where: { id: domainId, tenantId } })
    : (await prisma.domain.findFirst({ where: { tenantId, isDefault: true } })) ??
      (await prisma.domain.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } }));

  if (!domain) {
    throw badRequest(
      domainId
        ? 'Domain not found, or it belongs to another tenant.'
        : 'No domain configured. Add a domain before creating links.',
    );
  }
  return domain;
}

export interface CreateLinkResult {
  id: string;
  slug: string;
  shortUrl: string;
}

export async function createLink(
  input: CreateLinkInput,
  actor: LinkActor,
  source: 'dashboard' | 'api' | 'bulk' | 'seed' = 'api',
): Promise<CreateLinkResult> {
  const domain = await resolveDomain(actor.tenantId, input.domainId);

  let destination = checkDestination(input.destination);
  if (input.utm) destination = applyUtm(destination, input.utm);

  // An explicit slug must pass validation (which includes the reserved list).
  // A generated one is retried on collision.
  const explicit = input.slug !== undefined;
  if (explicit) {
    const v = validateSlug(input.slug as string);
    if (!v.ok) throw unprocessable(v.reason);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < (explicit ? 1 : SLUG_COLLISION_RETRIES); attempt += 1) {
    const slug = explicit ? (input.slug as string) : generateValidSlug(env.DEFAULT_SLUG_LENGTH);
    try {
      const link = await prisma.$transaction(async (tx) => {
        const created = await tx.link.create({
          data: {
            domainId: domain.id,
            tenantId: actor.tenantId,
            slug,
            destination,
            redirectCode: input.redirectCode,
            title: input.title ?? null,
            description: input.description ?? null,
            folderId: input.folderId ?? null,
            tags: input.tags,
            createdById: actor.userId ?? null,
          },
        });
        // The creating write is version 1, so history is complete from the
        // first destination the link ever had.
        await tx.linkVersion.create({
          data: {
            linkId: created.id,
            destination,
            redirectCode: input.redirectCode,
            slug,
            changedById: actor.userId ?? null,
            note: 'Created',
          },
        });
        return created;
      });

      // A brand-new slug may have a negative cache entry from someone hitting
      // the 404 before it existed, so clear the key on create too.
      await invalidateLink({ hostname: domain.hostname, slug: link.slug });
      linksCreated.inc({ source });

      return {
        id: link.id,
        slug: link.slug,
        shortUrl: `https://${domain.hostname}/${link.slug}`,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (explicit) {
          throw conflict(`The slug "${slug}" is already in use on ${domain.hostname}.`);
        }
        continue; // generated slug collided — try another
      }
      throw err;
    }
  }

  throw conflict(
    `Unable to allocate a unique slug after ${SLUG_COLLISION_RETRIES} attempts. Consider increasing DEFAULT_SLUG_LENGTH.`,
    { cause: String(lastError) },
  );
}

export async function updateLink(
  linkId: string,
  input: UpdateLinkInput,
  actor: LinkActor,
): Promise<void> {
  const existing = await prisma.link.findFirst({
    where: { id: linkId, tenantId: actor.tenantId },
    include: { domain: true },
  });
  if (!existing) throw notFound('Link not found.');

  const data: Prisma.LinkUpdateInput = {};
  let destinationChanged = false;
  let newDestination = existing.destination;
  let newSlug = existing.slug;
  let newHostname = existing.domain.hostname;
  let newRedirectCode = existing.redirectCode;

  if (input.destination !== undefined) {
    newDestination = checkDestination(input.destination);
    if (newDestination !== existing.destination) {
      data.destination = newDestination;
      destinationChanged = true;
      // A changed destination invalidates the cached OG preview.
      data.ogTitle = null;
      data.ogDescription = null;
      data.ogImage = null;
      data.ogFetchedAt = null;
    }
  }

  if (input.slug !== undefined && input.slug !== existing.slug) {
    const v = validateSlug(input.slug);
    if (!v.ok) throw unprocessable(v.reason);
    data.slug = v.slug;
    newSlug = v.slug;
  }

  if (input.domainId !== undefined && input.domainId !== existing.domainId) {
    const domain = await resolveDomain(actor.tenantId, input.domainId);
    data.domain = { connect: { id: domain.id } };
    newHostname = domain.hostname;
  }

  if (input.redirectCode !== undefined) {
    data.redirectCode = input.redirectCode;
    newRedirectCode = input.redirectCode;
  }
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.folderId !== undefined) {
    data.folder = input.folderId ? { connect: { id: input.folderId } } : { disconnect: true };
  }
  if (input.tags !== undefined) data.tags = input.tags;
  if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

  const slugOrDomainChanged = newSlug !== existing.slug || newHostname !== existing.domain.hostname;
  const needsVersion = destinationChanged || slugOrDomainChanged || newRedirectCode !== existing.redirectCode;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.link.update({ where: { id: linkId }, data });
      if (needsVersion) {
        await tx.linkVersion.create({
          data: {
            linkId,
            destination: newDestination,
            redirectCode: newRedirectCode,
            slug: newSlug,
            changedById: actor.userId ?? null,
            note: input.note ?? null,
          },
        });
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict(`The slug "${newSlug}" is already in use on ${newHostname}.`);
    }
    throw err;
  }

  // Invalidate AFTER the transaction commits. Invalidating first would let a
  // concurrent redirect re-populate the cache from the pre-commit row.
  await invalidateLink({
    hostname: newHostname,
    slug: newSlug,
    ...(slugOrDomainChanged
      ? { previous: { hostname: existing.domain.hostname, slug: existing.slug } }
      : {}),
  });

  if (destinationChanged) destinationChanges.inc();
}

export async function deleteLink(linkId: string, actor: LinkActor): Promise<void> {
  const existing = await prisma.link.findFirst({
    where: { id: linkId, tenantId: actor.tenantId },
    include: { domain: true },
  });
  if (!existing) throw notFound('Link not found.');

  await prisma.link.delete({ where: { id: linkId } });
  await invalidateLink({ hostname: existing.domain.hostname, slug: existing.slug });
}

export interface BulkRow {
  index: number;
  ok: boolean;
  id?: string;
  slug?: string;
  shortUrl?: string;
  error?: string;
}

export async function createLinksBulk(
  inputs: CreateLinkInput[],
  actor: LinkActor,
  continueOnError: boolean,
): Promise<{ created: number; failed: number; rows: BulkRow[] }> {
  const rows: BulkRow[] = [];
  let created = 0;
  let failed = 0;

  for (const [index, input] of inputs.entries()) {
    try {
      const result = await createLink(input, actor, 'bulk');
      rows.push({ index, ok: true, ...result });
      created += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : 'Unknown error';
      rows.push({ index, ok: false, error: message });
      if (!continueOnError) break;
    }
  }

  return { created, failed, rows };
}

export const _test = { SLUG_COLLISION_RETRIES, resolveDomain };
export type { RedirectCode };
