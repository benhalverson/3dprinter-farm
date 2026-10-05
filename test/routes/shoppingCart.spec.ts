import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import {
  capturedInserts,
  mockDelete,
  mockDrizzle,
  mockInsert,
  mockQuery,
  mockUpdate,
  mockWhere,
} from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

// This suite exercises handlers after authorization. The real authorization
// predicates and middleware are covered in cartOwnership.spec.ts.
vi.mock('../../src/modules/cartOwnership', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/modules/cartOwnership')>()),
  requireCartAccess: vi.fn(
    async (_db, id: string, caller: { userId?: string }) => ({
      id,
      userId: caller.userId ?? null,
      guestTokenHash: null,
      accessVersion: 'test-version',
    }),
  ),
}));
vi.mock('../../src/modules/cartConfiguration', () => ({
  validateCartConfiguration: vi.fn(),
}));

// Mock Stripe
const mockStripeCheckoutCreate = vi.fn();
const mockPaymentIntentsCreate = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn(
    /** Builds the Stripe stub when production code calls its constructor. */
    function StripeMock() {
      return {
        checkout: {
          sessions: {
            create: mockStripeCheckoutCreate,
          },
        },
        paymentIntents: {
          create: mockPaymentIntentsCreate,
        },
        webhooks: {
          constructEventAsync: vi.fn(),
        },
      };
    },
  ),
}));

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
      country: userRow.country || '',
    })),
}));

// Mock generateOrderNumber
vi.mock('../../src/utils/generateOrderNumber', () => ({
  generateOrderNumber: vi.fn(() => 'ORDER-123456'),
}));

const mockCartId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const mockUserId = 1;
const defaultBlackFilamentId = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';

const env = mockEnv();

function readyStripeCartItem(overrides: Record<string, unknown> = {}) {
  return {
    cartItemId: 1,
    cartUserId: 'user_123',
    skuNumber: 'TEST-SKU-001',
    filamentType: 'PLA',
    filamentId: defaultBlackFilamentId,
    productSkuNumber: 'TEST-SKU-001',
    stripePriceId: 'price_test1',
    publicFileServiceId: 'public-file-123',
    quantity: 1,
    price: 19.99,
    name: 'Test Product',
    ...overrides,
  };
}

function envWithAvailableFilaments(publicIds: string[]) {
  return {
    ...env,
    COLOR_CACHE: {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          success: true,
          data: publicIds.map(publicId => ({
            publicId,
            available: true,
          })),
        }),
      ),
    } as unknown as KVNamespace,
  };
}

describe('Shopping Cart Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mock functions
    mockWhere.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockQuery.cart.findFirst.mockReset();
    mockQuery.cart.findMany.mockReset();
    capturedInserts.length = 0;

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

  describe('cart mutation limits and conflicts', () => {
    const selection = {
      cartId: mockCartId,
      skuNumber: 'TEST-SKU-001',
      quantity: 1,
      color: 'Black',
      filamentType: 'PLA',
      filamentId: defaultBlackFilamentId,
    };
    const add = () =>
      app.request(
        '/cart/add',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selection),
        },
        env,
      );

    test('rejects an addition that would exceed the per-line quantity limit', async () => {
      mockQuery.cart.findFirst.mockResolvedValueOnce({
        id: 1,
        quantity: 69,
        userId: null,
      });
      const response = await add();
      expect(response.status).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(capturedInserts).toHaveLength(0);
    });
    test('reports a concurrent quantity change instead of losing an addition', async () => {
      mockQuery.cart.findFirst.mockResolvedValueOnce({
        id: 1,
        quantity: 2,
        userId: null,
      });
      mockUpdate.mockResolvedValueOnce([]);
      const response = await add();
      expect(response.status).toBe(409);
      expect(capturedInserts).toHaveLength(0);
    });
    test('accepts an addition whose conditional update succeeded', async () => {
      mockQuery.cart.findFirst.mockResolvedValueOnce({
        id: 1,
        quantity: 2,
        userId: null,
      });
      mockUpdate.mockResolvedValueOnce([{ id: 1 }]);
      expect((await add()).status).toBe(200);
    });
    test.each([
      -1, 0.5, 70,
    ])('rejects invalid update quantity %s', async quantity => {
      const response = await app.request(
        '/cart/update',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cartId: mockCartId, itemId: 1, quantity }),
        },
        env,
      );
      expect(response.status).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
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
          filamentId: '8cfbf30a-2995-486e-a1e8-8f7d41488f1e',
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
          filamentId: null,
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
        filamentId: '8cfbf30a-2995-486e-a1e8-8f7d41488f1e',
        name: 'Test Product 1',
        price: 19.99,
      });
      expect(data.items[1].filamentId).toBe(defaultBlackFilamentId);
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

    test('returns validation error for invalid filamentId', async () => {
      const invalidItem = {
        cartId: mockCartId,
        skuNumber: 'TEST-SKU-001',
        quantity: 1,
        color: '#ff0000',
        filamentType: 'PLA',
        filamentId: 'not-a-uuid',
      };

      const request = new Request('http://localhost/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidItem),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(400);
    });

    test('stores provided filamentId on cart items', async () => {
      const filamentId = '8cfbf30a-2995-486e-a1e8-8f7d41488f1e';
      mockQuery.cart.findFirst.mockResolvedValueOnce(undefined);

      const request = new Request('http://localhost/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: mockCartId,
          skuNumber: 'TEST-SKU-001',
          quantity: 1,
          color: '#ff0000',
          filamentType: 'PLA',
          filamentId,
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(200);
      expect(capturedInserts).toHaveLength(1);
      expect(capturedInserts[0]).toMatchObject({
        cartId: mockCartId,
        skuNumber: 'TEST-SKU-001',
        quantity: 1,
        color: '#ff0000',
        filamentType: 'PLA',
        filamentId,
      });
    });

    test('returns validation error when filamentId is omitted', async () => {
      const request = new Request('http://localhost/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cartId: mockCartId,
          skuNumber: 'TEST-SKU-001',
          quantity: 1,
          color: '#ff0000',
          filamentType: 'PLA',
        }),
      });

      const res = await app.fetch(request, env);

      expect(res.status).toBe(400);
      expect(capturedInserts).toHaveLength(0);
    });
  });

  describe('GET /cart/shipping (authenticated)', () => {
    test('returns shipping estimate successfully', async () => {
      const mockDraftOrderResponse = {
        data: {
          order: {
            deliveryCost: '15.99',
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDraftOrderResponse),
      } as Response);

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
          country: 'us',
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
          publicFileServiceId: 'public-file-123',
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

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v2/api/orders'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.SLANT_API_V2}`,
          }),
        }),
      );

      const fetchCall = (global.fetch as any).mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);
      expect(requestBody).toMatchObject({
        platformId: env.SLANT_PLATFORM_ID,
        ownerId: 'user_123',
        customer: {
          details: {
            email: 'test@example.com',
            address: {
              line1: 'encrypted-123-main-st',
              city: 'encrypted-testville',
              state: 'encrypted-ts',
              zip: 'encrypted-12345',
              country: 'US',
            },
          },
        },
      });
      expect(requestBody.items).toEqual([
        expect.objectContaining({
          type: 'PRINT',
          publicFileServiceId: 'public-file-123',
          filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
          quantity: 2,
        }),
      ]);
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
      expect(data.error).toBe('A valid cartId is required');
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
            country: 'us',
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

    test('returns 400 when a cart item is missing publicFileServiceId', async () => {
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
            country: 'us',
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
            publicFileServiceId: null,
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

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe('Missing publicFileServiceId for cart item');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('handles upstream draft order estimate failure', async () => {
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
            country: 'us',
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
            publicFileServiceId: 'public-file-123',
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
      expect(data).toEqual({ error: 'Shipping provider estimate unavailable' });
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
          publicFileServiceId: 'public-file-123',
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

  describe('authorized cart mutation results', () => {
    test.each([
      { path: '/cart/update', method: 'PUT', quantity: 3, succeeds: true },
      { path: '/cart/update', method: 'PUT', quantity: 3, succeeds: false },
      { path: '/cart/update', method: 'PUT', quantity: 0, succeeds: true },
      { path: '/cart/update', method: 'PUT', quantity: 0, succeeds: false },
      { path: '/cart/remove', method: 'DELETE', succeeds: true },
      { path: '/cart/remove', method: 'DELETE', succeeds: false },
    ])('reports the actual mutation result: %j', async ({
      path,
      method,
      quantity,
      succeeds,
    }) => {
      mockUpdate.mockResolvedValueOnce(succeeds ? [{ id: 1 }] : []);
      mockDelete.mockReset().mockResolvedValueOnce(succeeds ? [{ id: 1 }] : []);
      const response = await app.request(
        path,
        {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cartId: mockCartId, itemId: 1, quantity }),
        },
        env,
      );
      expect(response.status).toBe(succeeds ? 200 : 404);
      if (!succeeds)
        expect(await response.json()).toEqual({
          error: 'No cart item found with that ID',
        });
      expect(mockQuery.cart.findMany).not.toHaveBeenCalled();
    });
  });

});
