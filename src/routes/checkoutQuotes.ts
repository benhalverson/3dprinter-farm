import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { validator } from 'hono-openapi/zod';
import { z } from 'zod';
import factory from '../factory';
import {
  createCheckoutQuote,
  quoteResponseSchema,
  readCheckoutQuote,
} from '../modules/checkoutQuotes';
import { authMiddleware } from '../utils/authMiddleware';

const router = factory.createApp();
/** Keep authentication failures and quote evidence out of shared caches. */
const privateQuote = factory.createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
router.use('/cart/:cartId/quotes', privateQuote, authMiddleware);
router.use('/cart/:cartId/quotes/:quoteId', privateQuote, authMiddleware);
const params = z.object({ cartId: z.string().uuid() });
const metadata = {
  tags: ['Checkout quotes'],
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description:
        'Immutable owned snapshot, integer USD cents, epoch milliseconds and current validity. A valid read is not payment authorization.',
      content: {
        'application/json': { schema: resolver(quoteResponseSchema) },
      },
    },
    400: {
      description: 'Invalid request or unavailable filament configuration',
    },
    401: { description: 'Sign in required' },
    404: { description: 'Owned cart or quote not found' },
    409: {
      description:
        'Cart, profile or Online Price requires correction or a fresh review',
    },
    502: { description: 'Shipping estimate failed' },
    503: { description: 'Configuration or filament verification unavailable' },
  },
};
router.post(
  '/cart/:cartId/quotes',
  describeRoute({
    ...metadata,
    description:
      'Create a 15-minute shipping-inclusive quote from the owned cart and saved profile. Empty JSON object only: caller totals, addresses and sales channels are rejected. Separate shipping uses the validated Slant3D USD draft estimate. No tax policy, payment, order or manufacture is created.',
  }),
  validator('param', params),
  validator('json', z.object({}).strict()),
  async c => {
    const userId = c.var.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(
      await createCheckoutQuote(
        c.var.db,
        c.env,
        c.req.valid('param').cartId,
        userId,
      ),
    );
  },
);
router.get(
  '/cart/:cartId/quotes/:quoteId',
  describeRoute({
    ...metadata,
    description:
      'Read immutable quote evidence and revalidate current cart/address/Online Price/filament availability. Stale observations permanently invalidate the quote. Provider failures fail closed. Square #178 must atomically bind and consume this quote after its own current-input validation; this endpoint cannot authorize payment.',
  }),
  validator('param', params.extend({ quoteId: z.string().uuid() })),
  async c => {
    const userId = c.var.userId;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const { cartId, quoteId } = c.req.valid('param');
    return c.json(
      await readCheckoutQuote(c.var.db, c.env, cartId, userId, quoteId),
    );
  },
);
export default router;
