import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockInsert } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

// Mock STL file content for testing
const MOCK_STL_CONTENT =
  'solid test\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid';

const authHeaders = {
  Cookie: 'better-auth.session_token=mock-session-token',
};

describe('Printer V2 Upload Routes', () => {
  describe('POST /v2/upload', () => {
    let env: ReturnType<typeof mockEnv>;

    beforeEach(() => {
      env = mockEnv();
      vi.clearAllMocks();
    });

    test('should return 401 when not authenticated', async () => {
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

      expect(response.status).toBe(401);
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

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('files/direct-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('files/confirm-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/estimate')) {
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
      global.fetch = fetchMock;

      // Create a mock STL file
      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });

      // Create form data
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        headers: authHeaders,
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

      const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(calledUrls).toContain(
        'https://slant3dapi.com/v2/api/files/direct-upload',
      );
      expect(calledUrls).toContain(
        'https://slant3dapi.com/v2/api/files/confirm-upload',
      );
      expect(
        calledUrls.some(url => url.includes('/files/') && url.includes('/estimate')),
      ).toBe(true);
      expect(
        calledUrls.some(url => url.includes('/v2/presigned-upload')),
      ).toBe(false);
      expect(calledUrls.some(url => url.includes('/v2/confirm'))).toBe(false);
      expect(calledUrls.some(url => url.includes('/v2/estimate'))).toBe(false);
    });

    test('should reject non-STL file types', async () => {
      // Create a mock non-STL file
      const file = new File(['not an stl'], 'test.txt', { type: 'text/plain' });

      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('File validation failed');
    });

    test('should reject empty STL files', async () => {
      const file = new File([], 'empty.stl', { type: 'model/stl' });

      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('File validation failed');
      expect(data.details).toBe('File is empty');
    });

    test('should reject oversized STL files', async () => {
      const file = new File([new Uint8Array(100 * 1024 * 1024 + 1)], 'large.stl', {
        type: 'model/stl',
      });

      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('File validation failed');
      expect(data.details).toBe('File is too large (max 100MB)');
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
        if (url.includes('files/direct-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('files/confirm-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/estimate')) {
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
        headers: authHeaders,
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
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe('No file uploaded');
    });

    test('should return 500 when SLANT_PLATFORM_ID is missing', async () => {
      const envWithoutPlatformId = {
        ...env,
        SLANT_PLATFORM_ID: '',
      };
      global.fetch = vi.fn();

      const file = new File([MOCK_STL_CONTENT], 'test-model.stl', {
        type: 'model/stl',
      });
      const formData = new FormData();
      formData.append('file', file);

      const request = new Request('http://localhost/v2/upload', {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, envWithoutPlatformId);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Missing SLANT_PLATFORM_ID environment variable.');
      expect(global.fetch).not.toHaveBeenCalled();
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
        if (url.includes('files/direct-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
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
        headers: authHeaders,
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
        if (url.includes('files/direct-upload')) {
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
        headers: authHeaders,
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
        if (url.includes('files/direct-upload')) {
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
        headers: authHeaders,
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
        headers: authHeaders,
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
        if (url.includes('files/direct-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockPresignedData),
            json: async () => mockPresignedData,
          } as Response);
        }
        if (url.includes('files/confirm-upload')) {
          return Promise.resolve({
            ok: true,
            text: async () => JSON.stringify(mockConfirmData),
            json: async () => mockConfirmData,
          } as Response);
        }
        if (url.includes('/estimate')) {
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
        headers: authHeaders,
        body: formData,
      });

      const response = await app.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });
  });
});
