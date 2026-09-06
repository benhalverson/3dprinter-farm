import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  cart,
  paymentFulfillmentTable,
  productsTable,
  users,
} from '../db/schema';
import factory from '../factory';
import {
  readinessErrorResponse,
  validateCartReadiness,
} from '../modules/catalogReadiness';
import {
  sendAdminFailureAlert,
  sendOrderNotification,
} from '../modules/orderNotifications';
import {
  createPaidOrderFulfillment,
  type PaidOrderProfile,
} from '../modules/paidOrderFulfillment';
import {
  createSquarePayment,
  type SquarePayment,
  verifySquareWebhook,
} from '../modules/squareClient';
import { authMiddleware } from '../utils/authMiddleware';
import { decryptStoredShippingProfile } from '../utils/profileCrypto';

const paymentSchema = z.object({
  sourceId: z.string().trim().min(1),
  idempotencyKey: z.string().uuid(),
  customerEmail: z.string().email().optional(),
});

const cartIdSchema = z.object({ cartId: z.string().uuid() });

const squarePayments = factory
  .createApp()
  .post(
    '/cart/:cartId/square-payment',
    authMiddleware,
    zValidator('param', cartIdSchema),
    zValidator('json', paymentSchema),
    async c => {
      const { cartId } = c.req.valid('param');
      const body = c.req.valid('json');
      const caller = c.get('jwtPayload') as
        | { id?: string; email?: string }
        | undefined;
      const userId = caller?.id;
      if (!userId) return c.json({ error: 'Unauthorized' }, 401);

      const [existing] = await c.var.db
        .select()
        .from(paymentFulfillmentTable)
        .where(eq(paymentFulfillmentTable.idempotencyKey, body.idempotencyKey));
      if (existing?.status === 'processed') {
        return c.json({
          success: true,
          paymentId: existing.providerPaymentId,
          orderId: existing.slantOrderId,
        });
      }

      const items = await c.var.db
        .select({
          cartItemId: cart.id,
          id: cart.id,
          cartUserId: cart.userId,
          skuNumber: cart.skuNumber,
          quantity: cart.quantity,
          color: cart.color,
          filamentType: cart.filamentType,
          filamentId: cart.filamentId,
          productSkuNumber: productsTable.skuNumber,
          publicFileServiceId: productsTable.publicFileServiceId,
          productName: productsTable.name,
          productImage: productsTable.image,
          productPrice: productsTable.price,
          price: productsTable.price,
          stl: productsTable.stl,
        })
        .from(cart)
        .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
        .where(eq(cart.cartId, cartId));
      if (items.length === 0) return c.json({ error: 'Cart is empty' }, 404);
      if (items.some(item => item.cartUserId && item.cartUserId !== userId)) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const readiness = await validateCartReadiness(c.env, items);
      if (readiness.length > 0) {
        return c.json(readinessErrorResponse(readiness), 409);
      }
      const amountCents = items.reduce(
        (sum, item) =>
          sum + Math.round((item.price ?? 0) * 100) * item.quantity,
        0,
      );
      if (amountCents <= 0)
        return c.json({ error: 'Cart total must be greater than zero' }, 400);

      let payment: SquarePayment;
      try {
        payment = await createSquarePayment(c.env, {
          ...body,
          cartId,
          amountCents,
          customerEmail: body.customerEmail ?? caller.email,
        });
      } catch (error) {
        console.error('Square payment failed:', error);
        return c.json({ error: 'Payment failed' }, 502);
      }
      if (
        payment.status !== 'COMPLETED' ||
        payment.amount_money.amount !== amountCents
      ) {
        return c.json({ error: 'Payment was not completed' }, 409);
      }

      if (!existing) {
        await c.var.db.insert(paymentFulfillmentTable).values({
          idempotencyKey: body.idempotencyKey,
          provider: 'square',
          providerPaymentId: payment.id,
          providerOrderId: payment.order_id ?? null,
          cartId,
          userId,
          status: 'paid',
        });
      }

      const [user] = await c.var.db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      if (!user) return c.json({ error: 'User not found' }, 404);
      let profile: PaidOrderProfile;
      try {
        profile = (await decryptStoredShippingProfile(
          user,
          c.env.ENCRYPTION_PASSPHRASE,
        )) as PaidOrderProfile;
      } catch (error) {
        console.error('Failed to load shipping profile:', error);
        return c.json({ error: 'Shipping profile is unavailable' }, 409);
      }

      const fulfillment = createPaidOrderFulfillment({
        db: c.var.db,
        env: c.env,
      });
      try {
        const completed = await fulfillment.fulfillPaidOrder({
          fulfillment: {
            cartId,
            userId,
            paymentProvider: 'square',
            providerEventId: `capture:${payment.id}`,
            providerOrderId: payment.order_id,
            providerPaymentId: payment.id,
            idempotencyKey: body.idempotencyKey,
            customerEmail: body.customerEmail ?? caller.email,
          },
          profile,
          items,
        });
        await c.var.db
          .update(paymentFulfillmentTable)
          .set({ status: 'processed', slantOrderId: completed.publicOrderId })
          .where(
            and(
              eq(paymentFulfillmentTable.idempotencyKey, body.idempotencyKey),
              eq(paymentFulfillmentTable.provider, 'square'),
            ),
          );
        await c.var.db.delete(cart).where(eq(cart.cartId, cartId));
        await sendOrderNotification({
          db: c.var.db,
          env: c.env,
          order: {
            id: completed.localOrderId,
            orderNumber: completed.orderNumber,
            customerEmail: profile.email,
            status: 'processing',
            slantStatus: 'PROCESSING',
          },
          type: 'order_confirmation',
          source: 'square',
          statusTransition: 'paid_to_processing',
        });
        return c.json({
          success: true,
          paymentId: payment.id,
          orderId: completed.publicOrderId,
        });
      } catch (error) {
        await sendAdminFailureAlert({
          db: c.var.db,
          env: c.env,
          source: 'square',
          statusTransition: 'slant_fulfillment_failed',
          reason: 'Slant3D fulfillment failed after Square payment',
          details: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          { error: 'Payment completed but fulfillment requires attention' },
          502,
        );
      }
    },
  )
  .post('/webhook/square', async c => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-square-hmacsha256-signature');
    if (!signature) return c.json({ error: 'Missing Square signature' }, 400);
    const valid = await verifySquareWebhook({
      rawBody,
      signature,
      notificationUrl: c.env.SQUARE_WEBHOOK_URL,
      signatureKey: c.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    });
    if (!valid) return c.json({ error: 'Invalid Square signature' }, 400);
    const event = z
      .object({ event_id: z.string(), type: z.string() })
      .passthrough()
      .safeParse(JSON.parse(rawBody));
    if (!event.success) return c.json({ error: 'Invalid Square event' }, 400);
    return c.json({ received: true, eventId: event.data.event_id });
  });

export default squarePayments;
