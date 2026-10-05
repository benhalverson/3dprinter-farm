import { zValidator } from '@hono/zod-validator';
import { describeRoute } from 'hono-openapi';
import { eq } from 'drizzle-orm';
import { inPersonPriceSchema, productsTable } from '../db/schema';
import { priceToCents, saveCatalogItem } from '../modules/catalogPublication';
import { z } from 'zod';
import factory from '../factory';
import {
  catalogPublication,
  isPublicationFailure,
} from '../modules/catalogPublication';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';

const squareCatalog = factory.createApp();
const catalogIdSchema = z.object({
  id: z.coerce.number().int().positive().safe(),
});
const publicationSchema = {
  type: 'object' as const,
  required: ['price', 'inPersonPrice'],
  properties: {
    id: { type: 'integer' as const },
    price: { type: 'number' as const, description: 'Online Price in USD' },
    inPersonPrice: {
      type: 'number' as const,
      description: 'In-Person Price in USD; null until explicitly priced',
      nullable: true,
    },
    status: {
      type: 'string' as const,
      enum: ['unpublished', 'published', 'needs_update'],
    },
    mapping: {
      type: 'object' as const,
      nullable: true,
      properties: {
        environment: {
          type: 'string' as const,
          enum: ['sandbox', 'production'],
        },
        merchantId: { type: 'string' as const },
        locationId: { type: 'string' as const },
        itemId: { type: 'string' as const, nullable: true },
        variationId: { type: 'string' as const, nullable: true },
      },
    },
    pendingOperation: {
      type: 'object' as const,
      nullable: true,
      properties: {
        id: { type: 'string' as const },
        kind: { type: 'string' as const, enum: ['publish', 'unpublish'] },
        createdAt: { type: 'string' as const },
      },
    },
    error: {
      type: 'string' as const,
      nullable: true,
      description: 'Sanitized provider error code',
    },
  },
};
for (const action of ['status', 'publish', 'unpublish'] as const) {
  const path = `/admin/catalog/:id/square${action === 'status' ? '' : `/${action}`}`;
  squareCatalog.on(
    action === 'status' ? 'GET' : 'POST',
    path,
    authMiddleware,
    requireCatalogMutationRole,
    describeRoute({
      tags: ['Admin Catalog'],
      summary: `${action} Square catalog publication`,
      description:
        'Explicit publication only. An unresolved operation is replayed with its saved request before newer changes or an opposite action. Inspect pendingOperation and status, then invoke the desired action again. No Slant3D requests.',
      responses: {
        200: {
          description: 'Current publication state',
          content: { 'application/json': { schema: publicationSchema } },
        },
        400: {
          description: 'Invalid ID or missing valid In-Person Price/name',
        },
        401: { description: 'Authentication required' },
        403: { description: 'Admin/owner required' },
        404: { description: 'Catalog Item not found' },
        409: {
          description:
            'Configuration differs from mapping or catalog changed; inspect and retry',
        },
        502: {
          description:
            'Sanitized Square failure; inspect state and retry unresolved operations',
        },
        503: { description: 'Square configuration required' },
      },
    }),
    zValidator('param', catalogIdSchema, (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_catalog_id' }, 400);
    }),
    /** Applies an authorized publication operation and exposes only sanitized failures. */
    async c => {
      const { id } = c.req.valid('param');
      try {
        return c.json(await catalogPublication(c.env)[action](id));
      } catch (error) {
        if (isPublicationFailure(error))
          return c.json({ error: error.code }, error.status);
        return c.json({ error: 'catalog_publication_unavailable' }, 503);
      }
    },
  );
}
squareCatalog.patch(
  '/admin/catalog/:id/in-person-price',
  authMiddleware,
  requireCatalogMutationRole,
  describeRoute({
    tags: ['Admin Catalog'],
    summary:
      'Set an explicit In-Person Price without changing Online Price or print metadata',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['inPersonPrice'],
            additionalProperties: false,
            properties: {
              inPersonPrice: {
                type: 'number',
                minimum: 0,
                exclusiveMinimum: true,
                maximum: 99999999.99,
                multipleOf: 0.01,
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Updated channel prices',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['id', 'price', 'inPersonPrice'],
              properties: {
                id: { type: 'integer' },
                price: {
                  type: 'number',
                  description: 'Unchanged Online Price in USD',
                },
                inPersonPrice: {
                  type: 'number',
                  description: 'Explicit In-Person Price in USD',
                },
              },
            },
          },
        },
      },
      400: { description: 'Invalid product ID or positive USD price' },
      401: { description: 'Authentication required' },
      403: { description: 'Admin/owner required' },
      404: { description: 'Catalog Item not found' },
      409: { description: 'Concurrent catalog edit; reload before retrying' },
    },
  }),
  zValidator('param', catalogIdSchema),
  zValidator('json', z.object({ inPersonPrice: inPersonPriceSchema }).strict()),
  /** Backfills only an explicitly supplied price, using the catalog revision guard. */
  async c => {
    const { id } = c.req.valid('param');
    const { inPersonPrice } = c.req.valid('json');
    const current = await c.var.db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, id))
      .get();
    if (!current) return c.json({ error: 'catalog_item_not_found' }, 404);
    try {
      await saveCatalogItem(c.var.db, current, {
        inPersonPrice: priceToCents(inPersonPrice),
      });
      return c.json({ id, price: current.price, inPersonPrice });
    } catch (error) {
      if (isPublicationFailure(error))
        return c.json({ error: error.code }, error.status);
      throw error;
    }
  },
);
export default squareCatalog;
