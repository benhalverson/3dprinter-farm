import { and, eq, inArray, ne } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  inPersonSales,
  productsTable,
  ordersTable,
  orderEventsTable,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { squareClient, squareConfig } from '../lib/square';
type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
export const saleInputSchema = z
  .object({
    requestKey: z.string().uuid(),
    items: z
      .array(
        z
          .object({
            productId: z.number().int().positive(),
            quantity: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    input =>
      new Set(input.items.map(item => item.productId)).size ===
      input.items.length,
    'Duplicate product',
  );
const snapshotSchema = z.object({
  lines: z.array(
    z.object({
      productId: z.number().int(),
      name: z.string(),
      quantity: z.number().int().positive(),
      unitAmountCents: z.number().int().positive().safe(),
    }),
  ),
  totalCents: z.number().int().positive().safe(),
  currency: z.literal('USD'),
});
type Sale = typeof inPersonSales.$inferSelect;
export function saleResponse(sale: Sale) {
  return {
    saleId: sale.id,
    ...snapshotSchema.parse(JSON.parse(sale.snapshot)),
    paymentStatus: sale.state,
    paymentUrl: sale.state === 'paid' ? null : sale.paymentUrl,
    outcome:
      sale.state === 'pending' && !sale.paymentUrl ? 'unknown' : sale.state,
  };
}
/** Saves the immutable sale before contacting Square; identical retries reuse its idempotency key. */
export async function createInPersonSale(
  db: Database,
  env: Environment,
  sellerId: string,
  input: z.infer<typeof saleInputSchema>,
) {
  const config = squareConfig(env);
  const provider = squareClient(config);
  const request = JSON.stringify(
    [...input.items].sort((a, b) => a.productId - b.productId),
  );
  let [sale] = await db
    .select()
    .from(inPersonSales)
    .where(eq(inPersonSales.requestKey, input.requestKey));
  if (!sale) {
    const products = await db
      .select()
      .from(productsTable)
      .where(
        inArray(
          productsTable.id,
          input.items.map(item => item.productId),
        ),
      );
    const lines = input.items.map(item => {
      const product = products.find(product => product.id === item.productId);
      if (
        !product ||
        !Number.isSafeInteger(product.inPersonPrice) ||
        (product.inPersonPrice ?? 0) <= 0
      )
        throw new HTTPException(400, {
          message: 'Valid In-Person Price required for every item',
        });
      return {
        ...item,
        name: product.name,
        unitAmountCents: product.inPersonPrice!,
      };
    });
    const snapshot = snapshotSchema.parse({
      lines,
      totalCents: lines.reduce(
        (sum, line) => sum + line.quantity * line.unitAmountCents,
        0,
      ),
      currency: 'USD',
    });
    await db
      .insert(inPersonSales)
      .values({
        id: crypto.randomUUID(),
        requestKey: input.requestKey,
        sellerId,
        request,
        snapshot: JSON.stringify(snapshot),
        merchantId: config.SQUARE_MERCHANT_ID,
        locationId: config.SQUARE_LOCATION_ID,
        environment: config.SQUARE_ENVIRONMENT,
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
    [sale] = await db
      .select()
      .from(inPersonSales)
      .where(eq(inPersonSales.requestKey, input.requestKey));
  }
  if (!sale || sale.sellerId !== sellerId || sale.request !== request)
    throw new HTTPException(409, {
      message: 'Sale key already bound to different input',
    });
  if (
    sale.merchantId !== config.SQUARE_MERCHANT_ID ||
    sale.locationId !== config.SQUARE_LOCATION_ID ||
    sale.environment !== config.SQUARE_ENVIRONMENT
  )
    throw new HTTPException(409, {
      message: 'Sale seller configuration changed',
    });
  if (sale.paymentUrl || sale.state !== 'pending') return saleResponse(sale);
  await provider.validateLocation();
  const snapshot = snapshotSchema.parse(JSON.parse(sale.snapshot));
  const link = await provider.createPaymentLink({
    idempotency_key: sale.id,
    order: {
      location_id: sale.locationId,
      reference_id: `qr:${sale.id}`,
      line_items: snapshot.lines.map(line => ({
        name: line.name,
        quantity: String(line.quantity),
        base_price_money: { amount: line.unitAmountCents, currency: 'USD' },
      })),
    },
    checkout_options: {
      allow_tipping: false,
      enable_coupon: false,
      enable_loyalty: false,
    },
  });
  const order = await provider.retrieveOrder(link.order_id);
  if (
    order.reference_id !== `qr:${sale.id}` ||
    order.location_id !== sale.locationId ||
    order.total_money.amount !== snapshot.totalCents ||
    order.total_money.currency !== 'USD'
  )
    throw new HTTPException(502, {
      message: 'Sale checkout association mismatch',
    });
  await db
    .update(inPersonSales)
    .set({
      squareOrderId: link.order_id,
      paymentLinkId: link.id,
      paymentUrl: link.url,
    })
    .where(
      and(eq(inPersonSales.id, sale.id), eq(inPersonSales.state, 'pending')),
    );
  return saleResponse(
    (
      await db.select().from(inPersonSales).where(eq(inPersonSales.id, sale.id))
    )[0],
  );
}
/** Only the shared verified-payment boundary invokes this; in-person intake never manufactures. */
export async function acceptInPersonPayment(
  db: Database,
  env: Environment,
  merchantId: string,
  payment: Awaited<
    ReturnType<ReturnType<typeof squareClient>['retrievePayment']>
  >,
  external: Awaited<
    ReturnType<ReturnType<typeof squareClient>['retrieveOrder']>
  >,
) {
  const config = squareConfig(env);
  const [sale] = await db
    .select()
    .from(inPersonSales)
    .where(eq(inPersonSales.id, external.reference_id.slice(3)));
  if (!sale)
    throw new HTTPException(400, { message: 'Unknown in-person sale' });
  const snapshot = snapshotSchema.parse(JSON.parse(sale.snapshot));
  if (
    sale.merchantId !== merchantId ||
    sale.environment !== config.SQUARE_ENVIRONMENT ||
    sale.locationId !== payment.location_id ||
    external.location_id !== sale.locationId ||
    (sale.squareOrderId && sale.squareOrderId !== payment.order_id) ||
    (sale.squarePaymentId && sale.squarePaymentId !== payment.id) ||
    [payment.amount_money, payment.total_money, external.total_money].some(
      money => money.currency !== 'USD' || money.amount !== snapshot.totalCents,
    )
  )
    throw new HTTPException(400, {
      message: 'Sale payment association mismatch',
    });
  if (payment.status !== 'COMPLETED') {
    if (['FAILED', 'CANCELED'].includes(payment.status))
      await db
        .update(inPersonSales)
        .set({ state: payment.status === 'FAILED' ? 'failed' : 'cancelled' })
        .where(
          and(eq(inPersonSales.id, sale.id), ne(inPersonSales.state, 'paid')),
        );
    return { received: true };
  }
  await db
    .insert(ordersTable)
    .values({
      orderNumber: `QR-${sale.id}`,
      checkoutAttemptId: sale.id,
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
      source: 'qr',
      fulfillmentType: 'in_person',
      paymentStatus: 'paid',
      status: 'handed_over',
      fulfillmentState: 'handed_over',
      totalAmountCents: snapshot.totalCents,
      shippingAmountCents: 0,
      currency: 'USD',
      itemSnapshot: JSON.stringify(snapshot.lines),
    })
    .onConflictDoNothing();
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.checkoutAttemptId, sale.id));
  if (!order || order.squarePaymentId !== payment.id)
    throw new HTTPException(409, { message: 'Payment already associated' });
  await db
    .update(inPersonSales)
    .set({
      state: 'paid',
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
    })
    .where(eq(inPersonSales.id, sale.id));
  await db
    .insert(orderEventsTable)
    .values({
      orderId: order.id,
      type: 'square_payment_verified',
      dedupeKey: `square-paid:${payment.id}`,
      source: 'square',
      actor: 'square',
      externalEventId: payment.id,
      previousStatus: 'pending',
      nextStatus: 'handed_over',
    })
    .onConflictDoNothing();
  return { received: true };
}
