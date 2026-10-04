import { z } from 'zod';

export const attachmentKindSchema = z.enum(['photo', 'print']);
export const transferStatusSchema = z.enum([
  'pending',
  'saved',
  'incomplete',
  'failed',
  'unresolved',
]);
export const savedAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    kind: attachmentKindSchema,
    name: z.string(),
    size: z.number().int().nonnegative(),
    contentType: z.string(),
    status: z.literal('saved'),
    imageUrl: z.string().nullable(),
    publicFileServiceId: z.string().nullable(),
  })
  .strict();
export const attachmentTransferSchema = z
  .object({
    id: z.string().uuid(),
    attachmentId: z.string().uuid(),
    kind: attachmentKindSchema,
    name: z.string(),
    size: z.number().int().positive(),
    contentType: z.string().nullable(),
    status: transferStatusSchema,
    replacesId: z.string().uuid().nullable(),
    error: z.string().nullable(),
    requiresReselection: z.boolean(),
  })
  .strict();
export const attachmentCleanupSchema = z
  .object({
    id: z.string().uuid(),
    assetId: z.string().uuid(),
    status: z.enum(['pending', 'deleted', 'protected']),
    reason: z.string().nullable(),
  })
  .strict();
export const productAttachmentsSchema = z
  .object({
    photos: z.array(savedAttachmentSchema),
    printFile: savedAttachmentSchema.nullable(),
    primaryPhotoId: z.string().uuid().nullable(),
    photoOrder: z.array(z.string().uuid()),
    transfers: z.array(attachmentTransferSchema),
    validation: z.array(
      z
        .object({ field: z.string(), code: z.string(), message: z.string() })
        .strict(),
    ),
    cleanup: z.array(attachmentCleanupSchema),
  })
  .strict();
export const attachmentRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const attachmentIntentSchema = z
  .object({
    expectedRevision: attachmentRevisionSchema,
    kind: attachmentKindSchema,
    name: z.string().trim().min(1).max(512),
    size: z.number().int().positive().safe(),
    replacesId: z.string().uuid().optional(),
  })
  .strict();
export const attachmentActionSchema = z
  .object({ expectedRevision: attachmentRevisionSchema })
  .strict();
export const attachmentEditSchema = attachmentActionSchema
  .extend({
    primaryPhotoId: z.string().uuid().nullable().optional(),
    photoOrder: z.array(z.string().uuid()).max(5).optional(),
  })
  .strict();
export const attachmentUploadSchema = z
  .object({
    id: z.string().uuid(),
    upload: z
      .object({
        method: z.literal('PUT'),
        url: z.string(),
        headers: z.record(z.string()),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const draftCleanupResponseSchema = z
  .object({
    id: z.string().uuid(),
    revision: attachmentRevisionSchema,
    status: z.enum(['active', 'discarded']),
    cleanup: z.array(attachmentCleanupSchema),
  })
  .strict();
export type SavedAttachment = z.infer<typeof savedAttachmentSchema>;
export type AttachmentTransfer = z.infer<typeof attachmentTransferSchema>;
export type AttachmentCleanup = z.infer<typeof attachmentCleanupSchema>;
export type ProductAttachments = z.infer<typeof productAttachmentsSchema>;
export type AttachmentIntent = z.infer<typeof attachmentIntentSchema>;
export type AttachmentEdit = z.infer<typeof attachmentEditSchema>;
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
