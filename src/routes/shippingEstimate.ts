import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import {
  cart,
  DEFAULT_PLA_BLACK_FILAMENT_ID,
  productsTable,
  users,
} from '../db/schema';
import factory from '../factory';
import { cartLines } from '../modules/cartOwnership';
import {
  mapShippingAddress,
  requestShippingEstimate,
  shippingErrorSchema,
  shippingEstimateSchema,
  shippingProfileSchema,
  type ShippingDraft,
} from '../modules/shippingEstimate';
import { authMiddleware } from '../utils/authMiddleware';
import { cartAccessMiddleware } from '../utils/cartAccessMiddleware';
import { decryptStoredShippingProfile } from '../utils/profileCrypto';

const errorContent = {
  'application/json': { schema: resolver(shippingErrorSchema) },
};

/** Estimates an authenticated cart using its owner's saved, decrypted profile. */
const estimateShipping = factory.createHandlers(async c => {
  c.header('Cache-Control', 'no-store');
  try {
    const userId = c.var.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const [user] = await c.var.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return c.json({ error: 'User not found' }, 404);
    if (
      !c.env.ENCRYPTION_PASSPHRASE ||
      !c.env.SLANT_PLATFORM_ID ||
      !c.env.SLANT_API_V2
    ) {
      return c.json({ error: 'Shipping estimate is not configured' }, 500);
    }
    const profile = shippingProfileSchema.safeParse(
      await decryptStoredShippingProfile(user, c.env.ENCRYPTION_PASSPHRASE),
    );
    if (!profile.success) {
      return c.json(
        { error: 'Complete your shipping profile before estimating shipping' },
        400,
      );
    }
    const items = await c.var.db
      .select({
        cartUserId: cart.userId,
        publicFileServiceId: productsTable.publicFileServiceId,
        filamentId: cart.filamentId,
        quantity: cart.quantity,
      })
      .from(cart)
      .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
      .where(cartLines(c.var.cartAccess));
    if (items.length === 0)
      return c.json({ error: 'Cart empty or not found' }, 404);
    const printItems: ShippingDraft['items'] = [];
    for (const item of items) {
      if (item.cartUserId != null && item.cartUserId !== userId) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (!item.publicFileServiceId?.trim()) {
        return c.json(
          { error: 'Missing publicFileServiceId for cart item' },
          400,
        );
      }
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        return c.json({ error: 'Invalid cart item quantity' }, 400);
      }
      printItems.push({
        type: 'PRINT',
        publicFileServiceId: item.publicFileServiceId,
        // Preserve the existing legacy default; this is not checkout readiness.
        filamentId: item.filamentId?.trim() || DEFAULT_PLA_BLACK_FILAMENT_ID,
        quantity: item.quantity,
      });
    }
    try {
      const estimate = await requestShippingEstimate(
        {
          platformId: c.env.SLANT_PLATFORM_ID,
          ownerId: userId,
          customer: {
            details: {
              email: profile.data.email,
              address: mapShippingAddress(profile.data),
            },
          },
          items: printItems,
        },
        c.env.SLANT_API_V2,
      );
      return c.json(estimate);
    } catch {
      return c.json({ error: 'Shipping provider estimate unavailable' }, 502);
    }
  } catch {
    return c.json({ error: 'Failed to retrieve shipping estimate' }, 500);
  }
});

const shippingRouter = factory.createApp();

/** Marks even early authentication denials as private and non-cacheable. */
const privateEstimate = factory.createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

export default shippingRouter.get(
  '/cart/shipping',
  privateEstimate,
  authMiddleware,
  cartAccessMiddleware,
  describeRoute({
    description:
      'Estimate shipping using the authenticated cart owner’s saved profile. GET /profile retrieves the address; POST /profile/:id updates it. No request body. Requires email, firstName, lastName, shippingAddress, city, state, zipCode, and a two-letter country code. Creates a provider draft estimate, not a purchase or persisted payable quote. Only documented V2 data.order.deliveryCost and data.totals.deliveryCost are accepted. The provider USD example uses major units; current-account currency assurance is still required before currency formatting or payment.',
    tags: ['Shopping Cart'],
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        name: 'cartId',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uuid' },
        description:
          'Cart claimed by the authenticated customer. Guest tokens alone are insufficient.',
      },
    ],
    responses: {
      200: {
        description:
          'Unconverted provider shipping estimate, not an address. Cache-Control: no-store.',
        content: {
          'application/json': {
            schema: resolver(shippingEstimateSchema),
          },
        },
      },
      400: {
        description:
          'Invalid cartId, incomplete profile, missing print file or invalid quantity.',
        content: errorContent,
      },
      401: {
        description:
          'Missing/invalid session or cart not claimed by the signed-in user.',
        content: errorContent,
      },
      403: {
        description: 'Cart contains lines belonging to another account.',
        content: errorContent,
      },
      404: {
        description: 'Profile/cart missing, inaccessible cart or empty cart.',
        content: errorContent,
      },
      500: {
        description:
          'Server configuration, profile decryption or database failure.',
        content: errorContent,
      },
      502: {
        description:
          'Provider rejection, transport failure, timeout, invalid JSON or invalid/ambiguous amount.',
        content: errorContent,
      },
    },
  }),
  ...estimateShipping,
);
