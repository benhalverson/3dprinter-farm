import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import { productsTable } from '../db/schema';
import factory from '../factory';
import { productPrices } from '../modules/catalogPublication';
import { evaluateCatalogReadiness } from '../modules/catalogReadiness';
import { productDraftIdSchema } from '../modules/productDraftContracts';
import {
  productMutationRequestSchema,
  productMutationResponseSchema,
  reconcileProductMutationSchema,
} from '../modules/productMutationContracts';
import {
  mutationResponse,
  ProductMutationError,
  readProductMutation,
  reconcileProductMutation,
  submitProductMutation,
} from '../modules/productMutations';

const router = factory.createApp();
const validationError = (
  result: { success: boolean },
  c: import('hono').Context<import('../factory').WorkerEnv>,
) => {
  if (!result.success) return c.json({ error: 'Invalid input' }, 400);
};
const responses = {
  200: {
    description:
      'Durable operation evidence; only succeeded confirms local completion',
    content: {
      'application/json': {
        schema: resolver(
          z.object({
            operation: productMutationResponseSchema.nullable(),
            product: z.unknown().nullable(),
            readiness: z.unknown().nullable(),
            storefrontVisible: z.boolean(),
          }),
        ),
      },
    },
  },
  400: { description: 'Invalid explicit action' },
  401: { description: 'Authentication required' },
  403: { description: 'Catalog administrator required' },
  404: { description: 'Owned draft or operation not found' },
  409: { description: 'Current preparation or reconciliation required' },
  503: { description: 'Unavailable; inspect saved operation before retry' },
};
/** Returns current catalog evidence independently of the saved conversation. */
async function result(
  c: import('hono').Context<import('../factory').WorkerEnv>,
  operation: Awaited<ReturnType<typeof readProductMutation>>,
) {
  const product =
    operation?.state === 'succeeded' &&
    operation.action !== 'delete' &&
    operation.productId
      ? await c.var.db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, operation.productId))
          .get()
      : undefined;
  const readiness = product
    ? (await evaluateCatalogReadiness(c.env, [product])).products[0]
    : null;
  return c.json({
    operation: operation ? mutationResponse(operation) : null,
    product: product ? productPrices(product) : null,
    readiness,
    storefrontVisible: Boolean(product),
  });
}
/** Exposes fixed application codes and keeps unknown persistence/provider details private. */
async function errors(
  c: import('hono').Context<import('../factory').WorkerEnv>,
  action: () => Promise<Response>,
) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProductMutationError)
      return c.json({ error: error.message }, error.status);
    return c.json({ error: 'product_operation_unavailable' }, 503);
  }
}
router.post(
  '/:id/submit',
  describeRoute({
    tags: ['Admin product drafts'],
    summary:
      'Explicitly create, save changes, or delete from the current prepared card',
    description:
      'Only this explicit action authorizes provider effects. Natural language, draft saves, restored cards and preparation never submit. Square success and primary image confirmation precede coherent local persistence. A duplicate returns durable evidence; use reconcile to recover.',
    responses,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: createSchema(productMutationRequestSchema).schema as Record<
            string,
            unknown
          >,
        },
      },
    },
  }),
  zValidator('param', productDraftIdSchema, validationError),
  zValidator('json', productMutationRequestSchema, validationError),
  c =>
    errors(c, async () =>
      result(
        c,
        await submitProductMutation(
          c.var.db,
          c.env,
          c.var.userId ?? '',
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
    ),
);
router.get(
  '/:id/operation',
  describeRoute({
    tags: ['Admin product drafts'],
    summary: 'Inspect durable mutation progress',
    responses,
  }),
  zValidator('param', productDraftIdSchema, validationError),
  c =>
    errors(c, async () =>
      result(
        c,
        await readProductMutation(
          c.var.db,
          c.var.userId ?? '',
          c.req.valid('param').id,
        ),
      ),
    ),
);
router.post(
  '/:id/reconcile',
  describeRoute({
    tags: ['Admin product drafts'],
    summary: 'Resume the saved operation without authorizing newer changes',
    description:
      'Replays only the immutable provider request and key until confirmed. After confirmation retries local persistence only; configuration and concurrency conflicts remain visible.',
    responses,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: createSchema(reconcileProductMutationSchema).schema as Record<
            string,
            unknown
          >,
        },
      },
    },
  }),
  zValidator('param', productDraftIdSchema, validationError),
  zValidator('json', reconcileProductMutationSchema, validationError),
  c =>
    errors(c, async () =>
      result(
        c,
        await reconcileProductMutation(
          c.var.db,
          c.env,
          c.var.userId ?? '',
          c.req.valid('param').id,
          c.req.valid('json').operationId,
        ),
      ),
    ),
);
export default router;
