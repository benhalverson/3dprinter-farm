import { and, eq, isNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { cart, shoppingCarts } from '../db/schema';
import type { WorkerEnv } from '../factory';

type Database = WorkerEnv['Variables']['db'];
export type CartAccess = typeof shoppingCarts.$inferSelect;
export type CartCaller = { userId?: string; guestToken?: string };

/** Rejects stale account assertions; session identity alone remains authoritative. */
export function assertCartIdentity(
  userId: string | undefined,
  expectedUserId: string | null,
): void {
  if ((userId ?? null) !== expectedUserId) {
    throw new HTTPException(409, {
      message: 'Account changed; refresh your session before retrying',
    });
  }
}

const tokenSchema = z.string().uuid();

/** Hashes the bearer capability before persistence or comparison. */
async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Persists an empty cart; only an anonymous creator receives a guest capability. */
export async function createCart(db: Database, userId?: string) {
  const guestToken = userId ? undefined : crypto.randomUUID();
  const cartId = crypto.randomUUID();
  await db.insert(shoppingCarts).values({
    id: cartId,
    userId: userId ?? null,
    guestTokenHash: guestToken ? await tokenHash(guestToken) : null,
    accessVersion: crypto.randomUUID(),
  });
  return { cartId, guestToken, ownerId: userId ?? null };
}

/** Resolves a durable owner from the verified session or an unclaimed guest capability. */
export async function requireCartAccess(
  db: Database,
  cartId: string,
  caller: CartCaller,
) {
  const token = tokenSchema.safeParse(caller.guestToken);
  if (!caller.userId && !token.success) {
    throw new HTTPException(404, { message: 'Cart not found' });
  }
  const [access] = await db
    .select()
    .from(shoppingCarts)
    .where(
      and(
        eq(shoppingCarts.id, cartId),
        or(
          caller.userId ? eq(shoppingCarts.userId, caller.userId) : undefined,
          token.success
            ? and(
                isNull(shoppingCarts.userId),
                eq(shoppingCarts.guestTokenHash, await tokenHash(token.data)),
              )
            : undefined,
        ),
      ),
    );
  if (!access) throw new HTTPException(404, { message: 'Cart not found' });
  return access;
}

/** Every line query uses the authorization version; claiming revokes in-flight guest requests. */
export function cartLines(access: CartAccess) {
  return and(
    eq(cart.cartId, access.id),
    eq(cart.accessVersion, access.accessVersion),
  );
}

/** Atomically claims a guest cart once and revokes every outstanding guest authorization. */
export async function claimCart(
  db: Database,
  cartId: string,
  caller: CartCaller,
) {
  if (!caller.userId) throw new HTTPException(401, { message: 'Unauthorized' });
  const access = await requireCartAccess(db, cartId, caller);
  if (access.userId === caller.userId) return;
  const accessVersion = crypto.randomUUID();
  // D1's Drizzle batch is atomic. The FK cascades the new authorization version
  // to existing lines; inserts carrying the old version can no longer succeed.
  const [claimed] = await db.batch([
    db
      .update(shoppingCarts)
      .set({
        userId: caller.userId,
        guestTokenHash: null,
        accessVersion,
      })
      .where(
        and(
          eq(shoppingCarts.id, cartId),
          eq(shoppingCarts.accessVersion, access.accessVersion),
          isNull(shoppingCarts.userId),
        ),
      )
      .returning({ id: shoppingCarts.id }),
    db
      .update(cart)
      .set({ userId: caller.userId })
      .where(
        and(eq(cart.cartId, cartId), eq(cart.accessVersion, accessVersion)),
      ),
  ]);
  if (claimed.length === 0)
    throw new HTTPException(409, {
      message: 'Cart ownership changed; reload the cart',
    });
}
