import { z } from 'zod';
import { draftRevisionSchema } from './productDraftContracts';

export const preparationRequestSchema = z
  .object({
    expectedRevision: draftRevisionSchema.min(1),
    action: z.enum(['create', 'update', 'delete']).optional(),
  })
  .strict();
export const preparationValidationSchema = z
  .object({ field: z.string(), code: z.string(), message: z.string() })
  .strict();
export const preparedSnapshotSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('new') }).strict(),
      z
        .object({
          kind: z.literal('existing'),
          productId: z.number().int().positive(),
        })
        .strict(),
    ]),
    action: z.enum(['create', 'update', 'delete']),
    productRevision: z.number().int().nonnegative().nullable(),
    name: z.string(),
    description: z.string(),
    categoryIds: z.array(z.number().int().positive()),
    filamentType: z.string(),
    color: z.string(),
    publicFileServiceId: z.string(),
    stl: z.string(),
    image: z.string(),
    imageGallery: z.array(z.string()),
    primaryPhotoAssetId: z.string().nullable(),
    assetIds: z.array(z.string()),
    cleanupAssetIds: z.array(z.string()),
    assetRevisions: z.array(
      z.object({ id: z.string(), revision: z.number().int() }).strict(),
    ),
    categoryBindings: z.array(
      z.object({ categoryId: z.number(), categoryName: z.string() }).strict(),
    ),
    sourceBinding: z.string(),
  })
  .strict();
export const preparationPricingSchema = z
  .object({
    currency: z.literal('USD'),
    productionCost: z.number().finite().nonnegative().nullable(),
    markupPercentage: z.number().finite().positive().nullable(),
    onlinePrice: z.number().finite().nonnegative().nullable(),
    inPersonPrice: z.number().finite().nonnegative().nullable(),
    basis: z
      .object({
        publicFileServiceId: z.string(),
        filamentId: z.string().uuid(),
        material: z.string(),
        color: z.string(),
        quantity: z.literal(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const productPreparationSchema = z
  .object({
    id: z.string().uuid(),
    draftRevision: draftRevisionSchema,
    preparedAt: z.number().int().nonnegative(),
    status: z.enum(['ready', 'blocked', 'unavailable', 'stale']),
    readiness: z
      .object({ ready: z.boolean(), submissionAuthorized: z.literal(false) })
      .strict(),
    validation: z.array(preparationValidationSchema),
    pricing: preparationPricingSchema,
    snapshot: preparedSnapshotSchema.nullable(),
  })
  .strict();
export type ProductPreparation = z.infer<typeof productPreparationSchema>;
export type PreparedSnapshot = z.infer<typeof preparedSnapshotSchema>;
