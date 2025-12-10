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

describe('Product Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedInserts.length = 0;
  });

  test('GET /products returns list of products', async () => {
    mockAll.mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]);

    const request = new Request('http://localhost/products', {
      method: 'GET',
      headers: {
        Cookie: fakeSignedCookie,
      },
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: number; name: string }[];
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toMatchObject({ id: 1 });
  });

  test('GET /product/:id returns single product', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]);

    const request = new Request('http://localhost/product/1', {
      method: 'GET',
      headers: {
        Cookie: fakeSignedCookie,
      },
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: number };
    expect(data).toMatchObject({ id: 1 });
  });

  test('GET /product/:id returns 404 if not found', async () => {
    mockWhere.mockResolvedValueOnce([]);

    const request = new Request('http://localhost/product/999', {
      method: 'GET',
      headers: {
        Cookie: fakeSignedCookie,
      },
    });

    const res = await app.fetch(request, mockEnv());

    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/not found/i);
  });

  test('POST /add-product adds a product without categories', async () => {
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
    const [productInsertOnly] = capturedInserts as Array<any>;
    expect(productInsertOnly).toHaveProperty('categoryId', null);
  });

  test('POST /add-product handles slicer API failure', async () => {
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

    // First insert is product; next three are join rows
    expect(capturedInserts.length).toBe(4);
    const [productInsert, ...joinInserts] =
      capturedInserts as unknown as Array<{
        id?: number;
        categoryId: number | null;
      }>;
    expect(productInsert).toMatchObject({ categoryId: 2 });
    // Join inserts should target the created product id and provided categoryIds
    const joinCategoryIds = joinInserts.map(v => v.categoryId);
    expect(joinCategoryIds).toEqual([2, 3, 5]);
  });

  test('PUT /update-product updates a product', async () => {
    mockUpdate.mockResolvedValueOnce({ success: true });

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
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('Validation error');
  });

  test('DELETE /delete-product/:id deletes a product', async () => {
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
});
