import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import {
  SHARED_ORGANIZATION_ID,
  SHARED_ORGANIZATION_NAME,
  SHARED_ORGANIZATION_SLUG,
} from '../constants';
import * as schema from '../db/schema';

type Database = DrizzleD1Database<typeof schema>;

export type SharedOrganizationRole = 'owner' | 'admin' | 'member';

export function normalizeLegacyRole(role?: string | null) {
  if (!role) {
    return 'user';
  }

  return role
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

export function mapLegacyRoleToOrganizationRole(
  role?: string | null,
): SharedOrganizationRole {
  const normalizedRole = normalizeLegacyRole(role);

  if (normalizedRole === 'owner') {
    return 'owner';
  }

  if (normalizedRole === 'admin' || normalizedRole === 'catalog_manager') {
    return 'admin';
  }

  return 'member';
}

export async function ensureSharedOrganization(db: Database) {
  const existing = await db
    .select()
    .from(schema.organizationTable)
    .where(eq(schema.organizationTable.id, SHARED_ORGANIZATION_ID))
    .get();

  if (existing) {
    return existing;
  }

  const inserted = await db
    .insert(schema.organizationTable)
    .values({
      id: SHARED_ORGANIZATION_ID,
      name: SHARED_ORGANIZATION_NAME,
      slug: SHARED_ORGANIZATION_SLUG,
      logo: null,
      metadata: JSON.stringify({ type: 'shared' }),
      createdAt: new Date(),
    })
    .returning();

  return (
    inserted?.[0] ?? {
      id: SHARED_ORGANIZATION_ID,
      name: SHARED_ORGANIZATION_NAME,
      slug: SHARED_ORGANIZATION_SLUG,
      logo: null,
      metadata: JSON.stringify({ type: 'shared' }),
      createdAt: new Date(),
    }
  );
}

export async function getSharedOrganizationMembership(db: Database, userId: string) {
  return db
    .select()
    .from(schema.memberTable)
    .where(
      and(
        eq(schema.memberTable.organizationId, SHARED_ORGANIZATION_ID),
        eq(schema.memberTable.userId, userId),
      ),
    )
    .get();
}

export async function ensureSharedOrganizationMembership(
  db: Database,
  {
    userId,
    role,
  }: {
    userId: string;
    role: SharedOrganizationRole;
  },
) {
  await ensureSharedOrganization(db);

  const existingMembership = await getSharedOrganizationMembership(db, userId);

  if (existingMembership) {
    return existingMembership;
  }

  const memberId = `member:${SHARED_ORGANIZATION_ID}:${userId}`;
  const createdAt = new Date();
  const inserted = await db
    .insert(schema.memberTable)
    .values({
      id: memberId,
      organizationId: SHARED_ORGANIZATION_ID,
      userId,
      role,
      createdAt,
    })
    .returning();

  return (
    inserted?.[0] ?? {
      id: memberId,
      organizationId: SHARED_ORGANIZATION_ID,
      userId,
      role,
      createdAt,
    }
  );
}
