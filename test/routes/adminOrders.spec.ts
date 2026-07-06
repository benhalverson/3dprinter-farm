import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import {
  capturedInserts,
  mockAll,
  mockDelete,
  mockDrizzle,
  mockInsert,
  mockWhere,
} from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';
import { mockGlobalFetch } from '../mocks/fetch';

const mockStripeRefundCreate = vi.hoisted(() => vi.fn());

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    refunds: {
      create: mockStripeRefundCreate,
    },
  })),
}));

mockAuth();
mockDrizzle();
mockGlobalFetch();

const env = mockEnv();

function mockAdminUser() {
  mockBetterAuth.getSession.mockResolvedValue({
    session: {
      id: 'session_admin',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    user: {
      id: 'admin_user_1',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
    },
  });

  // Organization lookup
  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'org_shared_catalog',
      name: '3D Printer Web API',
      slug: '3dprinter-web-api',
    }),
  });

  // Member lookup
  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'member_org_shared_catalog_admin_user_1',
      organizationId: 'org_shared_catalog',
      userId: 'admin_user_1',
      role: 'admin',
      createdAt: new Date(),
    }),
  });
}

function mockNonAdminUser() {
  mockBetterAuth.getSession.mockResolvedValue({
    session: {
      id: 'session_user',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    user: {
      id: 'user_123',
      email: 'user@example.com',
      name: 'Regular User',
      role: 'user',
    },
  });

  // Organization lookup
  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'org_shared_catalog',
      name: '3D Printer Web API',
      slug: '3dprinter-web-api',
    }),
  });

  // Member lookup - member role (not admin)
  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'member_org_shared_catalog_user_123',
      organizationId: 'org_shared_catalog',
      userId: 'user_123',
      role: 'member',
      createdAt: new Date(),
    }),
  });
}

function mockUnauthenticated() {
  mockBetterAuth.getSession.mockRejectedValue(new Error('No session'));
}

function mockCancelableOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orderNumber: 'ORD-001',
    userId: 'user_1',
    status: 'processing',
    slantStatus: 'PROCESSING',
    slantPublicOrderId: 'slant-order-123',
    stripePaymentIntentId: 'pi_123',
    stripeCheckoutSessionId: 'cs_123',
    customerEmail: 'customer@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockReconciliationOrder(overrides: Record<string, unknown> = {}) {
  return mockCancelableOrder({
    cartId: 'cart-123',
    itemSnapshot: JSON.stringify([{ skuNumber: 'SKU-001', quantity: 1 }]),
    customerSnapshot: JSON.stringify({ email: 'customer@example.com' }),
    ...overrides,
  });
}

function mockSlantDeleteResponse(ok = true, status = 200, body = '{}') {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

function mockSlantGetResponse(ok = true, status = 200, body = '{}') {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

describe('Admin Orders API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReset();
    mockAll.mockReset();
    mockInsert.mockReset();
    mockDelete.mockReset();
    mockStripeRefundCreate.mockReset();
    mockGlobalFetch();
    capturedInserts.length = 0;
  });

  describe('GET /admin/orders', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders', {
          headers: { Cookie: '' },
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for non-admin user', async () => {
      mockNonAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    test('returns order list for admin user', async () => {
      mockAdminUser();

      const mockOrders = [
        {
          id: 1,
          orderNumber: 'ORD-001',
          userId: 'user_1',
          status: 'pending',
          slantStatus: null,
          slantPublicOrderId: null,
          customerEmail: 'customer@example.com',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];

      mockAll.mockResolvedValueOnce(mockOrders);

      const res = await app.fetch(
        new Request('http://localhost/admin/orders', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('orders');
      expect(body.orders).toEqual(mockOrders);
    });

    test('supports status filter', async () => {
      mockAdminUser();
      mockAll.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request('http://localhost/admin/orders?status=failed', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orders).toEqual([]);
    });

    test('supports email filter', async () => {
      mockAdminUser();
      mockAll.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request('http://localhost/admin/orders?email=test@example.com', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
    });

    test('supports date range filters', async () => {
      mockAdminUser();
      mockAll.mockResolvedValueOnce([]);

      const res = await app.fetch(
        new Request(
          'http://localhost/admin/orders?createdAfter=2024-01-01&createdBefore=2024-12-31',
          {
            headers: { Cookie: 'better-auth.session_token=mock-session-token' },
          },
        ),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe('GET /admin/orders/:id', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1', {
          headers: { Cookie: '' },
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for non-admin user', async () => {
      mockNonAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    test('returns 400 for invalid order ID', async () => {
      mockAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/not-a-number', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid order ID');
    });

    test('returns 404 for missing order', async () => {
      mockAdminUser();

      // Order lookup returns undefined
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/999', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Order not found');
    });

    test('returns order detail with events for admin', async () => {
      mockAdminUser();

      const mockOrder = {
        id: 1,
        orderNumber: 'ORD-001',
        userId: 'user_1',
        filename: 'test.stl',
        fileURL: 'https://example.com/test.stl',
        status: 'pending',
        slantStatus: null,
        slantPublicOrderId: null,
        stripeCheckoutSessionId: 'cs_123',
        stripePaymentIntentId: 'pi_123',
        customerEmail: 'customer@example.com',
        shipToName: 'John Doe',
        shipToStreet1: '123 Main St',
        shipToStreet2: null,
        shipToCity: 'Anytown',
        shipToState: 'CA',
        shipToZip: '90210',
        shipToCountryISO: 'US',
        billToStreet1: null,
        billToStreet2: null,
        billToCity: null,
        billToState: null,
        billToZip: null,
        billToCountryISO: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const mockEvents = [
        {
          id: 1,
          type: 'order_created',
          detail: 'Order placed',
          actor: 'system',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];

      // Order lookup
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(mockOrder),
      });

      // Events lookup
      mockWhere.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(mockEvents),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1', {
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orderNumber).toBe('ORD-001');
      expect(body.events).toEqual(mockEvents);
      expect(body.stripeCheckoutSessionId).toBe('cs_123');
    });
  });

  describe('POST /admin/orders/:id/retry', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/retry', {
          method: 'POST',
          headers: { Cookie: '' },
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for non-admin user', async () => {
      mockNonAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    test('returns 400 for invalid order ID', async () => {
      mockAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/not-a-number/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid order ID');
    });

    test('returns 404 for missing order', async () => {
      mockAdminUser();

      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/999/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(404);
    });

    test('blocks retry for already fulfilled order', async () => {
      mockAdminUser();

      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 1,
          status: 'completed',
          slantStatus: 'fulfilled',
        }),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('already successfully processed');
    });

    test('blocks retry for non-eligible status', async () => {
      mockAdminUser();

      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 1,
          status: 'shipped',
          slantStatus: null,
        }),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('not eligible for retry');
    });

    test('allows retry for failed order and records event', async () => {
      mockAdminUser();

      // Order lookup
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 1,
          status: 'failed',
          slantStatus: null,
        }),
      });

      // Update status mock (update -> set -> where)
      // The drizzle mock handles update().set().where() already

      // Insert event returning
      mockInsert.mockResolvedValueOnce([
        {
          id: 1,
          orderId: 1,
          type: 'retry_initiated',
          detail: 'Admin retry initiated by admin@example.com',
          actor: 'admin@example.com',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/retry', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.event.type).toBe('retry_initiated');
    });
  });

  describe('POST /admin/orders/:id/cancel-refund', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: { Cookie: '' },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for non-admin user', async () => {
      mockNonAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    test('cancels Slant order before refunding Stripe', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockCancelableOrder()),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });
      mockSlantDeleteResponse(true, 200, JSON.stringify({ ok: true }));
      mockStripeRefundCreate.mockResolvedValueOnce({
        id: 're_123',
        status: 'succeeded',
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        orderId: 1,
        status: 'canceled',
        slantStatus: 'CANCELED',
        stripeRefundId: 're_123',
        stripeRefundStatus: 'succeeded',
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://slant3dapi.com/v2/api/orders/slant-order-123',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockStripeRefundCreate).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: 'pi_123' }),
        expect.objectContaining({
          idempotencyKey: 'order-1-cancel-refund',
        }),
      );
      expect(capturedInserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: 1,
            finalStatus: 'canceled_refunded',
            stripeRefundId: 're_123',
          }),
          expect.objectContaining({
            orderId: 1,
            type: 'admin_cancel_refund',
            source: 'admin',
          }),
        ]),
      );
    });

    test('does not create duplicate refunds for duplicate requests', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(
            mockCancelableOrder({
              status: 'canceled',
              slantStatus: 'CANCELED',
            }),
          ),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([
            {
              orderId: 1,
              finalStatus: 'canceled_refunded',
              stripeRefundId: 're_existing',
              stripeRefundStatus: 'succeeded',
            },
          ]),
        });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Retry click' }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        duplicate: true,
        stripeRefundId: 're_existing',
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(mockStripeRefundCreate).not.toHaveBeenCalled();
    });

    test('blocks shipped orders without override', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(
            mockCancelableOrder({
              status: 'shipped',
              slantStatus: 'SHIPPED',
            }),
          ),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(mockStripeRefundCreate).not.toHaveBeenCalled();
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          finalStatus: 'blocked_ineligible_status',
        }),
      );
    });

    test('does not refund Stripe when Slant cancellation fails', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockCancelableOrder()),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });
      mockSlantDeleteResponse(false, 500, 'Slant failed');

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'Slant3D cancellation failed; Stripe was not refunded.',
      });
      expect(mockStripeRefundCreate).not.toHaveBeenCalled();
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          finalStatus: 'slant_cancellation_failed',
          slantStatus: 'failed',
        }),
      );
    });

    test('persists Stripe refund failure after Slant cancellation succeeds', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockCancelableOrder()),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });
      mockSlantDeleteResponse(true, 200, JSON.stringify({ ok: true }));
      mockStripeRefundCreate.mockRejectedValueOnce(new Error('Stripe failed'));

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'Customer request' }),
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Stripe refund failed.' });
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          finalStatus: 'stripe_refund_failed',
          errorMessage: 'Stripe failed',
        }),
      );
    });

    test('override allows refund when shipped order Slant cancellation fails', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(
            mockCancelableOrder({
              status: 'shipped',
              slantStatus: 'SHIPPED',
            }),
          ),
        })
        .mockReturnValueOnce({
          all: vi.fn().mockResolvedValue([]),
        });
      mockSlantDeleteResponse(false, 409, 'Already shipped');
      mockStripeRefundCreate.mockResolvedValueOnce({
        id: 're_override',
        status: 'succeeded',
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/cancel-refund', {
          method: 'POST',
          headers: {
            Cookie: 'better-auth.session_token=mock-session-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            reason: 'Manual support override',
            override: true,
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        stripeRefundId: 're_override',
      });
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          finalStatus: 'canceled_refunded',
          override: true,
          slantStatus: 'failed',
        }),
      );
    });
  });

  describe('POST /admin/orders/:id/reconcile', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: '' },
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns no action when local and Slant states already match', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockReconciliationOrder()),
        })
        .mockReturnValueOnce([]);
      mockSlantGetResponse(
        true,
        200,
        JSON.stringify({ data: { status: 'PROCESSING' } }),
      );

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        orderId: 1,
        resultStatus: 'no_action',
        detectedIssues: [],
        actionsTaken: [],
        localStatus: 'processing',
        slantStatus: 'PROCESSING',
      });
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          triggerSource: 'admin',
          resultStatus: 'no_action',
        }),
      );
    });

    test('recovers stale local status from Slant and notifies the customer', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockReconciliationOrder()),
        })
        .mockReturnValueOnce([]);
      mockSlantGetResponse(
        true,
        200,
        JSON.stringify({ data: { status: 'SHIPPED' } }),
      );

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        orderId: 1,
        resultStatus: 'recovered',
        detectedIssues: ['local_status_stale'],
        actionsTaken: ['updated_local_status'],
        localStatus: 'shipped',
        slantStatus: 'SHIPPED',
      });
      expect(capturedInserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: 1,
            type: 'reconciliation_status_updated',
            source: 'admin',
            previousStatus: 'PROCESSING',
            nextStatus: 'SHIPPED',
          }),
          expect.objectContaining({
            orderId: 1,
            notificationType: 'order_shipped',
            recipientEmail: 'customer@example.com',
            status: 'sent',
          }),
          expect.objectContaining({
            orderId: 1,
            resultStatus: 'recovered',
            detectedIssueType: JSON.stringify(['local_status_stale']),
            actionsTaken: JSON.stringify(['updated_local_status']),
          }),
        ]),
      );
    });

    test('reports paid orders without a Slant order id', async () => {
      mockAdminUser();
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(
          mockReconciliationOrder({
            slantPublicOrderId: null,
            slantStatus: null,
            status: 'failed',
          }),
        ),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resultStatus: 'needs_admin_action',
        detectedIssues: ['paid_without_slant_order_id'],
        recommendedAction: 'Use admin retry fulfillment or cancel/refund.',
      });
      expect(capturedInserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: 1,
            resultStatus: 'needs_admin_action',
          }),
          expect.objectContaining({
            orderId: 1,
            notificationType: 'admin_failure_alert',
            status: 'sent',
          }),
        ]),
      );
    });

    test('persists failed Slant lookups', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockReconciliationOrder()),
        })
        .mockReturnValueOnce([]);
      mockSlantGetResponse(false, 500, 'Slant unavailable');

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Slant3D lookup failed.' });
      expect(capturedInserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: 1,
            resultStatus: 'failed',
            detectedIssueType: JSON.stringify(['slant_lookup_failed']),
            errorMessage: 'Slant3D lookup failed with 500',
          }),
          expect.objectContaining({
            orderId: 1,
            notificationType: 'admin_failure_alert',
            status: 'sent',
          }),
        ]),
      );
    });

    test('clears a fulfilled order cart that was left behind', async () => {
      mockAdminUser();
      mockWhere
        .mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(mockReconciliationOrder()),
        })
        .mockReturnValueOnce([{ id: 1, cartId: 'cart-123' }]);
      mockSlantGetResponse(
        true,
        200,
        JSON.stringify({ data: { status: 'PROCESSING' } }),
      );
      mockDelete.mockResolvedValueOnce({ changes: 1 });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/reconcile', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resultStatus: 'recovered',
        detectedIssues: ['cart_not_cleared_after_fulfillment'],
        actionsTaken: ['cleared_cart'],
      });
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(capturedInserts).toContainEqual(
        expect.objectContaining({
          orderId: 1,
          resultStatus: 'recovered',
          detectedIssueType: JSON.stringify([
            'cart_not_cleared_after_fulfillment',
          ]),
          actionsTaken: JSON.stringify(['cleared_cart']),
        }),
      );
    });
  });

  describe('POST /admin/orders/:id/resend-notification', () => {
    test('returns 401 for unauthenticated user', async () => {
      mockUnauthenticated();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/resend-notification', {
          method: 'POST',
          headers: { Cookie: '' },
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    test('returns 403 for non-admin user', async () => {
      mockNonAdminUser();

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/resend-notification', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(403);
    });

    test('returns 400 for invalid order ID', async () => {
      mockAdminUser();

      const res = await app.fetch(
        new Request(
          'http://localhost/admin/orders/not-a-number/resend-notification',
          {
            method: 'POST',
            headers: { Cookie: 'better-auth.session_token=mock-session-token' },
          },
        ),
        env,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid order ID');
    });

    test('returns 404 for missing order', async () => {
      mockAdminUser();

      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/999/resend-notification', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(404);
    });

    test('resends notification and records event', async () => {
      mockAdminUser();

      // Order lookup
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 1,
          orderNumber: 'ORD-001',
          status: 'pending',
          slantStatus: 'PROCESSING',
          customerEmail: 'customer@example.com',
        }),
      });

      // Insert event returning
      mockInsert.mockResolvedValueOnce([
        {
          id: 2,
          orderId: 1,
          type: 'notification_resent',
          detail: 'Notification resent by admin@example.com',
          actor: 'admin@example.com',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ]);
      // Order lookup for the actual resend attempt
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(mockCancelableOrder()),
      });

      const res = await app.fetch(
        new Request('http://localhost/admin/orders/1/resend-notification', {
          method: 'POST',
          headers: { Cookie: 'better-auth.session_token=mock-session-token' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.event.type).toBe('notification_resent');
      expect(capturedInserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: 1,
            type: 'notification_resent',
          }),
          expect.objectContaining({
            orderId: 1,
            notificationType: 'order_confirmation',
            recipientEmail: 'customer@example.com',
            status: 'sent',
            source: 'admin',
          }),
        ]),
      );
    });
  });
});
