import { and, eq, ne } from 'drizzle-orm';
import {
  squarePhoneIntake,
  squareCatalogMappings,
  ordersTable,
  orderEventsTable,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { squareClient, squareConfig } from '../lib/square';
type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
type Payment = Awaited<
  ReturnType<ReturnType<typeof squareClient>['retrievePayment']>
>;
type Order = Awaited<
  ReturnType<ReturnType<typeof squareClient>['retrieveOrder']>
>;
/** Imports only supported POS evidence after online/QR correlation has been checked. */
export async function acceptSquarePhoneSale(
  db: Database,
  env: Environment,
  payment: Payment,
  external: Order,
) {
  const config = squareConfig(env);
  if (
    payment.application_details?.square_product !== 'SQUARE_POS' ||
    payment.status !== 'COMPLETED'
  )
    return { received: true };
  if (
    payment.location_id !== config.SQUARE_LOCATION_ID ||
    external.location_id !== config.SQUARE_LOCATION_ID
  )
    return { received: true };
  await db
    .insert(squarePhoneIntake)
    .values({
      paymentId: payment.id,
      squareOrderId: external.id,
      merchantId: config.SQUARE_MERCHANT_ID,
      locationId: payment.location_id,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  const [receipt] = await db
    .select()
    .from(squarePhoneIntake)
    .where(eq(squarePhoneIntake.paymentId, payment.id));
  if (receipt.state === 'recorded') return { received: true };
  const unmatched = async (error: string) => {
    await db
      .update(squarePhoneIntake)
      .set({ state: 'unmatched', error })
      .where(
        and(
          eq(squarePhoneIntake.paymentId, payment.id),
          ne(squarePhoneIntake.state, 'recorded'),
        ),
      );
    return { received: true, intake: 'unmatched' };
  };
  if (external.reference_id) return unmatched('unrecognized_order_reference');
  if (
    [payment.amount_money, payment.total_money, external.total_money].some(
      money =>
        money.currency !== 'USD' ||
        money.amount !== external.total_money.amount,
    ) ||
    external.total_money.amount <= 0
  )
    return unmatched('payment_total_mismatch');
  if (!external.line_items?.length || external.line_items.length > 100)
    return unmatched('unsupported_line_items');
  const lines = [];
  for (const line of external.line_items) {
    const quantity = Number(line.quantity);
    if (
      !line.catalog_object_id ||
      !line.name ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !line.base_price_money ||
      !line.total_money ||
      line.base_price_money.currency !== 'USD' ||
      line.total_money.currency !== 'USD' ||
      line.base_price_money.amount < 0 ||
      line.total_money.amount < 0
    )
      return unmatched('unsupported_line_item');
    const [mapping] = await db
      .select()
      .from(squareCatalogMappings)
      .where(
        and(
          eq(squareCatalogMappings.variationId, line.catalog_object_id),
          eq(squareCatalogMappings.merchantId, config.SQUARE_MERCHANT_ID),
          eq(squareCatalogMappings.locationId, config.SQUARE_LOCATION_ID),
          eq(squareCatalogMappings.environment, config.SQUARE_ENVIRONMENT),
        ),
      );
    if (!mapping?.productId) return unmatched('unknown_catalog_mapping');
    lines.push({
      productId: mapping.productId,
      name: line.name,
      quantity,
      unitAmountCents: line.base_price_money.amount,
      lineTotalCents: line.total_money.amount,
      squareVariationId: line.catalog_object_id,
    });
  }
  if (
    lines.reduce((sum, line) => sum + line.lineTotalCents, 0) !==
    external.total_money.amount
  )
    return unmatched('unsupported_order_adjustments');
  await db
    .insert(ordersTable)
    .values({
      orderNumber: `POS-${payment.id}`,
      squareOrderId: external.id,
      squarePaymentId: payment.id,
      source: 'phone',
      fulfillmentType: 'in_person',
      paymentStatus: 'paid',
      status: 'handed_over',
      fulfillmentState: 'handed_over',
      totalAmountCents: external.total_money.amount,
      shippingAmountCents: 0,
      currency: 'USD',
      itemSnapshot: JSON.stringify(lines),
    })
    .onConflictDoNothing();
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.squarePaymentId, payment.id));
  if (!order || order.source !== 'phone' || order.squareOrderId !== external.id)
    return unmatched('payment_already_associated');
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
  await db
    .update(squarePhoneIntake)
    .set({ state: 'recorded', error: null, orderId: order.id })
    .where(eq(squarePhoneIntake.paymentId, payment.id));
  return { received: true };
}
