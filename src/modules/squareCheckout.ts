import { acceptSquarePhoneSale } from './squarePhoneSales';
import { acceptInPersonPayment } from './inPersonSales';
import {
  and,
  eq,
  exists,
  notExists,
  notInArray,
  gt,
  isNull,
} from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  cart,
  productsTable,
  checkoutQuotes,
  checkoutAttempts,
  ordersTable,
  orderEventsTable,
  users,
  squarePhoneIntake,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { squareClient, squareConfig } from '../lib/square';
import { readCheckoutQuote, quoteSnapshotSchema } from './checkoutQuotes';
import { createPaidOrderFulfillment } from './paidOrderFulfillment';

type Database = WorkerEnv['Variables']['db'];
type Environment = WorkerEnv['Bindings'];
/** Reuses a persisted logical payment, rejecting cross-owner keys and changed quote inputs. */
export async function initiateSquareCheckout(
  db: Database,
  env: Environment,
  input: {
    cartId: string;
    quoteId: string;
    requestKey: string;
    ownerId: string;
  },
) {
  const config = squareConfig(env);
  const provider = squareClient(config);
  let [attempt] = await db
    .select()
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.requestKey, input.requestKey));
  if (
    attempt &&
    (attempt.ownerId !== input.ownerId ||
      attempt.cartId !== input.cartId ||
      attempt.quoteId !== input.quoteId)
  )
    throw new HTTPException(409, { message: 'Checkout key is already bound' });
  if (!attempt) {
    await provider.validateLocation();
    const [profileBefore] = await db
      .select()
      .from(users)
      .where(eq(users.id, input.ownerId));
    const quote = await readCheckoutQuote(
      db,
      env,
      input.cartId,
      input.ownerId,
      input.quoteId,
    );
    if (quote.status !== 'valid')
      throw new HTTPException(409, { message: 'Review a fresh quote' });
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.ownerId));
    if (!user) throw new HTTPException(404, { message: 'Customer not found' });
    const attemptId = crypto.randomUUID();
    if (!profileBefore)
      throw new HTTPException(404, { message: 'Customer not found' });
    const eligibility = and(
      eq(checkoutQuotes.id, input.quoteId),
      eq(checkoutQuotes.ownerId, input.ownerId),
      eq(checkoutQuotes.invalidated, false),
      isNull(checkoutQuotes.consumedAttemptId),
      gt(checkoutQuotes.expiresAt, Date.now()),
      exists(
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, input.ownerId),
              ...(
                [
                  'firstName',
                  'lastName',
                  'shippingAddress',
                  'city',
                  'state',
                  'zipCode',
                  'country',
                  'email',
                ] as const
              ).map(key => eq(users[key], profileBefore[key])),
            ),
          ),
      ),
      notExists(
        db
          .select({ id: cart.id })
          .from(cart)
          .where(
            and(
              eq(cart.cartId, input.cartId),
              notInArray(
                cart.id,
                quote.lines.map(line => line.cartItemId),
              ),
            ),
          ),
      ),
      ...quote.lines.map(line =>
        exists(
          db
            .select({ id: cart.id })
            .from(cart)
            .innerJoin(
              productsTable,
              eq(productsTable.skuNumber, cart.skuNumber),
            )
            .where(
              and(
                eq(cart.id, line.cartItemId),
                eq(cart.cartId, input.cartId),
                eq(cart.userId, input.ownerId),
                eq(cart.quantity, line.quantity),
                eq(cart.skuNumber, line.skuNumber),
                eq(productsTable.filamentType, line.filamentType),
                eq(cart.filamentId, line.filamentId),
                eq(cart.color, line.color),
                eq(cart.filamentType, line.filamentType),
                eq(productsTable.id, line.productId),
                eq(productsTable.price, line.unitAmountCents / 100),
                eq(productsTable.publicFileServiceId, line.publicFileServiceId),
                eq(productsTable.name, line.name),
              ),
            ),
        ),
      ),
    );
    // Conditional consumption and the composite FK insert run atomically; a lost eligibility race rolls back.
    try {
      await db.batch([
        db
          .update(checkoutQuotes)
          .set({ consumedAttemptId: attemptId })
          .where(eligibility),
        db.insert(checkoutAttempts).values({
          id: attemptId,
          ownerId: input.ownerId,
          cartId: input.cartId,
          quoteId: input.quoteId,
          requestKey: input.requestKey,
          snapshot: JSON.stringify(quoteSnapshotSchema.parse(quote)),
          customerEmail: user.email,
          merchantId: config.SQUARE_MERCHANT_ID,
          locationId: config.SQUARE_LOCATION_ID,
          createdAt: Date.now(),
        }),
      ]);
    } catch {
      // A concurrent identical request may have committed the same key. Resolve it below.
    }
    [attempt] = await db
      .select()
      .from(checkoutAttempts)
      .where(eq(checkoutAttempts.requestKey, input.requestKey));
    if (
      !attempt ||
      attempt.ownerId !== input.ownerId ||
      attempt.quoteId !== input.quoteId ||
      attempt.cartId !== input.cartId
    )
      throw new HTTPException(409, {
        message: 'Quote already consumed; reuse its checkout key',
      });
  }
  if (attempt.paymentUrl || attempt.state === 'paid') return attempt;
  if (
    attempt.merchantId !== config.SQUARE_MERCHANT_ID ||
    attempt.locationId !== config.SQUARE_LOCATION_ID
  )
    throw new HTTPException(409, {
      message: 'Checkout seller configuration changed',
    });
  const snapshot = quoteSnapshotSchema.parse(JSON.parse(attempt.snapshot));
  // Square replays the same idempotency key and payload even if a worker dies after acceptance.
  const link = await provider.createPaymentLink({
    idempotency_key: attempt.id,
    order: {
      location_id: attempt.locationId,
      reference_id: attempt.id,
      line_items: [
        ...snapshot.lines.map(line => ({
          name: line.name,
          quantity: String(line.quantity),
          base_price_money: { amount: line.unitAmountCents, currency: 'USD' },
        })),
        {
          name: 'Slant3D shipping',
          quantity: '1',
          base_price_money: { amount: snapshot.shippingCents, currency: 'USD' },
        },
      ],
    },
    checkout_options: {
      allow_tipping: false,
      enable_coupon: false,
      enable_loyalty: false,
    },
  });
  const order = await provider.retrieveOrder(link.order_id);
  if (
    order.reference_id !== attempt.id ||
    order.location_id !== attempt.locationId ||
    order.total_money.amount !== snapshot.totalCents ||
    order.total_money.currency !== 'USD'
  )
    throw new HTTPException(502, {
      message: 'Square checkout association mismatch',
    });
  await db
    .update(checkoutAttempts)
    .set({
      squareOrderId: link.order_id,
      paymentLinkId: link.id,
      paymentUrl: link.url,
    })
    .where(
      and(
        eq(checkoutAttempts.id, attempt.id),
        eq(checkoutAttempts.state, 'initiating'),
      ),
    );
  return (
    await db
      .select()
      .from(checkoutAttempts)
      .where(eq(checkoutAttempts.id, attempt.id))
  )[0];
}

/** Resolves signed event identity through Square and persists verified evidence before fulfillment. */
export async function acceptSquarePayment(
  db: Database,
  env: Environment,
  merchantId: string,
  paymentId: string,
) {
  const config = squareConfig(env);
  if (merchantId !== config.SQUARE_MERCHANT_ID)
    throw new HTTPException(400, { message: 'Seller mismatch' });
  const provider = squareClient(config);
  const payment = await provider.retrievePayment(paymentId);
  if (!['COMPLETED', 'FAILED', 'CANCELED'].includes(payment.status)) return { received: true };
  await provider.validateLocation();
  if (payment.status === 'COMPLETED' && payment.application_details?.square_product === 'SQUARE_POS' && payment.location_id === config.SQUARE_LOCATION_ID) {
    await db.insert(squarePhoneIntake).values({paymentId:payment.id,squareOrderId:payment.order_id,merchantId,locationId:payment.location_id,state:'pending',error:'awaiting_order_evidence',createdAt:Date.now()}).onConflictDoNothing();
  }
  const external = await provider.retrieveOrder(payment.order_id);
  if (external.reference_id.startsWith('qr:')) return acceptInPersonPayment(db, env, merchantId, payment, external);
  const [attempt] = await db
    .select()
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.id, external.reference_id));
  if (!attempt) return acceptSquarePhoneSale(db, env, payment, external);
  const snapshot = quoteSnapshotSchema.parse(JSON.parse(attempt.snapshot));
  if (
    attempt.merchantId !== merchantId ||
    attempt.locationId !== payment.location_id ||
    external.location_id !== attempt.locationId ||
    (attempt.squareOrderId && attempt.squareOrderId !== payment.order_id) ||
    payment.amount_money.amount !== snapshot.totalCents ||
    payment.amount_money.currency !== 'USD' ||
    payment.total_money.amount !== snapshot.totalCents ||
    payment.total_money.currency !== 'USD' ||
    external.total_money.amount !== snapshot.totalCents ||
    external.total_money.currency !== 'USD' ||
    (attempt.squarePaymentId && attempt.squarePaymentId !== payment.id)
  )
    throw new HTTPException(400, { message: 'Payment association mismatch' });
  if (payment.status !== 'COMPLETED') {
    await db.update(checkoutAttempts).set({ state: payment.status === 'CANCELED' ? 'cancelled' : 'failed' }).where(and(
      eq(checkoutAttempts.id, attempt.id), notInArray(checkoutAttempts.state, ['paid']),
    ));
    return { received: true };
  }
  await db
    .update(checkoutAttempts)
    .set({
      state: 'paid',
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
    })
    .where(
      and(
        eq(checkoutAttempts.id, attempt.id),
        notInArray(checkoutAttempts.state, ['paid']),
      ),
    );
  const [confirmed] = await db
    .select()
    .from(checkoutAttempts)
    .where(eq(checkoutAttempts.id, attempt.id));
  if (confirmed.squarePaymentId !== payment.id)
    throw new HTTPException(409, {
      message: 'Checkout already paid by another payment',
    });
  const address = snapshot.address;
  await db
    .insert(ordersTable)
    .values({
      userId: attempt.ownerId,
      orderNumber: `SQ-${attempt.id}`,
      cartId: attempt.cartId,
      checkoutAttemptId: attempt.id,
      squareOrderId: payment.order_id,
      squarePaymentId: payment.id,
      source: 'online',
      fulfillmentType: 'slant',
      paymentStatus: 'paid',
      status: 'paid',
      fulfillmentState: 'ready',
      fileURL: snapshot.lines[0].publicFileServiceId,
      shipToName: address.name,
      shipToStreet1: address.line1,
      shipToStreet2: address.line2,
      shipToCity: address.city,
      shipToState: address.state,
      shipToZip: address.zip,
      shipToCountryISO: address.country,
      totalAmountCents: snapshot.totalCents,
      shippingAmountCents: snapshot.shippingCents,
      currency: 'USD',
      customerEmail: attempt.customerEmail,
      itemSnapshot: JSON.stringify(snapshot.lines),
      customerSnapshot: JSON.stringify({
        email: attempt.customerEmail,
        shippingAddress: address,
      }),
    })
    .onConflictDoNothing();
  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.checkoutAttemptId, attempt.id));
  if (!order || order.squarePaymentId !== payment.id)
    throw new HTTPException(409, { message: 'Payment already associated' });
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
      nextStatus: 'paid',
    })
    .onConflictDoNothing();
  await createPaidOrderFulfillment({ db, env }).fulfillPaidOrder(order.id);
  return { received: true, orderId: order.id };
}
