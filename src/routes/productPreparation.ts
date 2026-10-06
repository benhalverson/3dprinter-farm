import { zValidator } from '@hono/zod-validator';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import factory from '../factory';
import { AttachmentError } from '../modules/productAssets';
import { productDraftIdSchema } from '../modules/productDraftContracts';
import { readProductDraft } from '../modules/productDrafts';
import {
  prepareProduct,
  readCurrentPreparation,
} from '../modules/productPreparation';
import {
  preparationRequestSchema,
  productPreparationSchema,
} from '../modules/productPreparationContracts';
import { logProductDraftError } from '../utils/productDraftError';

const validationError = (
  result: { success: boolean },
  c: Parameters<typeof logProductDraftError>[0],
) => {
  if (!result.success) return c.json({ error: 'Invalid input' }, 400);
};
const envelope = z
  .object({ preparation: productPreparationSchema.nullable() })
  .strict();
const metadata = (summary: string, prepare = false) =>
  describeRoute({
    tags: ['Admin product drafts'],
    summary,
    description:
      'Authoritative private preparation only. Does not authorize or execute a catalog mutation.',
    security: [{ cookieAuth: [] }],
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ],
    ...(prepare
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: createSchema(preparationRequestSchema).schema as Record<
                  string,
                  unknown
                >,
              },
            },
          },
        }
      : {}),
    responses: {
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 500].map(status => [
          status,
          {
            description:
              'Invalid input, authorization, missing draft, stale inputs, or persistence failure',
            content: {
              'application/json': {
                schema: resolver(z.object({ error: z.string() })),
              },
            },
          },
        ]),
      ),
      200: {
        description: 'Revision-bound readiness and USD pricing',
        content: { 'application/json': { schema: resolver(envelope) } },
      },
    },
  });
const router = factory
  .createApp()
  .post(
    '/:id/pricing/prepare',
    metadata('Prepare current product pricing and readiness', true),
    zValidator('param', productDraftIdSchema, validationError),
    zValidator('json', preparationRequestSchema, validationError),
    async c => {
      try {
        return c.json({
          preparation: await prepareProduct(
            c.var.db,
            c.env,
            c.var.userId!,
            c.req.valid('param').id,
            c.req.valid('json').expectedRevision,
            c.req.valid('json').action,
          ),
        });
      } catch (error) {
        if (error instanceof AttachmentError)
          return c.json({ error: error.message }, error.status);
        logProductDraftError(c, 'draft.prepare', error);
        return c.json({ error: 'Product preparation failed' }, 500);
      }
    },
  )
  .get(
    '/:id/preparation',
    metadata('Read current preparation and invalidate changed inputs'),
    zValidator('param', productDraftIdSchema, validationError),
    async c => {
      try {
        const id = c.req.valid('param').id;
        if (!(await readProductDraft(c.var.db, c.var.userId!, id)))
          return c.json({ error: 'Draft not found' }, 404);
        return c.json({
          preparation:
            (await readCurrentPreparation(c.var.db, c.var.userId!, id)) ?? null,
        });
      } catch (error) {
        logProductDraftError(c, 'draft.preparation.read', error);
        return c.json({ error: 'Product preparation failed' }, 500);
      }
    },
  );
export default router;
