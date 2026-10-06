import { z } from 'zod';
import { attachmentCleanupSchema } from './productAttachmentContracts';
import { draftRevisionSchema } from './productDraftContracts';

export const productMutationRequestSchema = z
  .object({
    expectedRevision: draftRevisionSchema.min(1),
    preparationId: z.string().uuid(),
    action: z.enum(['create', 'update', 'delete']),
  })
  .strict();
export const reconcileProductMutationSchema = z
  .object({ operationId: z.string().uuid() })
  .strict();
export const productMutationResponseSchema = z
  .object({
    id: z.string().uuid(),
    draftId: z.string().uuid(),
    preparationId: z.string().uuid(),
    action: z.enum(['create', 'update', 'delete']),
    state: z.enum([
      'prepared',
      'pending',
      'item_confirmed',
      'square_confirmed',
      'repair_required',
      'succeeded',
      'failed',
    ]),
    productId: z.number().int().positive().nullable(),
    error: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    retryable: z.boolean(),
    cleanup: z.array(attachmentCleanupSchema),
  })
  .strict();
export type ProductMutationRequest = z.infer<
  typeof productMutationRequestSchema
>;
