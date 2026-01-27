import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockInsert } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

// Mock STL file content for testing
const MOCK_STL_CONTENT =
  'solid test\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid';

describe('Printer V2 Upload Routes', () => {
  describe('POST /v2/upload', () => {
    let env: ReturnType<typeof mockEnv>;

    beforeEach(() => {
      env = mockEnv();
      vi.clearAllMocks();
    });

    test('should successfully upload and register STL file', async () => {
      // Configure database mock to return insert result
      mockInsert.mockResolvedValueOnce([{ id: 1 }]);

      // Mock local endpoint responses
      const mockPresignedData = {
        success: true,
        message: 'Presigned URL generated successfully',
        data: {
          presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
          key: 'uploads/test-model.stl',
          filePlaceholder: {
            publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            name: 'test-model',
            ownerId: 'test-owner',
            platformId: 'test-platform-id',
            type: 'stl',
            createdAt: '2025-12-09T07:00:00Z',
            updatedAt: '2025-12-09T07:00:00Z',
          },
        },
      };

      const mockConfirmData = {
        success: true,
        data: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-model',
          fileURL: 'https://slant3d.com/files/test-model.stl',
          STLMetrics: {
            dimensionX: 100,
            dimensionY: 100,
            dimensionZ: 50,
            weight: 25,
            volume: 500,
            surfaceArea: 1000,
          },
        },
      };

      const mockEstimateData = {
        success: true,
        data: {
          estimatedCost: 15.99,
          quantity: 1,
        },
      };

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('/v2/confirm')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/v2/estimate')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockEstimateData),
            json: async () => mockEstimateData,
          } as Response);
        }
        // For S3 presigned URL upload
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({}),
        } as Response);
      });

      // Create a mock STL file
      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });

      // Create form data
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.message).toBe(
        'File uploaded and estimate saved successfully',
      );
      expect(data.data.publicFileServiceId).toBe(
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      );
      expect(data.data.fileName).toBe('test-model.stl');
      expect(data.data.fileURL).toBe(
        'https://slant3d.com/files/test-model.stl',
      );
      expect(data.data.estimate.cost).toBe(15.99);
    });

    test('should reject non-STL file types', async () => {
      // Create a mock non-STL file
      const file = new File(['not an stl'], 'test.txt', { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('File validation failed');
    });

    test('should accept file with .stl extension even without proper MIME type', async () => {
      // Configure database mock to return insert result
      mockInsert.mockResolvedValueOnce([{ id: 1 }]);

      // Mock local endpoint responses
      const mockPresignedData = {
        success: true,
        message: 'Presigned URL generated successfully',
        data: {
          presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
          key: 'uploads/test-model.stl',
          filePlaceholder: {
            publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            name: 'test-model',
            ownerId: 'test-owner',
            platformId: 'test-platform-id',
            type: 'stl',
            createdAt: '2025-12-09T07:00:00Z',
            updatedAt: '2025-12-09T07:00:00Z',
          },
        },
      };

      const mockConfirmData = {
        success: true,
        data: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-model',
          fileURL: 'https://slant3d.com/files/test-model.stl',
          STLMetrics: {
            dimensionX: 100,
            dimensionY: 100,
            dimensionZ: 50,
            weight: 25,
            volume: 500,
            surfaceArea: 1000,
          },
        },
      };

      const mockEstimateData = {
        success: true,
        data: {
          estimatedCost: 15.99,
          quantity: 1,
        },
      };

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('/v2/confirm')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/v2/estimate')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockEstimateData),
            json: async () => mockEstimateData,
          } as Response);
        }
        // For S3 presigned URL upload
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({}),
        } as Response);
      });

      // Create a file with .stl extension but no proper MIME type
      const file = new File([MOCK_STL_CONTENT], 'test-model.STL', {
        type: 'application/octet-stream',
      });

      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });

    test('should return 400 when no file is uploaded', async () => {
      const formData = new FormData();
      // Don't append any file

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('No file uploaded');
    });

    test('should return 500 when SLANT_PLATFORM_ID is missing', async () => {
      // Mock presigned-upload endpoint to fail due to missing platform ID
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => 'Missing SLANT_PLATFORM_ID',
            json: async () => ({
              success: false,
              error: 'Missing SLANT_PLATFORM_ID',
            }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    test('should handle R2 bucket upload failures', async () => {
      // Mock presigned-upload endpoint response
      const mockPresignedData = {
        success: true,
        message: 'Presigned URL generated successfully',
        data: {
          presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
          key: 'uploads/test-model.stl',
          filePlaceholder: {
            publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          },
        },
      };

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockPresignedData,
          } as Response);
        }
        // Simulate S3 upload failure
        if (url.includes('s3.amazonaws.com')) {
          return Promise.resolve({
            ok: false,
            status: 403,
            text: async () => 'R2 upload failed',
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to upload file to S3');
    });

    test('should handle Slant3D API failures with JSON error response', async () => {
      // Mock presigned-upload to fail
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                success: false,
                error: { message: 'Invalid file format' },
              }),
            json: async () => ({
              success: false,
              error: { message: 'Invalid file format' },
            }),
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to get presigned URL');
    });

    test('should handle Slant3D API failures with text error response', async () => {
      // Mock presigned-upload to fail with text response
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: async () => 'Internal server error',
            json: async () => {
              throw new Error('Not JSON');
            },
          } as Response);
        }
        return Promise.resolve({ ok: false } as Response);
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
    });

    test('should handle network errors when calling Slant3D API', async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        throw new Error('Network error');
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to upload file');
    });

    test('should handle files with dashes in filename', async () => {
      // Configure database mock to return insert result
      mockInsert.mockResolvedValueOnce([{ id: 1 }]);

      // Mock local endpoint responses
      const mockPresignedData = {
        success: true,
        message: 'Presigned URL generated successfully',
        data: {
          presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
          key: 'uploads/test-model-v2.stl',
          filePlaceholder: {
            publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            name: 'test-model-v2',
          },
        },
      };

      const mockConfirmData = {
        success: true,
        data: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-model-v2',
          fileURL: 'https://slant3d.com/files/test-model-v2.stl',
          STLMetrics: {
            dimensionX: 100,
            dimensionY: 100,
            dimensionZ: 50,
            weight: 25,
            volume: 500,
            surfaceArea: 1000,
          },
        },
      };

      const mockEstimateData = {
        success: true,
        data: {
          estimatedCost: 15.99,
          quantity: 1,
        },
      };

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v2/presigned-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('/v2/confirm')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/v2/estimate')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockEstimateData),
            json: async () => mockEstimateData,
          } as Response);
        }
        // For S3 presigned URL upload
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({}),
        } as Response);
      });

      const file = new File([MOCK_STL_CONTENT], 'test-model-v2.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });
  });
});
