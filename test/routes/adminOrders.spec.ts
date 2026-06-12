import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import { mockDrizzle, mockWhere, mockAll, mockInsert, mockUpdate } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';
import { mockGlobalFetch } from '../mocks/fetch';

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

describe('Admin Orders API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          status: 'pending',
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
    });
  });
});
