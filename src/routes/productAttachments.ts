import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import { createSchema } from 'zod-openapi';
import factory, { type WorkerEnv } from '../factory';
import { AttachmentError } from '../modules/productAssets';
import {
  attachmentActionSchema,
  attachmentEditSchema,
  attachmentIntentSchema,
  attachmentUploadSchema,
  draftCleanupResponseSchema,
} from '../modules/productAttachmentContracts';
import {
  attachmentDraft,
  cleanupResponse,
  confirmAttachment,
  createAttachmentIntent,
  editAttachments,
  readAttachmentPhoto,
  removeAttachment,
  retryAttachmentCleanup,
  retryAttachmentTransfer,
  uploadAttachmentPhoto,
} from '../modules/productAttachments';
import {
  discardProductDraftSchema,
  productDraftResponseSchema,
} from '../modules/productDraftContracts';
import { productDraftResponse } from '../modules/productDrafts';

const parameters = z.object({
  id: z.string().uuid(),
  transferId: z.string().uuid().optional(),
  attachmentId: z.string().uuid().optional(),
});
const draftEnvelope = z.object({ draft: productDraftResponseSchema });
const intentEnvelope = draftEnvelope.extend({
  transfer: attachmentUploadSchema,
});
const validate = (result: { success: boolean }, c: Context<WorkerEnv>) => {
  if (!result.success) return c.json({ error: 'Invalid input' }, 400);
};
const description = (
  summary: string,
  schema: z.ZodType = draftEnvelope,
  input?: z.ZodType,
  status = 200,
) =>
  describeRoute({
    tags: ['Admin product drafts'],
    summary,
    security: [{ cookieAuth: [] }],
    ...(input
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: createSchema(input).schema as Record<string, unknown>,
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: 'Durable attachment state',
        content: { 'application/json': { schema: resolver(schema) } },
      },
    },
  });
async function action(
  c: Context<WorkerEnv>,
  run: (ownerId: string) => Promise<Response>,
) {
  try {
    return await run(c.var.userId!);
  } catch (error) {
    if (error instanceof AttachmentError)
      return c.json({ error: error.message }, error.status);
    return c.json(
      { error: 'Attachment request failed; reload to recover saved state' },
      500,
    );
  }
}
const router = factory
  .createApp()
  .use('/:id/attachments/intents', bodyLimit({ maxSize: 256 * 1024 }))
  .use('/:id/attachments', bodyLimit({ maxSize: 256 * 1024 }))
  .use(
    '/:id/attachments/transfers/:transferId/confirm',
    bodyLimit({ maxSize: 256 * 1024 }),
  )
  .use(
    '/:id/attachments/transfers/:transferId/retry',
    bodyLimit({ maxSize: 256 * 1024 }),
  )
  .use('/:id/cleanup/retry', bodyLimit({ maxSize: 256 * 1024 }))
  .post(
    '/:id/attachments/intents',
    zValidator('param', parameters, validate),
    description(
      'Reserve a durable attachment transfer',
      intentEnvelope,
      attachmentIntentSchema,
      201,
    ),
    zValidator('json', attachmentIntentSchema, validate),
    c =>
      action(c, async ownerId => {
        const result = await createAttachmentIntent(
          c.var.db,
          c.env,
          ownerId,
          c.req.param('id')!,
          c.req.valid('json'),
        );
        return c.json(
          {
            draft: await productDraftResponse(c.var.db, result.row),
            transfer: result.transfer,
          },
          201,
        );
      }),
  )
  .put(
    '/:id/attachments/transfers/:transferId/content',
    zValidator('param', parameters, validate),
    description('Validate and store an owned photo'),
    zValidator('query', discardProductDraftSchema, validate),
    c =>
      action(c, async ownerId => {
        const row = await uploadAttachmentPhoto(
          c.var.db,
          c.env,
          ownerId,
          c.req.param('id')!,
          c.req.param('transferId')!,
          c.req.valid('query').expectedRevision,
          c.req.raw.body,
        );
        return c.json({ draft: await productDraftResponse(c.var.db, row) });
      }),
  )
  .post(
    '/:id/attachments/transfers/:transferId/confirm',
    zValidator('param', parameters, validate),
    description(
      'Confirm or recover the same durable transfer',
      draftEnvelope,
      attachmentActionSchema,
    ),
    zValidator('json', attachmentActionSchema, validate),
    c =>
      action(c, async ownerId => {
        const row = await confirmAttachment(
          c.var.db,
          c.env,
          ownerId,
          c.req.param('id')!,
          c.req.param('transferId')!,
          c.req.valid('json').expectedRevision,
        );
        return c.json({ draft: await productDraftResponse(c.var.db, row) });
      }),
  )
  .post(
    '/:id/attachments/transfers/:transferId/retry',
    zValidator('param', parameters, validate),
    description(
      'Retry safe transfer recovery',
      intentEnvelope,
      attachmentActionSchema,
    ),
    zValidator('json', attachmentActionSchema, validate),
    c =>
      action(c, async ownerId => {
        const result = await retryAttachmentTransfer(
          c.var.db,
          c.env,
          ownerId,
          c.req.param('id')!,
          c.req.param('transferId')!,
          c.req.valid('json').expectedRevision,
        );
        return c.json({
          draft: await productDraftResponse(c.var.db, result.row),
          transfer: result.transfer,
        });
      }),
  )
  .patch(
    '/:id/attachments',
    zValidator('param', parameters, validate),
    description(
      'Set primary identity and gallery order independently',
      draftEnvelope,
      attachmentEditSchema,
    ),
    zValidator('json', attachmentEditSchema, validate),
    c =>
      action(c, async ownerId => {
        const row = await editAttachments(
          c.var.db,
          ownerId,
          c.req.param('id')!,
          c.req.valid('json'),
        );
        return c.json({ draft: await productDraftResponse(c.var.db, row) });
      }),
  )
  .delete(
    '/:id/attachments/:attachmentId',
    zValidator('param', parameters, validate),
    description('Remove one attachment and retain cleanup recovery'),
    zValidator('query', discardProductDraftSchema, validate),
    c =>
      action(c, async ownerId => {
        let row = await removeAttachment(
          c.var.db,
          ownerId,
          c.req.param('id')!,
          c.req.param('attachmentId')!,
          c.req.valid('query').expectedRevision,
        );
        row = await retryAttachmentCleanup(
          c.var.db,
          c.env,
          ownerId,
          row.id,
          row.revision,
        );
        return c.json({ draft: await productDraftResponse(c.var.db, row) });
      }),
  )
  .get(
    '/:id/attachments/:attachmentId/image',
    zValidator('param', parameters, validate),
    describeRoute({
      tags: ['Admin product drafts'],
      summary: 'Read a private saved photo',
      security: [{ cookieAuth: [] }],
    }),
    c =>
      action(c, async ownerId => {
        const photo = await readAttachmentPhoto(
          c.var.db,
          c.env,
          ownerId,
          c.req.param('id')!,
          c.req.param('attachmentId')!,
        );
        return c.body(photo.bytes, 200, {
          'Content-Type': photo.contentType,
          'X-Content-Type-Options': 'nosniff',
        });
      }),
  )
  .get(
    '/:id/cleanup',
    zValidator('param', parameters, validate),
    description(
      'Read active or discarded draft cleanup recovery',
      draftCleanupResponseSchema,
    ),
    c =>
      action(c, async ownerId =>
        c.json(
          cleanupResponse(
            await attachmentDraft(
              c.var.db,
              ownerId,
              c.req.param('id')!,
              undefined,
              true,
            ),
          ),
        ),
      ),
  )
  .post(
    '/:id/cleanup/retry',
    zValidator('param', parameters, validate),
    description(
      'Retry reference-aware cleanup',
      draftCleanupResponseSchema,
      attachmentActionSchema,
    ),
    zValidator('json', attachmentActionSchema, validate),
    c =>
      action(c, async ownerId =>
        c.json(
          cleanupResponse(
            await retryAttachmentCleanup(
              c.var.db,
              c.env,
              ownerId,
              c.req.param('id')!,
              c.req.valid('json').expectedRevision,
            ),
          ),
        ),
      ),
  );

export default router;
