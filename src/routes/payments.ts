import {attemptStatusSchema,readOwnedCheckoutAttempt} from '../modules/checkoutAttemptRead';
import { describeRoute } from 'hono-openapi';
import { validator, resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import factory from '../factory';
import { tryReconcileSquareNotifications } from '../lib/notifications';
import { verifySquareSignature, isSquareFailure } from '../lib/square';
import {
  acceptSquarePayment,
  initiateSquareCheckout,
} from '../modules/squareCheckout';
import { authMiddleware } from '../utils/authMiddleware';
import { cartAccessMiddleware } from '../utils/cartAccessMiddleware';

const router = factory.createApp();
router.use('/cart/:cartId/checkout', authMiddleware, cartAccessMiddleware);
const checkoutRequest = z
  .object({ quoteId: z.string().uuid(), requestKey: z.string().uuid() })
  .strict();
const checkoutResponse = z.object({
  attemptId: z.string(),
  quoteId: z.string(),
  state: z.string(),
  paymentUrl: z.string().nullable(),
  squareOrderId: z.string().nullable(),
});
router.post(
  '/cart/:cartId/checkout',
  describeRoute({
    tags: ['Square payments'],
    security: [{ cookieAuth: [] }],
    description:
      'Consume an owned valid immutable Online Price plus shipping quote. Reuse requestKey on timeout; changed inputs conflict. No client amount or channel is accepted.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['quoteId', 'requestKey'],
            additionalProperties: false,
            properties: {
              quoteId: { type: 'string', format: 'uuid' },
              requestKey: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'Durable checkout identity and hosted Square payment URL; pending is not paid.',
        content: { 'application/json': { schema: resolver(checkoutResponse) } },
      },
      400: { description: 'Invalid input' },
      401: { description: 'Sign in required' },
      404: { description: 'Owned quote not found' },
      409: { description: 'Stale quote or conflicting key' },
      502: { description: 'Provider outcome unknown; retry same key' },
      503: { description: 'Square not configured' },
    },
  }),
  validator('param', z.object({ cartId: z.string().uuid() })),
  validator('json', checkoutRequest),
  async c => {
    if (!c.var.userId) return c.json({ error: 'Unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    try {
      const attempt = await initiateSquareCheckout(c.var.db, c.env, {
        ...c.req.valid('json'),
        cartId: c.req.valid('param').cartId,
        ownerId: c.var.userId,
      });
      return c.json({
        attemptId: attempt.id,
        quoteId: attempt.quoteId,
        state: attempt.state,
        paymentUrl: attempt.paymentUrl,
        squareOrderId: attempt.squareOrderId,
      });
    } catch (error) {
      if (isSquareFailure(error))
        return c.json(
          { error: error.code },
          error.code === 'square_configuration_required' ? 503 : 502,
        );
      throw error;
    }
  },
);
for (const [path, key] of [
  ['/checkout-attempts/:attemptId', 'attemptId'],
  ['/checkout-attempts/by-request-key/:requestKey', 'requestKey'],
] as const) {
  router.get(path, authMiddleware, describeRoute({
    tags: ['Square payments'], security: [{ cookieAuth: [] }],
    description: 'Read an owned durable checkout outcome after timeout or reload, even after cart cleanup. Read-only: redirects never prove payment and this route never creates payments or manufacture. Unknown outcomes must retain the original request key.',
    responses: { 200: { description: 'Owned checkout state', content: { 'application/json': { schema: resolver(attemptStatusSchema) } } }, 401: { description: 'Sign in required' }, 404: { description: 'Owned attempt not found' } },
  }), async c => {
    c.header('Cache-Control', 'no-store');
    const value = c.req.param(key);
    if (!z.string().uuid().safeParse(value).success) return c.json({ error: 'Attempt not found' }, 404);
    const result=await readOwnedCheckoutAttempt(c.var.db,c.var.userId||'',key,value);
    return result ? c.json(result) : c.json({error:'Attempt not found'},404);
  });
}

router.post(
  '/webhook/square',
  describeRoute({
    tags: ['Square payments', 'Webhooks'],
    security: [],
    description:
      'Square payment.created/payment.updated ingress. HMAC-SHA256 uses exact raw body and configured fixed notification URL. Retrieved completed payment, merchant/location, order reference and exact USD totals authorize payment; redirects never do.',
    responses: {
      200: {
        description:
          'Event acknowledged; durable payment and fulfillment state retained separately',
      },
      400: { description: 'Malformed event or mismatched payment' },
      403: { description: 'Invalid raw-body signature' },
      502: { description: 'Provider unavailable; Square should redeliver' },
      503: { description: 'Webhook configuration required' },
    },
  }),
  /** Resolve only authenticated Square payment evidence before notification reconciliation. */
  async c => {
    const body = await c.req.text();
    if (body.length > 1024 * 1024)
      return c.json({ error: 'Event too large' }, 400);
    try {
      if (
        !(await verifySquareSignature(
          body,
          c.req.header('x-square-hmacsha256-signature'),
          c.env,
        ))
      )
        return c.json({ error: 'Invalid signature' }, 403);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return c.json({ error: 'Invalid event' }, 400);
      }
      const event = z
        .object({
          type: z.string(),
          merchant_id: z.string(),
          data: z.object({ id: z.string(), type: z.string() }),
        })
        .safeParse(value);
      if (!event.success) return c.json({ error: 'Invalid event' }, 400);
      if (
        !['payment.created', 'payment.updated'].includes(event.data.type) ||
        event.data.data.type !== 'payment'
      )
        return c.json({ received: true });
      const accepted = await acceptSquarePayment(
        c.var.db, c.env, event.data.merchant_id, event.data.data.id,
      );
      if ('orderId' in accepted && typeof accepted.orderId === 'number') {
        await tryReconcileSquareNotifications(c.var.db, c.env, accepted.orderId);
      }
      return c.json(accepted);
    } catch (error) {
      if (isSquareFailure(error))
        return c.json(
          { error: error.code },
          error.code === 'square_configuration_required' ? 503 : 502,
        );
      throw error;
    }
  },
);
export default router;
