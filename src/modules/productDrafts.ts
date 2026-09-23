import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import {
  categoryTable,
  productDrafts,
  productsTable,
  productsToCategories,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  type BeginProductDraft,
  type ProductDraftContext,
  type ProductDraftTarget,
  productDraftResponseSchema,
  productDraftSummarySchema,
  type SaveProductDraft,
} from './productDraftContracts';

type Database = WorkerEnv['Variables']['db'];
type DraftRow = typeof productDrafts.$inferSelect;
const owned = (id: string, ownerId: string) =>
  and(eq(productDrafts.id, id), eq(productDrafts.ownerId, ownerId));

export async function readProductDraftContext(
  db: Database,
  target: ProductDraftTarget,
): Promise<ProductDraftContext> {
  if (target.kind === 'new') return { status: 'new' };
  const product = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, target.productId))
    .get();
  if (!product) return { status: 'unavailable', productId: target.productId };
  const linkedCategories = db
    .select({ id: productsToCategories.categoryId })
    .from(productsToCategories)
    .where(eq(productsToCategories.productId, product.id));
  const categories = await db
    .select()
    .from(categoryTable)
    .where(
      or(
        inArray(categoryTable.categoryId, linkedCategories),
        ...(product.categoryId === null
          ? []
          : [eq(categoryTable.categoryId, product.categoryId)]),
      ),
    )
    .orderBy(asc(categoryTable.categoryId))
    .all();
  return {
    status: 'available',
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      image: product.image,
      price: product.price,
      filamentType: product.filamentType,
      color: product.color,
      skuNumber: product.skuNumber,
      publicFileServiceId: product.publicFileServiceId,
    },
    categories,
  };
}

export async function productDraftResponse(db: Database, row: DraftRow) {
  return productDraftResponseSchema.parse({
    ...summary(row),
    state: row.state,
    context: await readProductDraftContext(db, row.target),
  });
}
function summary(row: DraftRow) {
  return productDraftSummarySchema.parse({
    id: row.id,
    target: row.target,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
export async function beginProductDraft(
  db: Database,
  ownerId: string,
  input: BeginProductDraft,
) {
  const context = await readProductDraftContext(db, input.target);
  if (context.status === 'unavailable') return undefined;
  const now = Date.now();
  const [row] = await db
    .insert(productDrafts)
    .values({
      id: crypto.randomUUID(),
      ownerId,
      target: input.target,
      state: input.state ?? { answers: {}, pendingQuestions: [], history: [] },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return productDraftResponseSchema.parse({
    ...summary(row),
    state: row.state,
    context,
  });
}
export async function listProductDrafts(db: Database, ownerId: string) {
  const rows = await db
    .select({
      id: productDrafts.id,
      target: productDrafts.target,
      revision: productDrafts.revision,
      createdAt: productDrafts.createdAt,
      updatedAt: productDrafts.updatedAt,
    })
    .from(productDrafts)
    .where(eq(productDrafts.ownerId, ownerId))
    .orderBy(desc(productDrafts.updatedAt), asc(productDrafts.id))
    .all();
  return { drafts: rows.map(row => productDraftSummarySchema.parse(row)) };
}
export function readProductDraft(db: Database, ownerId: string, id: string) {
  return db.select().from(productDrafts).where(owned(id, ownerId)).get();
}
export async function saveProductDraft(
  db: Database,
  ownerId: string,
  id: string,
  input: SaveProductDraft,
) {
  const [row] = await db
    .update(productDrafts)
    .set({
      state: input.state,
      revision: input.expectedRevision + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        owned(id, ownerId),
        eq(productDrafts.revision, input.expectedRevision),
      ),
    )
    .returning();
  return row;
}
export async function discardProductDraft(
  db: Database,
  ownerId: string,
  id: string,
  expectedRevision: number,
) {
  const [row] = await db
    .delete(productDrafts)
    .where(
      and(owned(id, ownerId), eq(productDrafts.revision, expectedRevision)),
    )
    .returning({ id: productDrafts.id });
  return row;
}
