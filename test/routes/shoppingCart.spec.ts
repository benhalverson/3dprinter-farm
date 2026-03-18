import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import {
  mockDrizzle,
  mockInsert,
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

// Mock Stripe for payment-intent tests
const mockPaymentIntentsCreate = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
    },
  })),
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
  });

  describe('POST /cart/:cartId/payment-intent', () => {
    beforeEach(() => {
      mockPaymentIntentsCreate.mockReset();
    });

    test('creates payment intent using authenticated user id (ignores client-supplied userId)', async () => {
      // Cart items with prices
      mockWhere.mockResolvedValueOnce([
        {
          stripePriceId: 'price_test1',
          quantity: 2,
          price: 19.99,
          name: 'Test Product',
        },
      ]);

      mockPaymentIntentsCreate.mockResolvedValueOnce({
        client_secret: 'pi_test_secret_123',
        id: 'pi_test_123',
      });

      // Client supplies a spoofed userId — should be ignored
      const res = await app.fetch(
        new Request(`http://localhost/cart/${mockCartId}/payment-intent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=mock-session-token',
          },
          body: JSON.stringify({ userId: 'spoofed-attacker-id' }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('clientSecret', 'pi_test_secret_123');

      // Verify Stripe was called with the authenticated user's ID (user_123),
      // NOT the spoofed attacker ID
      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            userId: 'user_123',
          }),
        }),
      );
      const callArg = mockPaymentIntentsCreate.mock.calls[0][0];
      expect(callArg.metadata.userId).not.toBe('spoofed-attacker-id');
    });

    test('creates payment intent using authenticated user id when no userId in body', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          stripePriceId: 'price_test1',
          quantity: 1,
          price: 9.99,
          name: 'Test Product',
        },
      ]);

      mockPaymentIntentsCreate.mockResolvedValueOnce({
        client_secret: 'pi_test_secret_456',
        id: 'pi_test_456',
      });

      const res = await app.fetch(
        new Request(`http://localhost/cart/${mockCartId}/payment-intent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=mock-session-token',
          },
          body: JSON.stringify({}),
        }),
        env,
      );

      expect(res.status).toBe(200);

      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            userId: 'user_123',
          }),
        }),
      );
    });

    test('returns 404 when cart is empty', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request(`http://localhost/cart/${mockCartId}/payment-intent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'better-auth.session_token=mock-session-token',
          },
          body: JSON.stringify({}),
        }),
        env,
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Cart is empty');
    });
  });
});
