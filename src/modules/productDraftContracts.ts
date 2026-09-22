import { z } from 'zod';

const productIdSchema = z.number().int().positive().safe();
export const draftRevisionSchema = z.number().int().positive().safe();
export const productDraftTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }).strict(),
  z
    .object({ kind: z.literal('existing'), productId: productIdSchema })
    .strict(),
]);

// These are supplied answers, never catalog values or execution authority.
export const productDraftAnswersSchema = z
  .object({
    name: z.string().max(512).optional(),
    description: z.string().max(16384).optional(),
    categoryIds: z.array(productIdSchema).max(100).optional(),
    filamentType: z.string().max(256).optional(),
    color: z.string().max(256).optional(),
    notes: z.string().max(16384).optional(),
  })
  .strict();
export const productDraftStateSchema = z
  .object({
    answers: productDraftAnswersSchema,
    pendingQuestions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            prompt: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(100),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(16384),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const beginProductDraftSchema = z
  .object({
    target: productDraftTargetSchema,
    state: productDraftStateSchema.optional(),
  })
  .strict();
export const saveProductDraftSchema = z
  .object({
    expectedRevision: draftRevisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
    state: productDraftStateSchema,
  })
  .strict();
export const discardProductDraftSchema = z
  .object({
    expectedRevision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(draftRevisionSchema),
  })
  .strict();
export const productDraftIdSchema = z
  .object({ id: z.string().uuid() })
  .strict();

export const productDraftContextSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('new') }).strict(),
  z
    .object({ status: z.literal('unavailable'), productId: productIdSchema })
    .strict(),
  z
    .object({
      status: z.literal('available'),
      product: z
        .object({
          id: productIdSchema,
          name: z.string(),
          description: z.string(),
          image: z.string().nullable(),
          price: z.number(),
          filamentType: z.string(),
          color: z.string().nullable(),
          skuNumber: z.string().nullable(),
          publicFileServiceId: z.string().nullable(),
        })
        .strict(),
      categories: z.array(
        z
          .object({
            categoryId: productIdSchema,
            categoryName: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export const productDraftSummarySchema = z
  .object({
    id: z.string().uuid(),
    target: productDraftTargetSchema,
    revision: draftRevisionSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export const productDraftResponseSchema = productDraftSummarySchema
  .extend({
    state: productDraftStateSchema,
    context: productDraftContextSchema,
  })
  .strict();
export const productDraftListSchema = z
  .object({ drafts: z.array(productDraftSummarySchema) })
  .strict();
export type ProductDraftTarget = z.infer<typeof productDraftTargetSchema>;
export type ProductDraftState = z.infer<typeof productDraftStateSchema>;
export type ProductDraftContext = z.infer<typeof productDraftContextSchema>;
export type BeginProductDraft = z.infer<typeof beginProductDraftSchema>;
export type SaveProductDraft = z.infer<typeof saveProductDraftSchema>;
export type DiscardProductDraft = z.infer<typeof discardProductDraftSchema>;
export type ProductDraft = z.infer<typeof productDraftResponseSchema>;
export type ProductDraftSummary = z.infer<typeof productDraftSummarySchema>;
export type ProductDraftList = z.infer<typeof productDraftListSchema>;
