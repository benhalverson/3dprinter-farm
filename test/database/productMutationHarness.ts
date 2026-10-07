import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/libsql';
import type { WorkerEnv } from '../../src/factory';
import * as schema from '../../src/db/schema';
import { reconcileProductMutation } from '../../src/modules/productMutations';
import type { Bindings } from '../../src/types';

type Command = {
  command: string;
  assets?: (typeof schema.productAssets.$inferInsert)[];
  attempt?: typeof schema.productAssetReferenceAttempts.$inferInsert;
  operation?: typeof schema.productMutationOperations.$inferInsert;
  product?: typeof schema.productsTable.$inferInsert;
  mapping?: typeof schema.squareCatalogMappings.$inferInsert;
  category?: typeof schema.categoryTable.$inferInsert;
  id?: string;
  categoryName?: string;
  revision?: number;
};
export default {
  /** Runs production reconciliation and local SQLite batches against a persisted local database. */
  async fetch(
    request: Request,
    env: { db: ReturnType<typeof drizzle<typeof schema>> } & Record<
      string,
      unknown
    >,
  ) {
    const input = (await request.json()) as Command;
    const db = env.db;
    if (input.command === 'seed') {
      if (input.assets)
        await db.insert(schema.productAssets).values(input.assets);
      if (input.attempt)
        await db
          .insert(schema.productAssetReferenceAttempts)
          .values(input.attempt);
      if (input.category)
        await db.insert(schema.categoryTable).values(input.category);
      if (input.product)
        await db.insert(schema.productsTable).values(input.product);
      if (input.mapping)
        await db.insert(schema.squareCatalogMappings).values(input.mapping);
      if (input.operation)
        await db
          .insert(schema.productMutationOperations)
          .values(input.operation);
    }
    if (input.command === 'product' && input.product)
      await db
        .update(schema.productsTable)
        .set(input.product)
        .where(eq(schema.productsTable.id, 1));
    if (input.command === 'removeProduct')
      await db
        .delete(schema.productsTable)
        .where(eq(schema.productsTable.id, 1));
    if (input.command === 'category')
      await db
        .update(schema.categoryTable)
        .set({ categoryName: input.categoryName })
        .where(eq(schema.categoryTable.categoryId, 1));
    if (input.command === 'revision')
      await db
        .update(schema.productsTable)
        .set({ squareRevision: input.revision })
        .where(eq(schema.productsTable.id, 1));
    if (input.command === 'reconcile') {
      const operation = await db
        .select()
        .from(schema.productMutationOperations)
        .where(eq(schema.productMutationOperations.id, input.id ?? ''))
        .get();
      if (!operation)
        return Response.json({ error: 'missing operation' }, { status: 404 });
      await reconcileProductMutation(
        db as unknown as WorkerEnv['Variables']['db'],
        env as unknown as Bindings,
        operation.ownerId,
        operation.draftId,
        operation.id,
      );
    }
    return Response.json({
      assets: await db.select().from(schema.productAssets).all(),
      attempts: await db
        .select()
        .from(schema.productAssetReferenceAttempts)
        .all(),
      products: await db.select().from(schema.productsTable).all(),
      mappings: await db.select().from(schema.squareCatalogMappings).all(),
      categories: await db.select().from(schema.productsToCategories).all(),
      operations: await db
        .select()
        .from(schema.productMutationOperations)
        .all(),
    });
  },
};
