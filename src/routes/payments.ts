import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import { BASE_URL } from '../constants';
import { cart, productsTable, users } from '../db/schema';
import factory from '../factory';
import type {
  CartItemWithProduct,
  PayPalOrderResponse,
  Slant3DOrderData,
  Slant3DOrderResponse,
} from '../types';
import { generateOrderNumber } from '../utils/generateOrderNumber';
import { getPayPalAccessToken } from '../utils/payPalAccess';
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

// ---------------------------------------------------------------------------
// Shared helpers for webhook order processing
// ---------------------------------------------------------------------------

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

function normalizePhone(value: string | null | undefined): string {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : '0000000000';
}

type OrderProfile = {
  email: string;
  firstName: string;
  lastName: string;
  shippingAddress: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
};

function buildOrderDataArray(
  cartItems: CartItemWithProduct[],
  profile: OrderProfile,
): Slant3DOrderData[] {
  const { email, firstName, lastName, shippingAddress, city, state, zipCode, phone } =
    profile;
  const fullName = `${firstName} ${lastName}`.trim() || email;

  return cartItems.map((item: CartItemWithProduct): Slant3DOrderData => {
    const stlPath = item.stl;
    const filenameCandidate = stlPath?.split('/').pop();
    const normalizedColor = normalizeColor(item.color);

    return {
      email,
      phone,
      name: fullName,
      orderNumber: generateOrderNumber(),
      filename: filenameCandidate,
      fileURL: stlPath,
      bill_to_street_1: shippingAddress,
      bill_to_street_2: '',
      bill_to_street_3: '',
      bill_to_city: city,
      bill_to_state: state,
      bill_to_zip: zipCode,
      bill_to_country_as_iso: 'US',
      bill_to_is_US_residential: 'true',
      ship_to_name: fullName,
      ship_to_street_1: shippingAddress,
      ship_to_street_2: '',
      ship_to_street_3: '',
      ship_to_city: city,
      ship_to_state: state,
      ship_to_zip: zipCode,
      ship_to_country_as_iso: 'US',
      ship_to_is_US_residential: 'true',
      order_item_name: item.productName,
      order_quantity: String(item.quantity),
      order_image_url: '',
      order_sku: item.skuNumber,
      order_item_color: normalizedColor,
      profile: item.filamentType,
    };
  });
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
        // Phase 1: Verify webhook signature
        const t0 = Date.now();
        const event = await stripe.webhooks.constructEventAsync(
          body,
          sig,
          c.env.STRIPE_WEBHOOK_SECRET,
        );
        console.log(
          `[webhook] signature verified in ${Date.now() - t0}ms, event: ${event.type}`,
        );

        // Handle Payment Intent succeeded (embedded checkout flow)
        if (event.type === 'payment_intent.succeeded') {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;

          // Extract metadata from payment intent
          const cartId = paymentIntent.metadata?.cartId;
          const userId = paymentIntent.metadata?.userId;
          const customerEmail = paymentIntent.metadata?.customerEmail;
          // If no cartId, this might be a Payment Intent not created by our system
          // Just acknowledge receipt and return
          if (!cartId) {
            return c.json({ received: true });
          }

          try {
            const db = c.var.db;

            // Phase 2: Cart lookup
            const t1 = Date.now();
            const cartItems = await db
              .select({
                id: cart.id,
                skuNumber: cart.skuNumber,
                quantity: cart.quantity,
                color: cart.color,
                filamentType: cart.filamentType,
                productName: productsTable.name,
                stl: productsTable.stl,
              })
              .from(cart)
              .leftJoin(
                productsTable,
                eq(cart.skuNumber, productsTable.skuNumber),
              )
              .where(eq(cart.cartId, cartId));
            console.log(`[webhook] cart lookup in ${Date.now() - t1}ms (${cartItems.length} items)`);

            if (cartItems.length === 0) {
              console.error('No cart items found for cartId:', cartId);
              return c.json({ error: 'Cart not found' }, 404);
            }

            // Phase 3: User lookup
            const t2 = Date.now();
            let userRow: typeof users.$inferSelect | undefined;

            if (userId) {
              const [found] = await db
                .select()
                .from(users)
                .where(eq(users.id, userId));
              userRow = found;
            }

            // If no user found by ID, try by email
            if (!userRow) {
              const emailToLookup =
                customerEmail || paymentIntent.receipt_email;
              if (emailToLookup) {
                const [found] = await db
                  .select()
                  .from(users)
                  .where(eq(users.email, emailToLookup));
                userRow = found;
              }
            }
            console.log(
              `[webhook] user lookup in ${Date.now() - t2}ms, found: ${!!userRow}`,
            );

            // Phase 4: Profile decryption (concurrent)
            const defaults = {
              firstName: 'Guest',
              lastName: '',
              shippingAddress: 'Address Required',
              city: 'City',
              state: 'CA',
              zipCode: '00000',
              phone: '0000000000',
              email:
                customerEmail ||
                paymentIntent.receipt_email ||
                'guest@example.com',
            };

            let profile = { ...defaults };

            if (userRow) {
              const t3 = Date.now();
              try {
                const decrypted = await decryptStoredShippingProfile(
                  userRow,
                  c.env.ENCRYPTION_PASSPHRASE,
                );
                console.log(`[webhook] profile decryption in ${Date.now() - t3}ms`);
                profile = {
                  email: userRow.email,
                  firstName: decrypted.firstName || defaults.firstName,
                  lastName: decrypted.lastName || defaults.lastName,
                  shippingAddress:
                    decrypted.shippingAddress || defaults.shippingAddress,
                  city: decrypted.city || defaults.city,
                  state: decrypted.state || defaults.state,
                  zipCode: decrypted.zipCode || defaults.zipCode,
                  phone: normalizePhone(decrypted.phone),
                };
              } catch (e) {
                console.error('[webhook] Error decrypting user profile:', e);
                // Use defaults if decryption fails
              }
            }

            // Phase 5: Build order data + call Slant3D
            const t4 = Date.now();
            const orderDataArray = buildOrderDataArray(
              cartItems as CartItemWithProduct[],
              profile,
            );

            // TODO: Change to ${BASE_URL}order when ready for production
            const response = await fetch(`${BASE_URL}order/estimate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'api-key': c.env.SLANT_API,
              },
              body: JSON.stringify(orderDataArray),
            });
            console.log(`[webhook] Slant3D API call in ${Date.now() - t4}ms, status: ${response.status}`);

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                'Slant3D order creation failed:',
                response.status,
                errorText,
              );
              console.error(
                'Failed order data:',
                JSON.stringify(orderDataArray, null, 2),
              );
              return c.json({ error: 'Order creation failed' }, 502);
            }

            const orderResponse =
              (await response.json()) as Slant3DOrderResponse;

            // Phase 6: Cart cleanup
            const t5 = Date.now();
            await db.delete(cart).where(eq(cart.cartId, cartId));
            console.log(`[webhook] cart cleanup in ${Date.now() - t5}ms`);

            console.log(
              `[webhook] payment_intent.succeeded total: ${Date.now() - t0}ms`,
            );
            return c.json({
              success: true,
              orderId: orderResponse.orderId || 'created',
            });
          } catch (error) {
            console.error('Error processing payment_intent.succeeded:', error);
            return c.json({ error: 'Order processing failed' }, 500);
          }
        }

        // Handle Checkout Session completed (redirect checkout flow)
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session;

          // Extract metadata from session (cartId, userId)
          const cartId = session.metadata?.cartId;
          const userId = session.metadata?.userId;

          if (!cartId || !userId) {
            console.error(
              'Missing metadata in Stripe session:',
              session.metadata,
            );
            return c.json({ error: 'Missing required metadata' }, 400);
          }

          const db = c.var.db;

          // Phase 2: Cart lookup
          const t1 = Date.now();
          const cartItems = await db
            .select({
              id: cart.id,
              skuNumber: cart.skuNumber,
              quantity: cart.quantity,
              color: cart.color,
              filamentType: cart.filamentType,
              productName: productsTable.name,
              stl: productsTable.stl,
            })
            .from(cart)
            .leftJoin(
              productsTable,
              eq(cart.skuNumber, productsTable.skuNumber),
            )
            .where(eq(cart.cartId, cartId));
          console.log(`[webhook] cart lookup in ${Date.now() - t1}ms (${cartItems.length} items)`);

          if (cartItems.length === 0) {
            console.error('No cart items found for cartId:', cartId);
            return c.json({ error: 'Cart not found' }, 404);
          }

          // Phase 3: User lookup
          const t2 = Date.now();
          const [userRow] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId));
          console.log(`[webhook] user lookup in ${Date.now() - t2}ms, found: ${!!userRow}`);

          if (!userRow) {
            console.error('User not found for userId:', userId);
            return c.json({ error: 'User not found' }, 404);
          }

          // Phase 4: Profile decryption (concurrent)
          const t3 = Date.now();
          const decrypted = await decryptStoredShippingProfile(
            userRow,
            c.env.ENCRYPTION_PASSPHRASE,
          );
          console.log(`[webhook] profile decryption in ${Date.now() - t3}ms`);

          const profile: OrderProfile = {
            email: userRow.email,
            firstName: decrypted.firstName || '',
            lastName: decrypted.lastName || '',
            shippingAddress: decrypted.shippingAddress || '',
            city: decrypted.city || '',
            state: decrypted.state || '',
            zipCode: decrypted.zipCode || '',
            phone: normalizePhone(decrypted.phone),
          };

          // Phase 5: Build order data + call Slant3D
          const t4 = Date.now();
          const orderDataArray = buildOrderDataArray(
            cartItems as CartItemWithProduct[],
            profile,
          );

          // TODO: Change to ${BASE_URL}order when ready for production
          try {
            const response = await fetch(`${BASE_URL}order/estimate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'api-key': c.env.SLANT_API,
              },
              body: JSON.stringify(orderDataArray),
            });
            console.log(`[webhook] Slant3D API call in ${Date.now() - t4}ms, status: ${response.status}`);

            if (!response.ok) {
              console.error(
                'Slant3D order creation failed:',
                response.status,
                await response.text(),
              );
              console.error(
                'Failed order data:',
                JSON.stringify(orderDataArray, null, 2),
              );
              return c.json({ error: 'Order creation failed' }, 502);
            }

            const orderResponse =
              (await response.json()) as Slant3DOrderResponse;

            // Phase 6: Cart cleanup
            const t5 = Date.now();
            await db.delete(cart).where(eq(cart.cartId, cartId));
            console.log(`[webhook] cart cleanup in ${Date.now() - t5}ms`);

            // TODO: Store order record in your database for tracking
            // TODO: Send confirmation email to customer

            console.log(
              `[webhook] checkout.session.completed total: ${Date.now() - t0}ms`,
            );
            return c.json({
              success: true,
              orderId: orderResponse.orderId || 'created',
            });
          } catch (error) {
            console.error('Error creating Slant3D order:', error);
            return c.json({ error: 'Order creation failed' }, 500);
          }
        }

        // Acknowledge receipt of event
        return c.json({ received: true });
      } catch (err) {
        console.error('Webhook signature verification failed:', err);
        return c.json({ error: 'Webhook signature verification failed' }, 400);
      }
    },
  );
export default paymentsRouter;
