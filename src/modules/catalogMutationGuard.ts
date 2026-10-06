import { and, eq, inArray, notExists } from 'drizzle-orm';
import { productMutationOperations, productsTable } from '../db/schema';
import type { drizzle } from 'drizzle-orm/d1';

/** Serialize legacy catalog writes with durable admin operations, including confirmed remote work awaiting local repair. */
export function noPendingProductMutation(
  db: Pick<ReturnType<typeof drizzle>, 'select'>,
  productId: number | typeof productsTable.id,
) {
  return notExists(
    db
      .select({ id: productMutationOperations.id })
      .from(productMutationOperations)
      .where(
        and(
          eq(productMutationOperations.productId, productId),
          inArray(productMutationOperations.state, [
            'prepared',
            'pending',
            'item_confirmed',
            'square_confirmed',
            'repair_required',
          ]),
        ),
      ),
  );
}
