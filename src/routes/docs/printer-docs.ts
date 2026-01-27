import { resolver } from 'hono-openapi/zod';
import { z } from 'zod';
import {
  ColorErrorSchema,
  ColorSchema,
  ConfirmUploadResponseSchema,
  ErrorSchema,
  EstimateErrorSchema,
  EstimateResponseSchema,
  FilamentTypeSchema,
  FilamentV2ErrorSchema,
  FilamentV2ResponseSchema,
  ListItemSchema,
  type OpenAPISchema,
  PresignedUploadResponseSchema,
  UploadedFileResponseSchema,
  UploadedFilesListResponseSchema,
  UploadResponseSchema,
} from '../schemas/printer-schemas';

// List 3D models documentation
export const listModelsDoc = {
  summary: 'List all 3D models',
  description: 'Retrieves a list of all 3D models available for printing.',
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
  description: 'Upload a file to the bucket',
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
            key: 'dragon-model.stl',
            url: 'https://pub-example.r2.dev/dragon-model.stl',
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
      description: 'No file uploaded',
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
export const getColorsDoc = {
  summary: 'Get available filament colors',
  description: 'Retrieves a list of available filament colors.',
  tags: ['Printer'],
  parameters: [
    {
      name: 'filamentType',
      in: 'query',
      required: false,
      schema: resolver(FilamentTypeSchema),
      description: 'Filter colors by filament type (PLA or PETG)',
      example: 'PLA',
    },
  ],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(z.array(ColorSchema)),
          example: [
            {
              filament: 'PLA',
              hexColor: '#FF0000',
              colorTag: 'Red',
            },
            {
              filament: 'PLA',
              hexColor: '#0000FF',
              colorTag: 'Blue',
            },
            {
              filament: 'PLA',
              hexColor: '#000000',
              colorTag: 'Black',
            },
          ],
        },
      },
      description: 'List of filament colors',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(ColorErrorSchema),
          example: {
            error: 'Invalid filament type',
            message: 'Accepted values are "PLA" and "PETG".',
          },
        },
      },
      description: 'Invalid filament type',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(
            z.object({
              error: z.string(),
              details: z.unknown(),
            }),
          ) as unknown as OpenAPISchema,
        },
      },
      description: 'Failed to retrieve colors',
    },
  },
};

// Get filaments V2 documentation
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
              estimatedCost: 24.75,
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
export const v2UploadDoc = {
  summary: 'Upload STL file and get instant estimate',
  description:
    'Upload STL file using presigned upload workflow. Automatically registers with Slant3D V2 API, gets price estimate, and stores file metadata in database for later retrieval.',
  tags: ['Printer'],
  requestBody: {
    content: {
      'multipart/form-data': {
        schema: resolver(
          z.object({
            file: z.instanceof(File).describe('STL file to upload'),
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
    201: {
      content: {
        'application/json': {
          schema: resolver(
            z.object({
              success: z.boolean(),
              message: z.string(),
              data: z.object({
                id: z.number(),
                publicFileServiceId: z.string(),
                fileName: z.string(),
                fileURL: z.string(),
                STLMetrics: z
                  .object({
                    dimensionX: z.number().optional(),
                    dimensionY: z.number().optional(),
                    dimensionZ: z.number().optional(),
                    volume: z.number().optional(),
                    weight: z.number().optional(),
                    surfaceArea: z.number().optional(),
                  })
                  .optional(),
                estimate: z.object({
                  filamentId: z.string(),
                  filamentName: z.string(),
                  quantity: z.number(),
                  cost: z.number().nullable(),
                }),
              }),
            }),
          ) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'File uploaded and estimate saved successfully',
            data: {
              id: 1,
              publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              fileName: 'dragon-model.stl',
              fileURL:
                'https://s3.amazonaws.com/slant3d-files/dragon-model.stl?signature=...',
              STLMetrics: {
                dimensionX: 120.5,
                dimensionY: 85.3,
                dimensionZ: 45.2,
                volume: 45230.5,
                weight: 15.8,
                surfaceArea: 12450.2,
              },
              estimate: {
                filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
                filamentName: 'PLA BLACK',
                quantity: 1,
                cost: 12.5,
              },
            },
          },
        },
      },
      description: 'File uploaded and estimate saved successfully',
    },
    400: {
      content: {
        'application/json': {
          schema: resolver(EstimateErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            error: 'No file uploaded or file is not an STL',
          },
        },
      },
      description: 'Invalid file or missing parameters',
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
      description: 'Upload or registration failed',
    },
  },
};

// Get uploaded file by ID documentation
export const getUploadedFileDoc = {
  summary: 'Get uploaded file details by ID',
  description:
    'Retrieve details of an uploaded STL file including metadata, metrics, and cached estimate from database.',
  tags: ['Printer'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(
            UploadedFileResponseSchema,
          ) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'File retrieved successfully',
            data: {
              id: 1,
              publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              fileName: 'dragon-model.stl',
              fileURL:
                'https://s3.amazonaws.com/slant3d-files/dragon-model.stl',
              dimensionX: 120.5,
              dimensionY: 85.3,
              dimensionZ: 45.2,
              volume: 45230.5,
              weight: 15.8,
              surfaceArea: 12450.2,
              defaultFilamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
              estimatedCost: 12.5,
              estimatedQuantity: 1,
              createdAt: 1705962000,
              updatedAt: 1705962000,
            },
          },
        },
      },
      description: 'File details retrieved successfully',
    },
    404: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
          example: {
            success: false,
            error: 'File not found',
          },
        },
      },
      description: 'File not found',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
      description: 'Server error',
    },
  },
};

// Get all uploaded files documentation
export const getUploadedFilesDoc = {
  summary: 'Get all uploaded files',
  description:
    'Retrieve a list of all uploaded STL files for the authenticated user with their estimates.',
  tags: ['Printer'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: resolver(
            UploadedFilesListResponseSchema,
          ) as unknown as OpenAPISchema,
          example: {
            success: true,
            message: 'Files retrieved successfully',
            count: 2,
            data: [
              {
                id: 1,
                publicFileServiceId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                fileName: 'dragon-model.stl',
                fileURL:
                  'https://s3.amazonaws.com/slant3d-files/dragon-model.stl',
                dimensionX: 120.5,
                dimensionY: 85.3,
                dimensionZ: 45.2,
                volume: 45230.5,
                weight: 15.8,
                surfaceArea: 12450.2,
                defaultFilamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
                estimatedCost: 12.5,
                estimatedQuantity: 1,
                createdAt: 1705962000,
                updatedAt: 1705962000,
              },
              {
                id: 2,
                publicFileServiceId: 'b2c3d4e5-f6g7-8901-bcde-fg2345678901',
                fileName: 'cube-model.stl',
                fileURL:
                  'https://s3.amazonaws.com/slant3d-files/cube-model.stl',
                dimensionX: 50.0,
                dimensionY: 50.0,
                dimensionZ: 50.0,
                volume: 125000.0,
                weight: 5.0,
                surfaceArea: 15000.0,
                defaultFilamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
                estimatedCost: 5.25,
                estimatedQuantity: 1,
                createdAt: 1705961000,
                updatedAt: 1705961000,
              },
            ],
          },
        },
      },
      description: 'Files retrieved successfully',
    },
    500: {
      content: {
        'application/json': {
          schema: resolver(ErrorSchema) as unknown as OpenAPISchema,
        },
      },
      description: 'Server error',
    },
  },
};
