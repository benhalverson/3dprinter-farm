import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import {
  cart,
  productsTable,
  stripeFulfillmentTable,
  users,
} from '../db/schema';
import factory from '../factory';
import {
  sendAdminFailureAlert,
  sendOrderNotification,
} from '../modules/orderNotifications';
import {
  createPaidOrderFulfillment,
  type PaidOrderProfile,
} from '../modules/paidOrderFulfillment';
import { decryptStoredShippingProfile } from '../utils/profileCrypto';

// Schemas
const _stripeCheckoutSchema = z.object({
  cartId: z.string().uuid(),
});

const _stripeWebhookSchema = z.object({
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string(),
      metadata: z
        .object({
          cartId: z.string().uuid(),
          userId: z.string(),
        })
        .optional(),
    }),
  }),
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StripeWebhookMetadata = {
  cartId?: string;
  userId?: string;
  customerEmail?: string;
};

type CartFulfillmentItem = {
  id: number;
  skuNumber: string | null;
  quantity: number;
  color: string | null;
  filamentType: string | null;
  filamentId: string | null;
  productName: string | null;
  productImage: string | null;
  productPrice: number | null;
  stl: string | null;
  publicFileServiceId: string | null;
};

type StripeFulfillmentInput = {
  cartId: string;
  userId: string;
  stripeEventId: string;
  stripeObjectId: string;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  idempotencyKey: string;
  customerEmail?: string;
};

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function extractMetadata(
  event: Stripe.Event,
): StripeWebhookMetadata | undefined {
  if (event.type === 'checkout.session.completed') {
    return (event.data.object as Stripe.Checkout.Session).metadata ?? undefined;
  }
  if (event.type === 'payment_intent.succeeded') {
    return (event.data.object as Stripe.PaymentIntent).metadata ?? undefined;
  }
  return undefined;
}

function extractStripeFulfillmentInput(
  event: Stripe.Event,
): StripeFulfillmentInput | null {
  const metadata = extractMetadata(event);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (!metadata?.cartId || !metadata?.userId) {
      return null;
    }

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.id;

    return {
      cartId: metadata.cartId,
      userId: metadata.userId,
      stripeEventId: event.id,
      stripeObjectId: session.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      idempotencyKey: paymentIntentId,
      customerEmail: session.customer_details?.email ?? undefined,
    };
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    if (!metadata?.cartId || !metadata?.userId) {
      return null;
    }

    return {
      cartId: metadata.cartId,
      userId: metadata.userId,
      stripeEventId: event.id,
      stripeObjectId: paymentIntent.id,
      stripePaymentIntentId: paymentIntent.id,
      idempotencyKey: paymentIntent.id,
      customerEmail:
        metadata.customerEmail ?? paymentIntent.receipt_email ?? undefined,
    };
  }

  return null;
}

async function loadShippingProfile(c: Context, userId: string) {
  const [userRow] = await c.var.db
    .select()
    .from(users)
    .where(eq(users.id, userId));

  if (!userRow) {
    return { error: c.json({ error: 'User not found' }, 404) };
  }

  const passphrase = c.env.ENCRYPTION_PASSPHRASE;
  if (!passphrase) {
    return { error: c.json({ error: 'Server configuration error' }, 500) };
  }

  try {
    const profile = await decryptStoredShippingProfile(userRow, passphrase);
    return { profile };
  } catch (error) {
    console.error('Failed to decrypt user shipping profile:', error);
    return { error: c.json({ error: 'Failed to decrypt user profile' }, 500) };
  }
}

async function loadCartFulfillmentItems(c: Context, cartId: string) {
  const items = (await c.var.db
    .select({
      id: cart.id,
      skuNumber: cart.skuNumber,
      quantity: cart.quantity,
      color: cart.color,
      filamentType: cart.filamentType,
      filamentId: cart.filamentId,
      productName: productsTable.name,
      productImage: productsTable.image,
      productPrice: productsTable.price,
      stl: productsTable.stl,
      publicFileServiceId: productsTable.publicFileServiceId,
    })
    .from(cart)
    .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
    .where(eq(cart.cartId, cartId))) as CartFulfillmentItem[];

  if (items.length === 0) {
    return { error: c.json({ error: 'Cart not found' }, 404) };
  }

  const missingFile = items.find(item => !item.publicFileServiceId);
  if (missingFile) {
    return {
      error: c.json({ error: 'Missing publicFileServiceId' }, 400),
    };
  }

  const invalidFilament = items.find(
    item => item.filamentId && !isUuid(item.filamentId),
  );
  if (invalidFilament) {
    return { error: c.json({ error: 'Invalid filamentId' }, 400) };
  }

  return { items };
}

const paymentsRouter = factory
  .createApp()
  .get(
    '/success',
    describeRoute({
      description:
        'Stripe payment success callback page. Users are redirected here after successful payment. Can include session_id query parameter for verification.',
      tags: ['Payments', 'Stripe'],
      parameters: [
        {
          name: 'session_id',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Stripe checkout session ID for verification',
        },
      ],
      responses: {
        200: {
          description: 'Payment success confirmation',
          content: {
            'application/json': {
              example: {
                status: 'Success',
              },
            },
          },
        },
      },
    }),
    (c: Context) => {
      return c.json({ status: 'Success' });
    },
  )
  .get(
    '/cancel',
    describeRoute({
      description:
        'Stripe payment cancellation callback page. Users are redirected here when they cancel payment or payment fails.',
      tags: ['Payments', 'Stripe'],
      responses: {
        200: {
          description: 'Payment cancellation confirmation',
          content: {
            'application/json': {
              example: {
                status: 'Cancelled',
              },
            },
          },
        },
      },
    }),
    (c: Context) => {
      return c.json({ status: 'Cancelled' });
    },
  )
  .post(
    '/webhook/stripe',
    describeRoute({
      description:
        'Handle Stripe webhook events for payment confirmation. This endpoint processes checkout.session.completed events, creates orders with Slant3D API, and clears the cart. Must be configured in Stripe Dashboard with proper webhook secret.',
      tags: ['Payments', 'Stripe', 'Webhooks'],
      responses: {
        200: {
          description:
            'Webhook processed successfully - order created and cart cleared',
          content: {
            'application/json': {
              example: {
                success: true,
                orderId: 'slant3d_order_123',
              },
            },
          },
        },
        400: {
          description: 'Bad request - missing signature or invalid metadata',
          content: {
            'application/json': {
              example: {
                error: 'Missing stripe-signature header',
              },
            },
          },
        },
        404: {
          description: 'Cart or user not found',
          content: {
            'application/json': {
              example: {
                error: 'Cart not found',
              },
            },
          },
        },
        502: {
          description: 'Slant3D API error - order creation failed',
          content: {
            'application/json': {
              example: {
                error: 'Order creation failed',
              },
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
      const sig = c.req.header('stripe-signature');
      const body = await c.req.text();

      if (!sig) {
        return c.json({ error: 'Missing stripe-signature header' }, 400);
      }

      try {
        // Verify webhook signature using async method for Cloudflare Workers
        const event = await stripe.webhooks.constructEventAsync(
          body,
          sig,
          c.env.STRIPE_WEBHOOK_SECRET,
        );

        console.log('Received Stripe webhook event:', event.type);
        if (
          event.type !== 'checkout.session.completed' &&
          event.type !== 'payment_intent.succeeded'
        ) {
          return c.json({ received: true });
        }

        const input = extractStripeFulfillmentInput(event);
        if (!input) {
          if (event.type === 'payment_intent.succeeded') {
            return c.json({ received: true });
          }

          console.error('Missing required metadata:', extractMetadata(event));
          return c.json({ error: 'Missing required metadata' }, 400);
        }

        const [existingFulfillment] = await c.var.db
          .select()
          .from(stripeFulfillmentTable)
          .where(
            eq(stripeFulfillmentTable.idempotencyKey, input.idempotencyKey),
          );

        if (existingFulfillment?.status === 'processed') {
          return c.json({
            success: true,
            orderId: existingFulfillment.slantOrderId || 'processed',
          });
        }

        const cartLoad = await loadCartFulfillmentItems(c, input.cartId);
        if (cartLoad.error) {
          return cartLoad.error;
        }

        const shippingProfile = await loadShippingProfile(c, input.userId);
        if (shippingProfile.error) {
          return shippingProfile.error;
        }
        const items = cartLoad.items;
        const profile = shippingProfile.profile;
        if (!items || !profile) {
          return c.json({ error: 'Order processing failed' }, 500);
        }

        const fulfillment = createPaidOrderFulfillment({
          db: c.var.db,
          env: c.env,
        });
        let completed: Awaited<ReturnType<typeof fulfillment.fulfillPaidOrder>>;
        try {
          completed = await fulfillment.fulfillPaidOrder({
            fulfillment: input,
            profile: profile as PaidOrderProfile,
            items,
          });
        } catch (error) {
          const stage =
            error instanceof Error && 'stage' in error
              ? (error as { stage: 'draft' | 'process' }).stage
              : 'draft';
          const status =
            error instanceof Error && 'status' in error
              ? (error as { status?: number }).status
              : undefined;
          const message =
            error instanceof Error ? error.message : String(error);
          await sendAdminFailureAlert({
            db: c.var.db,
            env: c.env,
            source: 'stripe',
            statusTransition: `slant_${stage}_failed`,
            reason: `Slant3D order ${stage} failed after Stripe payment`,
            details: `Stripe event ${input.stripeEventId}, object ${input.stripeObjectId}${status ? `, HTTP ${status}` : ''}: ${message}`,
          });
          return c.json(
            {
              error:
                stage === 'draft'
                  ? 'Order draft failed'
                  : 'Order process failed',
            },
            502,
          );
        }

        await sendOrderNotification({
          db: c.var.db,
          env: c.env,
          order: {
            id: completed.localOrderId,
            orderNumber: completed.orderNumber,
            customerEmail: profile.email || input.customerEmail || null,
            status: 'processing',
            slantStatus: 'PROCESSING',
          },
          type: 'order_confirmation',
          source: 'stripe',
          statusTransition: 'paid_to_processing',
        });

        await c.var.db.insert(stripeFulfillmentTable).values({
          idempotencyKey: input.idempotencyKey,
          stripeEventId: input.stripeEventId,
          stripeObjectId: input.stripeObjectId,
          cartId: input.cartId,
          status: 'processed',
          slantOrderId: completed.publicOrderId,
        });

        await c.var.db.delete(cart).where(eq(cart.cartId, input.cartId));

        return c.json({
          success: true,
          orderId: completed.publicOrderId,
        });
      } catch (err) {
        console.error('Webhook signature verification failed:', err);
        return c.json({ error: 'Webhook signature verification failed' }, 400);
      }
    },
  );
export default paymentsRouter;
