import { z } from 'zod';

export type OpenAPISchema = Record<string, unknown>;

// File upload validation schema
export const FileUploadSchema = z.object({
  file: z
    .instanceof(File)
    .refine(
      file =>
        file.type === 'model/stl' || file.name.toLowerCase().endsWith('.stl'),
      {
        message: 'File must be a .stl file',
      },
    )
    .refine(file => file.size > 0, {
      message: 'File is empty',
    })
    .refine(file => file.size < 100 * 1024 * 1024, {
      message: 'File is too large (max 100MB)',
    })
    .describe('STL file to upload'),
});

export type FileUpload = z.infer<typeof FileUploadSchema>;

export const FilamentTypeSchema = z.enum(['PLA', 'PETG'], {
  errorMap: () => ({
    message: 'Accepted values are "PLA" and "PETG".',
  }),
});

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

export const ColorSchema = z.object({
  filament: z.string(),
  hexColor: z.string(),
  colorTag: z.string(),
});

export const ColorErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
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
    estimatedCost: z.number().describe('Estimated cost in USD'),
    quantity: z.number(),
    filamentId: z.string(),
    slicer: z.object({}).optional(),
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
  x: z.number().describe('Width in mm'),
  y: z.number().describe('Depth in mm'),
  z: z.number().describe('Height in mm'),
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

export const V2UploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.object({
    local: z.object({
      key: z.string().describe('File key in R2 bucket'),
      url: z.string().describe('R2 public URL'),
      name: z.string(),
    }),
    slant3D: z.object({
      publicFileServiceId: z.string().describe('UUID for use in orders'),
      name: z.string(),
      fileURL: z.string().describe('Slant3D file download URL'),
      STLMetrics: STLMetricsSchema.optional(),
    }),
  }),
});
// Uploaded file schema for GET endpoint
export const UploadedFileSchema = z.object({
  id: z.number().describe('Database record ID'),
  publicFileServiceId: z.string().describe('Slant3D file UUID'),
  fileName: z.string().describe('Original file name'),
  fileURL: z.string().describe('Slant3D file URL'),
  dimensionX: z.number().nullable().describe('Width in mm'),
  dimensionY: z.number().nullable().describe('Depth in mm'),
  dimensionZ: z.number().nullable().describe('Height in mm'),
  volume: z.number().nullable().describe('Volume in cubic cm'),
  weight: z.number().nullable().describe('Weight in grams'),
  surfaceArea: z.number().nullable().describe('Surface area in sq mm'),
  defaultFilamentId: z.string().describe('Default filament ID'),
  estimatedCost: z.number().nullable().describe('Estimated cost in USD'),
  estimatedQuantity: z.number().describe('Quantity for estimate'),
  createdAt: z.number().describe('Unix timestamp'),
  updatedAt: z.number().describe('Unix timestamp'),
});

export const UploadedFileResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: UploadedFileSchema,
});

export const UploadedFilesListResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z.array(UploadedFileSchema),
  count: z.number(),
});
