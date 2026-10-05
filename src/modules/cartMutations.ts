import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { type addCartItemSchema, cart } from '../db/schema';
import type { WorkerEnv } from '../factory';
import { type CartAccess, cartLines } from './cartOwnership';

type Database = WorkerEnv['Variables']['db'];
type Selection = z.infer<typeof addCartItemSchema>;

/** Identifies constraint races wrapped by Drizzle without exposing database details. */
function isConstraintConflict(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (/constraint/i.test(current.message)) return true;
    visited.add(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/** Reports a lost quantity or claim race; callers must reload before retrying. */
function changedCart(): HTTPException {
  return new HTTPException(409, {
    message: 'Cart changed; reload before retrying',
  });
}

/** Adds one validated configuration with bounded compare-and-swap quantity updates. */
export async function addCartLine(
  db: Database,
  access: CartAccess,
  selection: Selection,
): Promise<void> {
  const existing = await db.query.cart.findFirst({
    where: and(
      cartLines(access),
      eq(cart.skuNumber, selection.skuNumber),
      eq(cart.filamentId, selection.filamentId),
    ),
  });
  if (existing) {
    if (existing.quantity + selection.quantity > 69) {
      throw new HTTPException(400, { message: 'Maximum quantity is 69' });
    }
    const updated = await db
      .update(cart)
      .set({ quantity: existing.quantity + selection.quantity })
      .where(
        and(
          cartLines(access),
          eq(cart.id, existing.id),
          eq(cart.quantity, existing.quantity),
        ),
      )
      .returning({ id: cart.id });
    if (updated.length === 0) throw changedCart();
    return;
  }
  try {
    // The version FK rejects an insert if a claim revoked guest access, while
    // the unique index rejects concurrent insertions of the same configuration.
    await db
      .insert(cart)
      .values({
        ...selection,
        cartId: access.id,
        accessVersion: access.accessVersion,
        userId: access.userId,
      })
      .returning({ id: cart.id });
  } catch (error) {
    if (isConstraintConflict(error)) throw changedCart();
    throw error;
  }
}

/** Removes a line only within the authorized version, reporting stale or absent lines. */
export async function removeCartLine(
  db: Database,
  access: CartAccess,
  itemId: number,
): Promise<void> {
  const deleted = await db
    .delete(cart)
    .where(and(cartLines(access), eq(cart.id, itemId)))
    .returning({ id: cart.id });
  if (deleted.length === 0) {
    throw new HTTPException(404, {
      message: 'No cart item found with that ID',
    });
  }
}

/** Applies a validated absolute quantity or removes the line when it reaches zero. */
export async function setCartLineQuantity(
  db: Database,
  access: CartAccess,
  itemId: number,
  quantity: number,
): Promise<void> {
  if (quantity === 0) return removeCartLine(db, access, itemId);
  const updated = await db
    .update(cart)
    .set({ quantity })
    .where(and(cartLines(access), eq(cart.id, itemId)))
    .returning({ id: cart.id });
  if (updated.length === 0) {
    throw new HTTPException(404, {
      message: 'No cart item found with that ID',
    });
  }
}
