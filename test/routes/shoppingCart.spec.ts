import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import {
  mockDrizzle,
  mockInsert,
  mockQuery,
  mockUpdate,
  mockWhere,
} from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

// Mock the profile crypto utilities
vi.mock('../../src/utils/profileCrypto', () => ({
  getCipherKitSecretKey: vi.fn().mockResolvedValue('mock-secret-key'),
  decryptStoredProfileValue: vi
    .fn()
    .mockImplementation(async (value: string | null) => value),
  decryptStoredShippingProfile: vi
    .fn()
    .mockImplementation(async (userRow: Record<string, string>) => ({
      email: userRow.email || '',
      firstName: userRow.firstName || '',
      lastName: userRow.lastName || '',
      shippingAddress: userRow.shippingAddress || '',
      city: userRow.city || '',
      state: userRow.state || '',
      zipCode: userRow.zipCode || '',
      phone: userRow.phone || '',
    })),
}));

// Mock generateOrderNumber
vi.mock('../../src/utils/generateOrderNumber', () => ({
  generateOrderNumber: vi.fn(() => 'ORDER-123456'),
}));

const mockCartId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const mockUserId = 1;

const env = mockEnv();

describe('Shopping Cart Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mock functions
    mockWhere.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();

    // Mock external fetch for shipping API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          shippingCost: 15.99,
          currencyCode: 'USD',
        }),
    } as Response);
  });
  describe('POST /cart/create', () => {
    test('creates a new cart successfully', async () => {
      const res = await app.fetch(
        new Request('http://localhost/cart/create', {
          method: 'POST',
        }),
        env,
      );

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('cartId');
      expect(data).toHaveProperty('message', 'Cart created successfully');
      expect(data.cartId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ); // UUID format
    });
  });

  describe('GET /cart/:cartId', () => {
    test('retrieves cart items successfully', async () => {
      const mockCartItems = [
        {
          id: 1,
          cartId: mockCartId,
          skuNumber: 'TEST-SKU-001',
          quantity: 2,
          color: '#ff0000',
          filamentType: 'PLA',
          name: 'Test Product 1',
          price: 19.99,
          stripePriceId: 'price_test1',
        },
        {
          id: 2,
          cartId: mockCartId,
          skuNumber: 'TEST-SKU-002',
          quantity: 1,
          color: '#00ff00',
          filamentType: 'PETG',
          name: 'Test Product 2',
          price: 29.99,
          stripePriceId: 'price_test2',
        },
      ];

      mockWhere.mockResolvedValueOnce(mockCartItems);

      const request = new Request(`http://localhost/cart/${mockCartId}`, {
        method: 'GET',
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('items');
      expect(data).toHaveProperty('total');
      expect(data.items).toHaveLength(2);
      expect(data.total).toBe(69.97); // (19.99 * 2) + (29.99 * 1)
      expect(data.items[0]).toMatchObject({
        id: 1,
        productId: 'TEST-SKU-001',
        quantity: 2,
        color: '#ff0000',
        filamentType: 'PLA',
        name: 'Test Product 1',
        price: 19.99,
      });
    });

    test('returns empty cart when no items found', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const request = new Request(`http://localhost/cart/${mockCartId}`, {
        method: 'GET',
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.items).toHaveLength(0);
      expect(data.total).toBe(0);
    });
  });

  describe('POST /cart/add', () => {
    test('returns validation error for invalid data', async () => {
      const invalidItem = {
        cartId: 'invalid-uuid',
        skuNumber: 'TEST-SKU-001',
        quantity: -1, // Invalid negative quantity
        color: '#ff0000',
        filamentType: 'PLA',
      };

      const request = new Request('http://localhost/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidItem),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(400);
    });
  });

  describe('GET /cart/:cartId/stripe-items', () => {
    test('returns Stripe formatted items successfully', async () => {
      const mockStripeItems = [
        {
          stripePriceId: 'price_test1',
          quantity: 2,
        },
        {
          stripePriceId: 'price_test2',
          quantity: 1,
        },
      ];

      mockWhere.mockResolvedValueOnce(mockStripeItems);

      const request = new Request(
        `http://localhost/cart/${mockCartId}/stripe-items`,
        {
          method: 'GET',
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('line_items');
      expect(data.line_items).toHaveLength(2);
      expect(data.line_items[0]).toMatchObject({
        price: 'price_test1',
        quantity: 2,
      });
    });

    test('returns 404 when no items with Stripe price IDs found', async () => {
      // Mock items without Stripe price IDs
      mockWhere.mockResolvedValueOnce([
        {
          stripePriceId: null,
          quantity: 1,
        },
      ]);

      const request = new Request(
        `http://localhost/cart/${mockCartId}/stripe-items`,
        {
          method: 'GET',
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBe('No items with Stripe price IDs found');
    });

    test('returns 404 when cart is empty', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const request = new Request(
        `http://localhost/cart/${mockCartId}/stripe-items`,
        {
          method: 'GET',
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBe('No items with Stripe price IDs found');
    });
  });

  describe('GET /cart/shipping (authenticated)', () => {
    test('returns shipping estimate successfully', async () => {
      // Mock user query (first database call)
      mockWhere.mockResolvedValueOnce([
        {
          id: mockUserId,
          email: 'test@example.com',
          firstName: 'encrypted-test',
          lastName: 'encrypted-user',
          shippingAddress: 'encrypted-123-main-st',
          city: 'encrypted-testville',
          state: 'encrypted-ts',
          zipCode: 'encrypted-12345',
          country: 'encrypted-usa',
          phone: 'encrypted-123-456-7890',
        },
      ]);

      // Mock cart items query (second database call)
      mockWhere.mockResolvedValueOnce([
        {
          id: 1,
          skuNumber: 'TEST-SKU-001',
          quantity: 2,
          color: '#ff0000',
          filamentType: 'PLA',
          productName: 'Test Product',
          stl: 'http://example.com/test.stl',
        },
      ]);

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          headers: {
            Cookie: 'token=s.mocked.signed.cookie',
          },
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('shippingCost', 15.99);
    });

    test('returns 400 when cartId is missing', async () => {
      const request = new Request('http://localhost/cart/shipping', {
        method: 'GET',
        headers: {
          Cookie: 'token=s.mocked.signed.cookie',
        },
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe('cartId query param required');
    });

    test('returns 401 when not authenticated', async () => {
      mockBetterAuth.getSession.mockResolvedValueOnce(null);

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          // No authentication cookie
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(401);
    });

    test('returns 404 when cart is empty', async () => {
      // Mock user data
      mockWhere
        .mockResolvedValueOnce([
          {
            id: mockUserId,
            email: 'test@example.com',
            firstName: 'encrypted-test',
            lastName: 'encrypted-user',
            shippingAddress: 'encrypted-123-main-st',
            city: 'encrypted-testville',
            state: 'encrypted-ts',
            zipCode: 'encrypted-12345',
            country: 'encrypted-usa',
            phone: 'encrypted-123-456-7890',
          },
        ])
        .mockResolvedValueOnce([]); // Empty cart

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          headers: {
            Cookie: 'token=s.mocked.signed.cookie',
          },
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Cart empty or not found');
    });

    test('returns 404 when user not found', async () => {
      // Mock empty user result
      mockWhere.mockResolvedValueOnce([]);

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          headers: {
            Cookie: 'token=s.mocked.signed.cookie',
          },
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBe('User not found');
    });

    test('handles upstream shipping API failure', async () => {
      // Mock user and cart data
      mockWhere
        .mockResolvedValueOnce([
          {
            id: mockUserId,
            email: 'test@example.com',
            firstName: 'encrypted-test',
            lastName: 'encrypted-user',
            shippingAddress: 'encrypted-123-main-st',
            city: 'encrypted-testville',
            state: 'encrypted-ts',
            zipCode: 'encrypted-12345',
            country: 'encrypted-usa',
            phone: 'encrypted-123-456-7890',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 1,
            skuNumber: 'TEST-SKU-001',
            quantity: 2,
            color: '#ff0000',
            filamentType: 'PLA',
            productName: 'Test Product',
            stl: 'http://example.com/test.stl',
          },
        ]);

      // Mock failed shipping API response
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          headers: {
            Cookie: 'token=s.mocked.signed.cookie',
          },
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(502);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Upstream estimate failed');
    });

    test('returns 403 when cart is owned by a different user', async () => {
      // Mock user query
      mockWhere.mockResolvedValueOnce([
        {
          id: mockUserId,
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          shippingAddress: '123 Main St',
          city: 'Testville',
          state: 'TS',
          zipCode: '12345',
          country: 'US',
          phone: '123-456-7890',
        },
      ]);

      // Mock cart items query returning items owned by a different user
      mockWhere.mockResolvedValueOnce([
        {
          id: 1,
          cartUserId: 'different_user_456',
          skuNumber: 'TEST-SKU-001',
          quantity: 1,
          color: '#ff0000',
          filamentType: 'PLA',
          productName: 'Test Product',
          stl: 'http://example.com/test.stl',
        },
      ]);

      const request = new Request(
        `http://localhost/cart/shipping?cartId=${mockCartId}`,
        {
          method: 'GET',
          headers: {
            Cookie: 'token=s.mocked.signed.cookie',
          },
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Forbidden');
    });
  });

  describe('POST /cart/:cartId/payment-intent (authenticated)', () => {
    test('returns 401 when not authenticated', async () => {
      mockBetterAuth.getSession.mockResolvedValueOnce(null);

      const request = new Request(
        `http://localhost/cart/${mockCartId}/payment-intent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerEmail: 'test@example.com' }),
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(401);
    });

    test('returns 403 when cart is owned by a different user', async () => {
      // Cart items returned include a cartUserId that belongs to a different user
      mockWhere.mockResolvedValueOnce([
        {
          cartUserId: 'different_user_456',
          stripePriceId: 'price_test1',
          quantity: 1,
          price: 19.99,
          name: 'Test Product',
        },
      ]);

      const request = new Request(
        `http://localhost/cart/${mockCartId}/payment-intent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'token=s.mocked.signed.cookie',
          },
          body: JSON.stringify({ customerEmail: 'test@example.com' }),
        },
      );

      const res = await app.fetch(request, env);

      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Forbidden');
    });
  });

  describe('PUT /cart/update (ownership enforcement)', () => {
    test('returns 403 when cart is owned by a different authenticated user', async () => {
      // findMany returns items owned by a different user
      mockQuery.cart.findMany.mockResolvedValueOnce([
        { id: 1, cartId: mockCartId, userId: 'different_user_456', quantity: 2 },
      ]);

      const request = new Request('http://localhost/cart/update', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'token=s.mocked.signed.cookie',
        },
        body: JSON.stringify({
          cartId: mockCartId,
          itemId: 1,
          quantity: 3,
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Forbidden');
    });

    test('returns 401 when cart is owned but caller is not authenticated', async () => {
      // findMany returns items with an owner, but no auth cookie is provided
      mockQuery.cart.findMany.mockResolvedValueOnce([
        { id: 1, cartId: mockCartId, userId: 'user_123', quantity: 2 },
      ]);

      const request = new Request('http://localhost/cart/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: mockCartId,
          itemId: 1,
          quantity: 3,
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Unauthorized');
    });
  });

  describe('DELETE /cart/remove (ownership enforcement)', () => {
    test('returns 403 when cart is owned by a different authenticated user', async () => {
      // Ownership check select returns an item owned by a different user
      mockWhere.mockResolvedValueOnce([{ userId: 'different_user_456' }]);

      const request = new Request('http://localhost/cart/remove', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'token=s.mocked.signed.cookie',
        },
        body: JSON.stringify({
          cartId: mockCartId,
          itemId: 1,
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Forbidden');
    });

    test('returns 401 when cart is owned but caller is not authenticated', async () => {
      // Ownership check select returns an item with an owner, but no auth cookie
      mockWhere.mockResolvedValueOnce([{ userId: 'user_123' }]);

      const request = new Request('http://localhost/cart/remove', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: mockCartId,
          itemId: 1,
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Unauthorized');
    });
  });
});
