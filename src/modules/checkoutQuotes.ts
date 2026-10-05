import 'zod-openapi/extend';
import { and, asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { cart, checkoutQuotes, productsTable, users } from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  decryptStoredShippingProfile,
  encryptStoredProfileValue,
  decryptStoredProfileValue,
  getCipherKitSecretKey,
} from '../utils/profileCrypto';
import { validateCartConfiguration } from './cartConfiguration';
import { cartLines, requireCartAccess } from './cartOwnership';
import {
  mapShippingAddress,
  requestShippingEstimate,
  shippingProfileSchema,
  shippingUsdCents,
} from './shippingEstimate';

const cents = z.number().int().safe().nonnegative();
export const quoteSnapshotSchema = z.object({
  currency: z.literal('USD'),
  address: z.object({
    name: z.string(),
    line1: z.string(),
    line2: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
    country: z.string(),
  }),
  lines: z
    .array(
      z.object({
        cartItemId: z.number().int(),
        productId: z.number().int(),
        skuNumber: z.string(),
        name: z.string(),
        quantity: z.number().int().min(1).max(69),
        filamentType: z.string(),
        filamentId: z.string().uuid(),
        color: z.string(),
        publicFileServiceId: z.string(),
        unitAmountCents: cents,
        totalAmountCents: cents,
      }),
    )
    .min(1),
  subtotalCents: cents,
  shippingCents: cents,
  totalCents: cents,
});
export const quoteResponseSchema = quoteSnapshotSchema.extend({
  id: z.string().uuid(),
  cartId: z.string().uuid(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  status: z.enum(['valid', 'expired', 'stale']),
});
export type QuoteSnapshot = z.infer<typeof quoteSnapshotSchema>;
type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
// A bounded technical validity window, never a provider rate guarantee.
const QUOTE_LIFETIME_MS = 15 * 60 * 1000;

/** Raises a sanitized failure when a cart cannot safely be quoted. */
function stale(message = 'Cart is not ready for a quote'): never {
  throw new HTTPException(409, { message });
}

/** Reads owned current inputs and checks fixed-material availability without Stripe dependencies. */
async function currentInputs(
  db: Database,
  env: Environment,
  cartId: string,
  userId: string,
  verifyAvailability = true,
) {
  const access = await requireCartAccess(db, cartId, { userId });
  if (access.userId !== userId)
    throw new HTTPException(404, { message: 'Cart not found' });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new HTTPException(404, { message: 'Profile not found' });
  const parsed = shippingProfileSchema.safeParse(
    await decryptStoredShippingProfile(user, env.ENCRYPTION_PASSPHRASE),
  );
  if (!parsed.success)
    stale('Complete your shipping profile before requesting a quote');
  const profile = parsed.data;
  const items = await db
    .select({ line: cart, product: productsTable })
    .from(cart)
    .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
    .where(cartLines(access))
    .orderBy(asc(cart.id));
  if (!items.length) stale('Your cart is empty');
  const lines: QuoteSnapshot['lines'] = [];
  for (const { line, product } of items) {
    if (line.userId !== null && line.userId !== userId) stale();
    if (
      !product?.publicFileServiceId?.trim() ||
      product.filamentType !== line.filamentType ||
      !line.filamentId ||
      !line.color ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 69
    )
      stale();
    const unitAmountCents = shippingUsdCents(product.price);
    if (unitAmountCents === undefined || unitAmountCents <= 0)
      stale('Online Price is unavailable');
    const totalAmountCents = unitAmountCents * line.quantity;
    if (!Number.isSafeInteger(totalAmountCents))
      stale('Online Price exceeds safe amount limits');
    if (verifyAvailability)
      await validateCartConfiguration(db, env, {
        cartId,
        skuNumber: line.skuNumber,
        quantity: line.quantity,
        color: line.color,
        filamentType: line.filamentType,
        filamentId: line.filamentId,
      });
    lines.push({
      cartItemId: line.id,
      productId: product.id,
      skuNumber: line.skuNumber,
      name: product.name,
      quantity: line.quantity,
      filamentType: line.filamentType,
      filamentId: line.filamentId,
      color: line.color,
      publicFileServiceId: product.publicFileServiceId,
      unitAmountCents,
      totalAmountCents,
    });
  }
  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.totalAmountCents,
    0,
  );
  if (!Number.isSafeInteger(subtotalCents))
    stale('Cart exceeds safe amount limits');
  const input = {
    accessVersion: access.accessVersion,
    email: profile.email,
    address: mapShippingAddress(profile),
    lines,
    subtotalCents,
  };
  // Re-read persisted input after external availability checks, which can be slow.
  if (
    verifyAvailability &&
    JSON.stringify(input) !==
      JSON.stringify(await currentInputs(db, env, cartId, userId, false))
  )
    stale('Checkout changed during validation; request a new quote');
  return input;
}

/** Hashes canonical current inputs; no client amounts participate in quote validity. */
async function fingerprint(input: Awaited<ReturnType<typeof currentInputs>>) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Creates an immutable owned quote only after rechecking inputs following the shipping estimate. */
export async function createCheckoutQuote(
  db: Database,
  env: Environment,
  cartId: string,
  userId: string,
) {
  if (!env.ENCRYPTION_PASSPHRASE || !env.SLANT_PLATFORM_ID || !env.SLANT_API_V2)
    throw new HTTPException(503, { message: 'Quotes are not configured' });
  const input = await currentInputs(db, env, cartId, userId);
  const inputHash = await fingerprint(input);
  let shippingCents: number;
  try {
    const estimate = await requestShippingEstimate(
      {
        platformId: env.SLANT_PLATFORM_ID,
        ownerId: userId,
        customer: { details: { email: input.email, address: input.address } },
        items: input.lines.map(line => ({
          type: 'PRINT' as const,
          publicFileServiceId: line.publicFileServiceId,
          filamentId: line.filamentId,
          quantity: line.quantity,
        })),
      },
      env.SLANT_API_V2,
    );
    const value = shippingUsdCents(estimate.shippingCost);
    if (value === undefined) throw new Error('Invalid shipping amount');
    shippingCents = value;
  } catch {
    throw new HTTPException(502, {
      message: 'Shipping estimate unavailable; request a new quote',
    });
  }
  if (
    inputHash !==
    (await fingerprint(await currentInputs(db, env, cartId, userId)))
  )
    stale('Checkout changed while quoting; request a new quote');
  const snapshot = quoteSnapshotSchema.parse({
    currency: 'USD',
    address: input.address,
    lines: input.lines,
    subtotalCents: input.subtotalCents,
    shippingCents,
    totalCents: input.subtotalCents + shippingCents,
  });
  const createdAt = Date.now();
  const record = {
    id: crypto.randomUUID(),
    ownerId: userId,
    cartId,
    inputHash,
    encryptedSnapshot: (await encryptStoredProfileValue(
      JSON.stringify(snapshot),
      await getCipherKitSecretKey(env.ENCRYPTION_PASSPHRASE),
    )) as string,
    createdAt,
    expiresAt: createdAt + QUOTE_LIFETIME_MS,
    invalidated: false,
  };
  await db.insert(checkoutQuotes).values(record);
  return {
    ...snapshot,
    id: record.id,
    cartId,
    createdAt,
    expiresAt: record.expiresAt,
    status: 'valid' as const,
  };
}

/** Returns the immutable snapshot with current validity; this read never authorizes payment. */
export async function readCheckoutQuote(
  db: Database,
  env: Environment,
  cartId: string,
  userId: string,
  quoteId: string,
) {
  const [quote] = await db
    .select()
    .from(checkoutQuotes)
    .where(
      and(
        eq(checkoutQuotes.id, quoteId),
        eq(checkoutQuotes.ownerId, userId),
        eq(checkoutQuotes.cartId, cartId),
      ),
    );
  if (!quote) throw new HTTPException(404, { message: 'Quote not found' });
  let status: 'valid' | 'expired' | 'stale' = quote.invalidated
    ? 'stale'
    : Date.now() >= quote.expiresAt
      ? 'expired'
      : 'valid';
  if (status === 'valid') {
    try {
      const input = await currentInputs(db, env, cartId, userId);
      if (quote.inputHash !== (await fingerprint(input))) status = 'stale';
    } catch (error) {
      if (
        error instanceof HTTPException &&
        [400, 404, 409].includes(error.status)
      )
        status = 'stale';
      else throw error;
    }
    if (status === 'stale')
      await db
        .update(checkoutQuotes)
        .set({ invalidated: true })
        .where(eq(checkoutQuotes.id, quote.id));
  }
  const snapshot = quoteSnapshotSchema.parse(
    JSON.parse(
      (await decryptStoredProfileValue(
        quote.encryptedSnapshot,
        await getCipherKitSecretKey(env.ENCRYPTION_PASSPHRASE),
      )) as string,
    ),
  );
  const [latest] = await db
    .select({ invalidated: checkoutQuotes.invalidated })
    .from(checkoutQuotes)
    .where(
      and(eq(checkoutQuotes.id, quote.id), eq(checkoutQuotes.ownerId, userId)),
    );
  if (!latest) throw new HTTPException(404, { message: 'Quote not found' });
  if (latest.invalidated) status = 'stale';
  else if (Date.now() >= quote.expiresAt) status = 'expired';
  return {
    ...snapshot,
    id: quote.id,
    cartId: quote.cartId,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    status,
  };
}
