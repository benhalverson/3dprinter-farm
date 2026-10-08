import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { checkoutAttempts, ordersTable } from '../db/schema';
import type { WorkerEnv } from '../factory';
export const attemptStatusSchema = z.object({
  attemptId: z.string(),
  quoteId: z.string(),
  cartId: z.string(),
  state: z.enum(['pending', 'unknown', 'failed', 'cancelled', 'paid']),
  paymentUrl: z.string().nullable(),
  order: z
    .object({
      id: z.number(),
      paymentStatus: z.string().nullable(),
      fulfillmentState: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
});
export async function readOwnedCheckoutAttempt(
  db: WorkerEnv['Variables']['db'],
  ownerId: string,
  key: 'attemptId' | 'requestKey',
  value: string,
) {
  const [attempt] = await db
    .select()
    .from(checkoutAttempts)
    .where(
      and(
        eq(
          key === 'attemptId'
            ? checkoutAttempts.id
            : checkoutAttempts.requestKey,
          value,
        ),
        eq(checkoutAttempts.ownerId, ownerId),
      ),
    );
  if (!attempt) return undefined;
  const [order] = await db
    .select({
      id: ordersTable.id,
      paymentStatus: ordersTable.paymentStatus,
      fulfillmentState: ordersTable.fulfillmentState,
      status: ordersTable.status,
    })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.checkoutAttemptId, attempt.id),
        eq(ordersTable.userId, ownerId),
      ),
    );
  return attemptStatusSchema.parse({
    attemptId: attempt.id,
    quoteId: attempt.quoteId,
    cartId: attempt.cartId,
    state:
      attempt.state === 'paid'
        ? 'paid'
        : attempt.state === 'failed'
          ? 'failed'
          : attempt.state === 'cancelled'
            ? 'cancelled'
            : attempt.paymentUrl
              ? 'pending'
              : 'unknown',
    paymentUrl: attempt.state === 'paid' ? null : attempt.paymentUrl,
    order: order ?? null,
  });
}
