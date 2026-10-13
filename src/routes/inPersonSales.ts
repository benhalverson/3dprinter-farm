import { eq } from 'drizzle-orm';
import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { acceptSquarePayment } from '../modules/squareCheckout';
import { inPersonSales, squarePhoneIntake } from '../db/schema';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';
import {
  createInPersonSale,
  saleInputSchema,
  saleResponse,
} from '../modules/inPersonSales';
import { isSquareFailure } from '../lib/square';
const router = factory.createApp();
router.use(
  '/admin/in-person-sales/*',
  authMiddleware,
  requireCatalogMutationRole,
);
router.post(
  '/admin/in-person-sales',
  authMiddleware,
  requireCatalogMutationRole,
  zValidator('json', saleInputSchema),
  async c => {
    const sellerId = c.var.jwtPayload?.id;
    if (!sellerId) return c.json({ error: 'Unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    try {
      return c.json(
        await createInPersonSale(
          c.var.db,
          c.env,
          sellerId,
          c.req.valid('json'),
        ),
        201,
      );
    } catch (error) {
      if (isSquareFailure(error)) return c.json({ error: error.code }, 502);
      throw error;
    }
  },
);
router.get('/admin/in-person-sales/:id', async c => {
  const [sale] = await c.var.db
    .select()
    .from(inPersonSales)
    .where(eq(inPersonSales.id, c.req.param('id')));
  c.header('Cache-Control', 'no-store');
  return sale
    ? c.json(saleResponse(sale))
    : c.json({ error: 'Sale not found' }, 404);
});
router.use(
  '/admin/square-phone-intake/*',
  authMiddleware,
  requireCatalogMutationRole,
);
router.get('/admin/square-phone-intake/:paymentId', async c => {
  const [receipt] = await c.var.db
    .select()
    .from(squarePhoneIntake)
    .where(eq(squarePhoneIntake.paymentId, c.req.param('paymentId')));
  c.header('Cache-Control', 'no-store');
  return receipt ? c.json(receipt) : c.json({ error: 'Intake not found' }, 404);
});
router.post('/admin/square-phone-intake/:paymentId/reconcile', async c => {
  const [receipt] = await c.var.db
    .select()
    .from(squarePhoneIntake)
    .where(eq(squarePhoneIntake.paymentId, c.req.param('paymentId')));
  if (!receipt) return c.json({ error: 'Intake not found' }, 404);
  return c.json(
    await acceptSquarePayment(
      c.var.db,
      c.env,
      receipt.merchantId,
      receipt.paymentId,
    ),
  );
});
export default router;
