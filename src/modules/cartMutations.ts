import { and, eq, exists, param } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import {
  type addCartItemSchema,
  cart,
  shoppingCarts,
  cartAgentActions,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { type CartAccess, cartLines } from './cartOwnership';

type Database = WorkerEnv['Variables']['db'];
type Selection = z.infer<typeof addCartItemSchema>;
export type CartMutationIdentity = {
  expectedRevision: number;
  id: string;
  inputHash: string;
  active?: () => boolean;
};
const bound = <T extends string | number | null>(value: T) =>
  param(value)
    .getSQL()
    .mapWith(value => value as T);
function changedCart() {
  return new HTTPException(409, {
    message: 'Cart changed; reload before retrying',
  });
}
export async function readCartAction(
  db: Database,
  access: CartAccess,
  id: string,
) {
  return db
    .select()
    .from(cartAgentActions)
    .where(
      and(
        eq(cartAgentActions.id, id),
        eq(cartAgentActions.cartId, access.id),
        exists(
          db
            .select({ id: shoppingCarts.id })
            .from(shoppingCarts)
            .where(
              and(
                eq(shoppingCarts.id, access.id),
                eq(shoppingCarts.accessVersion, access.accessVersion),
              ),
            ),
        ),
      ),
    )
    .get();
}
/** One atomic revision gate protects both direct controls and agent effects. */
async function mutate(
  db: Database,
  access: CartAccess,
  change:
    | { kind: 'add'; selection: Selection }
    | { kind: 'quantity'; itemId: number; quantity: number }
    | { kind: 'remove'; itemId: number },
  identity?: CartMutationIdentity,
) {
  if (identity) {
    const prior = await readCartAction(db, access, identity.id);
    if (prior) {
      if (prior.inputHash !== identity.inputHash) throw changedCart();
      return;
    }
  }
  const current = await db
    .select()
    .from(shoppingCarts)
    .where(
      and(
        eq(shoppingCarts.id, access.id),
        eq(shoppingCarts.accessVersion, access.accessVersion),
      ),
    )
    .get();
  if (!current) {
    if (change.kind === 'add') throw changedCart();
    throw new HTTPException(404, {
      message: 'No cart item found with that ID',
    });
  }
  if (identity && current.revision !== identity.expectedRevision)
    throw changedCart();
  const token = crypto.randomUUID();
  const gate = exists(
    db
      .select({ id: shoppingCarts.id })
      .from(shoppingCarts)
      .where(
        and(
          eq(shoppingCarts.id, access.id),
          eq(shoppingCarts.accessVersion, access.accessVersion),
          eq(shoppingCarts.mutationToken, token),
        ),
      ),
  );
  let effect: Parameters<Database['batch']>[0][number];
  if (change.kind === 'add') {
    const selection = change.selection;
    const existing = await db.query.cart.findFirst({
      where: and(
        cartLines(access),
        eq(cart.skuNumber, selection.skuNumber),
        eq(cart.filamentId, selection.filamentId),
      ),
    });
    if (existing) {
      if (existing.quantity + selection.quantity > 69)
        throw new HTTPException(400, { message: 'Maximum quantity is 69' });
      effect = db
        .update(cart)
        .set({ quantity: existing.quantity + selection.quantity })
        .where(and(cartLines(access), eq(cart.id, existing.id), gate));
    } else {
      effect = db.insert(cart).select(
        db
          .select({
            id: bound(null).as('id'),
            cartId: bound(access.id).as('cart_id'),
            accessVersion: bound(access.accessVersion).as('access_version'),
            userId: bound(access.userId).as('user_id'),
            skuNumber: bound(selection.skuNumber).as('sku_number'),
            quantity: bound(selection.quantity).as('quantity'),
            color: bound(selection.color).as('color'),
            filamentType: bound(selection.filamentType).as('filament_type'),
            filamentId: bound(selection.filamentId).as('filament_id'),
          })
          .from(shoppingCarts)
          .where(and(eq(shoppingCarts.id, access.id), gate)),
      );
    }
  } else {
    const existing = await db.query.cart.findFirst({
      where: and(cartLines(access), eq(cart.id, change.itemId)),
    });
    if (!existing)
      throw new HTTPException(404, {
        message: 'No cart item found with that ID',
      });
    effect =
      change.kind === 'remove' || change.quantity === 0
        ? db
            .delete(cart)
            .where(and(cartLines(access), eq(cart.id, change.itemId), gate))
        : db
            .update(cart)
            .set({ quantity: change.quantity })
            .where(and(cartLines(access), eq(cart.id, change.itemId), gate));
  }
  const advance = db
    .update(shoppingCarts)
    .set({ revision: current.revision + 1, mutationToken: token })
    .where(
      and(
        eq(shoppingCarts.id, access.id),
        eq(shoppingCarts.accessVersion, access.accessVersion),
        eq(shoppingCarts.revision, current.revision),
      ),
    )
    .returning({ id: shoppingCarts.id });
  const statements = identity
    ? ([
        advance,
        effect,
        db.insert(cartAgentActions).select(
          db
            .select({
              id: bound(identity.id).as('id'),
              cartId: bound(access.id).as('cart_id'),
              inputHash: bound(identity.inputHash).as('input_hash'),
              revision: bound(current.revision + 1).as('revision'),
            })
            .from(shoppingCarts)
            .where(and(eq(shoppingCarts.id, access.id), gate)),
        ),
      ] as const)
    : ([advance, effect] as const);
  if (identity?.active && !identity.active()) throw changedCart();
  let advanced: {id:string}[];
  try { [advanced] = await db.batch([...statements]); }
  catch(error) {
    const seen=new Set<unknown>();let cause:unknown=error;
    while(cause instanceof Error && !seen.has(cause)){if(/constraint/i.test(cause.message))throw changedCart();seen.add(cause);cause=(cause as Error & {cause?:unknown}).cause;}
    throw error;
  }
  if (!advanced.length) {
    const prior = identity
      ? await readCartAction(db, access, identity.id)
      : undefined;
    if (prior?.inputHash === identity?.inputHash && prior) return;
    throw changedCart();
  }
}
export function addCartLine(
  db: Database,
  access: CartAccess,
  selection: Selection,
  identity?: CartMutationIdentity,
) {
  return mutate(db, access, { kind: 'add', selection }, identity);
}
export function removeCartLine(
  db: Database,
  access: CartAccess,
  itemId: number,
  identity?: CartMutationIdentity,
) {
  return mutate(db, access, { kind: 'remove', itemId }, identity);
}
export function setCartLineQuantity(
  db: Database,
  access: CartAccess,
  itemId: number,
  quantity: number,
  identity?: CartMutationIdentity,
) {
  return mutate(db, access, { kind: 'quantity', itemId, quantity }, identity);
}
