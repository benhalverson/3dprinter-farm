import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockAuth } from '../mocks/auth';
import {
  capturedInserts,
  mockAll,
  mockDrizzle,
  mockInsert,
  mockWhere,
} from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn(), constructEventAsync: vi.fn() },
  })),
}));

vi.mock('../../src/utils/profileCrypto', async importActual => {
  const actual =
    await importActual<typeof import('../../src/utils/profileCrypto')>();
  return {
    ...actual,
    getCipherKitSecretKey: vi.fn().mockResolvedValue('mock-secret-key'),
    decryptStoredShippingProfile: vi.fn().mockResolvedValue({}),
  };
});

const env = mockEnv();
const validSecret = 'test-slant-webhook-secret';
const slantOrderId = 'slant-order-123';
const itemSnapshot = JSON.stringify([
  {
    skuNumber: 'SKU-001',
    name: 'Printed Widget',
    quantity: 2,
    color: 'red',
    filamentType: 'PLA',
    filamentId: 'internal-filament-id',
    publicFileServiceId: 'internal-file-id',
    image: 'https://example.com/widget.jpg',
    price: 19.99,
  },
]);

function makeWebhookRequest(body: unknown, secret?: string): Request {
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

function mailjetResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: 'user_123',
    orderNumber: 'ORDER-123456',
    cartId: 'cart-123',
    filename: 'Printed Widget',
    fileURL: 'https://example.com/model.stl',
    shipToName: 'Test User',
    shipToStreet1: '123 Main St',
    shipToStreet2: '',
    shipToCity: 'San Diego',
    shipToState: 'CA',
    shipToZip: '92101',
    shipToCountryISO: 'US',
    billToStreet1: '123 Main St',
    billToStreet2: '',
    billToCity: 'San Diego',
    billToState: 'CA',
    billToZip: '92101',
    billToCountryISO: 'US',
    status: 'shipped',
    slantStatus: 'SHIPPED',
    slantPublicOrderId: slantOrderId,
    stripeCheckoutSessionId: 'cs_secret_internal',
    stripePaymentIntentId: 'pi_secret_internal',
    stripeEventId: 'evt_internal',
    customerEmail: 'test@example.com',
    totalAmountCents: 3998,
    currency: 'usd',
    itemSnapshot,
    customerSnapshot: JSON.stringify({ email: 'test@example.com' }),
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    processedAt: '2026-07-01T10:01:00.000Z',
    shippedAt: '2026-07-02T10:00:00.000Z',
    deliveredAt: null,
    canceledAt: null,
    ...overrides,
  };
}

describe('Customer Orders API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReset();
    mockAll.mockReset();
    mockInsert.mockReset();
    capturedInserts.length = 0;
  });

  test('returns 401 when listing orders without a session', async () => {
    const res = await app.fetch(new Request('http://localhost/orders'), env);

    expect(res.status).toBe(401);
  });

  test('lists the authenticated customer orders with pagination and safe fields', async () => {
    mockAll.mockResolvedValueOnce([
      makeOrder({
        id: 1,
        orderNumber: 'ORDER-OLD',
        createdAt: '2026-07-01T10:00:00.000Z',
      }),
      makeOrder({
        id: 2,
        orderNumber: 'ORDER-NEW',
        createdAt: '2026-07-03T10:00:00.000Z',
      }),
    ]);

    const res = await app.fetch(
      new Request('http://localhost/orders?limit=1&offset=1', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<{
        orderNumber: string;
        items: Array<Record<string, unknown>>;
        stripeCheckoutSessionId?: string;
      }>;
      pagination: { limit: number; offset: number; count: number };
    };
    expect(body.pagination).toEqual({ limit: 1, offset: 1, count: 2 });
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].orderNumber).toBe('ORDER-OLD');
    expect(body.orders[0].items[0]).toMatchObject({
      skuNumber: 'SKU-001',
      name: 'Printed Widget',
      quantity: 2,
      filamentType: 'PLA',
    });
    expect(body.orders[0].items[0]).not.toHaveProperty('publicFileServiceId');
    expect(body.orders[0].items[0]).not.toHaveProperty('filamentId');
    expect(body.orders[0]).not.toHaveProperty('stripeCheckoutSessionId');
  });

  test('returns an empty order history for customers without orders', async () => {
    mockAll.mockResolvedValueOnce([]);

    const res = await app.fetch(
      new Request('http://localhost/orders', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orders: [],
      pagination: { limit: 20, offset: 0, count: 0 },
    });
  });

  test('returns details for an owned order with tracking fields', async () => {
    mockWhere
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(makeOrder()),
      })
      .mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([
          {
            id: 7,
            orderId: 42,
            type: 'slant_status_changed',
            metadata: JSON.stringify({
              trackingNumber: 'TRACK123',
              trackingUrl: 'https://carrier.example/track/TRACK123',
              carrier: 'UPS',
              estimatedArrival: '2026-07-05',
            }),
            createdAt: '2026-07-02T10:00:00.000Z',
          },
        ]),
      });

    const res = await app.fetch(
      new Request('http://localhost/orders/42', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      fulfillment: {
        slantPublicOrderId: string | null;
        trackingNumber: string | null;
        trackingUrl: string | null;
        carrier: string | null;
        estimatedArrival: string | null;
        shippedAt: string | null;
      };
      stripePaymentIntentId?: string;
    };
    expect(body.id).toBe(42);
    expect(body.fulfillment).toMatchObject({
      slantPublicOrderId: slantOrderId,
      trackingNumber: 'TRACK123',
      trackingUrl: 'https://carrier.example/track/TRACK123',
      carrier: 'UPS',
      estimatedArrival: '2026-07-05',
      shippedAt: '2026-07-02T10:00:00.000Z',
    });
    expect(body).not.toHaveProperty('stripePaymentIntentId');
  });

  test('forbids access to another customer order', async () => {
    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(makeOrder({ userId: 'other_user' })),
    });

    const res = await app.fetch(
      new Request('http://localhost/orders/42', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  test('returns 404 for a missing order detail', async () => {
    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(undefined),
    });

    const res = await app.fetch(
      new Request('http://localhost/orders/999', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Order not found' });
  });
});

describe('POST /webhook/slant3d', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReset();
    mockInsert.mockReset();
    capturedInserts.length = 0;
  });

  test('returns 401 when the configured webhook secret is missing', async () => {
    const res = await app.fetch(
      makeWebhookRequest({ orderId: slantOrderId, status: 'SHIPPED' }),
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid webhook secret' });
  });

  test('returns 422 for an invalid webhook body', async () => {
    const res = await app.fetch(
      makeWebhookRequest({ orderId: slantOrderId, status: 'BAD' }, validSecret),
      env,
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Invalid request body' });
    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0]).toMatchObject({
      orderId: null,
      notificationType: 'admin_failure_alert',
      recipientEmail: env.MAILJET_SENDER_EMAIL,
      status: 'sent',
      statusTransition: 'slant_webhook_invalid_body',
      source: 'slant3d',
    });
  });

  test('returns 404 when the Slant order is unknown locally', async () => {
    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(undefined),
      all: vi.fn().mockResolvedValue([]),
    });

    const res = await app.fetch(
      makeWebhookRequest(
        { orderId: slantOrderId, status: 'SHIPPED' },
        validSecret,
      ),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Order not found' });
  });

  test('updates local status and records a Slant lifecycle event', async () => {
    mockWhere
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 42,
          orderNumber: 'ORDER-123456',
          status: 'processing',
          slantStatus: 'PROCESSING',
          slantPublicOrderId: slantOrderId,
          customerEmail: 'test@example.com',
        }),
        all: vi.fn().mockResolvedValue([]),
      })
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
        all: vi.fn().mockResolvedValue([]),
      });

    const res = await app.fetch(
      makeWebhookRequest(
        {
          eventId: 'slant-event-1',
          orderId: slantOrderId,
          status: 'SHIPPED',
          metadata: { trackingNumber: 'TRACK123' },
        },
        validSecret,
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      orderId: 42,
      status: 'SHIPPED',
    });
    expect(capturedInserts).toHaveLength(2);
    expect(capturedInserts[0]).toMatchObject({
      orderId: 42,
      type: 'slant_status_changed',
      actor: 'slant3d',
      externalEventId: 'slant-event-1',
      source: 'slant3d',
      previousStatus: 'PROCESSING',
      nextStatus: 'SHIPPED',
      metadata: JSON.stringify({ trackingNumber: 'TRACK123' }),
    });
    expect(capturedInserts[1]).toMatchObject({
      orderId: 42,
      notificationType: 'order_shipped',
      recipientEmail: 'test@example.com',
      status: 'sent',
      statusTransition: 'PROCESSING_to_SHIPPED',
      source: 'slant3d',
    });
  });

  test('acknowledges status updates and alerts admins when customer notification delivery fails', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        mailjetResponse(
          { Messages: [{ Errors: [{ ErrorMessage: 'down' }] }] },
          500,
        ),
      )
      .mockResolvedValueOnce(
        mailjetResponse({ Messages: [{ To: [{ MessageID: 123 }] }] }),
      );
    mockWhere
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 42,
          orderNumber: 'ORDER-123456',
          status: 'processing',
          slantStatus: 'PROCESSING',
          slantPublicOrderId: slantOrderId,
          customerEmail: 'test@example.com',
        }),
        all: vi.fn().mockResolvedValue([]),
      })
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
        all: vi.fn().mockResolvedValue([]),
      });

    const res = await app.fetch(
      makeWebhookRequest(
        {
          eventId: 'slant-event-notification-failed',
          orderId: slantOrderId,
          status: 'SHIPPED',
        },
        validSecret,
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      orderId: 42,
      status: 'SHIPPED',
    });
    expect(capturedInserts).toHaveLength(3);
    expect(capturedInserts[0]).toMatchObject({
      orderId: 42,
      type: 'slant_status_changed',
      nextStatus: 'SHIPPED',
    });
    expect(capturedInserts[1]).toMatchObject({
      orderId: 42,
      notificationType: 'order_shipped',
      recipientEmail: 'test@example.com',
      status: 'failed',
      statusTransition: 'PROCESSING_to_SHIPPED',
      source: 'slant3d',
    });
    expect(capturedInserts[2]).toMatchObject({
      orderId: 42,
      notificationType: 'admin_failure_alert',
      recipientEmail: env.MAILJET_SENDER_EMAIL,
      status: 'sent',
      statusTransition: 'order_shipped_delivery_failed',
      source: 'slant3d',
    });
  });

  test('acknowledges duplicate event ids without recording another event', async () => {
    mockWhere
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 42,
          status: 'shipped',
          slantStatus: 'SHIPPED',
          slantPublicOrderId: slantOrderId,
        }),
        all: vi.fn().mockResolvedValue([]),
      })
      .mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 7,
          orderId: 42,
          externalEventId: 'slant-event-1',
        }),
        all: vi.fn().mockResolvedValue([]),
      });

    const res = await app.fetch(
      makeWebhookRequest(
        {
          eventId: 'slant-event-1',
          orderId: slantOrderId,
          status: 'SHIPPED',
        },
        validSecret,
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      orderId: 42,
      status: 'SHIPPED',
    });
    expect(capturedInserts).toHaveLength(0);
  });
});
