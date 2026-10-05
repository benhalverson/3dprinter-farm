import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import factory from '../factory';
import { requireCartAccess } from '../modules/cartOwnership';

const cartRequest = z.object({ cartId: z.string().uuid() });

export const cartAccessMiddleware = factory.createMiddleware(
  async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.path === '/cart/create' || c.req.path.endsWith('/claim'))
      return next();
    const input =
      ['GET', 'HEAD'].includes(c.req.method) || c.req.param('cartId')
        ? { cartId: c.req.param('cartId') ?? c.req.query('cartId') }
        : await c.req.json().catch(() => null);
    const parsed = cartRequest.safeParse(input);
    if (!parsed.success)
      return c.json({ error: 'A valid cartId is required' }, 400);
    try {
      const access = await requireCartAccess(c.var.db, parsed.data.cartId, {
        userId: c.var.userId,
        guestToken: c.req.header('X-Cart-Token'),
      });
      if (
        (c.req.path === '/cart/shipping' ||
          /\/(checkout|payment-intent|stripe-items)$/.test(c.req.path)) &&
        (!c.var.userId || access.userId !== c.var.userId)
      ) {
        return c.json(
          { error: 'Sign in and claim the cart before checkout' },
          401,
        );
      }
      c.set('cartAccess', access);
    } catch (error) {
      if (error instanceof HTTPException)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
    return next();
  },
);
