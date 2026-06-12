import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockAuth } from '../mocks/auth';
import { mockDrizzle, mockInsert, mockWhere } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

// Mock profile crypto (required by payments route import chain)
vi.mock(
  '../../src/utils/profileCrypto',
  async (importActual) => {
    const actual =
      await importActual<typeof import('../../src/utils/profileCrypto')>();
    return {
      ...actual,
      getCipherKitSecretKey: vi.fn().mockResolvedValue('mock-secret-key'),
      decryptStoredProfileValue: vi.fn().mockImplementation(async (v: string | null) => (v || '').replace('encrypted-', '')),
      decryptStoredShippingProfile: vi.fn().mockResolvedValue({}),
    };
  },
);

// Mock Stripe (required by payments route import)
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn(), constructEventAsync: vi.fn() },
  })),
}));

vi.mock('../../src/utils/generateOrderNumber', () => ({
  generateOrderNumber: vi.fn(() => 'ORDER-20240909-123456'),
}));

const env = mockEnv();

const VALID_SECRET = 'test-slant-webhook-secret';
const MOCK_ORDER_ID = 'order-uuid-001';
const MOCK_SLANT_ORDER_ID = 'slant-order-123';

function makeWebhookRequest(
  body: unknown,
  secret?: string,
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['x-slant-webhook-secret'] = secret;
  }
  return new Request('http://localhost/webhook/slant3d', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /webhook/slant3d', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReset();
    mockInsert.mockReset();
  });

  describe('authentication', () => {
    test('returns 401 when secret header is missing and server has secret configured', async () => {
      const res = await app.fetch(
        makeWebhookRequest({
          orderId: MOCK_SLANT_ORDER_ID,
          status: 'SHIPPED',
        }),
        env,
      );
      expect(res.status).toBe(401);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Invalid webhook secret');
    });

    test('returns 401 when secret header is wrong', async () => {
      const res = await app.fetch(
        makeWebhookRequest(
          { orderId: MOCK_SLANT_ORDER_ID, status: 'SHIPPED' },
          'wrong-secret',
        ),
        env,
      );
      expect(res.status).toBe(401);
    });

    test('passes authentication with correct secret', async () => {
      // Will fail at 404 since order doesn't exist, but should pass auth
      mockWhere.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(undefined),
      });
      const res = await app.fetch(
        makeWebhookRequest(
          { orderId: MOCK_SLANT_ORDER_ID, status: 'SHIPPED' },
          VALID_SECRET,
        ),
        env,
      );
      // Should be 404 (order not found), not 401
      expect(res.status).toBe(404);
    });
  });

  describe('validation', () => {
    test('returns 422 for invalid body (missing required fields)', async () => {
      const res = await app.fetch(
        makeWebhookRequest({ foo: 'bar' }, VALID_SECRET),
        env,
      );
      expect(res.status).toBe(422);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Invalid request body');
    });

    test('returns 422 for invalid status value', async () => {
      const res = await app.fetch(
        makeWebhookRequest(
          { orderId: 'x', status: 'INVALID_STATUS' },
          VALID_SECRET,
        ),
        env,
      );
      expect(res.status).toBe(422);
    });
  });

  describe('unknown order', () => {
    test('returns 404 when order is not found', async () => {
      mockWhere.mockReturnValue({
        all: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(undefined),
      });

      const res = await app.fetch(
        makeWebhookRequest(
          { orderId: 'nonexistent-order', status: 'SHIPPED' },
          VALID_SECRET,
        ),
        env,
      );
      expect(res.status).toBe(404);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Order not found');
    });
  });

  describe('status updates', () => {
    const mockOrder = {
      id: MOCK_ORDER_ID,
      slantPublicOrderId: MOCK_SLANT_ORDER_ID,
      localStatus: 'DRAFT',
    };

    function setupOrderFound() {
      // First call: find order by slantPublicOrderId
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(mockOrder),
        all: vi.fn().mockResolvedValue([mockOrder]),
      });
      // Second call: idempotency check (no existing event)
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
        all: vi.fn().mockResolvedValue([]),
      });
    }

    test('handles SHIPPED status update', async () => {
      setupOrderFound();

      const res = await app.fetch(
        makeWebhookRequest(
          {
            eventId: 'evt-shipped-1',
            orderId: MOCK_SLANT_ORDER_ID,
            status: 'SHIPPED',
          },
          VALID_SECRET,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean; status: string; orderId: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('SHIPPED');
      expect(data.orderId).toBe(MOCK_ORDER_ID);
    });

    test('handles DELIVERED status update', async () => {
      setupOrderFound();

      const res = await app.fetch(
        makeWebhookRequest(
          {
            eventId: 'evt-delivered-1',
            orderId: MOCK_SLANT_ORDER_ID,
            status: 'DELIVERED',
          },
          VALID_SECRET,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('DELIVERED');
    });

    test('handles CANCELED status update', async () => {
      setupOrderFound();

      const res = await app.fetch(
        makeWebhookRequest(
          {
            eventId: 'evt-canceled-1',
            orderId: MOCK_SLANT_ORDER_ID,
            status: 'CANCELED',
          },
          VALID_SECRET,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('CANCELED');
    });

    test('handles PROCESSING status update', async () => {
      setupOrderFound();

      const res = await app.fetch(
        makeWebhookRequest(
          {
            eventId: 'evt-processing-1',
            orderId: MOCK_SLANT_ORDER_ID,
            status: 'PROCESSING',
          },
          VALID_SECRET,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('PROCESSING');
    });
  });

  describe('idempotency', () => {
    test('acknowledges duplicate event without creating new record', async () => {
      const mockOrder = {
        id: MOCK_ORDER_ID,
        slantPublicOrderId: MOCK_SLANT_ORDER_ID,
        localStatus: 'SHIPPED',
      };

      // First call: order lookup
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(mockOrder),
        all: vi.fn().mockResolvedValue([mockOrder]),
      });
      // Second call: idempotency check - event already exists
      mockWhere.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 1,
          orderId: MOCK_ORDER_ID,
          externalEventId: 'evt-dup-1',
        }),
        all: vi.fn().mockResolvedValue([{ id: 1 }]),
      });

      const res = await app.fetch(
        makeWebhookRequest(
          {
            eventId: 'evt-dup-1',
            orderId: MOCK_SLANT_ORDER_ID,
            status: 'SHIPPED',
          },
          VALID_SECRET,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean; status: string };
      expect(data.success).toBe(true);
      // Returns current status, not the webhook status
      expect(data.status).toBe('SHIPPED');
    });
  });
});
