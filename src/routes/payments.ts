import type { WebApiKey } from 'cipher-kit';
import {
  decrypt as ckDecrypt,
  createSecretKey,
  isInWebApiEncryptionFormat,
} from 'cipher-kit/web-api';
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
import { decryptField } from '../utils/crypto';
import { generateOrderNumber } from '../utils/generateOrderNumber';
import { getPayPalAccessToken } from '../utils/payPalAccess';

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
          // If no cartId, this might be a Payment Intent not created by our system
          // Just acknowledge receipt and return
          if (!cartId) {
            return c.json({ received: true });
          }

          // Get cart items
          const db = c.var.db;
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

          if (cartItems.length === 0) {
            console.error('No cart items found for cartId:', cartId);
            return c.json({ error: 'Cart not found' }, 404);
          }

          const normalizePhone = (value: string) => {
            const digits = (value || '').replace(/\D/g, '');
            return digits.length >= 10 ? digits : '0000000000';
          };

          try {
            const passphrase = c.env.ENCRYPTION_PASSPHRASE;
            let userRow: typeof users.$inferSelect | undefined;

            console.log('Attempting to load user profile. userId:', userId, 'customerEmail:', customerEmail, 'receiptEmail:', paymentIntent.receipt_email);

            // Try to load user by userId first
            if (userId) {
              console.log('Looking up user by userId:', userId);
              const [found] = await db
                .select()
                .from(users)
                .where(eq(users.id, parseInt(userId, 10)));
              userRow = found;
              if (userRow) {
                console.log('✓ User found by userId:', { id: userRow.id, email: userRow.email });
              } else {
                console.warn('✗ User not found for userId:', userId);
              }
            }

            // If no user found by ID, try by email
            if (!userRow) {
              const emailToLookup = customerEmail || paymentIntent.receipt_email;
              if (emailToLookup) {
                console.log('Looking up user by email:', emailToLookup);
                const [found] = await db
                  .select()
                  .from(users)
                  .where(eq(users.email, emailToLookup));
                userRow = found;
                if (userRow) {
                  console.log('✓ User found by email:', { id: userRow.id, email: userRow.email });
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
            let email = customerEmail || paymentIntent.receipt_email || 'guest@example.com';

            // Decrypt and load user profile if found
            if (userRow) {
              email = userRow.email;

              // Setup cipher-kit decryption (same as /profile endpoint)
              const secretKeyCache: Map<string, WebApiKey> =
                (globalThis as any).__profileSecretKeyCache || new Map();
              (globalThis as any).__profileSecretKeyCache = secretKeyCache;

              const getSecretKey = async (pass: string): Promise<WebApiKey> => {
                if (secretKeyCache.has(pass)) return secretKeyCache.get(pass)!;
                const res = await createSecretKey(pass);
                if (!res.success)
                  throw new Error(
                    `cipher-kit key derivation failed: ${res.error.message}`,
                  );
                secretKeyCache.set(pass, res.secretKey);
                return res.secretKey;
              };

              const decryptValue = async (
                value: string | null,
                pass: string,
                secretKey: WebApiKey,
              ): Promise<string | null> => {
                if (value == null || value === '') return value;
                try {
                  // New format (cipher-kit: iv.encrypted.)
                  if (isInWebApiEncryptionFormat(value)) {
                    const dec = await ckDecrypt(value, secretKey);
                    if (!dec.success)
                      throw new Error(`cipher-kit decrypt error: ${dec.error.message}`);
                    return dec.result as string;
                  }
                  // Legacy format (salt:iv:cipher)
                  if (value.includes(':') && value.split(':').length === 3) {
                    return await decryptField(value, pass);
                  }
                  // Fallback
                  return await decryptField(value, pass);
                } catch (e) {
                  console.warn(
                    'Webhook decrypt error for value, returning empty string. Reason:',
                    e,
                  );
                  return '';
                }
              };

              try {
                const secretKey = await getSecretKey(passphrase);

                firstName =
                  (await decryptValue(userRow.firstName, passphrase, secretKey)) ||
                  firstName;
                lastName =
                  (await decryptValue(userRow.lastName, passphrase, secretKey)) ||
                  lastName;
                shippingAddress =
                  (await decryptValue(
                    userRow.shippingAddress,
                    passphrase,
                    secretKey,
                  )) || shippingAddress;
                city =
                  (await decryptValue(userRow.city, passphrase, secretKey)) || city;
                state =
                  (await decryptValue(userRow.state, passphrase, secretKey)) ||
                  state;
                zipCode =
                  (await decryptValue(userRow.zipCode, passphrase, secretKey)) ||
                  zipCode;
                const decryptedPhone = await decryptValue(
                  userRow.phone,
                  passphrase,
                  secretKey,
                );
                phone = normalizePhone(decryptedPhone || phone);

          
              } catch (e) {
                console.error('Error decrypting user profile:', e);
                // Use defaults if decryption fails
              }
            }

            // Normalize color function
            const allowedColors = new Set([
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

            const normalizeColor = (raw: string | null | undefined): string => {
              if (!raw) return 'black';
              const trimmed = raw.trim();
              if (allowedColors.has(trimmed)) return trimmed;
              const lower = trimmed.toLowerCase();
              for (const c of allowedColors) {
                if (c.toLowerCase() === lower) return c;
              }
              return 'black';
            };

            // Build Slant3D order data
            const orderDataArray: Slant3DOrderData[] = cartItems.map(
              (item: CartItemWithProduct): Slant3DOrderData => {
                const stlPath = item.stl;
                const filenameCandidate = stlPath?.split('/').pop();
                const normalizedColor = normalizeColor(item.color);

                return {
                  email,
                  phone,
                  name: `${firstName} ${lastName}`.trim() || email,
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
                  ship_to_name: `${firstName} ${lastName}`.trim() || email,
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
              },
            );

            console.log('Creating Slant3D order with data:', orderDataArray);

            // Create order with Slant3D (using /estimate for testing since V1 has no test API)
            // TODO: Change to ${BASE_URL}order when ready for production
            const response = await fetch(`${BASE_URL}order/estimate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'api-key': c.env.SLANT_API,
              },
              body: JSON.stringify(orderDataArray),
            });

            console.log('Slant3D estimate response status:', response.status);

            if (!response.ok) {
              const errorText = await response.text();
              console.error(
                'Slant3D order creation failed:',
                response.status,
                errorText,
              );
              // Store failed order for manual review/retry
              console.error('Failed order data:', JSON.stringify(orderDataArray, null, 2));
              return c.json({ error: 'Order creation failed' }, 502);
            }

            const orderResponse =
              (await response.json()) as Slant3DOrderResponse;
            console.log('Slant3D order created successfully:', orderResponse);

            // Clear the cart after successful order
            await db.delete(cart).where(eq(cart.cartId, cartId));
            console.log('Cart cleared for cartId:', cartId);

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

          // Get cart items and user information
          const db = c.var.db;
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

          if (cartItems.length === 0) {
            console.error('No cart items found for cartId:', cartId);
            return c.json({ error: 'Cart not found' }, 404);
          }

          // Get user information
          const [userRow] = await db
            .select()
            .from(users)
            .where(eq(users.id, parseInt(userId, 10)));

          if (!userRow) {
            console.error('User not found for userId:', userId);
            return c.json({ error: 'User not found' }, 404);
          }

          // Decrypt user information
          const passphrase = c.env.ENCRYPTION_PASSPHRASE;
          const email = userRow.email; // Email is not encrypted
          const firstName = await decryptField(userRow.firstName, passphrase);
          const lastName = await decryptField(userRow.lastName, passphrase);
          const shippingAddress = await decryptField(
            userRow.shippingAddress,
            passphrase,
          );
          const city = await decryptField(userRow.city, passphrase);
          const state = await decryptField(userRow.state, passphrase);
          const zipCode = await decryptField(userRow.zipCode, passphrase);
          const phone = await decryptField(userRow.phone, passphrase);

          // Create order data for Slant3D API (using the same logic from shipping endpoint)
          const allowedColors = new Set([
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

          const normalizeColor = (raw: string | null | undefined): string => {
            if (!raw) return 'black';
            const trimmed = raw.trim();
            if (allowedColors.has(trimmed)) return trimmed;
            const lower = trimmed.toLowerCase();
            for (const c of allowedColors) {
              if (c.toLowerCase() === lower) return c;
            }
            return 'black';
          };

          const orderDataArray: Slant3DOrderData[] = cartItems.map(
            (item: CartItemWithProduct): Slant3DOrderData => {
              const stlPath = item.stl;
              const filenameCandidate = stlPath?.split('/').pop();
              const normalizedColor = normalizeColor(item.color);

              return {
                email,
                phone,
                name: `${firstName} ${lastName}`.trim(),
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
                ship_to_name: `${firstName} ${lastName}`.trim(),
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
            },
          );

          console.log('Creating Slant3D order with data:', orderDataArray);

          // Create order with Slant3D (using /estimate for testing since V1 has no test API)
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

            if (!response.ok) {
              console.error(
                'Slant3D order creation failed:',
                response.status,
                await response.text(),
              );
              // Store failed order for manual review/retry
              console.error('Failed order data:', JSON.stringify(orderDataArray, null, 2));
              return c.json({ error: 'Order creation failed' }, 502);
            }

            const orderResponse =
              (await response.json()) as Slant3DOrderResponse;
            console.log('Slant3D order created successfully:', orderResponse);

            // Clear the cart after successful order
            await db.delete(cart).where(eq(cart.cartId, cartId));

            // TODO: Store order record in your database for tracking
            // TODO: Send confirmation email to customer

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
