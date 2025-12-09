import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockEnv } from '../mocks/env';

describe('POST /v2/presigned-upload', () => {
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    env = mockEnv();
    vi.clearAllMocks();
  });

  test('should generate presigned URL successfully for valid STL file', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/test-file.stl',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-file',
          ownerId: 'test-owner',
          platformId: 'test-platform-id',
          type: 'stl',
          createdAt: '2025-12-09T07:00:00Z',
          updatedAt: '2025-12-09T07:00:00Z',
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSlant3DResponse,
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toContain('Presigned URL generated successfully');
    expect(data.data.presignedUrl).toBe(mockSlant3DResponse.data.presignedUrl);
    expect(data.data.key).toBe(mockSlant3DResponse.data.key);
    expect(data.data.filePlaceholder).toEqual(
      mockSlant3DResponse.data.filePlaceholder,
    );

    // Verify the fetch call was made correctly
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('files/direct-upload'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer fake-api-key-v2',
        }),
        body: JSON.stringify({
          name: 'test-file',
          platformId: 'test-platform-id',
          ownerId: 'test-owner',
        }),
      }),
    );
  });

  test('should use anonymous ownerId when not provided', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/anonymous-file.stl',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'anonymous-file',
          ownerId: 'anonymous',
          platformId: 'test-platform-id',
          type: 'stl',
          createdAt: '2025-12-09T07:00:00Z',
          updatedAt: '2025-12-09T07:00:00Z',
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSlant3DResponse,
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'anonymous-file.stl',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify anonymous was used as ownerId
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          name: 'anonymous-file',
          platformId: 'test-platform-id',
          ownerId: 'anonymous',
        }),
      }),
    );
  });

  test('should return 400 for missing fileName', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('fileName is required');
  });

  test('should return 400 for empty fileName', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: '',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('fileName is required');
  });

  test('should return 400 for non-STL file', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.obj',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Invalid file type. Only STL files are supported.');
  });

  test('should handle STL file extension case-insensitively', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/test-file.STL',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-file',
          ownerId: 'test-owner',
          platformId: 'test-platform-id',
          type: 'stl',
          createdAt: '2025-12-09T07:00:00Z',
          updatedAt: '2025-12-09T07:00:00Z',
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSlant3DResponse,
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.STL',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test('should return 500 when SLANT_PLATFORM_ID is missing', async () => {
    // Create env without SLANT_PLATFORM_ID
    const envWithoutPlatformId = {
      ...env,
      SLANT_PLATFORM_ID: '',
    };

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, envWithoutPlatformId);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Missing SLANT_PLATFORM_ID environment variable.');
  });

  test('should return 500 when Slant3D API returns error', async () => {
    const errorResponse = {
      error: 'API Error',
      details: { message: 'Invalid platform ID' },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify(errorResponse),
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe(
      'Failed to generate presigned URL from Slant3D V2 API',
    );
    expect(data.details).toEqual(errorResponse);
    expect(data.status).toBe(403);
  });

  test('should handle Slant3D API network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Failed to generate presigned URL');
    expect(data.details).toBe('Network error');
  });

  test('should handle invalid JSON response from Slant3D API', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe(
      'Failed to generate presigned URL from Slant3D V2 API',
    );
    expect(data.details).toBe('Internal Server Error');
  });

  test('should return 400 for invalid request body', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: 'invalid json',
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('Failed to parse request JSON');
  });

  test('should strip .stl extension from file name when calling Slant3D API', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/my-model.stl',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'my-model',
          ownerId: 'test-owner',
          platformId: 'test-platform-id',
          type: 'stl',
          createdAt: '2025-12-09T07:00:00Z',
          updatedAt: '2025-12-09T07:00:00Z',
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSlant3DResponse,
    } as Response);

    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'my-model.stl',
        ownerId: 'test-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify .stl extension was stripped
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          name: 'my-model',
          platformId: 'test-platform-id',
          ownerId: 'test-owner',
        }),
      }),
    );
  });
});
