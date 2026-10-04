import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import factory, { type WorkerEnv } from '../factory';
import { AttachmentError } from '../modules/productAssets';
import { draftCleanupResponseSchema } from '../modules/productAttachmentContracts';
import {
  cleanupResponse,
  discardAttachments,
  retryAttachmentCleanup,
} from '../modules/productAttachments';
import {
  beginProductDraftSchema,
  discardProductDraftSchema,
  productDraftIdSchema,
  productDraftListSchema,
  productDraftResponseSchema,
  saveProductDraftSchema,
} from '../modules/productDraftContracts';
import {
  beginProductDraft,
  listProductDrafts,
  productDraftResponse,
  readProductDraft,
  saveProductDraft,
} from '../modules/productDrafts';
import {
  authMiddleware,
  requireCatalogMutationRole,
} from '../utils/authMiddleware';
import { logProductDraftError } from '../utils/productDraftError';
import attachmentsRouter from './productAttachments';

const errors = Object.fromEntries(
  [
    [400, 'Invalid input'],
    [401, 'Unauthenticated'],
    [403, 'Catalog administrator required'],
    [404, 'Draft not found for this owner, or starting product unavailable'],
    [409, 'Revision conflict; read the draft before retrying'],
    [500, 'Persistence or context read failed'],
  ].map(([status, description]) => [
    status,
    {
      description: String(description),
      content: {
        'application/json': {
          schema: resolver(z.object({ error: z.string() })),
        },
      },
    },
  ]),
);
const pathParameter = {
  name: 'id',
  in: 'path' as const,
  required: true,
  schema: { type: 'string' as const, format: 'uuid' },
};
const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: {
    'application/json': {
      schema: createSchema(schema).schema as Record<string, unknown>,
    },
  },
});
const response = (schema: z.ZodType) => ({
  description:
    'Private saved conversation; no operation is authorized or executed',
  content: { 'application/json': { schema: resolver(schema) } },
});
const validationError = (
  result: { success: boolean },
  c: Context<WorkerEnv>,
) => {
  if (!result.success) return c.json({ error: 'Invalid input' }, 400);
};
async function withDraftErrors(
  c: Context<WorkerEnv>,
  operation: string,
  action: (
    ownerId: string,
    setOperation: (operation: string) => void,
  ) => Promise<Response>,
) {
  try {
    return await action(c.var.userId!, value => {
      operation = value;
    });
  } catch (error) {
    if (error instanceof AttachmentError)
      return c.json({ error: error.message }, error.status);
    logProductDraftError(c, operation, error);
    return c.json({ error: 'Product draft request failed' }, 500);
  }
}

const router = factory
  .createApp()
  .use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
    // Validation and authorization can throw before the endpoint handler.
    // Inspect Hono's captured error here so mounted OpenAPI metadata stays intact.
    if (c.error) {
      const invalidInput =
        c.error instanceof HTTPException &&
        (c.error.status === 400 || c.error.status === 413);
      if (!invalidInput) logProductDraftError(c, 'draft.middleware', c.error);
      c.res = c.json(
        {
          error: invalidInput
            ? 'Invalid input'
            : 'Product draft request failed',
        },
        invalidInput ? 400 : 500,
      );
    }
  })
  .use('*', authMiddleware, requireCatalogMutationRole)
  .route('/', attachmentsRouter)
  .use(
    '*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: c => c.json({ error: 'Draft exceeds 256 KiB' }, 400),
    }),
  )
  .post(
    '/',
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'Begin a separate product conversation',
      description:
        'Creates revision 1. Target is immutable. Incomplete answers are allowed. Retained until explicit discard.',
      security: [{ cookieAuth: [] }],
      requestBody: jsonBody(beginProductDraftSchema),
      responses: { ...errors, 201: response(productDraftResponseSchema) },
    }),
    zValidator('json', beginProductDraftSchema, validationError),
    c =>
      withDraftErrors(c, 'draft.begin', async ownerId => {
        const draft = await beginProductDraft(
          c.var.db,
          ownerId,
          c.req.valid('json'),
        );
        if (!draft) return c.json({ error: 'Product unavailable' }, 404);
        return c.json(draft, 201);
      }),
  )
  .get(
    '/',
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'List own drafts, newest updated first',
      security: [{ cookieAuth: [] }],
      responses: { ...errors, 200: response(productDraftListSchema) },
    }),
    c =>
      withDraftErrors(c, 'draft.list', async ownerId =>
        c.json(await listProductDrafts(c.var.db, ownerId)),
      ),
  )
  .get(
    '/:id',
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'Read or resume a private conversation',
      description:
        'Returns saved answers and ordered history with current authoritative catalog context. A deleted product has unavailable context; the existing target remains unchanged. History is data only, including old confirmations.',
      security: [{ cookieAuth: [] }],
      parameters: [pathParameter],
      responses: { ...errors, 200: response(productDraftResponseSchema) },
    }),
    zValidator('param', productDraftIdSchema, validationError),
    c =>
      withDraftErrors(c, 'draft.read', async ownerId => {
        const row = await readProductDraft(
          c.var.db,
          ownerId,
          c.req.valid('param').id,
        );
        if (!row) return c.json({ error: 'Draft not found' }, 404);
        return c.json(await productDraftResponse(c.var.db, row));
      }),
  )
  .put(
    '/:id',
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'Atomically replace conversation state',
      description:
        'Requires expectedRevision. A successful write increments it once. Stale or replayed writes conflict; never automatically merge. After an ambiguous failure, read to determine whether the save committed.',
      security: [{ cookieAuth: [] }],
      parameters: [pathParameter],
      requestBody: jsonBody(saveProductDraftSchema),
      responses: { ...errors, 200: response(productDraftResponseSchema) },
    }),
    zValidator('param', productDraftIdSchema, validationError),
    zValidator('json', saveProductDraftSchema, validationError),
    c =>
      withDraftErrors(c, 'draft.save', async ownerId => {
        const id = c.req.valid('param').id;
        const row = await saveProductDraft(
          c.var.db,
          ownerId,
          id,
          c.req.valid('json'),
        );
        if (row) return c.json(await productDraftResponse(c.var.db, row));
        const exists = await readProductDraft(c.var.db, ownerId, id);
        return exists
          ? c.json({ error: 'Revision conflict' }, 409)
          : c.json({ error: 'Draft not found' }, 404);
      }),
  )
  .delete(
    '/:id',
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'Discard conversation and clean up exclusively owned uploads',
      description:
        'Retains a recovery tombstone and unresolved transfer identities. Cleanup checks references and remains visible when pending.',
      security: [{ cookieAuth: [] }],
      parameters: [
        pathParameter,
        {
          name: 'expectedRevision',
          in: 'query',
          required: true,
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      ],
      responses: { ...errors, 200: response(draftCleanupResponseSchema) },
    }),
    zValidator('param', productDraftIdSchema, validationError),
    zValidator('query', discardProductDraftSchema, validationError),
    c =>
      withDraftErrors(
        c,
        'draft.discard.save',
        async (ownerId, setOperation) => {
          const id = c.req.valid('param').id;
          let row = await discardAttachments(
            c.var.db,
            ownerId,
            id,
            c.req.valid('query').expectedRevision,
          );
          setOperation('draft.discard.cleanup');
          row = await retryAttachmentCleanup(
            c.var.db,
            c.env,
            ownerId,
            id,
            row.revision,
          );
          return c.json(cleanupResponse(row));
        },
      ),
  );

export default router;
