import { zValidator } from '@hono/zod-validator';
import { describeRoute } from 'hono-openapi';
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
  type: 'object',
  properties: {
    id: { type: 'integer' },
    price: { type: 'number', description: 'Online Price in USD' },
    inPersonPrice: {
      type: 'number',
      nullable: true,
      description: 'In-Person Price in USD',
    },
    status: {
      type: 'string',
      enum: ['unpublished', 'published', 'needs_update'],
    },
    mapping: {
      type: 'object',
      nullable: true,
      properties: {
        environment: { type: 'string', enum: ['sandbox', 'production'] },
        merchantId: { type: 'string' },
        locationId: { type: 'string' },
        itemId: { type: 'string', nullable: true },
        variationId: { type: 'string', nullable: true },
      },
    },
    pendingOperation: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['publish', 'unpublish'] },
        createdAt: { type: 'string' },
      },
    },
    error: {
      type: 'string',
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
export default squareCatalog;
