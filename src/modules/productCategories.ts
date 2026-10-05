import { and, eq } from 'drizzle-orm';
import { categoryTable, productDrafts } from '../db/schema';
import type { WorkerEnv } from '../factory';
import type { SaveProductDraft } from './productDraftContracts';

type Database = WorkerEnv['Variables']['db'];
type Category = { categoryId: number; categoryName: string };

/** Signal an ambiguous legacy name that requires explicit category selection. */
export class CategoryConflictError extends Error {}

/** Match category names consistently without changing their displayed spelling. */
export function normalizeCategoryName(name: string) {
  return name.trim().toLowerCase();
}

/** Read only the public category identity; internal uniqueness keys stay private. */
export function readCategories(db: Database) {
  return db
    .select({
      categoryId: categoryTable.categoryId,
      categoryName: categoryTable.categoryName,
    })
    .from(categoryTable)
    .all();
}

/** Resolve legacy and newly keyed rows without choosing among ambiguous names. */
function matchingCategory(categories: Category[], name: string) {
  const key = normalizeCategoryName(name);
  const matches = categories.filter(
    category => normalizeCategoryName(category.categoryName) === key,
  );
  if (matches.length > 1)
    throw new CategoryConflictError('Category name is ambiguous; select its ID');
  return matches[0];
}

/** Reuse an existing category or create one unique normalized identity. */
export async function createCategory(db: Database, name: string) {
  const existing = matchingCategory(await readCategories(db), name);
  if (existing) return existing;
  await db
    .insert(categoryTable)
    .values({
      categoryName: name.trim(),
      normalizedKey: normalizeCategoryName(name),
    })
    .onConflictDoNothing({ target: categoryTable.normalizedKey });
  const category = matchingCategory(await readCategories(db), name);
  if (!category) throw new Error('Category creation could not be verified');
  return category;
}

/**
 * Atomically save an explicitly confirmed current draft and its category. The
 * caller validates the exact persisted proposal; history and DTO confirmations
 * never supply the fresh server token that gates the insert after the CAS.
 */
export async function saveConfirmedDraftCategory(
  db: Database,
  ownerId: string,
  id: string,
  input: SaveProductDraft,
  name: string,
) {
  const existing = matchingCategory(await readCategories(db), name);
  const token = crypto.randomUUID();
  const update = db
    .update(productDrafts)
    .set({
      state: input.state,
      revision: input.expectedRevision + 1,
      updatedAt: Date.now(),
      categoryConfirmationToken: token,
      categoryConfirmationName: name.trim(),
      categoryConfirmationKey: normalizeCategoryName(name),
      categoryConfirmationId: null,
    })
    .where(
      and(
        eq(productDrafts.id, id),
        eq(productDrafts.ownerId, ownerId),
        eq(productDrafts.status, 'active'),
        eq(productDrafts.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (existing) {
    const [row] = await update;
    return row;
  }
  const [rows] = await db.batch([
    update,
    db
      .insert(categoryTable)
      .select(
        db
          .select({
            categoryId: productDrafts.categoryConfirmationId,
            categoryName: productDrafts.categoryConfirmationName,
            normalizedKey: productDrafts.categoryConfirmationKey,
          })
          .from(productDrafts)
          .where(
            and(
              eq(productDrafts.id, id),
              eq(productDrafts.ownerId, ownerId),
              eq(productDrafts.status, 'active'),
              eq(productDrafts.revision, input.expectedRevision + 1),
              eq(productDrafts.categoryConfirmationToken, token),
            ),
          ),
      )
      .onConflictDoNothing({ target: categoryTable.normalizedKey }),
  ]);
  return rows[0];
}
