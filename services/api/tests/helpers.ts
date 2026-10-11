/**
 * Integration test harness.
 *
 * These tests talk to a real Postgres and a real Redis. Mocking either one
 * would defeat the point: the behaviour worth testing here is cache
 * invalidation and partition routing, and neither exists in a mock.
 *
 * Set DATABASE_URL / REDIS_URL before running. `make test` wires this up.
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash, Algorithm } from '@node-rs/argon2';

export const prisma = new PrismaClient();

export interface Fixture {
  tenantId: string;
  userId: string;
  domainId: string;
  hostname: string;
  email: string;
  password: string;
}

const PASSWORD = 'test-password-12345';

/** Create an isolated tenant. Every test file gets its own, so they cannot
 *  interfere with each other or with seed data. */
export async function createFixture(label = 'test'): Promise<Fixture> {
  const id = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({
    data: { name: `${label} ${id}`, slug: `${label}-${id}` },
  });

  const passwordHash = await hash(PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const email = `${label}-${id}@test.invalid`;
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email, passwordHash, name: 'Test User', role: 'owner' },
  });

  const hostname = `${label}-${id}.test.invalid`;
  const domain = await prisma.domain.create({
    data: { tenantId: tenant.id, hostname, isDefault: true },
  });

  return {
    tenantId: tenant.id,
    userId: user.id,
    domainId: domain.id,
    hostname,
    email,
    password: PASSWORD,
  };
}

export async function destroyFixture(f: Fixture): Promise<void> {
  // Clicks have no FK to tenant (partitioned tables cannot be FK targets
  // cheaply), so they are removed explicitly.
  await prisma.click.deleteMany({ where: { tenantId: f.tenantId } });
  await prisma.clickDaily.deleteMany({ where: { tenantId: f.tenantId } });
  await prisma.tenant.delete({ where: { id: f.tenantId } }).catch(() => undefined);
}

export async function closeHelpers(): Promise<void> {
  await prisma.$disconnect();
}
