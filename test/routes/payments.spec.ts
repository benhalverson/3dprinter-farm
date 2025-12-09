import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import type {
  PaymentStatusResponse,
  PayPalOrderResponse,
} from '../../src/types';
import { mockAuth } from '../mocks/auth';
import {
  mockDrizzle,
  mockInsert,
  mockUpdate,
  mockWhere,
} from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

// Mock Stripe
const mockStripeCreate = vi.fn();
const mockStripeWebhooks = {
  constructEvent: vi.fn(),
  constructEventAsync: vi.fn(),
};

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: {
        sessions: {
          create: mockStripeCreate,
        },
      },
      webhooks: mockStripeWebhooks,
    })),
  };
});

// Mock PayPal access token utility
vi.mock('../../src/utils/payPalAccess', () => ({
  getPayPalAccessToken: vi.fn().mockResolvedValue('mock-paypal-access-token'),
}));

// Mock crypto utilities
vi.mock('../../src/utils/crypto', () => ({
  decryptField: vi
    .fn()
    .mockImplementation(async (value: string) =>
      value.replace('encrypted-', ''),
    ),
  encryptField: vi
    .fn()
    .mockImplementation(async (value: string) => `encrypted-${value}`),
}));

// Mock generateOrderNumber
vi.mock('../../src/utils/generateOrderNumber', () => ({
  generateOrderNumber: vi.fn(() => 'ORDER-20240909-123456'),
}));

const mockCartId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const mockUserId = 1;

const env = mockEnv();

describe('Payments Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mock functions
    mockWhere.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockStripeCreate.mockReset();
    mockStripeWebhooks.constructEventAsync.mockReset();

    // Default fetch mock for external APIs
    global.fetch = vi.fn();
  });

  describe('GET /success', () => {
    test('returns success status', async () => {
      const res = await app.fetch(
        new Request('http://localhost/success', {
          method: 'GET',
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as PaymentStatusResponse;
      expect(data).toEqual({ status: 'Success' });
    });

    test('handles session_id query parameter', async () => {
      const res = await app.fetch(
        new Request('http://localhost/success?session_id=cs_test_123', {
          method: 'GET',
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as PaymentStatusResponse;
      expect(data).toEqual({ status: 'Success' });
    });
  });

  describe('GET /cancel', () => {
    test('returns cancelled status', async () => {
      const res = await app.fetch(
        new Request('http://localhost/cancel', {
          method: 'GET',
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as PaymentStatusResponse;
      expect(data).toEqual({ status: 'Cancelled' });
    });
  });

  describe.skip('POST /paypal', () => {
    test('creates PayPal order with default quantity', async () => {
      const mockPayPalResponse = {
        id: 'paypal-order-123',
        status: 'CREATED',
        links: [
          {
            href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/paypal-order-123',
            rel: 'self',
            method: 'GET',
          },
        ],
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPayPalResponse),
      } as Response);

      const res = await app.fetch(
        new Request('http://localhost/paypal', {
          method: 'POST',
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as PayPalOrderResponse;
      expect(data).toEqual(mockPayPalResponse);

      // Verify PayPal API was called with correct parameters
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-m.sandbox.paypal.com/v2/checkout/orders',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer mock-paypal-access-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                amount: {
                  currency_code: 'USD',
                  value: '10.00', // Default qty=1 * 10
                },
              },
            ],
          }),
        }),
      );
    });

    test('creates PayPal order with custom quantity', async () => {
      const mockPayPalResponse = {
        id: 'paypal-order-456',
        status: 'CREATED',
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPayPalResponse),
      });

      const res = await app.fetch(
        new Request('http://localhost/paypal?qty=5', {
          method: 'POST',
        }),
        env,
      );

      expect(res.status).toBe(200);

      // Verify correct amount calculation (qty=5 * 10 = 50.00)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-m.sandbox.paypal.com/v2/checkout/orders',
        expect.objectContaining({
          body: expect.stringContaining('"value":"50.00"'),
        }),
      );
    });

    test('handles PayPal API error', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'PayPal API error' }),
      });

      const res = await app.fetch(
        new Request('http://localhost/paypal', {
          method: 'POST',
        }),
        env,
      );

      // Should return the error response from PayPal
      expect(res.status).toBe(200); // The endpoint returns whatever PayPal returns
      const data = (await res.json()) as any;
      expect(data).toEqual({ error: 'PayPal API error' });
    });
  });

  describe('POST /webhook/stripe', () => {
    const mockWebhookPayload = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          metadata: {
            cartId: mockCartId,
            userId: mockUserId.toString(),
          },
        },
      },
    };

    beforeEach(() => {
      // Mock successful webhook signature verification (async)
      mockStripeWebhooks.constructEventAsync.mockResolvedValue(mockWebhookPayload);
    });

    test('processes successful payment webhook', async () => {
      // Mock cart items query
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

      // Mock user query
      mockWhere.mockResolvedValueOnce([
        {
          id: mockUserId,
          email: 'encrypted-test@example.com',
          firstName: 'encrypted-John',
          lastName: 'encrypted-Doe',
          shippingAddress: 'encrypted-123 Main St',
          city: 'encrypted-Test City',
          state: 'encrypted-TS',
          zipCode: 'encrypted-12345',
          phone: 'encrypted-555-0123',
        },
      ]);

      // Mock successful Slant3D API response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ orderId: 'slant3d-order-123' }),
      });

      // Mock cart deletion
      const mockDelete = vi.fn().mockResolvedValue({ changes: 1 });
      mockWhere.mockResolvedValueOnce({ delete: mockDelete });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        success: true,
        orderId: 'slant3d-order-123',
      });

      // Verify Stripe webhook signature was verified
      expect(mockStripeWebhooks.constructEventAsync).toHaveBeenCalledWith(
        JSON.stringify(mockWebhookPayload),
        'valid-signature',
        'whsec_123',
      );

      // Verify Slant3D API was called
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('estimate'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': 'fake-api-key',
          },
          body: expect.stringContaining('test@example.com'),
        }),
      );
    });

    test('returns error when signature is missing', async () => {
      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Missing stripe-signature header',
      });
    });

    test('returns error when signature verification fails', async () => {
      mockStripeWebhooks.constructEventAsync.mockRejectedValue(
        new Error('Invalid signature')
      );

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'invalid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Webhook signature verification failed',
      });
    });

    test('returns error when metadata is missing', async () => {
      const incompletePayload = {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            metadata: {}, // Missing cartId and userId
          },
        },
      };

      mockStripeWebhooks.constructEventAsync.mockResolvedValue(incompletePayload);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(incompletePayload),
        }),
        env,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Missing required metadata',
      });
    });

    test('returns error when cart is not found', async () => {
      // Mock empty cart
      mockWhere.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Cart not found',
      });
    });

    test('returns error when user is not found', async () => {
      // Mock cart items
      mockWhere.mockResolvedValueOnce([
        {
          id: 1,
          skuNumber: 'TEST-SKU-001',
          quantity: 1,
          color: '#000000',
          filamentType: 'PLA',
          productName: 'Test Product',
          stl: 'http://example.com/test.stl',
        },
      ]);

      // Mock empty user result
      mockWhere.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(404);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'User not found',
      });
    });

    test('returns error when Slant3D API fails', async () => {
      // Mock cart and user data
      mockWhere
        .mockResolvedValueOnce([
          {
            id: 1,
            skuNumber: 'TEST-SKU-001',
            quantity: 1,
            color: '#000000',
            filamentType: 'PLA',
            productName: 'Test Product',
            stl: 'http://example.com/test.stl',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: mockUserId,
            email: 'encrypted-test@example.com',
            firstName: 'encrypted-John',
            lastName: 'encrypted-Doe',
            shippingAddress: 'encrypted-123 Main St',
            city: 'encrypted-Test City',
            state: 'encrypted-TS',
            zipCode: 'encrypted-12345',
            phone: 'encrypted-555-0123',
          },
        ]);

      // Mock failed Slant3D API response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(502);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Order creation failed',
      });
    });

    test('acknowledges non-checkout events', async () => {
      const nonCheckoutPayload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_123',
          },
        },
      };

      mockStripeWebhooks.constructEventAsync.mockResolvedValue(nonCheckoutPayload);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(nonCheckoutPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        received: true,
      });
    });

    test('handles network errors during order creation', async () => {
      // Mock cart and user data
      mockWhere
        .mockResolvedValueOnce([
          {
            id: 1,
            skuNumber: 'TEST-SKU-001',
            quantity: 1,
            color: '#000000',
            filamentType: 'PLA',
            productName: 'Test Product',
            stl: 'http://example.com/test.stl',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: mockUserId,
            email: 'encrypted-test@example.com',
            firstName: 'encrypted-John',
            lastName: 'encrypted-Doe',
            shippingAddress: 'encrypted-123 Main St',
            city: 'encrypted-Test City',
            state: 'encrypted-TS',
            zipCode: 'encrypted-12345',
            phone: 'encrypted-555-0123',
          },
        ]);

      // Mock network error
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mockWebhookPayload),
        }),
        env,
      );

      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Order creation failed',
      });
    });
  });
});
