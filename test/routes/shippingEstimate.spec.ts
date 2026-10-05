import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import route from '../../src/routes/shippingEstimate';
import { shippingEstimateSchema } from '../../src/modules/shippingEstimate';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import { mockDrizzle, mockWhere } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();
vi.mock('../../src/utils/profileCrypto', () => ({
  /** Supplies a decrypted fixture without exercising persistence or encryption. */
  decryptStoredShippingProfile: vi.fn(async value => value),
}));
const cartId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const profile = {
  email: 'owner@example.com',
  firstName: ' Ada ',
  lastName: ' Lovelace ',
  shippingAddress: ' 10 Main St ',
  city: ' Toronto ',
  state: ' ON ',
  zipCode: ' M5V 1A1 ',
  country: ' ca ',
  phone: 'not sent',
};
const item = {
  cartUserId: 'user_123',
  publicFileServiceId: 'file-id',
  filamentId: 'filament-id',
  quantity: 2,
};
const fetchMock = vi.fn<typeof fetch>();
const env = mockEnv();

/** Arranges the actual middleware's cart lookup followed by profile and line reads. */
function arrange(
  overrides: Record<string, unknown> = {},
  lines: unknown[] = [item],
) {
  mockWhere
    .mockResolvedValueOnce([
      { id: cartId, userId: 'user_123', accessVersion: 'version' },
    ])
    .mockResolvedValueOnce([{ ...profile, ...overrides }])
    .mockResolvedValueOnce(lines);
}

/** Exercises the real route with a mock session and no live provider requests. */
function request(bindings = env, query = `cartId=${cartId}`) {
  return route.request(
    `/cart/shipping?${query}`,
    {
      headers: { Cookie: 'better-auth.session_token=test' },
    },
    bindings,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWhere.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue(
      Response.json({ data: { order: { deliveryCost: '15.99' } } }),
    );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shipping estimate contract', () => {
  test('maps profile fields explicitly and returns a validated raw provider value', async () => {
    arrange();
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(shippingEstimateSchema.parse(await result.json())).toEqual({
      shippingCost: 15.99,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slant3dapi.com/v2/api/orders');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({
      platformId: env.SLANT_PLATFORM_ID,
      ownerId: 'user_123',
      customer: {
        details: {
          email: 'owner@example.com',
          address: {
            name: 'Ada Lovelace',
            line1: '10 Main St',
            line2: '',
            city: 'Toronto',
            state: 'ON',
            zip: 'M5V 1A1',
            country: 'CA',
          },
        },
      },
      items: [
        {
          type: 'PRINT',
          publicFileServiceId: 'file-id',
          filamentId: 'filament-id',
          quantity: 2,
        },
      ],
    });
  });

  test('accepts the documented totals-only USD response', async () => {
    arrange();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        data: { totals: { deliveryCost: 8.25 } },
      }),
    );
    const result = await request();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ shippingCost: 8.25 });
  });

  test.each([
    'email',
    'firstName',
    'lastName',
    'shippingAddress',
    'city',
    'state',
    'zipCode',
    'country',
  ])('rejects blank %s before provider access', async field => {
    arrange({ [field]: ' ' });
    const result = await request();
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({
      error: 'Complete your shipping profile before estimating shipping',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    { country: 'USA' },
    { email: 'not-email' },
  ])('rejects invalid profile %o', async invalid => {
    arrange(invalid);
    expect((await request()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each(['', 'cartId=invalid'])('rejects invalid query %s', async query => {
    expect((await request(env, query)).status).toBe(400);
    expect(mockWhere).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('requires a session', async () => {
    mockBetterAuth.getSession.mockResolvedValueOnce(null);
    const result = await request();
    expect(result.status).toBe(401);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(mockWhere).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('requires a claimed cart even with guest access', async () => {
    mockWhere.mockResolvedValueOnce([{ id: cartId, userId: null }]);
    expect((await request()).status).toBe(401);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('hides inaccessible carts', async () => {
    mockWhere.mockResolvedValueOnce([]);
    expect((await request()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('rejects an empty cart', async () => {
    arrange({}, []);
    const result = await request();
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: 'Cart empty or not found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('checks every line owner', async () => {
    arrange({}, [item, { ...item, cartUserId: 'another-user' }]);
    expect((await request()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])('rejects invalid quantity %s', async quantity => {
    arrange({}, [{ ...item, quantity }]);
    expect((await request()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([
    'SLANT_API_V2',
    'SLANT_PLATFORM_ID',
    'ENCRYPTION_PASSPHRASE',
  ] as const)('requires %s', async key => {
    arrange();
    const result = await request({ ...env, [key]: '' });
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({
      error: 'Shipping estimate is not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('preserves the JSON error boundary for authorization DB failures after app mounting', async () => {
    mockWhere.mockRejectedValueOnce(new Error('private database details'));
    const result = await app.request(
      `/cart/shipping?cartId=${cartId}`,
      {
        headers: { Cookie: 'better-auth.session_token=test' },
      },
      env,
    );
    expect(result.status).toBe(500);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({
      error: 'Failed to retrieve shipping estimate',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('sanitizes internal errors', async () => {
    mockWhere
      .mockResolvedValueOnce([{ id: cartId, userId: 'user_123' }])
      .mockRejectedValueOnce(new Error('secret database details'));
    const result = await request();
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({
      error: 'Failed to retrieve shipping estimate',
    });
  });
  test.each([
    {
      body: JSON.stringify({ data: { totals: { deliveryCost: -1 } } }),
      status: 200,
    },
    { body: 'not JSON', status: 200 },
    {
      body: JSON.stringify({
        data: { order: { deliveryCost: '1.00' }, totals: { deliveryCost: 2 } },
      }),
      status: 200,
    },
    { body: JSON.stringify({ secret: 'PII' }), status: 400 },
    { body: '{}', status: 200 },
    {
      body: JSON.stringify({ data: { totals: { deliveryCost: 1.005 } } }),
      status: 200,
    },
    {
      body: JSON.stringify({
        data: { order: { deliveryCost: '90071992547409.91' } },
      }),
      status: 200,
    },
    { body: JSON.stringify({ shippingCost: 15.99 }), status: 200 },
  ])('sanitizes upstream failure %o', async ({ body, status }) => {
    arrange();
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    const result = await request();
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: 'Shipping provider estimate unavailable',
    });
  });
  test('maps network rejection to 502', async () => {
    arrange();
    fetchMock.mockRejectedValueOnce(new Error('secret provider URL'));
    const result = await request();
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: 'Shipping provider estimate unavailable',
    });
  });
  test('generated docs match the runtime success/error DTOs and authentication', async () => {
    const response = await app.request('/open-api', {}, env);
    const doc = (await response.json()) as {
      paths: Record<
        string,
        {
          get: {
            security: unknown;
            parameters: unknown[];
            responses: Record<
              string,
              {
                content: Record<
                  string,
                  {
                    schema: {
                      properties: Record<string, unknown>;
                      required: string[];
                    };
                  }
                >;
              }
            >;
          };
        }
      >;
    };
    const operation = doc.paths['/cart/shipping'].get;
    expect(operation.security).toEqual([{ cookieAuth: [] }]);
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({
        name: 'cartId',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }),
    );
    const success =
      operation.responses['200'].content['application/json'].schema;
    expect(Object.keys(success.properties)).toEqual(['shippingCost']);
    expect(success.required).toEqual(['shippingCost']);
    expect(success.properties.shippingCost).toMatchObject({
      type: 'number',
      minimum: 0,
      maximum: 90071992547409,
      description: expect.stringContaining('USD major units (dollars)'),
    });
    for (const status of ['400', '401', '403', '404', '500', '502']) {
      expect(
        operation.responses[status].content['application/json'].schema.required,
      ).toEqual(['error']);
    }
  });
});
