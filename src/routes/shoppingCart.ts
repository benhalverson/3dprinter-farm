import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import { BASE_URL } from '../constants';
import { addCartItemSchema, cart, productsTable, users } from '../db/schema';
import factory from '../factory';
import { authMiddleware, optionalAuthMiddleware } from '../utils/authMiddleware';
import { generateOrderNumber } from '../utils/generateOrderNumber';
import {
  decryptStoredShippingProfile,
} from '../utils/profileCrypto';

// Schema for update cart item
const updateCartItemSchema = z.object({
  cartId: z.string(),
  itemId: z.number(),
  quantity: z.number().min(0),
});

// Schema for remove cart item
const removeCartItemSchema = z.object({
  cartId: z.string(),
  itemId: z.number(),
});

const cartIdParamSchema = z.object({
  cartId: z.string().uuid(),
});

// Schema for creating a Stripe Checkout session
const createCheckoutSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
  shippingAddress: z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      address: z.string(),
      city: z.string(),
      state: z.string(),
      postalCode: z.string(),
      country: z
        .string()
        .length(2)
        .describe('ISO 3166-1 alpha-2 country code (e.g., US, CA)'),
    })
    .optional(),
});

/** Extracts the authenticated caller's user ID from Hono context, if present. */
function getCallerUserId(c: { get: (key: string) => unknown }): string | undefined {
  const payload = c.get('jwtPayload') as { id?: string } | undefined;
  return payload?.id ?? undefined;
}

const shoppingCart = factory
  .createApp()
  .get(
    '/cart/shipping',
    authMiddleware,
    describeRoute({
      description: 'Get the shipping address for the logged-in user',
      tags: ['Shopping Cart'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                address: z
                  .object({
                    firstName: z.string(),
                    lastName: z.string(),
                    shippingAddress: z.string(),
                    city: z.string(),
                    state: z.string(),
                    zipCode: z.string(),
                    country: z.string(),
                    phone: z.string(),
                  })
                  .nullable(),
              }),
            },
          },
          description: 'Shipping address retrieved successfully',
        },
        500: {
          content: {
            'application/json': {
              schema: z.object({ error: z.string() }),
            },
          },
          description: 'Failed to retrieve shipping address',
        },
      },
    }),
    async c => {
      try {
        const requestStart = performance.now();
        const jwtPayload = c.get('jwtPayload');
        const userId = jwtPayload?.id;
        if (!userId) return c.json({ error: 'Unauthorized' }, 401);

        // Expect cartId as query param to know which cart to estimate
        const cartId = c.req.query('cartId');
        if (!cartId)
          return c.json({ error: 'cartId query param required' }, 400);

        const [userRow] = await c.var.db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        if (!userRow) return c.json({ error: 'User not found' }, 404);

        const passphrase = c.env.ENCRYPTION_PASSPHRASE;
        if (!passphrase)
          return c.json({ error: 'Encryption passphrase missing' }, 500);
        const decryptStart = performance.now();
        const {
          email,
          firstName,
          lastName,
          shippingAddress,
          city,
          state,
          zipCode,
          phone: decryptedPhone,
        } = await decryptStoredShippingProfile(userRow, passphrase);
        const decryptMs = performance.now() - decryptStart;
        let phone = decryptedPhone;
        // Sanitize phone - keep digits and leading +, enforce <=20 chars
        phone = phone ? phone.replace(/[^+0-9]/g, '') : '';
        if (phone.length > 20) phone = phone.slice(0, 20);
        if (!phone) phone = '0000000000'; // fallback minimal placeholder if upstream requires

        // Pull cart contents and join products to enrich data.
        const cartQueryStart = performance.now();
        const cartItems = await c.var.db
          .select({
            id: cart.id,
            cartUserId: cart.userId,
            skuNumber: cart.skuNumber,
            quantity: cart.quantity,
            color: cart.color,
            filamentType: cart.filamentType,
            productName: productsTable.name,
            stl: productsTable.stl,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));
        const cartQueryMs = performance.now() - cartQueryStart;

        console.log('cartItems:', cartItems);

        if (cartItems.length === 0) {
          return c.json({ error: 'Cart empty or not found' }, 404);
        }

        // Enforce cart ownership: reject if the cart is owned by a different user.
        // Use != null (loose) to treat both null and undefined as "no owner".
        if (cartItems[0].cartUserId != null && cartItems[0].cartUserId !== userId) {
          return c.json({ error: 'Forbidden' }, 403);
        }

        // Build orderData array per API spec from each cart item.
        // Normalize colors to allowed enumeration expected by upstream API.
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
        const hexToNameMap: Record<string, string> = {
          '#000000': 'black',
          '#ffffff': 'white',
          '#fff': 'white',
          '#000': 'black',
          '#808080': 'gray',
          '#808081': 'gray',
          '#ff0000': 'red',
          '#ffff00': 'yellow',
          '#ffa500': 'orange',
          '#00ff00': 'green',
          '#008000': 'green',
          '#0000ff': 'blue',
          '#800080': 'purple',
          '#ffc0cb': 'pink',
          '#ffd700': 'gold',
        };
        const normalizeColor = (raw: string | null | undefined): string => {
          if (!raw) return 'black';
          const trimmed = raw.trim();
          // Already an allowed value (case sensitive match first)
          if (allowedColors.has(trimmed)) return trimmed;
          // Try case-insensitive simple colors
          const lower = trimmed.toLowerCase();
          for (const c of allowedColors) {
            if (c.toLowerCase() === lower) return c; // preserve canonical casing
          }
          // Attempt hex normalization
          let candidate = lower;
          if (
            !candidate.startsWith('#') &&
            /^([0-9a-f]{3}|[0-9a-f]{6})$/.test(candidate)
          ) {
            candidate = `#${candidate}`;
          }
          // Fix malformed 5-char like '#00000' by padding
          if (/^#[0-9a-f]{5}$/i.test(candidate)) candidate = `${candidate}0`;
          const mapped = hexToNameMap[candidate];
          if (mapped && allowedColors.has(mapped)) return mapped;
          // Map special marketing names ignoring case
          if (lower === 'matteblack') return 'matteBlack';
          if (lower === 'lunarregolith') return 'lunarRegolith';
          if (lower === 'petgblack' || lower === 'petg_black')
            return 'petgBlack';
          return 'black'; // safe fallback
        };

        const payloadBuildStart = performance.now();
        const orderDataArray = cartItems.map(cart => {
          // Derive filename: use product STL last path segment or fallback.
          const stlPath = cart.stl;
          const filenameCandidate = stlPath?.split('/').pop();
          const normalizedColor = normalizeColor(cart.color);
          if (normalizedColor !== cart.color) {
            console.log('Normalized color', {
              original: cart.color,
              normalized: normalizedColor,
            });
          }
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
            order_item_name: cart.productName,
            order_quantity: String(cart.quantity),
            order_image_url: '',
            order_sku: cart.skuNumber,
            order_item_color: normalizedColor,
            profile: cart.filamentType,
          };
        });
        const payloadBuildMs = performance.now() - payloadBuildStart;

        // API expects an array of orderData objects
        const upstreamStart = performance.now();
        const response = await fetch(`${BASE_URL}order/estimate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': c.env.SLANT_API,
          },
          body: JSON.stringify(orderDataArray),
        });
        const upstreamMs = performance.now() - upstreamStart;

        const totalMs = Number((performance.now() - requestStart).toFixed(2));
        const timings = {
          decryptMs: Number(decryptMs.toFixed(2)),
          cartQueryMs: Number(cartQueryMs.toFixed(2)),
          payloadBuildMs: Number(payloadBuildMs.toFixed(2)),
          upstreamMs: Number(upstreamMs.toFixed(2)),
          totalMs,
          cartItemCount: cartItems.length,
        };

        // Gate timing log on hot path to reduce overhead/log volume.
        const sampleEnv = (c.env as any)?.CART_SHIPPING_TIMING_SAMPLE_RATE;
        const sampleRate = typeof sampleEnv === 'string' ? Number(sampleEnv) : NaN;
        const isValidSampleRate =
          Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= 1;

        const SHOULD_LOG_SLOW_MS = 500; // Always log unusually slow requests.
        if (
          totalMs >= SHOULD_LOG_SLOW_MS ||
          (isValidSampleRate && Math.random() < sampleRate)
        ) {
          console.log('cart/shipping timing', timings);
        }
        if (!response.ok) {
          console.error(
            'Upstream estimate error:',
            response.status,
            await response.text(),
          );
          return c.json(
            { error: 'Upstream estimate failed', status: response.status },
            502,
          );
        }

        const data = (await response.json()) as ShippingResponse;
        return c.json({ shippingCost: data.shippingCost });
      } catch (err) {
        console.log('Error fetching shipping estimate:', err);
        return c.json(
          {
            error: 'Failed to retrieve shipping estimate',
            details: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    },
  )

  .post(
    '/cart/create',
    describeRoute({
      description: 'Create a new shopping cart',
      tags: ['Shopping Cart'],
      responses: {
        201: {
          content: {
            'application/json': {
              schema: z.object({
                cartId: z.string().uuid(),
                message: z.string(),
              }),
            },
          },
          description: 'Cart created successfully',
        },
      },
    }),
    async c => {
      try {
        const cartId = crypto.randomUUID();
        return c.json(
          {
            cartId,
            message: 'Cart created successfully',
          },
          201,
        );
      } catch (_error) {
        return c.json({ error: 'Failed to create cart' }, 500);
      }
    },
  )
  .get(
    '/cart/:cartId',
    describeRoute({
      description: 'Get shopping cart items',
      tags: ['Shopping Cart'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    productId: z.string(),
                    quantity: z.number(),
                    color: z.string(),
                    filamentType: z.string(),
                    name: z.string(),
                    price: z.number(),
                    stripePriceId: z.string().optional(),
                  }),
                ),
                total: z.number(),
              }),
            },
          },
          description: 'Cart items retrieved successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Cart not found',
        },
      },
    }),
    async c => {
      const cartId = c.req.param('cartId');

      try {
        // Join cart with products to get pricing, name, and Stripe information
        const items = await c.var.db
          .select({
            id: cart.id,
            cartId: cart.cartId,
            skuNumber: cart.skuNumber,
            quantity: cart.quantity,
            color: cart.color,
            filamentType: cart.filamentType,
            name: productsTable.name,
            price: productsTable.price,
            stripePriceId: productsTable.stripePriceId,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        const total = items.reduce(
          (sum, item) => sum + item.quantity * (item.price || 0),
          0,
        );

        return c.json({
          items: items.map(item => ({
            id: item.id,
            productId: item.skuNumber,
            quantity: item.quantity,
            color: item.color,
            filamentType: item.filamentType,
            name: item.name,
            price: item.price,
            stripePriceId: item.stripePriceId,
          })),
          total,
        });
      } catch (_error) {
        return c.json({ error: 'Failed to retrieve cart items' }, 500);
      }
    },
  )
  .post(
    '/cart/add',
    describeRoute({
      description: 'Add item to cart',
      tags: ['Shopping Cart'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: 'Item added successfully',
        },
        500: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Failed to add item',
        },
      },
    }),
    optionalAuthMiddleware,
    zValidator('json', addCartItemSchema),
    async c => {
      const { cartId, skuNumber, quantity, color, filamentType } =
        c.req.valid('json');

      // Bind the cart item to the authenticated user when a session is present.
      const userId: string | null = getCallerUserId(c) ?? null;

      try {
        const existing = await c.var.db.query.cart.findFirst({
          where: and(
            eq(cart.cartId, cartId),
            eq(cart.skuNumber, skuNumber),
            eq(cart.color, color),
            eq(cart.filamentType, filamentType),
          ),
        });

        if (existing) {
          // Enforce ownership: if the existing item has an owner, it must match the caller.
          // Use != null (loose) to treat both null and undefined as "no owner".
          if (existing.userId != null && userId !== null && existing.userId !== userId) {
            return c.json({ error: 'Forbidden' }, 403);
          }
          await c.var.db
            .update(cart)
            .set({
              quantity: existing.quantity + quantity,
            })
            .where(eq(cart.id, existing.id));
        } else {
          await c.var.db.insert(cart).values({
            cartId,
            userId,
            skuNumber: skuNumber,
            quantity,
            color,
            filamentType,
          });
        }

        return c.json({ message: 'Item added to cart successfully' });
      } catch (_error) {
        return c.json({ error: 'Failed to add item to cart' }, 500);
      }
    },
  )
  .put(
    '/cart/update',
    describeRoute({
      description: 'Update cart item quantity',
      tags: ['Shopping Cart'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: 'Cart item updated successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Invalid request',
        },
      },
    }),
    optionalAuthMiddleware,
    zValidator('json', updateCartItemSchema),
    async c => {
      const { cartId, itemId, quantity } = c.req.valid('json');

      try {
        // First, let's see what items exist in this cart
        const existingItems = await c.var.db.query.cart.findMany({
          where: eq(cart.cartId, cartId),
        });

        // Enforce ownership: if any item in the cart has an owner, require the caller to match.
        // Use != null (loose) to treat both null and undefined as "no owner".
        if (existingItems.length > 0 && existingItems[0].userId != null) {
          const callerId = getCallerUserId(c);
          if (!callerId) {
            return c.json({ error: 'Unauthorized' }, 401);
          }
          if (existingItems[0].userId !== callerId) {
            return c.json({ error: 'Forbidden' }, 403);
          }
        }

        if (quantity === 0) {
          const _deleteResult = await c.var.db
            .delete(cart)
            .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));
          return c.json({ message: 'Cart item removed successfully' });
        } else {
          const updateResult = await c.var.db
            .update(cart)
            .set({ quantity })
            .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));

          // Check if any rows were affected
          if (updateResult.changes === 0) {
            return c.json(
              {
                error: 'No cart item found with that ID',
                debug: {
                  itemId,
                  cartId,
                  existingItems,
                },
              },
              404,
            );
          }

          return c.json({ message: 'Cart item updated successfully' });
        }
      } catch (error) {
        console.error('Update error:', error);
        return c.json({ error: 'Failed to update cart item' }, 500);
      }
    },
  )
  .delete(
    '/cart/remove',
    describeRoute({
      description: 'Remove item from cart',
      tags: ['Shopping Cart'],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: 'Item removed from cart successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Invalid request',
        },
      },
    }),
    optionalAuthMiddleware,
    zValidator('json', removeCartItemSchema),
    async c => {
      const { cartId, itemId } = c.req.valid('json');

      try {
        // Verify ownership before deleting: reject if the cart is owned by a different user.
        // Use != null (loose) to treat both null and undefined as "no owner".
        const [existingItem] = await c.var.db
          .select({ userId: cart.userId })
          .from(cart)
          .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));

        if (existingItem?.userId != null) {
          const callerId = getCallerUserId(c);
          if (!callerId) {
            return c.json({ error: 'Unauthorized' }, 401);
          }
          if (existingItem.userId !== callerId) {
            return c.json({ error: 'Forbidden' }, 403);
          }
        }

        await c.var.db
          .delete(cart)
          .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));

        return c.json({ message: 'Item removed from cart successfully' });
      } catch (_error) {
        return c.json({ error: 'Failed to remove item from cart' }, 500);
      }
    },
  )
  .get(
    '/cart/:cartId/stripe-items',
    describeRoute({
      description: 'Get cart items formatted for Stripe checkout',
      tags: ['Shopping Cart', 'Stripe'],
      parameters: [
        {
          name: 'cartId',
          in: 'path',
          required: true,
          schema: z.string().uuid(),
          description: 'Cart identifier',
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                line_items: z.array(
                  z.object({
                    price: z.string(),
                    quantity: z.number(),
                  }),
                ),
              }),
            },
          },
          description: 'Stripe line items retrieved successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Cart not found or no Stripe price IDs available',
        },
      },
    }),
    zValidator('param', cartIdParamSchema),
    async c => {
      const cartId = c.req.param('cartId');

      try {
        // Join cart with products to get Stripe price IDs
        const items = await c.var.db
          .select({
            stripePriceId: productsTable.stripePriceId,
            quantity: cart.quantity,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        // Filter items that have Stripe price IDs
        const stripeItems = items
          .filter(item => item.stripePriceId)
          .map(item => ({
            price: item.stripePriceId!,
            quantity: item.quantity,
          }));

        if (stripeItems.length === 0) {
          return c.json({ error: 'No items with Stripe price IDs found' }, 404);
        }

        return c.json({ line_items: stripeItems });
      } catch (_error) {
        return c.json({ error: 'Failed to retrieve Stripe items' }, 500);
      }
    },
  )
  .post(
    '/cart/:cartId/checkout',
    describeRoute({
      description: 'Create a Stripe Checkout session for a cart',
      tags: ['Shopping Cart', 'Stripe'],
      parameters: [
        {
          name: 'cartId',
          in: 'path',
          required: true,
          schema: z.string().uuid(),
          description: 'Cart identifier',
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: createCheckoutSchema,
          },
        },
        required: true,
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                url: z.string().url(),
                id: z.string(),
              }),
            },
          },
          description: 'Checkout session created successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Cart not found or no Stripe price IDs available',
        },
        500: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
                details: z.any().optional(),
              }),
            },
          },
          description: 'Failed to create Stripe checkout session',
        },
      },
    }),
    zValidator('param', cartIdParamSchema),
    zValidator('json', createCheckoutSchema),
    async c => {
      const cartId = c.req.param('cartId');
      const { successUrl, cancelUrl, customerEmail, shippingAddress } =
        c.req.valid('json');

      try {
        const items = await c.var.db
          .select({
            stripePriceId: productsTable.stripePriceId,
            quantity: cart.quantity,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        const stripeLineItems = items
          .filter(item => item.stripePriceId)
          .map(item => ({
            price: item.stripePriceId!,
            quantity: item.quantity,
          }));

        if (stripeLineItems.length === 0) {
          return c.json({ error: 'No items with Stripe price IDs found' }, 404);
        }

        const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
          telemetry: false,
        });

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
          mode: 'payment',
          line_items: stripeLineItems,
          success_url: successUrl,
          cancel_url: cancelUrl,
          customer_email: customerEmail,
          metadata: { cartId },
        };

        // Add shipping address if provided
        if (shippingAddress) {
          sessionParams.shipping_address_collection = {
            allowed_countries: [shippingAddress.country],
          };
          sessionParams.billing_address_collection = 'required';
        }

        const session = await stripe.checkout.sessions.create(sessionParams);

        return c.json({ url: session.url!, id: session.id });
      } catch (error: any) {
        console.error('Stripe checkout error:', error);
        return c.json(
          {
            error: 'Failed to create checkout session',
            details: error?.message,
          },
          500,
        );
      }
    },
  )
  .post(
    '/cart/:cartId/payment-intent',
    describeRoute({
      description: 'Create a Stripe Payment Intent for embedded checkout',
      tags: ['Shopping Cart', 'Stripe'],
      parameters: [
        {
          name: 'cartId',
          in: 'path',
          required: true,
          schema: z.string().uuid(),
          description: 'Cart identifier',
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: z.object({
              userId: z.string().optional(),
              customerEmail: z.string().email().optional(),
              shippingAddress: z
                .object({
                  firstName: z.string(),
                  lastName: z.string(),
                  address: z.string(),
                  city: z.string(),
                  state: z.string(),
                  postalCode: z.string(),
                  country: z.string().length(2),
                })
                .optional(),
            }),
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({
                clientSecret: z.string(),
                amount: z.number(),
                currency: z.string(),
              }),
            },
          },
          description: 'Payment Intent created successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: 'Cart not found or empty',
        },
        500: {
          content: {
            'application/json': {
              schema: z.object({
                error: z.string(),
                details: z.any().optional(),
              }),
            },
          },
          description: 'Failed to create Payment Intent',
        },
      },
    }),
    authMiddleware,
    zValidator('param', cartIdParamSchema),
    async c => {
      const cartId = c.req.param('cartId');
      let body: any = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      let { customerEmail, shippingAddress } = body;

      // Always derive userId from the authenticated session — never trust a caller-supplied value.
      const userId = getCallerUserId(c);
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const jwtPayload = c.get('jwtPayload') as { id?: string; email?: string } | undefined;
      if (!customerEmail) {
        customerEmail = jwtPayload?.email;
      }

      console.log('POST /cart/:cartId/payment-intent called', {
        cartId,
        userId,
        customerEmail,
      });

      try {
        // Get cart items with prices; include userId for ownership verification.
        const items = await c.var.db
          .select({
            cartUserId: cart.userId,
            stripePriceId: productsTable.stripePriceId,
            quantity: cart.quantity,
            price: productsTable.price,
            name: productsTable.name,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        if (items.length === 0) {
          return c.json({ error: 'Cart is empty' }, 404);
        }

        // Enforce cart ownership: reject if the cart is owned by a different user.
        // Use != null (loose) to treat both null and undefined as "no owner".
        if (items[0].cartUserId != null && items[0].cartUserId !== userId) {
          return c.json({ error: 'Forbidden' }, 403);
        }

        // Calculate total amount (in cents)
        const totalAmount = items.reduce(
          (sum, item) => sum + (item.price || 0) * item.quantity,
          0,
        );

        if (totalAmount <= 0) {
          return c.json({ error: 'Cart total must be greater than zero' }, 400);
        }

        const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
          telemetry: false,
        });

        // Create Payment Intent
        const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
          amount: Math.round(totalAmount * 100), // Convert to cents
          currency: 'usd',
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: {
            cartId,
            ...(userId && { userId: String(userId) }),
            ...(customerEmail && { customerEmail }),
          },
          description: `Order for ${items.length} item(s)`,
        };

        // Add shipping if provided
        if (shippingAddress) {
          paymentIntentParams.shipping = {
            name: `${shippingAddress.firstName} ${shippingAddress.lastName}`,
            address: {
              line1: shippingAddress.address,
              city: shippingAddress.city,
              state: shippingAddress.state,
              postal_code: shippingAddress.postalCode,
              country: shippingAddress.country,
            },
          };
        }

        const paymentIntent =
          await stripe.paymentIntents.create(paymentIntentParams);

        return c.json({
          clientSecret: paymentIntent.client_secret!,
          amount: totalAmount,
          currency: 'usd',
        });
      } catch (error: any) {
        console.error('Payment Intent creation error:', error);
        return c.json(
          {
            error: 'Failed to create Payment Intent',
            details: error?.message,
          },
          500,
        );
      }
    },
  );
export default shoppingCart;

interface ShippingResponse {
  shippingCost: number;
  currencyCode: string;
}
