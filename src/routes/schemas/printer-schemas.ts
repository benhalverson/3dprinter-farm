import { z } from 'zod';

export type OpenAPISchema = Record<string, unknown>;

// OpenAPI Schemas - using Zod for validation and documentation
export const ListItemSchema = z.object({
  stl: z.string().describe('The STL file name'),
  size: z.number().describe('The size of the STL file in bytes'),
  version: z.string().describe('The version of the STL file'),
});

export const ErrorSchema = z.object({
  error: z.string(),
});

export const UploadResponseSchema = z.object({
  message: z.string(),
  key: z.string(),
  url: z.string(),
});

export const FilamentV2DataSchema = z.object({
  publicId: z.string().describe('UUID for order placement'),
  name: z.string().describe('Filament display name'),
  provider: z.string().describe('Manufacturer/brand'),
  profile: z.enum(['PLA', 'PETG', 'ABS']).describe('Material type'),
  color: z.string().describe('Color description'),
  hexValue: z.string().describe('Hex color code'),
  public: z.boolean().describe('Public visibility'),
  available: z.boolean().describe('In-stock status'),
});

export const FilamentV2ResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.array(FilamentV2DataSchema),
  count: z.number(),
  lastUpdated: z.string().optional(),
});

export const FilamentV2ErrorSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  error: z.string(),
});

export const EstimateResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    publicFileServiceId: z.string(),
    total: z.number().describe('Slant3D total estimate in USD'),
    estimatedCost: z.number().describe('Estimated cost in USD'),
    pricePerUnit: z.number().optional(),
    subtotal: z.number().optional(),
    quantity: z.number(),
    filamentId: z.string(),
    slicer: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const EstimateErrorSchema = z.object({
  success: z.boolean(),
  error: z.string(),
});

export const FilePlaceholderSchema = z.object({
  publicFileServiceId: z.string().describe('UUID for file'),
  name: z.string(),
  ownerId: z.string(),
  platformId: z.string(),
  type: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PresignedUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    presignedUrl: z.string().describe('URL to upload file to (1 hour expiry)'),
    key: z.string().describe('S3 object key'),
    filePlaceholder: FilePlaceholderSchema,
  }),
});

export const STLMetricsSchema = z.object({
  dimensionX: z.number().describe('Width in mm'),
  dimensionY: z.number().describe('Depth in mm'),
  dimensionZ: z.number().describe('Height in mm'),
  weight: z.number().describe('Weight in grams'),
  volume: z.number().describe('Volume in cubic cm'),
  surfaceArea: z.number().optional().describe('Surface area in sq mm'),
  imageURL: z.string().optional().describe('Preview image URL'),
});

export const ConfirmUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    publicFileServiceId: z.string().describe('UUID for file'),
    name: z.string(),
    fileURL: z.string().describe('Presigned download URL (1 hour expiry)'),
    STLMetrics: STLMetricsSchema.optional(),
  }),
});
