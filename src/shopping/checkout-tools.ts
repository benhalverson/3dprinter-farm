import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ordersTable } from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  createCheckoutQuote,
  readCheckoutQuote,
  quoteResponseSchema,
} from '../modules/checkoutQuotes';
import { readOwnedCheckoutAttempt } from '../modules/checkoutAttemptRead';
import { toCustomerOrder } from '../modules/customerOrderProjection';
import { requireCartAccess } from '../modules/cartOwnership';
import type { RunInput } from './contracts';
import type { CommerceTools, ToolDefinition } from './commerce';
const empty = z.object({}).strict();
const querySchema = z.discriminatedUnion('name', [
  z
    .object({ name: z.literal('checkout_prepare_review'), arguments: empty })
    .strict(),
  z
    .object({
      name: z.literal('checkout_read_quote'),
      arguments: z.object({ quoteId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('checkout_attempt_status'),
      arguments: z.object({attemptId:z.string().uuid().optional(),requestKey:z.string().uuid().optional()}).strict().refine(value=>Number(!!value.attemptId)+Number(!!value.requestKey)===1),
    })
    .strict(),
  z.object({ name: z.literal('customer_orders'), arguments: empty }).strict(),
  z
    .object({
      name: z.literal('customer_order'),
      arguments: z
        .object({ orderId: z.number().int().positive().safe() })
        .strict(),
    })
    .strict(),
]);
export const checkoutDefinitions: ToolDefinition[] = [
  {
    name: 'checkout_prepare_review',
    description:
      'Prepare a shipping-inclusive quote for the current authenticated cart and open trusted review. This cannot buy or charge. Explicit customer confirmation is required in trusted controls.',
    properties: {},
  },
  {
    name: 'checkout_read_quote',
    description:
      'Revalidate a quote for the current cart. Stale or expired quotes cannot authorize checkout.',
    properties: { quoteId: { type: 'string', format: 'uuid' } },
  },
  {
    name: 'checkout_attempt_status',
    description:
      'Read a previously created checkout outcome. Unknown is not failed or paid. This never creates another attempt.',
    properties: { attemptId: { type: 'string', format: 'uuid' },requestKey:{type:'string',format:'uuid'} },
  },
  {
    name: 'customer_orders',
    description:
      'Read up to ten recent orders belonging to the authenticated caller. Never guess unknown status or policies.',
    properties: {},
  },
  {
    name: 'customer_order',
    description:
      'Read one order belonging to the authenticated caller. Another account cannot be selected.',
    properties: { orderId: { type: 'integer', minimum: 1 } },
  },
].map(({ name, description, properties }) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: name==='checkout_attempt_status'?[]:Object.keys(properties),
      ...(name==='checkout_attempt_status'?{oneOf:[{required:['attemptId']},{required:['requestKey']}]}:{}),
      additionalProperties: false,
    },
  },
}));
const summarySchema = z
  .object({
    id: z.number().int(),
    orderNumber: z.string(),
    paymentStatus: z.string().nullable(),
    fulfillmentState: z.string().nullable(),
    status: z.string().nullable(),
    totalAmountCents: z.number().int().nullable(),
    currency: z.string().nullable(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    refund: z
      .object({
        status: z.string(),
        amountCents: z.number().int().nullable(),
        currency: z.string().nullable(),
        refundedAt: z.string().nullable(),
      })
      .nullable(),
  })
  .strict();
/** Minimal model facts from the same customer projection used by direct order reads. */
function orderSummary(row: typeof ordersTable.$inferSelect) {
  const order = toCustomerOrder(row);
  return summarySchema.parse({
    id: order.id,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    fulfillmentState: order.fulfillmentState,
    status: order.status,
    totalAmountCents: order.totalAmountCents,
    currency: order.currency,
    shippedAt: order.fulfillment.shippedAt,
    deliveredAt: order.fulfillment.deliveredAt,
    refund: order.refund,
  });
}
export function checkoutTools(
  db: WorkerEnv['Variables']['db'],
  env: WorkerEnv['Bindings'],
  userId: string,
  input: RunInput,
  active: () => boolean,
  publish: (value: unknown) => void,
): CommerceTools {
  let prepared = false;
  const emit = (kind: string, result: object) => {
    if (active()) publish({ kind, accountId: userId, ...result });
    return result;
  };
  return {
    definitions: checkoutDefinitions,
    context: {
      checkout:
        'Trusted review and explicit confirmation required; natural language never authorizes payment',
      orders:
        'Only current authenticated customer data; unknown facts remain unknown',
    },
    async execute(raw) {
      const query = querySchema.parse(raw);
      if (!active()) throw new Error('Run superseded');
      if (query.name === 'customer_order' || query.name === 'customer_orders') {
        const rows = await db
          .select()
          .from(ordersTable)
          .where(
            and(
              eq(ordersTable.userId, userId),
              query.name === 'customer_order'
                ? eq(ordersTable.id, query.arguments.orderId)
                : undefined,
            ),
          )
          .orderBy(desc(ordersTable.createdAt))
          .limit(query.name === 'customer_order' ? 1 : 10);
        return emit('owned_orders', {
          status: rows.length ? 'known' : 'unknown',
          orders: rows.map(orderSummary),
          policy: 'unknown',
        });
      }
      if (query.name === 'checkout_attempt_status') {
        const attempt = await readOwnedCheckoutAttempt(
          db,
          userId,
          query.arguments.attemptId?'attemptId':'requestKey',
          (query.arguments.attemptId??query.arguments.requestKey)!,
        );
        // Hosted payment URLs stay in deterministic recovery, never model context.
        return emit('checkout_attempt', {
          status: attempt ? 'known' : 'unknown',
          attempt: attempt
            ? {
                attemptId: attempt.attemptId,
                state: attempt.state,
                order: attempt.order,
              }
            : null,
        });
      }
      if (!input.cart)
        return emit('checkout_review', { status: 'cart_required' });
      const access = await requireCartAccess(db, input.cart.id, { userId });
      if (access.revision !== input.cart.revision)
        return emit('checkout_review', { status: 'stale' });
      if (query.name === 'checkout_prepare_review' && prepared)
        return emit('checkout_review', { status: 'review_already_prepared' });
      const quote = quoteResponseSchema.parse(
        query.name === 'checkout_prepare_review'
          ? await createCheckoutQuote(db, env, input.cart.id, userId)
          : await readCheckoutQuote(
              db,
              env,
              input.cart.id,
              userId,
              query.arguments.quoteId,
            ),
      );
      prepared = true;
      if (
        !active() ||
        (await requireCartAccess(db, input.cart.id, { userId })).revision !==
          input.cart.revision
      )
        return { status: 'stale' };
      // Profile/address, Print File IDs, payment URLs and credentials never enter the model.
      return emit('checkout_review', {
        status: quote.status === 'valid' ? 'review_required' : quote.status,
        review: {
          quoteId: quote.id,
          cartId: quote.cartId,
          currency: quote.currency,
          subtotalCents: quote.subtotalCents,
          shippingCents: quote.shippingCents,
          totalCents: quote.totalCents,
          expiresAt: quote.expiresAt,
          confirmationRequired: true,
        },
      });
    },
  };
}
