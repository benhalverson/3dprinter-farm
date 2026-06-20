import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import type { PaymentStatusResponse } from '../../src/types';
import { mockAuth } from '../mocks/auth';
import {
  capturedInserts,
  mockDelete,
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

// Mock profile crypto utilities – spread importActual so that all named
// exports (e.g. buildEncryptedProfileUpdate, encryptStoredProfileValue,
// isCipherKitEncryptedValue) are preserved for route modules that import them.
vi.mock(
  '../../src/utils/profileCrypto',
  async (importActual) => {
    const actual =
      await importActual<typeof import('../../src/utils/profileCrypto')>();
    return {
      ...actual,
      getCipherKitSecretKey: vi.fn().mockResolvedValue('mock-secret-key'),
      decryptStoredProfileValue: vi
        .fn()
        .mockImplementation(async (value: string | null) =>
          (value || '').replace('encrypted-', ''),
        ),
      decryptStoredShippingProfile: vi
        .fn()
        .mockImplementation(async (userRow: Record<string, string>) => ({
          email: userRow.email || '',
          firstName: (userRow.firstName || '').replace('encrypted-', ''),
          lastName: (userRow.lastName || '').replace('encrypted-', ''),
          shippingAddress: (userRow.shippingAddress || '').replace(
            'encrypted-',
            '',
          ),
          city: (userRow.city || '').replace('encrypted-', ''),
          state: (userRow.state || '').replace('encrypted-', ''),
          zipCode: (userRow.zipCode || '').replace('encrypted-', ''),
          phone: (userRow.phone || '').replace('encrypted-', ''),
        })),
    };
  },
);

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
    mockDelete.mockReset();
    mockStripeCreate.mockReset();
    mockStripeWebhooks.constructEventAsync.mockReset();
    capturedInserts.length = 0;

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

  describe('POST /paypal', () => {
    test('returns not found after legacy route removal', async () => {
      const res = await app.fetch(
        new Request('http://localhost/paypal', {
          method: 'POST',
        }),
        env,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /webhook/stripe', () => {
    const defaultFilamentId = '76fe1f79-3f1e-43e4-b8f4-61159de5b93c';
    const checkoutSessionPayload = {
      id: 'evt_checkout_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          payment_intent: 'pi_test_123',
          metadata: {
            cartId: mockCartId,
            userId: mockUserId.toString(),
          },
          customer_details: {
            email: 'checkout@example.com',
          },
        },
      },
    };
    const paymentIntentPayload = {
      id: 'evt_payment_intent_123',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_test_123',
          metadata: {
            cartId: mockCartId,
            userId: mockUserId.toString(),
            customerEmail: 'intent@example.com',
          },
          receipt_email: 'intent@example.com',
        },
      },
    };

    const mockCartItem = (overrides: Record<string, unknown> = {}) => ({
      id: 1,
      skuNumber: 'TEST-SKU-001',
      quantity: 2,
      color: '#ff0000',
      filamentType: 'PLA',
      filamentId: '11111111-1111-4111-8111-111111111111',
      productName: 'Test Product',
      publicFileServiceId: 'file-service-123',
      ...overrides,
    });

    const mockUserRow = {
      id: mockUserId,
      email: 'encrypted-test@example.com',
      firstName: 'encrypted-John',
      lastName: 'encrypted-Doe',
      shippingAddress: 'encrypted-123 Main St',
      city: 'encrypted-Test City',
      state: 'encrypted-TS',
      zipCode: 'encrypted-12345',
      phone: 'encrypted-555-0123',
    };

    beforeEach(() => {
      // Mock successful webhook signature verification (async)
      mockStripeWebhooks.constructEventAsync.mockResolvedValue(
        checkoutSessionPayload,
      );
    });

    test('processes checkout session webhooks through Slant V2', async () => {
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockCartItem()])
        .mockResolvedValueOnce([mockUserRow]);
      mockInsert.mockResolvedValueOnce([
        {
          idempotencyKey: 'pi_test_123',
        },
      ]);
      mockDelete.mockResolvedValueOnce({ changes: 1 });
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ data: { publicOrderId: 'slant3d-order-123' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        success: true,
        orderId: 'slant3d-order-123',
      });
      expect(mockStripeWebhooks.constructEventAsync).toHaveBeenCalledWith(
        JSON.stringify(checkoutSessionPayload),
        'valid-signature',
        'whsec_123',
      );
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'https://slant3dapi.com/v2/api/orders',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.any(String),
          }),
        }),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'https://slant3dapi.com/v2/api/orders/slant3d-order-123',
        expect.objectContaining({
          method: 'POST',
        }),
      );

      const draftBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(draftBody.items[0]).toMatchObject({
        publicFileServiceId: 'file-service-123',
        filamentId: '11111111-1111-4111-8111-111111111111',
        quantity: 2,
      });

      const processBody = JSON.parse(
        (global.fetch as any).mock.calls[1][1].body,
      );
      expect(processBody.metadata.idempotencyKey).toBe('pi_test_123');
      expect(JSON.stringify(processBody)).not.toContain('publicPaymentServiceId');
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(capturedInserts).toHaveLength(1);
    });

    test('processes payment intent webhooks and falls back to the default filament', async () => {
      mockStripeWebhooks.constructEventAsync.mockResolvedValue(
        paymentIntentPayload,
      );
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockCartItem({ filamentId: null })])
        .mockResolvedValueOnce([mockUserRow]);
      mockInsert.mockResolvedValueOnce([
        {
          idempotencyKey: 'pi_test_123',
        },
      ]);
      mockDelete.mockResolvedValueOnce({ changes: 1 });
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ data: { publicOrderId: 'slant3d-order-456' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(paymentIntentPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        orderId: 'slant3d-order-456',
      });

      const draftBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(draftBody.items[0].filamentId).toBe(defaultFilamentId);
    });

    test('returns error when signature is missing', async () => {
      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
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
        new Error('Invalid signature'),
      );

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'invalid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
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
        id: 'evt_checkout_missing',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_123',
            metadata: {}, // Missing cartId and userId
          },
        },
      };

      mockStripeWebhooks.constructEventAsync.mockResolvedValue(
        incompletePayload,
      );

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

    test('returns error when publicFileServiceId is missing', async () => {
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockCartItem({ publicFileServiceId: null })]);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        error: 'Missing publicFileServiceId',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('returns error when filamentId is invalid', async () => {
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          mockCartItem({ filamentId: 'not-a-uuid' }),
        ]);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid filamentId',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('does not create duplicate Slant orders for retried webhooks', async () => {
      mockWhere.mockResolvedValueOnce([
        {
          idempotencyKey: 'pi_test_123',
          status: 'processed',
          slantOrderId: 'slant3d-order-existing',
        },
      ]);

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        orderId: 'slant3d-order-existing',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('acknowledges unhandled Stripe events with the payments webhook response shape', async () => {
      const unhandledEventPayload = {
        type: 'charge.succeeded',
        data: {
          object: {
            id: 'ch_test_123',
          },
        },
      };

      mockStripeWebhooks.constructEventAsync.mockResolvedValue(
        unhandledEventPayload,
      );

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(unhandledEventPayload),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toEqual({
        received: true,
      });
    });

    test('does not clear the cart when Slant draft creation fails', async () => {
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          mockCartItem(),
        ])
        .mockResolvedValueOnce([mockUserRow]);

      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'Order draft failed',
      });
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('does not clear the cart when Slant order processing fails', async () => {
      mockWhere
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([mockCartItem()])
        .mockResolvedValueOnce([mockUserRow]);
      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ data: { publicOrderId: 'slant3d-order-789' } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        });

      const res = await app.fetch(
        new Request('http://localhost/webhook/stripe', {
          method: 'POST',
          headers: {
            'stripe-signature': 'valid-signature',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(checkoutSessionPayload),
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'Order process failed',
      });
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
