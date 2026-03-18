import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import {
  capturedInserts,
  mockAll,
  mockDelete,
  mockInsert,
  mockUpdate,
  mockWhere,
} from '../mocks/drizzle';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

// Mock Stripe to prevent network calls
vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      products: {
        create: vi.fn().mockResolvedValue({
          id: 'prod_test123',
          name: 'Test Product',
          description: 'Test Description',
        }),
      },
      prices: {
        create: vi.fn().mockResolvedValue({
          id: 'price_test123',
          product: 'prod_test123',
          unit_amount: 1000,
          currency: 'usd',
        }),
      },
    })),
  };
});

// This cookie value matches what your mockAuth is expecting
const fakeSignedCookie = 'token=s.mocked.signed.cookie';

function mockSessionRole(role: string) {
  mockBetterAuth.getSession.mockImplementationOnce(
    async ({ headers }: { headers?: Headers }) => {
      const cookie = headers?.get('cookie') || headers?.get('Cookie');
      const authorization = headers?.get('authorization');

      if (!cookie && !authorization) {
        return null;
      }

      return {
        session: {
          id: 'session_123',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        user: {
          id: 'user_123',
          email: 'test@example.com',
          name: 'Test User',
          role,
        },
      };
    },
  );

  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValueOnce({
      id: 'org_shared_catalog',
      name: '3D Printer Web API',
      slug: '3dprinter-web-api',
    }),
  });

  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValueOnce({
      id: 'member:org_shared_catalog:user_123',
      organizationId: 'org_shared_catalog',
      userId: 'user_123',
      role,
      createdAt: new Date(),
    }),
  });
}

function mockV2AddProductDependencies() {
  const stlBuffer = new TextEncoder().encode('solid test').buffer;

  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://uploads.example.com/test-file.stl') {
        return {
          ok: true,
          arrayBuffer: async () => stlBuffer,
        } as Response;
      }

      if (url.includes('files/direct-upload')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              presignedUrl: 'https://upload.example.com/presigned',
              filePlaceholder: {
                publicFileServiceId: 'file_123',
                name: 'Test Product',
                ownerId: 'user_123',
                platformId: 'platform_123',
                type: 'stl',
                createdAt: '2026-03-12T00:00:00.000Z',
                updatedAt: '2026-03-12T00:00:00.000Z',
              },
            },
          }),
        } as Response;
      }

      if (url === 'https://upload.example.com/presigned') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
        } as Response;
      }

      if (url.includes('files/confirm-upload')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              publicFileServiceId: 'file_123',
            },
          }),
        } as Response;
      }

      if (url.includes('/estimate')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              total: 10,
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    },
  );
}

describe('Product Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedInserts.length = 0;
  });

  test('GET /products returns list of products', async () => {
    mockAll.mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]);

    const request = new Request('http://localhost/products', {
      method: 'GET',
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: number; name: string }[];
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toMatchObject({ id: 1 });
  });

  test('GET /product/:id returns single product', async () => {
    mockWhere.mockReturnValueOnce({
      all: vi.fn().mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]),
      get: vi.fn().mockResolvedValueOnce({ id: 1, name: 'Test Product' }),
      orderBy: vi.fn(() => ({
        all: vi.fn().mockResolvedValueOnce([]),
      })),
    });

    const request = new Request('http://localhost/product/1', {
      method: 'GET',
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: number };
    expect(data).toMatchObject({ id: 1 });
  });

  test('GET /product/:id returns 404 if not found', async () => {
    mockWhere.mockReturnValueOnce({
      all: vi.fn().mockResolvedValueOnce([]),
      get: vi.fn().mockResolvedValueOnce(undefined),
      orderBy: vi.fn(() => ({
        all: vi.fn().mockResolvedValueOnce([]),
      })),
    });

    const request = new Request('http://localhost/product/999', {
      method: 'GET',
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  test('GET /products/search is public', async () => {
    const request = new Request('http://localhost/products/search?q=a', {
      method: 'GET',
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('at least 2 characters');
  });

  test('POST /add-product returns 401 when not authenticated', async () => {
    const request = new Request('http://localhost/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'New Product',
        description: 'desc',
        stl: 'url/to.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(401);
  });

  test('POST /add-product adds a product without categories', async () => {
    mockSessionRole('admin');
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { price: 10 },
      }),
    });

    mockInsert.mockResolvedValueOnce([{ id: 1 }]);
    const request = new Request('http://localhost/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'New Product',
        description: 'desc',
        stl: 'url/to.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ id: number }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toHaveProperty('id');
    // One insert for product only; no join rows because categoryIds omitted
    expect(capturedInserts.length).toBe(1);
    // Inserted product should have null categoryId during transition
    const [productInsertOnly] = capturedInserts as Array<{
      categoryId: number | null;
    }>;
    expect(productInsertOnly).toHaveProperty('categoryId', null);
  });

  test('POST /add-product handles slicer API failure', async () => {
    mockSessionRole('admin');
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        message: 'slicer failed',
      }),
    });

    const request = new Request('http://localhost/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'Bad Product',
        description: 'desc',
        stl: 'url/to.stl',
        image: 'url/to/image.jpg',
        price: 15,
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Failed to slice file');
  });

  test('POST /add-product adds a product with multiple categories', async () => {
    mockSessionRole('admin');
    (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { price: 12 },
      }),
    });

    mockInsert.mockResolvedValueOnce([{ id: 42 }]);

    const request = new Request('http://localhost/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'Categorized Product',
        description: 'desc',
        stl: 'url/to.stl',
        price: 25,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#123456',
        categoryIds: [2, 3, 5],
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ id: number }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toHaveProperty('id');

    // First insert is product; second insert is batch insert of join rows
    expect(capturedInserts.length).toBe(2);
    const [productInsert, batchJoinInsert] = capturedInserts as unknown as [
      { id?: number; categoryId: number | null },
      Array<{ productId: number; categoryId: number; orderIndex: number }>,
    ];
    expect(productInsert).toMatchObject({ categoryId: 2 });
    // Batch insert should contain all three category joins
    expect(Array.isArray(batchJoinInsert)).toBe(true);
    expect(batchJoinInsert.length).toBe(3);
    const joinCategoryIds = batchJoinInsert.map(v => v.categoryId);
    expect(joinCategoryIds).toEqual([2, 3, 5]);
  });

  test('PUT /update-product updates a product', async () => {
    mockSessionRole('admin');
    mockUpdate.mockResolvedValueOnce({ success: true });
    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValueOnce({ id: 1 }),
    });

    const request = new Request('http://localhost/update-product', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        id: 1,
        name: 'Updated Product',
        description: 'Updated desc',
        price: 20,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#000000',
        stl: 'url/to/updated.stl',
        skuNumber: 'SKU123',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  test('PUT /update-product validation error returns 400', async () => {
    mockSessionRole('admin');
    const request = new Request('http://localhost/update-product', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({}),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(400);
    const data = (await res.json()) as { success?: boolean; error?: unknown };
    expect(data).toHaveProperty('error');
  });

  test('PUT /update-product returns 401 when not authenticated', async () => {
    const request = new Request('http://localhost/update-product', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 1,
        name: 'Updated Product',
        description: 'Updated desc',
        price: 20,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#000000',
        stl: 'url/to/updated.stl',
        skuNumber: 'SKU123',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(401);
  });

  test('DELETE /delete-product/:id deletes a product', async () => {
    mockSessionRole('admin');
    mockDelete.mockResolvedValueOnce({ changes: 1 });

    const request = new Request('http://localhost/delete-product/1', {
      method: 'DELETE',
      headers: {
        Cookie: fakeSignedCookie,
      },
    });

    expect(request.method).toBe('DELETE');

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean };
    expect(data.success).toBe(true);
  });

  test('DELETE /delete-product/:id returns 401 when not authenticated', async () => {
    const request = new Request('http://localhost/delete-product/1', {
      method: 'DELETE',
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(401);
  });

  test('POST /add-category returns 401 when not authenticated', async () => {
    const request = new Request('http://localhost/add-category', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ categoryName: 'Accessories' }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(401);
  });

  test('POST /add-product returns 403 for authenticated non-admin users', async () => {
    const request = new Request('http://localhost/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'New Product',
        description: 'desc',
        stl: 'url/to.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('POST /v2/add-product returns 403 for authenticated non-admin users', async () => {
    const request = new Request('http://localhost/v2/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'New Product',
        description: 'desc',
        stl: 'https://uploads.example.com/test-file.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('POST /v2/add-product allows admin users', async () => {
    mockSessionRole('admin');
    mockV2AddProductDependencies();
    mockInsert.mockResolvedValueOnce([
      {
        id: 7,
        name: 'V2 Product',
        price: 15,
        skuNumber: 'SKU-V2',
      },
    ]);

    const request = new Request('http://localhost/v2/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'V2 Product',
        description: 'desc',
        stl: 'https://uploads.example.com/test-file.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    const data = (await res.json()) as {
      success: boolean;
      product: { id: number; publicFileServiceId: string };
    };

    expect(res.status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.product).toMatchObject({
      id: 7,
      publicFileServiceId: 'file_123',
    });
  });

  test('POST /v2/add-product rejects untrusted STL host', async () => {
    mockSessionRole('admin');
    mockV2AddProductDependencies();

    const request = new Request('http://localhost/v2/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'V2 Product',
        description: 'desc',
        stl: 'https://evil.example.com/malicious.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/invalid stl url/i);
  });

  test('POST /v2/add-product rejects non-https STL URL', async () => {
    mockSessionRole('admin');
    mockV2AddProductDependencies();

    const request = new Request('http://localhost/v2/add-product', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        name: 'V2 Product',
        description: 'desc',
        stl: 'http://uploads.example.com/file.stl',
        price: 15,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#ffffff',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/invalid stl url/i);
  });

  test('PUT /update-product returns 403 for authenticated non-admin users', async () => {
    const request = new Request('http://localhost/update-product', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({
        id: 1,
        name: 'Updated Product',
        description: 'Updated desc',
        price: 20,
        image: 'url/to/image.jpg',
        filamentType: 'PLA',
        color: '#000000',
        stl: 'url/to/updated.stl',
        skuNumber: 'SKU123',
      }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(403);
  });

  test('DELETE /delete-product/:id returns 403 for authenticated non-admin users', async () => {
    const request = new Request('http://localhost/delete-product/1', {
      method: 'DELETE',
      headers: {
        Cookie: fakeSignedCookie,
      },
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(403);
  });

  test('POST /add-category returns 403 for authenticated non-admin users', async () => {
    const request = new Request('http://localhost/add-category', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({ categoryName: 'Accessories' }),
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(403);
  });

  test('POST /add-category allows admin users', async () => {
    mockSessionRole('admin');
    mockInsert.mockResolvedValueOnce([
      { categoryId: 1, categoryName: 'Accessories' },
    ]);

    const request = new Request('http://localhost/add-category', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: fakeSignedCookie,
      },
      body: JSON.stringify({ categoryName: 'Accessories' }),
    });

    const res = await app.fetch(request, mockEnv());
    const data = (await res.json()) as Array<{
      categoryId: number;
      categoryName: string;
    }>;

    expect(res.status).toBe(200);
    expect(data[0]).toMatchObject({
      categoryId: 1,
      categoryName: 'Accessories',
    });
  });
});
