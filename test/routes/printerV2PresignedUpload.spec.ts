import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockEnv } from '../mocks/env';

const authHeaders = {
  Cookie: 'better-auth.session_token=mock-session-token',
};

describe('POST /v2/presigned-upload', () => {
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    env = mockEnv();
    vi.clearAllMocks();
  });

  test('should return 401 when not authenticated', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
      }),
    });

    const response = await app.fetch(request, env);

    expect(response.status).toBe(401);
  });

  test('should generate presigned URL successfully for valid STL file', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/test-file.stl',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'test-file',
          ownerId: 'user_123',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
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

    // Verify the fetch call was made with the session user ID as ownerId
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
          ownerId: 'user_123',
        }),
      }),
    );
  });

  test('should use authenticated user ID as ownerId (ignores any client-supplied ownerId)', async () => {
    const mockSlant3DResponse = {
      data: {
        presignedUrl: 'https://s3.amazonaws.com/bucket/key?signature=xyz',
        key: 'uploads/my-file.stl',
        filePlaceholder: {
          publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          name: 'my-file',
          ownerId: 'user_123',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'my-file.stl',
        ownerId: 'attacker-supplied-owner',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify session user ID was used, not the client-supplied value
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          name: 'my-file',
          platformId: 'test-platform-id',
          ownerId: 'user_123',
        }),
      }),
    );
  });

  test('should return 400 for missing fileName', async () => {
    const request = new Request('http://localhost/v2/presigned-upload', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: '',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.obj',
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
          ownerId: 'user_123',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.STL',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'test-file.stl',
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
        ...authHeaders,
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
          ownerId: 'user_123',
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
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: 'my-model.stl',
      }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify .stl extension was stripped and session user ID was used as ownerId
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          name: 'my-model',
          platformId: 'test-platform-id',
          ownerId: 'user_123',
        }),
      }),
    );
  });
});

describe('POST /v2/confirm', () => {
  let env: ReturnType<typeof mockEnv>;

  beforeEach(() => {
    env = mockEnv();
    vi.clearAllMocks();
  });

  test('should return 401 when not authenticated', async () => {
    const request = new Request('http://localhost/v2/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filePlaceholder: { publicFileServiceId: 'abc' },
      }),
    });

    const response = await app.fetch(request, env);

    expect(response.status).toBe(401);
  });

  test('should confirm upload successfully when authenticated', async () => {
    const mockSlant3DResponse = {
      data: {
        publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        name: 'test-file',
        fileURL: 'https://slant3d.com/files/test-file.stl',
        STLMetrics: {
          dimensionX: 100,
          dimensionY: 50,
          dimensionZ: 25,
          volume: 125000,
          weight: 100,
          surfaceArea: 30000,
        },
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSlant3DResponse,
    } as Response);

    const filePlaceholder = {
      publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: 'test-file',
      ownerId: 'user_123',
      platformId: 'test-platform-id',
      type: 'stl',
    };

    const request = new Request('http://localhost/v2/confirm', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filePlaceholder }),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.publicFileServiceId).toBe(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    );
    expect(data.data.fileURL).toBe('https://slant3d.com/files/test-file.stl');
  });

  test('should return 400 when filePlaceholder is missing', async () => {
    const request = new Request('http://localhost/v2/confirm', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const response = await app.fetch(request, env);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('filePlaceholder is required');
  });
});
