import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import { BASE_URL, BASE_URL_V2 } from '../constants';
import { cart, productsTable, stripeFulfillmentTable, users } from '../db/schema';
import factory from '../factory';
import type { PayPalOrderResponse } from '../types';
import { generateOrderNumber } from '../utils/generateOrderNumber';
import { getPayPalAccessToken } from '../utils/payPalAccess';
import {
  decryptStoredShippingProfile,
} from '../utils/profileCrypto';

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

const DEFAULT_SLANT_FILAMENT_ID = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_COLORS = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'yellow',
  'red',
  'gold',
  'purple',
  'blue',
  'orange',
  'green',
  'pink',
  'matteBlack',
  'lunarRegolith',
  'petgBlack',
]);

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
  publicFileServiceId: string | null;
};

type ShippingProfile = Awaited<
  ReturnType<typeof decryptStoredShippingProfile>
>;

type StripeFulfillmentInput = {
  cartId: string;
  userId: string;
  stripeEventId: string;
  stripeObjectId: string;
  idempotencyKey: string;
  customerEmail?: string;
};

function normalizePhone(value: string) {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : '0000000000';
}

function normalizeColor(raw: string | null | undefined): string {
  if (!raw) return 'black';
  const trimmed = raw.trim();
  if (ALLOWED_COLORS.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const color of ALLOWED_COLORS) {
    if (color.toLowerCase() === lower) return color;
  }
  return 'black';
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function extractMetadata(
  event: Stripe.Event,
): StripeWebhookMetadata | undefined {
  if (event.type === 'checkout.session.completed') {
    return (event.data.object as Stripe.Checkout.Session).metadata;
  }
  if (event.type === 'payment_intent.succeeded') {
    return (event.data.object as Stripe.PaymentIntent).metadata;
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
      publicFileServiceId: productsTable.publicFileServiceId,
    })
    .from(cart)
    .leftJoin(
      productsTable,
      eq(cart.skuNumber, productsTable.skuNumber),
    )
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

function buildSlantDraftPayload(args: {
  c: Context;
  input: StripeFulfillmentInput;
  profile: ShippingProfile;
  items: CartFulfillmentItem[];
  orderNumber: string;
}) {
  const { c, input, profile, items, orderNumber } = args;
  const fullName = `${profile.firstName} ${profile.lastName}`.trim() || profile.email;

  return {
    orderNumber,
    platformId: c.env.SLANT_PLATFORM_ID,
    customer: {
      email: profile.email || input.customerEmail || 'guest@example.com',
      phone: normalizePhone(profile.phone || ''),
      name: fullName,
    },
    billingAddress: {
      street1: profile.shippingAddress,
      street2: '',
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      country: 'US',
      isResidential: true,
    },
    shippingAddress: {
      name: fullName,
      street1: profile.shippingAddress,
      street2: '',
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      country: 'US',
      isResidential: true,
    },
    items: items.map(item => ({
      name: item.productName,
      sku: item.skuNumber,
      quantity: item.quantity,
      publicFileServiceId: item.publicFileServiceId!,
      filamentId: item.filamentId || DEFAULT_SLANT_FILAMENT_ID,
      color: normalizeColor(item.color),
      profile: item.filamentType,
    })),
    metadata: {
      cartId: input.cartId,
      stripeEventId: input.stripeEventId,
      stripeObjectId: input.stripeObjectId,
      idempotencyKey: input.idempotencyKey,
    },
  };
}

function extractSlantOrderId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const response = payload as {
    publicOrderId?: string;
    orderId?: string;
    data?: {
      publicOrderId?: string;
      orderId?: string;
      id?: string;
    };
  };

  return (
    response.publicOrderId ||
    response.orderId ||
    response.data?.publicOrderId ||
    response.data?.orderId ||
    response.data?.id
  );
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
    '/paypal',
    describeRoute({
      description:
        'Create PayPal payment order. Legacy endpoint that creates a PayPal order with quantity-based pricing. Uses sandbox PayPal API.',
      tags: ['Payments', 'PayPal'],
      parameters: [
        {
          name: 'qty',
          in: 'query',
          required: false,
          schema: { type: 'string', default: '1' },
          description:
            'Quantity multiplier for pricing (qty * 10 = total price)',
        },
      ],
      responses: {
        200: {
          description: 'PayPal order created successfully',
          content: {
            'application/json': {
              example: {
                id: 'paypal_order_id',
                status: 'CREATED',
                links: [
                  {
                    href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/paypal_order_id',
                    rel: 'self',
                    method: 'GET',
                  },
                ],
              },
            },
          },
        },
      },
    }),
    async (c: Context) => {
      const qty = c.req.query('qty') || 1;
      const accessToken = await getPayPalAccessToken(c);

      const quantity = (+qty * 10).toFixed(2);

      const response = await fetch(
        'https://api-m.sandbox.paypal.com/v2/checkout/orders',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                amount: {
                  currency_code: 'USD',
                  value: quantity,
                },
              },
            ],
          }),
        },
      );

      const data = (await response.json()) as PayPalOrderResponse;
      return c.json(data);
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
          .where(eq(stripeFulfillmentTable.idempotencyKey, input.idempotencyKey));

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

        const orderNumber = generateOrderNumber();
        const draftPayload = buildSlantDraftPayload({
          c,
          input,
          profile: shippingProfile.profile!,
          items: cartLoad.items!,
          orderNumber,
        });

        const authHeaders = {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + c.env.SLANT_API_V2,
        };

        let publicOrderId: string | undefined;
        try {
          const draftResponse = await fetch(`${BASE_URL_V2}orders`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify(draftPayload),
          });

          if (!draftResponse.ok) {
            console.error('Slant3D order draft failed:', draftResponse.status);
            return c.json({ error: 'Order draft failed' }, 502);
          }

          const draftData = await draftResponse.json();
          publicOrderId = extractSlantOrderId(draftData);

          if (!publicOrderId) {
            console.error('Slant3D draft response missing public order id');
            return c.json({ error: 'Order draft failed' }, 502);
          }
        } catch (error) {
          console.error('Error drafting Slant3D order:', error);
          return c.json({ error: 'Order draft failed' }, 502);
        }

        try {
          const processResponse = await fetch(
            `${BASE_URL_V2}orders/${publicOrderId}`,
            {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({
                orderNumber,
                metadata: {
                  stripeEventId: input.stripeEventId,
                  stripeObjectId: input.stripeObjectId,
                  idempotencyKey: input.idempotencyKey,
                },
              }),
            },
          );

          if (!processResponse.ok) {
            console.error(
              'Slant3D order process failed:',
              processResponse.status,
            );
            return c.json({ error: 'Order process failed' }, 502);
          }
        } catch (error) {
          console.error('Error processing Slant3D order:', error);
          return c.json({ error: 'Order process failed' }, 502);
        }

        await c.var.db
          .insert(stripeFulfillmentTable)
          .values({
            idempotencyKey: input.idempotencyKey,
            stripeEventId: input.stripeEventId,
            stripeObjectId: input.stripeObjectId,
            cartId: input.cartId,
            status: 'processed',
            slantOrderId: publicOrderId,
          })
          .returning();

        await c.var.db.delete(cart).where(eq(cart.cartId, input.cartId));

        return c.json({
          success: true,
          orderId: publicOrderId,
        });
      } catch (err) {
        console.error('Webhook signature verification failed:', err);
        return c.json({ error: 'Webhook signature verification failed' }, 400);
      }
    },
  );
export default paymentsRouter;
