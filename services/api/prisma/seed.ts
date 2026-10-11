/**
 * Seed a usable instance: one tenant, one owner, one domain, 25 links,
 * a few folders and tags, and some click history so the analytics page is
 * not empty on first load.
 *
 * Idempotent: re-running updates the existing seed tenant rather than
 * duplicating it.
 */

import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';
import { generateValidSlug } from '@mtlink/shared';

const prisma = new PrismaClient();

const SEED_EMAIL = process.env['SEED_EMAIL'] ?? 'mig@mttechservices.com';
const SEED_PASSWORD = process.env['SEED_PASSWORD'] ?? 'change-me-right-away-123';
const SEED_HOSTNAME = process.env['SEED_HOSTNAME'] ?? 'go.localhost';
const SEED_TENANT = process.env['SEED_TENANT'] ?? 'MT Tech Services';

const SAMPLES: Array<{ destination: string; title: string; tags: string[]; folder?: string }> = [
  { destination: 'https://www.fieldnation.com/workorders', title: 'Field Nation — work orders', tags: ['fieldnation', 'work'], folder: 'Field Service' },
  { destination: 'https://www.workmarket.com/assignments', title: 'WorkMarket — assignments', tags: ['workmarket', 'work'], folder: 'Field Service' },
  { destination: 'https://mttechservices.com/contact', title: 'Contact MT Tech', tags: ['marketing'], folder: 'Marketing' },
  { destination: 'https://mttechservices.com/services/structured-cabling', title: 'Structured cabling', tags: ['marketing', 'services'], folder: 'Marketing' },
  { destination: 'https://mttechservices.com/services/cctv', title: 'CCTV installation', tags: ['marketing', 'services'], folder: 'Marketing' },
  { destination: 'https://mttechservices.com/services/pos', title: 'POS deployment', tags: ['marketing', 'services'], folder: 'Marketing' },
  { destination: 'https://docs.netgate.com/pfsense/en/latest/', title: 'pfSense docs', tags: ['reference', 'network'], folder: 'References' },
  { destination: 'https://docs.vyos.io/en/latest/', title: 'VyOS docs', tags: ['reference', 'network'], folder: 'References' },
  { destination: 'https://ubntwiki.com/products/unifi', title: 'UniFi reference', tags: ['reference', 'network'], folder: 'References' },
  { destination: 'https://www.cablesupply.com/', title: 'Cable supply', tags: ['vendor'], folder: 'Vendors' },
  { destination: 'https://www.graybar.com/', title: 'Graybar', tags: ['vendor'], folder: 'Vendors' },
  { destination: 'https://www.anixter.com/', title: 'Anixter', tags: ['vendor'], folder: 'Vendors' },
  { destination: 'https://www.homedepot.com/b/Electrical/N-5yc1vZbm3b', title: 'Home Depot electrical', tags: ['vendor'], folder: 'Vendors' },
  { destination: 'https://www.lowes.com/pl/Electrical/4294612085', title: 'Lowes electrical', tags: ['vendor'], folder: 'Vendors' },
  { destination: 'https://support.hikvision.com/', title: 'Hikvision support', tags: ['support', 'cctv'], folder: 'References' },
  { destination: 'https://www.axis.com/support', title: 'Axis support', tags: ['support', 'cctv'], folder: 'References' },
  { destination: 'https://support.zebra.com/', title: 'Zebra printers support', tags: ['support', 'printers'], folder: 'References' },
  { destination: 'https://www.ubiquiti.com/download/unifi', title: 'UniFi downloads', tags: ['network', 'downloads'], folder: 'References' },
  { destination: 'https://calendly.com/mttechservices/site-survey', title: 'Book a site survey', tags: ['marketing', 'booking'], folder: 'Marketing' },
  { destination: 'https://github.com/migtam628/url_shortener', title: 'MT Link repo', tags: ['internal'], folder: 'Internal' },
  { destination: 'https://status.mttechservices.com/', title: 'Status page', tags: ['internal'], folder: 'Internal' },
  { destination: 'https://mttechservices.com/quote', title: 'Request a quote', tags: ['marketing'], folder: 'Marketing' },
  { destination: 'https://mttechservices.com/coverage/south-florida', title: 'South Florida coverage', tags: ['marketing'], folder: 'Marketing' },
  { destination: 'https://www.youtube.com/@mttechservices', title: 'YouTube channel', tags: ['marketing', 'social'], folder: 'Marketing' },
  { destination: 'https://www.linkedin.com/company/mt-tech-services', title: 'LinkedIn', tags: ['marketing', 'social'], folder: 'Marketing' },
];

const COUNTRIES = ['US', 'US', 'US', 'US', 'CA', 'MX', 'GB', 'ES', 'CO', 'BR'];
const DEVICES = ['mobile', 'mobile', 'mobile', 'desktop', 'desktop', 'tablet'];
const BROWSERS = ['Chrome', 'Chrome', 'Safari', 'Mobile Safari', 'Firefox', 'Edge'];
const OSES = ['iOS', 'Android', 'Windows', 'macOS', 'Linux'];
const REFERRERS = [null, null, 'www.google.com', 'mttechservices.com', 'l.facebook.com', 't.co'];

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T;
}

async function main(): Promise<void> {
  console.log('Seeding MT Link…\n');

  const passwordHash = await hash(SEED_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const tenant = await prisma.tenant.upsert({
    where: { slug: 'mt-tech-services' },
    update: { name: SEED_TENANT },
    create: { name: SEED_TENANT, slug: 'mt-tech-services' },
  });
  console.log(`  tenant   ${tenant.name} (${tenant.id})`);

  const user = await prisma.user.upsert({
    where: { email: SEED_EMAIL },
    update: { passwordHash, role: 'owner' },
    create: {
      tenantId: tenant.id,
      email: SEED_EMAIL,
      passwordHash,
      name: 'Miguel',
      role: 'owner',
    },
  });
  console.log(`  user     ${user.email} (${user.role})`);

  const domain = await prisma.domain.upsert({
    where: { hostname: SEED_HOSTNAME },
    update: { tenantId: tenant.id, isDefault: true },
    create: {
      tenantId: tenant.id,
      hostname: SEED_HOSTNAME,
      isDefault: true,
      mainPageRedirect: 'https://mttechservices.com',
      notFoundRedirect: null,
      certStatus: 'active',
      verifiedAt: new Date(),
    },
  });
  console.log(`  domain   ${domain.hostname}`);

  // ---- folders ----------------------------------------------------------
  const folderNames = [...new Set(SAMPLES.map((s) => s.folder).filter(Boolean))] as string[];
  const folders = new Map<string, string>();
  for (const name of folderNames) {
    const existing = await prisma.folder.findFirst({ where: { tenantId: tenant.id, name, parentId: null } });
    const folder = existing ?? (await prisma.folder.create({ data: { tenantId: tenant.id, name } }));
    folders.set(name, folder.id);
  }
  console.log(`  folders  ${folderNames.join(', ')}`);

  // ---- links ------------------------------------------------------------
  const linkIds: string[] = [];
  let created = 0;
  let reused = 0;

  for (const [i, sample] of SAMPLES.entries()) {
    const existing = await prisma.link.findFirst({
      where: { domainId: domain.id, destination: sample.destination },
    });
    if (existing) {
      linkIds.push(existing.id);
      reused += 1;
      continue;
    }

    const slug = generateValidSlug(7);
    const link = await prisma.link.create({
      data: {
        domainId: domain.id,
        tenantId: tenant.id,
        slug,
        destination: sample.destination,
        redirectCode: 302,
        title: sample.title,
        tags: sample.tags,
        folderId: sample.folder ? (folders.get(sample.folder) ?? null) : null,
        createdById: user.id,
        // Spread creation dates so the list and charts look real.
        createdAt: new Date(Date.now() - (SAMPLES.length - i) * 36 * 3600_000),
      },
    });
    await prisma.linkVersion.create({
      data: {
        linkId: link.id,
        destination: link.destination,
        redirectCode: link.redirectCode,
        slug: link.slug,
        changedById: user.id,
        note: 'Created by seed',
      },
    });
    linkIds.push(link.id);
    created += 1;
  }
  console.log(`  links    ${created} created, ${reused} already present (${linkIds.length} total)`);

  // ---- click history ----------------------------------------------------
  const existingClicks = await prisma.click.count({ where: { tenantId: tenant.id } });
  if (existingClicks > 0) {
    console.log(`  clicks   ${existingClicks} already present, skipping`);
  } else {
    const rows: Array<{
      ts: Date; linkId: string; tenantId: string; ipHash: string;
      country: string; deviceType: string; browser: string; os: string;
      referrerHost: string | null; language: string; isBot: boolean;
    }> = [];

    let n = 0;
    for (let daysAgo = 29; daysAgo >= 0; daysAgo -= 1) {
      // Weekday traffic, with a weekend dip, so the chart has a shape.
      const date = new Date(Date.now() - daysAgo * 86_400_000);
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
      const volume = Math.round((weekend ? 12 : 40) * (1 + Math.sin(daysAgo / 4) * 0.3));

      for (let j = 0; j < volume; j += 1) {
        n += 1;
        // Zipf-ish: the first few links get most of the traffic.
        const linkIdx = Math.floor(Math.abs(Math.sin(n * 2.7)) ** 2 * linkIds.length) % linkIds.length;
        const ts = new Date(date);
        ts.setUTCHours(7 + (n % 13), (n * 7) % 60, (n * 13) % 60, 0);
        rows.push({
          ts,
          linkId: linkIds[linkIdx] as string,
          tenantId: tenant.id,
          ipHash: `seed${(n % 180).toString(36)}`.padEnd(10, 'x'),
          country: pick(COUNTRIES, n),
          deviceType: pick(DEVICES, n),
          browser: pick(BROWSERS, n),
          os: pick(OSES, n),
          referrerHost: pick(REFERRERS, n),
          language: n % 5 === 0 ? 'es-us' : 'en-us',
          isBot: n % 23 === 0,
        });
      }
    }

    for (let i = 0; i < rows.length; i += 500) {
      await prisma.click.createMany({ data: rows.slice(i, i + 500) });
    }

    // Keep the denormalized counter consistent with the clicks just written.
    await prisma.$executeRawUnsafe(`
      UPDATE "link" l
      SET "click_count" = COALESCE(c.n, 0)
      FROM (SELECT link_id, COUNT(*) AS n FROM click WHERE NOT is_bot GROUP BY link_id) c
      WHERE l.id = c.link_id
    `);

    // And roll the history up so long-range analytics work immediately.
    for (let daysAgo = 30; daysAgo >= 0; daysAgo -= 1) {
      const d = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
      await prisma.$executeRawUnsafe(`SELECT mtlink_rollup_day('${d}'::date)`);
    }

    console.log(`  clicks   ${rows.length} synthetic clicks over 30 days, rolled up`);
  }

  console.log('\nSeed complete.\n');
  console.log(`  Dashboard login : ${SEED_EMAIL}`);
  console.log(`  Password        : ${SEED_PASSWORD}`);
  console.log(`  Short domain    : ${SEED_HOSTNAME}`);
  console.log('\n  Change that password before exposing this instance.\n');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
