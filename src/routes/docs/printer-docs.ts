import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import {
  ConfirmUploadResponseSchema,
  ErrorSchema,
  EstimateErrorSchema,
  EstimateResponseSchema,
  FilamentV2ErrorSchema,
  FilamentV2ResponseSchema,
  ListItemSchema,
  type OpenAPISchema,
  PresignedUploadResponseSchema,
  UploadResponseSchema,
} from '../schemas/printer-schemas';

// List 3D models documentation
export const listModelsDoc = {
  summary: 'List your uploaded 3D models',
  description: 'Lists STL objects in the authenticated user namespace. Legacy shared keys are excluded.',
  tags: ['Printer'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(z.array(ListItemSchema)),
        },
      },
      description: 'List of 3D models',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
      description: 'Failed to retrieve list',
    },
  },
};

// Upload file documentation
export const uploadFileDoc = {
  description:
    'Upload a public JPEG, PNG, or WebP photo (decoded bytes, maximum 5,000,000 bytes) or an STL file. Photos receive unique keys and detected MIME metadata. STL uploads receive immutable owner-scoped keys; identity collisions return 409. Requires a configured public URL for the selected bucket.',
  tags: ['Printer'],
  requestBody: {
    content: {
      'multipart/form-data': {
        schema: resolver(
          z.object({
            file: z.instanceof(File).describe('The file to upload'),
          }),
        ) as unknown as OpenAPISchema,
        example: {
          file: 'dragon-model.stl',
        },
      },
    },
    required: true,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(UploadResponseSchema),
          example: {
            message: 'File uploaded',
            key: 'users/user-id/11111111-1111-4111-8111-111111111111.stl',
            url: 'https://pub-example.r2.dev/users%2Fuser-id%2F11111111-1111-4111-8111-111111111111.stl',
          },
        },
      },
      description: 'File uploaded successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
          example: {
            error: 'No file uploaded',
          },
        },
      },
      description:
        'Missing file, malformed form, invalid photo bytes, or oversized photo',
    },
    415: {
      description: 'Unsupported file format',
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
    },
    503: {
      description:
        'Public URL for the selected storage bucket is not configured',
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
      description: 'Failed to upload file',
    },
  },
};

// Get filament colors documentation
export const getFilamentsV2Doc = {
  summary: 'Get available filaments (V2 API)',
  description:
    'Retrieves filaments from Slant3D V2 API with enhanced metadata including publicId, availability, and provider information.',
  tags: ['Printer'],
  parameters: [
    {
      name: 'profile',
      in: 'query',
      required: false,
      schema: resolver(z.enum(['PLA', 'PETG', 'ABS'])),
      description: 'Filter by material type',
      example: 'PLA',
    },
    {
      name: 'available',
      in: 'query',
      required: false,
      schema: resolver(z.enum(['true', 'false'])),
      description: 'Filter by availability status',
      example: 'true',
    },
    {
      name: 'provider',
      in: 'query',
      required: false,
      schema: resolver(z.string()),
      description: 'Filter by filament provider/manufacturer',
      example: 'PolyMaker',
    },
  ],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(FilamentV2ResponseSchema),
          example: {
            success: true,
            message: 'Filaments retrieved successfully',
            data: [
              {
                publicId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
                name: 'PLA Black',
                provider: 'PolyMaker',
                profile: 'PLA',
                color: 'Black',
                hexValue: '#000000',
                public: true,
                available: true,
              },
              {
                publicId: '8a2c3e4f-5d6e-7f8a-9b0c-1d2e3f4a5b6c',
                name: 'PLA Red',
                provider: 'PolyMaker',
                profile: 'PLA',
                color: 'Red',
                hexValue: '#FF0000',
                public: true,
                available: true,
              },
            ],
            count: 2,
            lastUpdated: '2026-01-25T10:30:00Z',
          },
        },
      },
      description: 'Filaments retrieved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(FilamentV2ErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            message: 'Invalid profile parameter',
            error: 'Accepted values are "PLA", "PETG", or "ABS"',
          },
        },
      },
      description: 'Invalid query parameters',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(FilamentV2ErrorSchema) as unknown as OpenAPISchema,
        },
      },
      description: 'Failed to retrieve filaments',
    },
  },
};

// Estimate file cost V2 documentation
export const estimateV2Doc = {
  summary: 'Estimate file print cost (V2 API)',
  description:
    'Estimate the cost to print a single file without drafting an order. If no filament is provided, cost is estimated against PLA BLACK. Note: filamentId, quantity, and slicer options are sent to Slant3D nested in an "options" object.',
  tags: ['Printer'],
  requestBody: {
    content: {
      'application/json': {
        schema: resolver(
          z.object({
            publicFileServiceId: z
              .string()
              .uuid()
              .describe(
                'UUID of the file returned from /v2/upload or /v2/confirm',
              ),
            options: z
              .object({
                filamentId: z
                  .string()
                  .uuid()
                  .optional()
                  .describe(
                    'UUID of the filament (defaults to PLA BLACK if not provided)',
                  ),
                quantity: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe('Number of copies to print (default: 1)'),
                slicer: z
                  .object({
                    support_enabled: z
                      .boolean()
                      .optional()
                      .describe('Enable support structures (default: true)'),
                  })
                  .optional()
                  .describe('Slicer configuration options'),
              })
              .optional()
              .describe(
                'Options object containing filament, quantity, and slicer settings',
              ),
          }),
        ) as unknown as OpenAPISchema,
        example: {
          publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          options: {
            filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
            quantity: 5,
            slicer: {
              support_enabled: true,
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(EstimateResponseSchema) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'File price estimated successfully',
            data: {
              publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              total: 24.75,
              estimatedCost: 24.75,
              pricePerUnit: 24.75,
              subtotal: 24.75,
              quantity: 5,
              filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
              slicer: {
                support_enabled: true,
              },
            },
          },
        },
      },
      description: 'Cost estimated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(EstimateErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            error: 'publicFileServiceId is required',
          },
        },
      },
      description: 'Invalid parameters',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(
            z.object({
              success: z.boolean(),
              error: z.string(),
              details: z.unknown(),
            }),
          ) as unknown as OpenAPISchema,
        },
      },
      description: 'Estimation failed',
    },
  },
};

// Get presigned upload URL documentation
export const presignedUploadDoc = {
  summary: 'Get presigned URL for direct file upload to Slant3D',
  description:
    'Generate a presigned URL for direct browser upload to Slant3D S3 storage. This is the recommended method. After uploading the file to the presigned URL, call /v2/confirm to complete registration.',
  tags: ['Printer'],
  requestBody: {
    content: {
      'application/json': {
        schema: resolver(
          z.object({
            fileName: z.string().describe('Name of the STL file to upload'),
            ownerId: z
              .string()
              .optional()
              .describe('Your application user ID for tracking'),
          }),
        ) as unknown as OpenAPISchema,
        example: {
          fileName: 'dragon-model.stl',
          ownerId: 'user_123456',
        },
      },
    },
    required: true,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(
            PresignedUploadResponseSchema,
          ) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'Presigned URL generated successfully',
            data: {
              presignedUrl:
                'https://s3.amazonaws.com/slant3d-uploads/dragon-model.stl?signature=...',
              key: 'uploads/user_123456/dragon-model.stl',
              filePlaceholder: {
                publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                name: 'dragon-model',
                ownerId: 'user_123456',
                platformId: 'platform_abc123',
                type: 'stl',
                createdAt: '2026-01-25T10:30:00Z',
                updatedAt: '2026-01-25T10:30:00Z',
              },
            },
          },
        },
      },
      description: 'Presigned URL generated successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(EstimateErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            error: 'fileName is required',
          },
        },
      },
      description: 'Invalid file name',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(
            z.object({
              success: z.boolean(),
              error: z.string(),
              details: z.unknown(),
            }),
          ) as unknown as OpenAPISchema,
        },
      },
      description: 'Failed to generate presigned URL',
    },
  },
};

// Confirm presigned upload documentation
export const confirmUploadDoc = {
  summary: 'Confirm presigned upload and complete file registration',
  description:
    'REQUIRED: Call this endpoint after successfully uploading to the presigned URL to trigger file processing and analysis. The filePlaceholder object must be the exact one returned from /v2/upload.',
  tags: ['Printer'],
  requestBody: {
    content: {
      'application/json': {
        schema: resolver(
          z.object({
            filePlaceholder: z
              .object({
                publicFileServiceId: z.string(),
                name: z.string(),
                ownerId: z.string(),
                platformId: z.string(),
                type: z.string(),
                createdAt: z.string(),
                updatedAt: z.string(),
              })
              .describe(
                'The exact filePlaceholder object returned from /v2/presigned-upload',
              ),
          }),
        ) as unknown as OpenAPISchema,
        example: {
          filePlaceholder: {
            publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            name: 'dragon-model',
            ownerId: 'user_123456',
            platformId: 'platform_abc123',
            type: 'stl',
            createdAt: '2026-01-25T10:30:00Z',
            updatedAt: '2026-01-25T10:30:00Z',
          },
        },
      },
    },
    required: true,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(
            ConfirmUploadResponseSchema,
          ) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'Upload confirmed and file processed successfully',
            data: {
              publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              name: 'dragon-model',
              fileURL:
                'https://s3.amazonaws.com/slant3d-files/dragon-model.stl?signature=...',
              STLMetrics: {
                x: 120.5,
                y: 85.3,
                z: 45.2,
                weight: 15.8,
                volume: 45230.5,
                surfaceArea: 12450.2,
                imageURL:
                  'https://s3.amazonaws.com/slant3d-previews/dragon-model.png',
              },
            },
          },
        },
      },
      description: 'Upload confirmed and file processed successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(EstimateErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            error: 'Invalid or missing filePlaceholder',
          },
        },
      },
      description: 'Invalid or missing filePlaceholder',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(
            z.object({
              success: z.boolean(),
              error: z.string(),
              details: z.unknown(),
            }),
          ) as unknown as OpenAPISchema,
        },
      },
      description: 'Confirmation failed',
    },
  },
};

// V2 upload documentation
