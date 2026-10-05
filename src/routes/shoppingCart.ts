import shippingEstimate from './shippingEstimate';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { describeRoute } from 'hono-openapi';
import Stripe from 'stripe';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import {
  addCartItemSchema,
  cart,
  DEFAULT_PLA_BLACK_FILAMENT_ID,
  productsTable,
} from '../db/schema';
import factory from '../factory';
import {
  addCartLine,
  removeCartLine,
  setCartLineQuantity,
} from '../modules/cartMutations';
import { validateCartConfiguration } from '../modules/cartConfiguration';
import {
  assertCartIdentity,
  cartLines,
  claimCart,
  createCart,
} from '../modules/cartOwnership';
import {
  readinessErrorResponse,
  validateCartReadiness,
} from '../modules/catalogReadiness';
import {
  authMiddleware,
  optionalAuthMiddleware,
} from '../utils/authMiddleware';
import { cartAccessMiddleware } from '../utils/cartAccessMiddleware';
import { serializeError as serializeCartCreateError } from '../utils/serializeError';

// Schema for update cart item
const updateCartItemSchema = z.object({
  cartId: z.string().uuid(),
  itemId: z.number().int().positive(),
  quantity: z.number().int().min(0).max(69),
});

// Schema for remove cart item
const removeCartItemSchema = z.object({
  cartId: z.string().uuid(),
  itemId: z.number().int().positive(),
});

const cartIdParamSchema = z.object({
  cartId: z.string().uuid(),
});

const claimCartSchema = z.object({ expectedUserId: z.string().min(1) });
const createCartIdentitySchema = z.object({
  expectedUserId: z.string().min(1).nullable().optional(),
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

const paymentIntentRequestSchema = z.object({
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
});

type DescribeRouteConfig = Parameters<typeof describeRoute>[0];
type ResponseSchema = NonNullable<
  NonNullable<
    Extract<
      NonNullable<DescribeRouteConfig['responses']>[string],
      { content?: Record<string, { schema?: unknown }> }
    >['content']
  >[string]['schema']
>;
type RequestBodySchema = NonNullable<
  NonNullable<
    Extract<
      NonNullable<DescribeRouteConfig['requestBody']>,
      { content?: Record<string, { schema?: unknown }> }
    >['content']
  >[string]['schema']
>;
type OpenApiSchema = ResponseSchema & RequestBodySchema;

function openApiSchema(
  schema: z.ZodTypeAny,
  schemaType: 'input' | 'output' = 'output',
): OpenApiSchema {
  return createSchema(schema, {
    openapi: '3.1.0',
    schemaType,
  }).schema as unknown as OpenApiSchema;
}

/** Extracts the authenticated caller's user ID from Hono context, if present. */
function getCallerUserId(c: {
  get: (key: string) => unknown;
}): string | undefined {
  const payload = c.get('jwtPayload') as { id?: string } | undefined;
  return payload?.id ?? undefined;
}

function hasStripePriceId<T extends { stripePriceId?: string | null }>(
  item: T,
): item is T & { stripePriceId: string } {
  return (
    typeof item.stripePriceId === 'string' &&
    item.stripePriceId.trim().length > 0
  );
}

/** Documents the bearer capability without exposing it in URLs or response caches. */
function cartCapabilityParameter() {
  return {
    name: 'X-Cart-Token',
    in: 'header' as const,
    required: false,
    description:
      'Guest capability returned once by POST /cart/create. Required for unclaimed guest carts; ignored for account ownership. Send session cookies for owned carts.',
    schema: openApiSchema(z.string().uuid()),
  };
}

/** Describes non-enumerating ownership denial and mutation conflict responses. */
function cartAccessResponses() {
  const content = {
    'application/json': {
      schema: openApiSchema(z.object({ error: z.string() })),
    },
  };
  return {
    401: {
      description:
        'A verified account session and claimed cart are required for this operation.',
      content,
    },
    404: {
      description:
        'Cart or line not found, or caller lacks the owner session or guest capability.',
      content,
    },
    409: {
      description:
        'Cart changed concurrently. Reload using the current owner session before retrying.',
      content,
    },
  };
}

const shoppingCart = factory
  .createApp()
  .use('/cart/*', optionalAuthMiddleware, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  })
  .post(
    '/cart/:cartId/claim',
    describeRoute({
      description:
        'Claim an unowned guest cart for the verified Better Auth session. Requires X-Cart-Token and expectedUserId matching the verified session; this assertion cannot grant ownership. Claim atomically revokes the token. A repeat by the owning account is idempotent.',
      tags: ['Shopping Cart'],
      parameters: [
        {
          name: 'cartId',
          in: 'path',
          required: true,
          schema: openApiSchema(z.string().uuid()),
        },
        cartCapabilityParameter(),
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: openApiSchema(claimCartSchema, 'input'),
          },
        },
      },
      responses: {
        ...cartAccessResponses(),
        200: {
          description:
            'The verified account owns the cart, including an empty cart.',
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  message: z.literal('Cart claimed'),
                  ownerId: z.string(),
                }),
              ),
            },
          },
        },
      },
    }),
    authMiddleware,
    zValidator('param', cartIdParamSchema),
    zValidator('json', claimCartSchema),
    /** Verifies the caller's account expectation before consuming the guest capability. */
    async c => {
      try {
        const ownerId = c.var.userId;
        if (!ownerId) throw new HTTPException(401, { message: 'Unauthorized' });
        assertCartIdentity(ownerId, c.req.valid('json').expectedUserId);
        await claimCart(c.var.db, c.req.valid('param').cartId, {
          userId: c.var.userId,
          guestToken: c.req.header('X-Cart-Token'),
        });
        return c.json({ message: 'Cart claimed', ownerId });
      } catch (error) {
        if (error instanceof HTTPException)
          return c.json({ error: error.message }, error.status);
        throw error;
      }
    },
  )
  .route('/', shippingEstimate)

  .post(
    '/cart/create',
    describeRoute({
      description:
        'Persist an empty cart. A verified session creates an account-owned cart; anonymous creation returns a guestToken capability once. Client-supplied owner fields are ignored.',
      tags: ['Shopping Cart'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: openApiSchema(createCartIdentitySchema, 'input'),
          },
        },
      },
      responses: {
        ...cartAccessResponses(),
        201: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  cartId: z.string().uuid(),
                  guestToken: z.string().uuid().optional(),
                  ownerId: z.string().nullable(),
                  message: z.string(),
                }),
              ),
            },
          },
          description: 'Cart created successfully',
        },
      },
    }),
    /** Creates an empty cart only when the observed account still matches the session. */
    async c => {
      const requestStart = performance.now();
      try {
        const rawBody = await c.req.text();
        const parsed = createCartIdentitySchema.safeParse(
          rawBody ? JSON.parse(rawBody) : {},
        );
        if (!parsed.success)
          return c.json({ error: 'Invalid cart identity assertion' }, 400);
        if (parsed.data.expectedUserId !== undefined) {
          assertCartIdentity(c.var.userId, parsed.data.expectedUserId);
        }
        const { cartId, guestToken, ownerId } = await createCart(
          c.var.db,
          c.var.userId,
        );
        return c.json(
          {
            cartId,
            guestToken,
            ownerId,
            message: 'Cart created successfully',
          },
          201,
        );
      } catch (error) {
        if (error instanceof HTTPException)
          return c.json({ error: error.message }, error.status);
        if (error instanceof SyntaxError)
          return c.json({ error: 'Invalid JSON body' }, 400);
        console.error({
          event: 'cart.create.failed',
          route: 'POST /cart/create',
          origin: c.req.header('Origin') ?? null,
          rayId: c.req.header('CF-Ray') ?? null,
          elapsedMs: performance.now() - requestStart,
          authenticated: Boolean(c.var.userId),
          error: serializeCartCreateError(error),
        });
        return c.json({ error: 'Failed to create cart' }, 500);
      }
    },
  )
  .get(
    '/cart/:cartId',
    cartAccessMiddleware,
    describeRoute({
      description: 'Get shopping cart items',
      tags: ['Shopping Cart'],
      parameters: [
        {
          name: 'cartId',
          in: 'path',
          required: true,
          schema: openApiSchema(z.string().uuid()),
        },
        cartCapabilityParameter(),
      ],
      responses: {
        ...cartAccessResponses(),
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  items: z.array(
                    z.object({
                      id: z.number(),
                      productId: z.string(),
                      quantity: z.number(),
                      color: z.string().nullable(),
                      filamentType: z.string(),
                      filamentId: z.string().uuid(),
                      name: z.string().nullable(),
                      price: z.number().nullable(),
                      stripePriceId: z.string().nullable(),
                    }),
                  ),
                  total: z.number(),
                }),
              ),
            },
          },
          description: 'Cart items retrieved successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Cart not found or caller lacks access',
        },
      },
    }),
    async c => {
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
            filamentId: cart.filamentId,
            name: productsTable.name,
            price: productsTable.price,
            stripePriceId: productsTable.stripePriceId,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(cartLines(c.var.cartAccess));

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
            filamentId: item.filamentId ?? DEFAULT_PLA_BLACK_FILAMENT_ID,
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
      parameters: [cartCapabilityParameter()],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: openApiSchema(addCartItemSchema, 'input'),
          },
        },
      },
      responses: {
        ...cartAccessResponses(),
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  message: z.string(),
                }),
              ),
            },
          },
          description: 'Item added successfully',
        },
        500: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Failed to add item',
        },
      },
    }),
    zValidator('json', addCartItemSchema),
    cartAccessMiddleware,
    /** Validates the selection and commits a capability-scoped atomic addition. */
    async c => {
      try {
        const selection = c.req.valid('json');
        await validateCartConfiguration(c.var.db, c.env, selection);
        await addCartLine(c.var.db, c.var.cartAccess, selection);
        return c.json({ message: 'Item added to cart successfully' });
      } catch (error) {
        if (error instanceof HTTPException)
          return c.json({ error: error.message }, error.status);
        console.error('POST /cart/add failed:', error);
        return c.json({ error: 'Failed to add item to cart' }, 500);
      }
    },
  )
  .put(
    '/cart/update',
    describeRoute({
      description: 'Update cart item quantity',
      tags: ['Shopping Cart'],
      parameters: [cartCapabilityParameter()],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: openApiSchema(updateCartItemSchema, 'input'),
          },
        },
      },
      responses: {
        ...cartAccessResponses(),
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  message: z.string(),
                }),
              ),
            },
          },
          description: 'Cart item updated successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Invalid request',
        },
      },
    }),
    zValidator('json', updateCartItemSchema),
    cartAccessMiddleware,
    /** Applies only a validated quantity to a line in the authorized cart version. */
    async c => {
      const { itemId, quantity } = c.req.valid('json');
      try {
        await setCartLineQuantity(c.var.db, c.var.cartAccess, itemId, quantity);
        return c.json({
          message:
            quantity === 0
              ? 'Cart item removed successfully'
              : 'Cart item updated successfully',
        });
      } catch (error) {
        if (error instanceof HTTPException)
          return c.json({ error: error.message }, error.status);
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
      parameters: [cartCapabilityParameter()],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: openApiSchema(removeCartItemSchema, 'input'),
          },
        },
      },
      responses: {
        ...cartAccessResponses(),
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  message: z.string(),
                }),
              ),
            },
          },
          description: 'Item removed from cart successfully',
        },
        400: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Invalid request',
        },
      },
    }),
    zValidator('json', removeCartItemSchema),
    cartAccessMiddleware,
    /** Deletes a line only while its cart authorization remains current. */
    async c => {
      const { itemId } = c.req.valid('json');
      try {
        await removeCartLine(c.var.db, c.var.cartAccess, itemId);
        return c.json({ message: 'Item removed from cart successfully' });
      } catch (error) {
        if (error instanceof HTTPException)
          return c.json({ error: error.message }, error.status);
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
          schema: openApiSchema(z.string().uuid()),
          description: 'Cart identifier',
        },
      ],
      responses: {
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  line_items: z.array(
                    z.object({
                      price: z.string(),
                      quantity: z.number(),
                    }),
                  ),
                }),
              ),
            },
          },
          description: 'Stripe line items retrieved successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Cart not found or no Stripe price IDs available',
        },
      },
    }),
    zValidator('param', cartIdParamSchema),
    cartAccessMiddleware,
    async c => {
      try {
        // Join cart with products to get Stripe price IDs
        const items = await c.var.db
          .select({
            stripePriceId: productsTable.stripePriceId,
            quantity: cart.quantity,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(cartLines(c.var.cartAccess));

        // Filter items that have Stripe price IDs
        const stripeItems = items.filter(hasStripePriceId).map(item => ({
          price: item.stripePriceId,
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
          schema: openApiSchema(z.string().uuid()),
          description: 'Cart identifier',
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: openApiSchema(createCheckoutSchema, 'input'),
          },
        },
        required: true,
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  url: z.string().url(),
                  id: z.string(),
                }),
              ),
            },
          },
          description: 'Checkout session created successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Cart not found or no Stripe price IDs available',
        },
        409: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                  items: z.array(
                    z.object({
                      cartItemId: z.number(),
                      skuNumber: z.string().nullable(),
                      reasons: z.array(z.string()),
                    }),
                  ),
                }),
              ),
            },
          },
          description: 'Cart contains items that are not checkout-ready',
        },
        500: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                  details: z.any().optional(),
                }),
              ),
            },
          },
          description: 'Failed to create Stripe checkout session',
        },
      },
    }),
    authMiddleware,
    zValidator('param', cartIdParamSchema),
    zValidator('json', createCheckoutSchema),
    cartAccessMiddleware,
    async c => {
      const cartId = c.req.param('cartId');
      const {
        successUrl,
        cancelUrl,
        customerEmail: bodyEmail,
        shippingAddress,
      } = c.req.valid('json');

      // Extract userId and customerEmail from the authenticated session
      const jwtPayload = c.get('jwtPayload') as
        | { id?: string; email?: string }
        | undefined;
      const userId = jwtPayload?.id ? String(jwtPayload.id) : undefined;
      const customerEmail = bodyEmail ?? jwtPayload?.email;

      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      try {
        const items = await c.var.db
          .select({
            cartItemId: cart.id,
            cartUserId: cart.userId,
            skuNumber: cart.skuNumber,
            filamentType: cart.filamentType,
            filamentId: cart.filamentId,
            productSkuNumber: productsTable.skuNumber,
            stripePriceId: productsTable.stripePriceId,
            publicFileServiceId: productsTable.publicFileServiceId,
            quantity: cart.quantity,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(cartLines(c.var.cartAccess));

        if (items.length === 0) {
          return c.json({ error: 'Cart is empty' }, 404);
        }

        if (items[0].cartUserId != null && items[0].cartUserId !== userId) {
          return c.json({ error: 'Forbidden' }, 403);
        }

        const readinessErrors = await validateCartReadiness(c.env, items);
        if (readinessErrors.length > 0) {
          return c.json(readinessErrorResponse(readinessErrors), 409);
        }

        const stripeLineItems = items.map(item => ({
          price: item.stripePriceId ?? '',
          quantity: item.quantity,
        }));

        const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
          telemetry: false,
        });

        const sessionParams: Stripe.Checkout.SessionCreateParams = {
          mode: 'payment',
          line_items: stripeLineItems,
          success_url: successUrl,
          cancel_url: cancelUrl,
          customer_email: customerEmail,
          metadata: {
            cartId,
            userId,
          },
        };

        // Add shipping address if provided
        if (shippingAddress) {
          sessionParams.shipping_address_collection = {
            allowed_countries: [
              shippingAddress.country as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry,
            ],
          };
          sessionParams.billing_address_collection = 'required';
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        if (!session.url) {
          return c.json({ error: 'Stripe checkout session missing URL' }, 500);
        }

        return c.json({ url: session.url, id: session.id });
      } catch (error: unknown) {
        console.error('Stripe checkout error:', error);
        return c.json(
          {
            error: 'Failed to create checkout session',
            details: error instanceof Error ? error.message : String(error),
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
          schema: openApiSchema(z.string().uuid()),
          description: 'Cart identifier',
        },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: openApiSchema(paymentIntentRequestSchema, 'input'),
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  clientSecret: z.string(),
                  amount: z.number(),
                  currency: z.string(),
                }),
              ),
            },
          },
          description: 'Payment Intent created successfully',
        },
        404: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                }),
              ),
            },
          },
          description: 'Cart not found or empty',
        },
        409: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                  items: z.array(
                    z.object({
                      cartItemId: z.number(),
                      skuNumber: z.string().nullable(),
                      reasons: z.array(z.string()),
                    }),
                  ),
                }),
              ),
            },
          },
          description: 'Cart contains items that are not checkout-ready',
        },
        500: {
          content: {
            'application/json': {
              schema: openApiSchema(
                z.object({
                  error: z.string(),
                  details: z.any().optional(),
                }),
              ),
            },
          },
          description: 'Failed to create Payment Intent',
        },
      },
    }),
    authMiddleware,
    zValidator('param', cartIdParamSchema),
    cartAccessMiddleware,
    async c => {
      const cartId = c.req.param('cartId');
      let body: z.infer<typeof paymentIntentRequestSchema> = {};
      try {
        const parsedBody = paymentIntentRequestSchema.safeParse(
          await c.req.json(),
        );
        body = parsedBody.success ? parsedBody.data : {};
      } catch {
        body = {};
      }
      let { customerEmail, shippingAddress } = body;

      // Always derive userId from the authenticated session — never trust a caller-supplied value.
      const userId = getCallerUserId(c);
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const jwtPayload = c.get('jwtPayload') as
        | { id?: string; email?: string }
        | undefined;
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
            cartItemId: cart.id,
            cartUserId: cart.userId,
            skuNumber: cart.skuNumber,
            filamentType: cart.filamentType,
            filamentId: cart.filamentId,
            productSkuNumber: productsTable.skuNumber,
            stripePriceId: productsTable.stripePriceId,
            publicFileServiceId: productsTable.publicFileServiceId,
            quantity: cart.quantity,
            price: productsTable.price,
            name: productsTable.name,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(cartLines(c.var.cartAccess));

        if (items.length === 0) {
          return c.json({ error: 'Cart is empty' }, 404);
        }

        // Enforce cart ownership: reject if the cart is owned by a different user.
        // Use != null (loose) to treat both null and undefined as "no owner".
        if (items[0].cartUserId != null && items[0].cartUserId !== userId) {
          return c.json({ error: 'Forbidden' }, 403);
        }

        const readinessErrors = await validateCartReadiness(c.env, items);
        if (readinessErrors.length > 0) {
          return c.json(readinessErrorResponse(readinessErrors), 409);
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
        if (!paymentIntent.client_secret) {
          return c.json(
            { error: 'Stripe Payment Intent missing client secret' },
            500,
          );
        }

        return c.json({
          clientSecret: paymentIntent.client_secret,
          amount: totalAmount,
          currency: 'usd',
        });
      } catch (error: unknown) {
        console.error('Payment Intent creation error:', error);
        return c.json(
          {
            error: 'Failed to create Payment Intent',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    },
  );
export default shoppingCart;
