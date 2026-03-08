import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import { users } from '../db/schema';
import factory from '../factory';
import {
  buildOrderData,
  clearCart,
  fetchCartItems,
  normalizePhone,
  Slant3DApiError,
  submitOrderToSlant3D,
} from '../services/stripeWebhookFulfillment';
import type { PayPalOrderResponse } from '../types';
import { getPayPalAccessToken } from '../utils/payPalAccess';
import {
  decryptStoredProfileValue,
  getCipherKitSecretKey,
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

        // Handle Payment Intent succeeded (embedded checkout flow)
        if (event.type === 'payment_intent.succeeded') {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;

          // Extract metadata from payment intent
          const cartId = paymentIntent.metadata?.cartId;
          const userId = paymentIntent.metadata?.userId;
          const customerEmail = paymentIntent.metadata?.customerEmail;

          // If no cartId, this is a Payment Intent not created by our system
          if (!cartId) {
            return c.json({ received: true });
          }

          const db = c.var.db;
          const cartItems = await fetchCartItems(db, cartId);

          if (cartItems.length === 0) {
            console.error('No cart items found for cartId:', cartId);
            return c.json({ error: 'Cart not found' }, 404);
          }

          try {
            const passphrase = c.env.ENCRYPTION_PASSPHRASE;
            let userRow: typeof users.$inferSelect | undefined;

            console.log(
              'Attempting to load user profile. userId:',
              userId,
              'customerEmail:',
              customerEmail,
              'receiptEmail:',
              paymentIntent.receipt_email,
            );

            // Try to load user by userId first
            if (userId) {
              console.log('Looking up user by userId:', userId);
              const [found] = await db
                .select()
                .from(users)
                .where(eq(users.id, userId));
              userRow = found;
              if (userRow) {
                console.log('✓ User found by userId:', {
                  id: userRow.id,
                  email: userRow.email,
                });
              } else {
                console.warn('✗ User not found for userId:', userId);
              }
            }

            // If no user found by ID, try by email
            if (!userRow) {
              const emailToLookup =
                customerEmail || paymentIntent.receipt_email;
              if (emailToLookup) {
                console.log('Looking up user by email:', emailToLookup);
                const [found] = await db
                  .select()
                  .from(users)
                  .where(eq(users.email, emailToLookup));
                userRow = found;
                if (userRow) {
                  console.log('✓ User found by email:', {
                    id: userRow.id,
                    email: userRow.email,
                  });
                } else {
                  console.warn('✗ User not found for email:', emailToLookup);
                }
              } else {
                console.warn('✗ No email available for user lookup');
              }
            }

            // Initialize defaults
            let firstName = 'Guest';
            let lastName = '';
            let shippingAddress = 'Address Required';
            let city = 'City';
            let state = 'CA';
            let zipCode = '00000';
            let phone = '0000000000';
            let email =
              customerEmail ||
              paymentIntent.receipt_email ||
              'guest@example.com';

            // Decrypt and load user profile if found
            if (userRow) {
              email = userRow.email;

              try {
                const secretKey = await getCipherKitSecretKey(passphrase);

                firstName =
                  (await decryptStoredProfileValue(
                    userRow.firstName,
                    secretKey,
                  )) || firstName;
                lastName =
                  (await decryptStoredProfileValue(
                    userRow.lastName,
                    secretKey,
                  )) || lastName;
                shippingAddress =
                  (await decryptStoredProfileValue(
                    userRow.shippingAddress,
                    secretKey,
                  )) || shippingAddress;
                city =
                  (await decryptStoredProfileValue(userRow.city, secretKey)) ||
                  city;
                state =
                  (await decryptStoredProfileValue(
                    userRow.state,
                    secretKey,
                  )) || state;
                zipCode =
                  (await decryptStoredProfileValue(
                    userRow.zipCode,
                    secretKey,
                  )) || zipCode;
                const decryptedPhone = await decryptStoredProfileValue(
                  userRow.phone,
                  secretKey,
                );
                phone = normalizePhone(decryptedPhone || phone);
              } catch (e) {
                console.error('Error decrypting user profile:', e);
                // Use defaults if decryption fails
              }
            }

            const orderDataArray = buildOrderData(cartItems, {
              email,
              firstName,
              lastName,
              shippingAddress,
              city,
              state,
              zipCode,
              phone,
            });

            console.log('Creating Slant3D order with data:', orderDataArray);

            const { orderId } = await submitOrderToSlant3D(
              orderDataArray,
              c.env.SLANT_API,
            );
            await clearCart(db, cartId);

            return c.json({ success: true, orderId });
          } catch (error) {
            console.error('Error processing payment_intent.succeeded:', error);
            if (error instanceof Slant3DApiError) {
              return c.json({ error: 'Order creation failed' }, 502);
            }
            return c.json({ error: 'Order creation failed' }, 500);
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
          const cartItems = await fetchCartItems(db, cartId);

          if (cartItems.length === 0) {
            console.error('No cart items found for cartId:', cartId);
            return c.json({ error: 'Cart not found' }, 404);
          }

          // Get user information
          const [userRow] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId));

          if (!userRow) {
            console.error('User not found for userId:', userId);
            return c.json({ error: 'User not found' }, 404);
          }

          // Decrypt user information
          const passphrase = c.env.ENCRYPTION_PASSPHRASE;
          const secretKey = await getCipherKitSecretKey(passphrase);

          const orderDataArray = buildOrderData(cartItems, {
            email: userRow.email,
            firstName:
              (await decryptStoredProfileValue(
                userRow.firstName,
                secretKey,
              )) || '',
            lastName:
              (await decryptStoredProfileValue(userRow.lastName, secretKey)) ||
              '',
            shippingAddress:
              (await decryptStoredProfileValue(
                userRow.shippingAddress,
                secretKey,
              )) || '',
            city:
              (await decryptStoredProfileValue(userRow.city, secretKey)) || '',
            state:
              (await decryptStoredProfileValue(userRow.state, secretKey)) ||
              '',
            zipCode:
              (await decryptStoredProfileValue(userRow.zipCode, secretKey)) ||
              '',
            phone:
              (await decryptStoredProfileValue(userRow.phone, secretKey)) ||
              '',
          });

          console.log('Creating Slant3D order with data:', orderDataArray);

          try {
            const { orderId } = await submitOrderToSlant3D(
              orderDataArray,
              c.env.SLANT_API,
            );
            await clearCart(db, cartId);

            return c.json({ success: true, orderId });
          } catch (error) {
            console.error('Error creating Slant3D order:', error);
            if (error instanceof Slant3DApiError) {
              return c.json({ error: 'Order creation failed' }, 502);
            }
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
