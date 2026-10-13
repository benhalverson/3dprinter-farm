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

