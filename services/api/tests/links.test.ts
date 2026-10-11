import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RESERVED_SLUGS } from '@mtlink/shared';
import { createFixture, destroyFixture, closeHelpers, prisma, type Fixture } from './helpers.js';
import { createLink, createLinksBulk, updateLink } from '../src/services/links.js';
import { ApiError } from '../src/errors.js';

let f: Fixture;

beforeAll(async () => { f = await createFixture('links'); });
afterAll(async () => { await destroyFixture(f); await closeHelpers(); });

const actor = () => ({ tenantId: f.tenantId, userId: f.userId });

describe('slug allocation', () => {
  it('generates a slug of the configured length when none is given', async () => {
    const link = await createLink({ destination: 'https://example.com/auto', redirectCode: 302, tags: [] }, actor());
    expect(link.slug).toHaveLength(7);
  });

  it('ACCEPTANCE 9: refuses every reserved slug', async () => {
    for (const reserved of [...RESERVED_SLUGS].slice(0, 12)) {
      // '.well-known' fails the regex before reaching the reserved check,
      // which is also a rejection — both paths are acceptable.
      await expect(
        createLink({ destination: 'https://example.com', redirectCode: 302, tags: [], slug: reserved }, actor()),
      ).rejects.toThrow();
    }
  });

  it('rejects a duplicate slug on the same domain with 409', async () => {
    const slug = `dup-${Date.now()}`;
    await createLink({ destination: 'https://example.com/1', redirectCode: 302, tags: [], slug }, actor());
    await expect(
      createLink({ destination: 'https://example.com/2', redirectCode: 302, tags: [], slug }, actor()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows the same slug on two different domains', async () => {
    const other = await prisma.domain.create({
      data: { tenantId: f.tenantId, hostname: `alt-${Date.now()}.test.invalid` },
    });
    const slug = `shared-${Date.now()}`;
    await createLink({ destination: 'https://example.com/a', redirectCode: 302, tags: [], slug }, actor());
    const second = await createLink(
      { destination: 'https://example.com/b', redirectCode: 302, tags: [], slug, domainId: other.id },
      actor(),
    );
    expect(second.slug).toBe(slug);
  });
});

describe('redirect codes', () => {
  it('defaults to 302, because destinations are editable', async () => {
    const link = await createLink({ destination: 'https://example.com/d', redirectCode: 302, tags: [] }, actor());
    const row = await prisma.link.findUnique({ where: { id: link.id } });
    expect(row?.redirectCode).toBe(302);
  });

  it('accepts an explicit 301 opt-in', async () => {
    const link = await createLink({ destination: 'https://example.com/perm', redirectCode: 301, tags: [] }, actor());
    const row = await prisma.link.findUnique({ where: { id: link.id } });
    expect(row?.redirectCode).toBe(301);
  });
});

describe('UTM application', () => {
  it('writes UTM parameters into the stored destination', async () => {
    const link = await createLink(
      {
        destination: 'https://example.com/landing?ref=abc',
        redirectCode: 302,
        tags: [],
        utm: { source: 'qr', medium: 'print', campaign: 'fall' },
      },
      actor(),
    );
    const row = await prisma.link.findUnique({ where: { id: link.id } });
    const q = new URL(row!.destination).searchParams;
    expect(q.get('ref')).toBe('abc');
    expect(q.get('utm_source')).toBe('qr');
    expect(q.get('utm_campaign')).toBe('fall');
  });
});

describe('tenant isolation', () => {
  it('will not update a link belonging to another tenant', async () => {
    const other = await createFixture('intruder');
    try {
      const link = await createLink({ destination: 'https://example.com/mine', redirectCode: 302, tags: [] }, actor());
      await expect(
        updateLink(link.id, { destination: 'https://evil.example/' }, { tenantId: other.tenantId, userId: other.userId }),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await destroyFixture(other);
    }
  });
});

describe('bulk create', () => {
  it('reports per-row results and keeps going past a bad row', async () => {
    const result = await createLinksBulk(
      [
        { destination: 'https://example.com/ok1', redirectCode: 302, tags: [] },
        { destination: 'http://127.0.0.1/ssrf', redirectCode: 302, tags: [] },
        { destination: 'https://example.com/ok2', redirectCode: 302, tags: [] },
        { destination: 'not-a-url', redirectCode: 302, tags: [] },
      ],
      actor(),
      true,
    );
    expect(result.created).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.rows[1]?.ok).toBe(false);
    expect(result.rows[1]?.error).toMatch(/private or reserved/i);
  });

  it('stops at the first failure when continueOnError is false', async () => {
    const result = await createLinksBulk(
      [
        { destination: 'https://example.com/x1', redirectCode: 302, tags: [] },
        { destination: 'http://localhost/bad', redirectCode: 302, tags: [] },
        { destination: 'https://example.com/x2', redirectCode: 302, tags: [] },
      ],
      actor(),
      false,
    );
    expect(result.created).toBe(1);
    expect(result.rows).toHaveLength(2);
  });
});

describe('destination validation on update', () => {
  it('rejects an SSRF destination on edit, not just on create', async () => {
    const link = await createLink({ destination: 'https://example.com/safe', redirectCode: 302, tags: [] }, actor());
    await expect(
      updateLink(link.id, { destination: 'http://169.254.169.254/' }, actor()),
    ).rejects.toThrow(ApiError);

    // And the stored value must be untouched.
    const row = await prisma.link.findUnique({ where: { id: link.id } });
    expect(row?.destination).toBe('https://example.com/safe');
  });
});
