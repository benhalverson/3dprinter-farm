import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
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
    squareOrderId: 'cs_secret_internal',
    squarePaymentId: 'pi_secret_internal',
    squareEventId: 'evt_internal',
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as {
      orders: Array<{
        orderNumber: string;
        items: Array<Record<string, unknown>>;
        squareOrderId?: string;
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
    expect(body.orders[0]).not.toHaveProperty('squareEventId');
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      accountId: 'user_123',
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
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
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
      squarePaymentId?: string;
    };
    expect(body.id).toBe(42);
    expect(body).toHaveProperty('accountId','user_123');
    expect(body.fulfillment).toMatchObject({
      slantPublicOrderId: slantOrderId,
      trackingNumber: 'TRACK123',
      trackingUrl: 'https://carrier.example/track/TRACK123',
      carrier: 'UPS',
      estimatedArrival: '2026-07-05',
      shippedAt: '2026-07-02T10:00:00.000Z',
    });
    expect(body).not.toHaveProperty('squareEventId');
  });

  test.each([
    'ready',
    'draft_unknown',
    'process_unknown',
    'drafted',
    'drafting',
    'processing',
    'processed',
  ])('keeps paid orders visible with fulfillment state %s without manufacturing side effects', async fulfillmentState => {
    const paid = makeOrder({
      status: fulfillmentState === 'ready' || fulfillmentState.endsWith('_unknown') ? 'paid_fulfillment_failed' : 'paid',
      paymentStatus: 'paid',
      fulfillmentState,
      source: 'online',
      fulfillmentType: 'slant',
      squareOrderId: 'square-order',
      squarePaymentId: 'square-payment',
      slantStatus: null,
      slantPublicOrderId: null,
      shippedAt: null,
      deliveredAt: null,
      itemSnapshot: JSON.stringify([
        {
          name: 'Widget',
          quantity: 2,
          unitAmountCents: 1999,
          publicFileServiceId: 'private-file',
          filamentId: 'private-filament',
        },
      ]),
    });
    mockWhere
      .mockReturnValueOnce({ get: vi.fn().mockResolvedValue(paid) })
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) });
    vi.mocked(fetch).mockClear();
    const response = await app.fetch(
      new Request('http://localhost/orders/42', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      paymentStatus: 'paid',
      fulfillmentState,
      totalAmountCents: 3998,
      currency: 'usd',
      items: [{ name: 'Widget', quantity: 2, price: 19.99 }],
      cancellation: null,
      fulfillment: {
        trackingNumber: null,
        trackingUrl: null,
        shippedAt: null,
        deliveredAt: null,
      },
    });
    expect(body).not.toHaveProperty('customerSnapshot');
    expect(body).not.toHaveProperty('itemSnapshot');
    expect(body.items[0]).not.toHaveProperty('publicFileServiceId');
    expect(body.items[0]).not.toHaveProperty('filamentId');
    expect(body.refund ?? null).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('cancellation evidence does not imply a completed refund', async () => {
    mockWhere
      .mockReturnValueOnce({
        get: vi
          .fn()
          .mockResolvedValue(
            makeOrder({
              status: 'canceled',
              paymentStatus: 'paid',
              canceledAt: '2026-10-01T12:00:00Z',
            }),
          ),
      })
      .mockReturnValueOnce({ all: vi.fn().mockResolvedValue([]) });
    const response = await app.fetch(
      new Request('http://localhost/orders/42', {
        headers: { Cookie: 'better-auth.session_token=mock-session-token' },
      }),
      env,
    );
    const body = await response.json();
    expect(body.paymentStatus).toBe('paid');
    expect(body.cancellation).toEqual({ canceledAt: '2026-10-01T12:00:00Z' });
    expect(body.refund ?? null).toBeNull();
  });

  test.each(['/orders','/orders/42'])('rejects an expected-account mismatch before reading %s',async path => {
    const response=await app.fetch(new Request(`http://localhost${path}`,{headers:{Cookie:'better-auth.session_token=mock-session-token','X-Expected-Account-Id':'previous-account'}}),env);
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'account_changed'});expect(mockWhere).not.toHaveBeenCalled();expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  test('binds an empty list to the authenticated account',async()=>{
    mockWhere.mockReturnValueOnce({all:vi.fn().mockResolvedValue([])});
    const response=await app.fetch(new Request('http://localhost/orders',{headers:{Cookie:'better-auth.session_token=mock-session-token','X-Expected-Account-Id':'user_123'}}),env);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({accountId:'user_123',orders:[]});
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
    expect(capturedInserts).toHaveLength(0);
  });
});
