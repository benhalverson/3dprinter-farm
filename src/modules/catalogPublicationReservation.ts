import { and, eq, exists, notExists } from 'drizzle-orm';
import {
  productsTable,
  squareCatalogMappings as mappings,
  squareCatalogOperations as operations,
} from '../db/schema';
import type { drizzle } from 'drizzle-orm/d1';

/** Persists an inert candidate, then atomically authorizes it only while its catalog snapshot is current. */
export async function reserveCatalogOperation(
  db: ReturnType<typeof drizzle>,
  item: typeof productsTable.$inferSelect,
  mapping: typeof mappings.$inferSelect,
  kind: 'publish' | 'unpublish',
  payload: string,
  targetSnapshot: string,
  key: string,
) {
  // Persist an inert candidate first. Only the conditional activation below
  // authorizes a Square request; a crash here leaves no external effect.
  await db
    .insert(operations)
    .values({
      id: key,
      mappingId: mapping.id,
      kind,
      payload,
      snapshot: targetSnapshot,
      state: 'prepared',
      createdAt: new Date().toISOString(),
      generation: mapping.generation,
    })
    .run();
  // SQLite serializes this statement with edits, deletion, and other activations.
  const [reserved] = await db
    .update(operations)
    .set({ state: 'pending' })
    .where(
      and(
        eq(operations.id, key),
        eq(operations.state, 'prepared'),
        exists(
          db
            .select({ id: mappings.id })
            .from(mappings)
            .innerJoin(productsTable, eq(productsTable.id, mappings.productId))
            .where(
              and(
                eq(mappings.id, mapping.id),
                eq(mappings.generation, mapping.generation),
                eq(productsTable.id, item.id),
                eq(productsTable.squareRevision, item.squareRevision),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: operations.id })
            .from(operations)
            .where(
              and(
                eq(operations.mappingId, mapping.id),
                eq(operations.state, 'pending'),
              ),
            ),
        ),
      ),
    )
    .returning();
  return reserved;
}
